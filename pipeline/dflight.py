"""Caricamento delle zone geografiche UAS D-Flight (ED-269) e regola dei tre colori."""

from __future__ import annotations

import gzip
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon, shape

from . import config

ROSSO, GIALLO, VERDE = "rosso", "giallo", "verde"
VIETATO, AUTORIZZAZIONE = "vietato", "autorizzazione"


def find_source() -> Path:
    candidates = [*config.RAW.rglob("dflight*.json.gz"), *config.RAW.rglob("dflight*.json")]
    if not candidates:
        raise FileNotFoundError(f"Nessun JSON D-Flight in {config.RAW}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def snapshot_time(title: str) -> datetime | None:
    """'ITA ZoneVersion 15/10/2026 19:16:10' → datetime (ora italiana, salvata così com'è)."""
    m = re.search(r"(\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2})", title or "")
    return datetime.strptime(m.group(1), "%d/%m/%Y %H:%M:%S") if m else None


def classify(restriction: str, lower: float) -> tuple[str, str | None, float | None]:
    """Colore di una singola zona → (colore, tipo_rosso, quota_max_m).

    Regola in CLAUDE.md: PROHIBITED → rosso vietato; REQ_AUTHORISATION da 0 m →
    rosso autorizzazione; con limite inferiore > 0 → giallo fino a quel limite.
    Restrizioni sconosciute: giallo se limite > 0, altrimenti rosso (prudenza).
    """
    if restriction == "PROHIBITED":
        return ROSSO, VIETATO, None
    if lower <= 0:
        return ROSSO, AUTORIZZAZIONE, None
    return GIALLO, None, float(lower)


def combine(zones: list[dict]) -> tuple[str, str | None, float | None]:
    """Colore di un tratto coperto da più zone: vince la più restrittiva.

    Tra rossi "vietato" prevale su "autorizzazione"; tra gialli vince la quota minore.
    """
    if not zones:
        return VERDE, None, None
    reds = [z for z in zones if z["colore"] == ROSSO]
    if reds:
        kind = VIETATO if any(z["tipo_rosso"] == VIETATO for z in reds) else AUTORIZZAZIONE
        return ROSSO, kind, None
    return GIALLO, None, min(z["quota_max_m"] for z in zones)


def _na(v):
    """D-Flight usa 'N.A.' e stringhe vuote per i campi mancanti."""
    if v is None:
        return None
    v = str(v).strip()
    return None if v in ("", "N.A.") else v


def _polygons(geom) -> list[Polygon]:
    geom = make_valid(geom)
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for part in getattr(geom, "geoms", []) for g in _polygons(part)]


def load(path: Path) -> tuple[gpd.GeoDataFrame, dict]:
    """Una riga per ogni parte geometrica di ogni zona, in WORK_CRS.

    Ritorna anche i metadati dello snapshot.
    """
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8-sig") as f:
        data = json.load(f)

    rows = []
    for feat in data["features"]:
        app = (feat.get("applicability") or [{}])[0]
        auth = (feat.get("zoneAuthority") or [{}])[0]
        base = {
            "zona_id": feat["identifier"],
            "nome": feat.get("name", "").strip(),
            "categoria": feat.get("otherReasonInfo"),
            "restrizione": feat.get("restriction"),
            "motivi": ",".join(feat.get("reason") or []),
            "messaggio": _na(feat.get("message")),
            "permanente": app.get("permanent") == "YES",
            "inizio": app.get("startDateTime"),
            "fine": app.get("endDateTime"),
            "ente": _na(auth.get("name")),
            "ente_servizio": _na(auth.get("service")),
            "ente_email": _na(auth.get("email")),
            "ente_telefono": _na(auth.get("phone")),
            "ente_contatto": _na(auth.get("contactName")),
            "ente_sito": _na(auth.get("siteURL")),
        }
        for part, g in enumerate(feat.get("geometry") or []):
            lower, upper = g.get("lowerLimit", 0), g.get("upperLimit")
            colore, tipo_rosso, quota_max = classify(base["restrizione"], lower)
            for poly in _polygons(shape(g["horizontalProjection"])):
                rows.append({
                    **base,
                    "parte": part,
                    "quota_min_m": lower,
                    "quota_sup_m": upper if upper is not None and upper < config.UNLIMITED_UPPER_M else None,
                    "riferimento": g.get("lowerVerticalReference"),
                    "colore": colore,
                    "tipo_rosso": tipo_rosso,
                    "quota_max_m": quota_max,
                    "geometry": poly,
                })

    gdf = gpd.GeoDataFrame(rows, crs=config.WEB_CRS).to_crs(config.WORK_CRS)
    snap = snapshot_time(data.get("title", ""))
    meta = {
        "titolo": data.get("title"),
        "descrizione": data.get("description"),
        "snapshot": snap.isoformat() if snap else None,
        "zone_totali": len(data["features"]),
    }
    return gdf, meta


def drop_expired(zones: gpd.GeoDataFrame, at: datetime) -> gpd.GeoDataFrame:
    """Scarta le zone temporanee già scadute alla data dello snapshot."""
    at_utc = at.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    expired = (~zones.permanente) & (zones.fine.fillna("9999") < at_utc)
    return zones[~expired].copy()
