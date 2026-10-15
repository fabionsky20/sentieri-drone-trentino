"""Comando unico della pipeline.

Uso (dalla cartella del progetto):
    .venv\\Scripts\\python -m pipeline.build

Legge i file più recenti in data/raw/ e scrive in data/processed/:
- segments.geojson   tratti di sentiero colorati (regola dei tre colori)
- zones.geojson      zone D-Flight dell'area, con tutti i campi utili all'app
- trails.json        attributi dei sentieri + km per colore + bbox (senza geometria)
- meta.json          data dello snapshot D-Flight, fonti, statistiche
e aggiorna lo scheletro di data/authorities.yaml.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime

import geopandas as gpd
import shapely
from shapely.geometry import box

from . import authorities, config, dflight, sat, segments


def write_geojson(gdf: gpd.GeoDataFrame, name: str, tolerance: float) -> int:
    """GeoJSON compatto, una feature per riga (diff leggibili su git)."""
    gdf = gdf.copy()
    gdf["geometry"] = gdf.geometry.simplify(tolerance, preserve_topology=True)
    gdf = gdf.to_crs(config.WEB_CRS)
    gdf["geometry"] = shapely.set_precision(gdf.geometry.values, 10 ** -config.COORD_PRECISION)
    fc = json.loads(gdf.to_json(na="null", drop_id=True))
    lines = [json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in fc["features"]]
    path = config.PROCESSED / name
    path.write_text('{"type":"FeatureCollection","features":[\n' + ",\n".join(lines) + "\n]}\n",
                    encoding="utf-8", newline="\n")
    return path.stat().st_size


def write_json(obj, name: str) -> int:
    path = config.PROCESSED / name
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
    return path.stat().st_size


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    config.PROCESSED.mkdir(parents=True, exist_ok=True)

    sat_path = sat.find_source()
    trails, sat_log = sat.load(sat_path)
    print(f"Sentieri: {sat_path.name} → {len(trails)} sentieri")
    for line in sat_log:
        print(f"  - {line}")

    zones_path = dflight.find_source()
    zones, meta = dflight.load(zones_path)
    print(f"D-Flight: {zones_path.name} → {meta['titolo']}")

    area = box(*trails.total_bounds).buffer(config.ZONES_MARGIN_M)
    zones = zones[zones.intersects(area)]
    if meta["snapshot"]:
        zones = dflight.drop_expired(zones, datetime.fromisoformat(meta["snapshot"]))
    zones = zones.reset_index(drop=True)
    print(f"  zone nell'area: {zones.zona_id.nunique()} ({len(zones)} poligoni)")

    segs = gpd.GeoDataFrame(segments.build(trails, zones), crs=config.WORK_CRS)
    print(f"Tratti: {len(segs)}")

    # Controllo: la somma dei tratti deve ridare la lunghezza dei sentieri.
    diff = abs(segs.length.sum() - trails.length.sum())
    assert diff < 1.0, f"lunghezza tratti ≠ sentieri (scarto {diff:.1f} m)"

    # Riepilogo per sentiero.
    km = defaultdict(lambda: defaultdict(float))
    temp = defaultdict(set)
    for s in segs.itertuples():
        km[s.sentiero_id][s.colore] += s.lunghezza_m / 1000
        temp[s.sentiero_id].update(filter(None, s.zone_temporanee.split(",")))
    bounds = trails.to_crs(config.WEB_CRS).bounds.round(5)
    trail_rows = []
    for i, t in trails.iterrows():
        row = sat.summary(t)
        row["km_verde"] = round(km[t.id]["verde"], 2)
        row["km_giallo"] = round(km[t.id]["giallo"], 2)
        row["km_rosso"] = round(km[t.id]["rosso"], 2)
        row["zone_temporanee"] = sorted(temp[t.id])
        row["bbox"] = bounds.loc[i].tolist()
        trail_rows.append(row)

    used_ids = set(",".join(segs.zone + "," + segs.zone_temporanee).split(",")) - {""}
    zones["sui_sentieri"] = zones.zona_id.isin(used_ids)

    sizes = {
        "segments.geojson": write_geojson(segs, "segments.geojson", config.SIMPLIFY_TRAILS_M),
        "zones.geojson": write_geojson(zones, "zones.geojson", config.SIMPLIFY_ZONES_M),
        "trails.json": write_json(trail_rows, "trails.json"),
    }

    totals = segs.groupby("colore").lunghezza_m.sum().div(1000).round(1).to_dict()
    meta.update({
        "fonti": {"sentieri": sat_path.name, "zone": zones_path.name},
        "sentieri": len(trails),
        "tratti": len(segs),
        "zone_area": int(zones.zona_id.nunique()),
        "zone_sui_sentieri": len({z for z in used_ids}),
        "km_per_colore": totals,
    })
    sizes["meta.json"] = write_json(meta, "meta.json")

    n_total, n_added = authorities.update(zones[zones.sui_sentieri])
    print(f"authorities.yaml: {n_total} zone ({n_added} aggiunte)")

    print("\nKm per colore (zone permanenti):")
    tot = sum(totals.values())
    for c in ("verde", "giallo", "rosso"):
        print(f"  {c:7s} {totals.get(c, 0):7.1f} km  {totals.get(c, 0) / tot:5.1%}")
    print("\nFile in data/processed/:")
    for name, size in sizes.items():
        print(f"  {name:18s} {size / 1e6:6.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
