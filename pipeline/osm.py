"""Punti di interesse e valli da OpenStreetMap (Overpass API), con cache in data/raw/osm/.

Uso diretto (solo download/aggiornamento della cache):
    .venv\\Scripts\\python -m pipeline.osm             # scarica solo le categorie mancanti o vecchie
    .venv\\Scripts\\python -m pipeline.osm --refresh   # riscarica tutto

Una richiesta per categoria, in sequenza, con pausa tra le richieste e attesa crescente
in caso di errore: Overpass è un servizio gratuito e condiviso, non va martellato.
La build usa la cache e scarica solo ciò che manca.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import geopandas as gpd
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, polygonize, unary_union

from . import config

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "sentieri-drone-trentino/1.0 (https://github.com/fabionsky20/sentieri-drone-trentino)"
PAUSE_S = 10  # tra una richiesta e l'altra
RETRY_WAIT_S = [30, 90, 240]  # attese crescenti dopo un errore

# Query Overpass per categoria ({bbox} = sud,ovest,nord,est). `out geom` per le forme che
# servono intere (laghi, valli), `out center` per il resto (un punto per edificio/area).
NOT_WATERCOURSE = '["water"!~"^(river|canal|stream|ditch|wastewater|lock|moat|stream_pool)$"]'
QUERIES: dict[str, str] = {
    "lago": f'nwr["natural"="water"]["name"]{NOT_WATERCOURSE}({{bbox}}); out geom;',
    "vetta": 'node["natural"~"^(peak|volcano)$"]["name"]({bbox}); out;',
    "malga": (
        'nwr["name"~"^(Malga|Malghetta|Casera|Malghe) ",i][!"highway"][!"waterway"][!"route"]({bbox}); out center tags;'
    ),
    "rifugio": 'nwr["tourism"="alpine_hut"]({bbox}); out center tags;',
    "bivacco": (
        '(nwr["tourism"="wilderness_hut"]({bbox}); nwr["amenity"="shelter"]["name"~"^Bivacc",i]({bbox}););'
        " out center tags;"
    ),
    "cascata": '(nwr["waterway"="waterfall"]({bbox}); nwr["natural"="waterfall"]({bbox});); out center tags;',
    "panoramico": 'nwr["tourism"="viewpoint"]({bbox}); out center tags;',
    "passo": '(node["mountain_pass"="yes"]({bbox}); node["natural"="saddle"]["name"]({bbox});); out;',
    "valle": 'nwr["natural"="valley"]["name"]({bbox}); out geom;',
    "paese": 'node["place"~"^(city|town|village|hamlet)$"]["name"]({bbox}); out;',
}

# Nome generico per i punti senza nome (solo dove ha senso tenerli).
DEFAULT_NAME = {"cascata": "Cascata", "panoramico": "Punto panoramico", "rifugio": "Rifugio", "bivacco": "Bivacco"}
POI_CATEGORIES = ["lago", "vetta", "malga", "rifugio", "bivacco", "cascata", "panoramico", "passo"]

CACHE = config.RAW / "osm"


# ---------------------------------------------------------------- download

def _bbox_str(bounds_wgs84) -> str:
    w, s, e, n = bounds_wgs84
    return f"{s:.4f},{w:.4f},{n:.4f},{e:.4f}"


def _post(query: str) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    last_err: Exception | None = None
    for attempt, wait in enumerate([0, *RETRY_WAIT_S]):
        if wait:
            print(f"    nuovo tentativo tra {wait} s ({last_err})")
            time.sleep(wait)
        endpoint = ENDPOINTS[attempt % len(ENDPOINTS)]
        req = urllib.request.Request(endpoint, data=data, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
    raise RuntimeError(f"Overpass non risponde: {last_err}")


def fetch(bounds_wgs84, refresh: bool = False, max_age_days: int | None = None) -> None:
    """Scarica le categorie mancanti (o tutte con refresh, o quelle più vecchie di max_age_days)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    bbox = _bbox_str(bounds_wgs84)
    todo = []
    for cat in QUERIES:
        path = CACHE / f"{cat}.json"
        if path.exists() and not refresh:
            age = (time.time() - path.stat().st_mtime) / 86400
            if max_age_days is None or age < max_age_days:
                continue
        todo.append(cat)

    for i, cat in enumerate(todo):
        if i:
            time.sleep(PAUSE_S)
        print(f"  Overpass: {cat}…")
        try:
            data = _post(f"[out:json][timeout:240];\n{QUERIES[cat].format(bbox=bbox)}")
        except RuntimeError as e:
            # Overpass giù: non insistere, ricava le categorie restanti dall'estratto regionale.
            print(f"  {e}\n  → uso l'estratto OSM regionale per: {', '.join(todo[i:])}")
            from . import osm_extract
            osm_extract.download()
            osm_extract.build_cache(bounds_wgs84, todo[i:])
            return
        data["_scaricato"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        data["_fonte"] = "Overpass"
        data["_bbox"] = bbox
        (CACHE / f"{cat}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print(f"    {len(data.get('elements', []))} elementi")


# ---------------------------------------------------------------- parsing

def _name(tags: dict) -> str | None:
    n = tags.get("name:it") or tags.get("name")
    return n.strip() if n else None


def _ele(tags: dict) -> float | None:
    m = re.match(r"^\s*(\d{2,4}(?:[.,]\d+)?)", tags.get("ele", ""))
    return round(float(m.group(1).replace(",", "."))) if m else None


def _geom(el: dict):
    """Geometria shapely in WGS84 da un elemento Overpass (out geom / out center / nodo)."""
    if "wkt" in el:  # cache creata dall'estratto regionale (pipeline/osm_extract.py)
        return shapely.from_wkt(el["wkt"])
    if el["type"] == "node":
        return Point(el["lon"], el["lat"])
    if "geometry" in el and el["type"] == "way":
        coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
        if len(coords) >= 4 and coords[0] == coords[-1]:
            return Polygon(coords)
        return LineString(coords) if len(coords) >= 2 else None
    if "members" in el and el["type"] == "relation":
        outer = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
                 for m in el["members"] if m.get("geometry") and m.get("role") in ("outer", "")]
        if not outer:
            return None
        polys = list(polygonize(linemerge(unary_union(outer))))
        return unary_union(polys) if polys else linemerge(unary_union(outer))
    if "center" in el:
        return Point(el["center"]["lon"], el["center"]["lat"])
    return None


def _load(cat: str) -> list[dict]:
    path = CACHE / f"{cat}.json"
    if not path.exists():
        return []
    rows = []
    for el in json.loads(path.read_text(encoding="utf-8")).get("elements", []):
        tags = el.get("tags", {})
        geom = _geom(el)
        if geom is None or geom.is_empty:
            continue
        rows.append({
            "osm": f"{el['type'][0]}{el['id']}",
            "nome": _name(tags),
            "ele": _ele(tags),
            "geometry": shapely.make_valid(geom) if not isinstance(geom, Point) else geom,
        })
    return rows


def _dedupe(gdf: gpd.GeoDataFrame, dist_m: float) -> gpd.GeoDataFrame:
    """Stesso nome entro dist_m (es. rifugio mappato come punto e come edificio): ne resta uno."""
    keep, seen = [], []
    order = gdf.assign(_n=gdf.nome.fillna("").str.lower(), _pt=gdf.osm.str[0] == "n")
    order = order.sort_values(["_pt", "ele"], ascending=[False, False], na_position="last")
    for idx, row in order.iterrows():
        pt = row.geometry.representative_point() if not isinstance(row.geometry, Point) else row.geometry
        if any(n == row._n and pt.distance(p) < dist_m for n, p in seen if row._n):
            continue
        seen.append((row._n, pt))
        keep.append(idx)
    return gdf.loc[sorted(keep)]


def pois() -> gpd.GeoDataFrame:
    """Tutti i POI in WORK_CRS. `geometry` = punto per la mappa, `forma` = area/linea per le distanze."""
    frames = []
    for cat in POI_CATEGORIES:
        rows = _load(cat)
        if not rows:
            continue
        g = gpd.GeoDataFrame(rows, crs=config.WEB_CRS).to_crs(config.WORK_CRS)
        if cat in DEFAULT_NAME:
            g["nome"] = g.nome.fillna(DEFAULT_NAME[cat])
        g = g[g.nome.notna()]
        if cat == "lago":
            g = g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon", "Point"])]
        g = _dedupe(g, 200)
        g["categoria"] = cat
        frames.append(g)
    if not frames:
        return gpd.GeoDataFrame(columns=["id", "categoria", "nome", "ele", "forma", "geometry"], geometry="geometry",
                                crs=config.WORK_CRS)
    out = gpd.GeoDataFrame(gpd.pd.concat(frames, ignore_index=True), crs=config.WORK_CRS)
    out["forma"] = out.geometry
    out["geometry"] = out.geometry.map(lambda g: g if isinstance(g, Point) else g.representative_point())
    out["id"] = out.categoria.str[:3] + ":" + out.osm
    return out[["id", "categoria", "nome", "ele", "osm", "forma", "geometry"]]


def valleys() -> gpd.GeoDataFrame:
    """Valli con nome; `importanza` = lunghezza (km) della linea o lato equivalente dell'area."""
    rows = _load("valle")
    if not rows:
        return gpd.GeoDataFrame(columns=["nome", "km", "geometry"], geometry="geometry", crs=config.WORK_CRS)
    g = gpd.GeoDataFrame(rows, crs=config.WEB_CRS).to_crs(config.WORK_CRS)
    g = g[g.nome.notna()]

    def size_km(geom) -> float:
        if geom.geom_type in ("LineString", "MultiLineString"):
            return geom.length / 1000
        if geom.geom_type in ("Polygon", "MultiPolygon"):
            minx, miny, maxx, maxy = geom.bounds
            return max(maxx - minx, maxy - miny) / 1000
        return 0.0

    g["km"] = g.geometry.map(size_km).round(1)
    # Le valli disegnate come area: per l'etichetta serve un punto o una linea, non il poligono.
    g["geometry"] = g.geometry.map(lambda x: x.representative_point() if x.geom_type.endswith("Polygon") else x)
    # Stessa valle spezzata in più tratti: si tiene il più lungo.
    g = g.sort_values("km", ascending=False).drop_duplicates("nome")
    return g[["nome", "km", "osm", "geometry"]]


def places() -> gpd.GeoDataFrame:
    rows = _load("paese")
    g = gpd.GeoDataFrame(rows, crs=config.WEB_CRS).to_crs(config.WORK_CRS) if rows else None
    return g[g.nome.notna()] if g is not None else gpd.GeoDataFrame(columns=["nome", "geometry"], geometry="geometry")


def downloaded_at() -> str | None:
    """Data del download più vecchio in cache (i POI sono aggiornati almeno a questa data)."""
    dates = []
    for cat in QUERIES:
        path = CACHE / f"{cat}.json"
        if path.exists():
            dates.append(json.loads(path.read_text(encoding="utf-8")).get("_scaricato"))
    dates = [d for d in dates if d]
    return min(dates) if dates else None


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--refresh", action="store_true", help="riscarica tutte le categorie")
    p.add_argument("--max-age", type=int, default=None, help="riscarica le categorie più vecchie di N giorni")
    args = p.parse_args()
    from . import sat
    trails, _ = sat.load(sat.find_source())
    fetch(trails.to_crs(config.WEB_CRS).total_bounds + [-0.04, -0.03, 0.04, 0.03], args.refresh, args.max_age)
    print({c: len(_load(c)) for c in QUERIES})
    return 0


if __name__ == "__main__":
    sys.exit(main())
