"""Piano B per i POI: estratto regionale OpenStreetMap letto in locale (nessun server da interrogare).

Si usa quando Overpass non risponde. Scarica una volta l'estratto Trentino-Alto Adige di
OpenStreetMap France (~140 MB, aggiornato ogni giorno) in data/raw/osm/ e ne ricava le stesse
categorie di pipeline/osm.py, scrivendo la cache nello stesso formato.

Limite: l'estratto copre solo la regione; i POI appena oltre il confine (es. Lessinia,
Altopiano di Asiago) non ci sono.
"""

from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import datetime, timezone

import osmium
import osmium.filter
import osmium.geom

from . import osm

URL = "https://download.openstreetmap.fr/extracts/europe/italy/trentino_alto_adige-latest.osm.pbf"
PBF = osm.CACHE / "trentino_alto_adige-latest.osm.pbf"
MAX_AGE_DAYS = 30

MALGA = re.compile(r"^(Malga|Malghetta|Casera|Malghe) ", re.I)
BIVACCO = re.compile(r"^Bivacc", re.I)
EXCLUDED_WATER = {"river", "canal", "stream", "ditch", "wastewater", "lock", "moat", "stream_pool"}


def download(force: bool = False) -> None:
    if PBF.exists() and not force and (time.time() - PBF.stat().st_mtime) / 86400 < MAX_AGE_DAYS:
        return
    print(f"  scarico l'estratto OSM regionale ({URL})…")
    req = urllib.request.Request(URL, headers={"User-Agent": osm.USER_AGENT})
    tmp = PBF.with_suffix(".tmp")
    with urllib.request.urlopen(req, timeout=600) as r, tmp.open("wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(PBF)


def classify(tags: dict, kind: str) -> list[str]:
    """Categorie a cui appartiene un oggetto OSM (stesse regole delle query Overpass)."""
    cats = []
    name = tags.get("name")
    nat = tags.get("natural")
    if nat == "water" and name and tags.get("water") not in EXCLUDED_WATER:
        cats.append("lago")
    if kind == "node" and nat in ("peak", "volcano") and name:
        cats.append("vetta")
    if name and MALGA.match(name) and not ({"highway", "waterway", "route"} & tags.keys()):
        cats.append("malga")
    if tags.get("tourism") == "alpine_hut":
        cats.append("rifugio")
    if tags.get("tourism") == "wilderness_hut" or (tags.get("amenity") == "shelter" and name and BIVACCO.match(name)):
        cats.append("bivacco")
    if tags.get("waterway") == "waterfall" or nat == "waterfall":
        cats.append("cascata")
    if tags.get("tourism") == "viewpoint":
        cats.append("panoramico")
    if kind == "node" and (tags.get("mountain_pass") == "yes" or (nat == "saddle" and name)):
        cats.append("passo")
    if nat == "valley" and name:
        cats.append("valle")
    if kind == "node" and name and tags.get("place") in ("city", "town", "village", "hamlet"):
        cats.append("paese")
    return cats


# Categorie per cui serve la forma intera (aree/linee) invece di un punto centrale.
SHAPE_CATS = {"lago", "valle"}


def build_cache(bounds_wgs84, categories: list[str]) -> None:
    """Legge l'estratto e scrive data/raw/osm/<categoria>.json per le categorie richieste."""
    w, s, e, n = bounds_wgs84
    inside = lambda lon, lat: w <= lon <= e and s <= lat <= n  # noqa: E731
    wkt = osmium.geom.WKTFactory()
    out: dict[str, list[dict]] = {c: [] for c in categories}

    fp = (osmium.FileProcessor(str(PBF))
          .with_locations()
          .with_areas()
          .with_filter(osmium.filter.EmptyTagFilter()))
    for obj in fp:
        tags = {t.k: t.v for t in obj.tags}
        if obj.is_node():
            cats = [c for c in classify(tags, "node") if c in out]
            if cats and inside(obj.location.lon, obj.location.lat):
                el = {"type": "node", "id": obj.id, "lat": obj.location.lat, "lon": obj.location.lon, "tags": tags}
                for c in cats:
                    out[c].append(el)
        elif obj.is_way():
            cats = [c for c in classify(tags, "way") if c in out]
            if not cats:
                continue
            try:
                line = wkt.create_linestring(obj)
                nodes = [(nd.lon, nd.lat) for nd in obj.nodes]
            except Exception:  # noqa: BLE001 - nodi mancanti ai bordi dell'estratto
                continue
            lon = sum(p[0] for p in nodes) / len(nodes)
            lat = sum(p[1] for p in nodes) / len(nodes)
            if not inside(lon, lat):
                continue
            for c in cats:
                if c in SHAPE_CATS:
                    if not obj.is_closed():  # le chiuse arrivano come aree
                        out[c].append({"type": "way", "id": obj.id, "tags": tags, "wkt": line})
                else:
                    out[c].append({"type": "way", "id": obj.id, "tags": tags, "center": {"lat": lat, "lon": lon}})
        elif obj.is_area():
            from_way = obj.from_way()
            cats = [c for c in classify(tags, "area") if c in out]
            # Le aree da way chiuse servono solo per le forme; per il resto basta la way.
            cats = [c for c in cats if c in SHAPE_CATS or not from_way]
            if not cats:
                continue
            try:
                geom = wkt.create_multipolygon(obj)
            except Exception:  # noqa: BLE001
                continue
            first = next(iter(obj.outer_rings()), None)
            if first is None:
                continue
            pts = [(nd.lon, nd.lat) for nd in first]
            lon, lat = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            if not inside(lon, lat):
                continue
            kind = "way" if from_way else "relation"
            for c in cats:
                if c in SHAPE_CATS:
                    out[c].append({"type": kind, "id": obj.orig_id(), "tags": tags, "wkt": geom})
                else:
                    out[c].append({"type": kind, "id": obj.orig_id(), "tags": tags, "center": {"lat": lat, "lon": lon}})

    stamp = datetime.fromtimestamp(PBF.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    for c, elements in out.items():
        data = {"elements": elements, "_scaricato": stamp, "_fonte": "estratto OSM France " + PBF.name}
        (osm.CACHE / f"{c}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print(f"    {c}: {len(elements)} elementi (estratto)")
