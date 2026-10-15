"""Ispezione dei dati grezzi in data/raw/ (fase 0).

Uso:  .venv\\Scripts\\python pipeline\\inspect_raw.py

Stampa un report su:
- ogni shapefile (.shp): CRS, numero feature, tipi geometria, bbox, tutti i campi
  con tipo, % di valori nulli, numero di valori distinti ed esempi;
- ogni JSON (.json/.geojson): struttura ad albero dei percorsi delle chiavi con
  conteggi, e se riconosce il formato ED-269 un riepilogo di tipi zona,
  restrizioni, limiti verticali, validità e contatti dell'ente.
"""

from __future__ import annotations

import gzip
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
MAX_EXAMPLES = 8


def section(title: str) -> None:
    print("\n" + "=" * 78 + f"\n{title}\n" + "=" * 78)


# --------------------------------------------------------------------------- SHP

def inspect_shapefile(path: Path) -> None:
    section(f"SHAPEFILE {path.relative_to(RAW)}")
    gdf = gpd.read_file(path)
    print(f"CRS: {gdf.crs}  (EPSG: {gdf.crs.to_epsg() if gdf.crs else None})")
    print(f"Feature: {len(gdf)}")
    print(f"Tipi geometria: {dict(Counter(gdf.geom_type.fillna('None')))}")
    print(f"Geometrie vuote/nulle: {int(gdf.geometry.is_empty.sum() + gdf.geometry.isna().sum())}")
    print(f"Geometrie non valide: {int((~gdf.geometry.is_valid).sum())}")
    print(f"BBox: {tuple(round(v, 2) for v in gdf.total_bounds)}")
    if gdf.crs and gdf.crs.is_projected:
        print(f"Lunghezza totale: {gdf.geometry.length.sum() / 1000:.1f} km")
    print(f"Ha coordinate Z: {bool(gdf.geometry.has_z.any())}")

    print("\nCampi:")
    for col in gdf.columns:
        if col == "geometry":
            continue
        s = gdf[col]
        nulls = s.isna().sum() + (s.astype(str).str.strip() == "").sum()
        uniq = s.dropna().unique()
        print(f"\n  - {col}  [{s.dtype}]  nulli/vuoti: {nulls / len(s):.0%}  distinti: {len(uniq)}")
        if len(uniq) <= 25:
            counts = s.value_counts(dropna=False).head(25)
            for v, n in counts.items():
                print(f"      {v!r}: {n}")
        else:
            print(f"      esempi: {[v for v in uniq[:MAX_EXAMPLES]]}")
            if s.dtype.kind in "if":
                print(f"      min {s.min()}  max {s.max()}  media {s.mean():.2f}")

    # Altri file collegati (.prj, .cpg, .dbf ...)
    sidecars = sorted(p.suffix for p in path.parent.glob(path.stem + ".*"))
    print(f"\nFile accessori: {sidecars}")


# -------------------------------------------------------------------------- JSON

def walk(obj, path: str, paths: Counter, examples: dict) -> None:
    """Conta ogni percorso di chiave (liste indicate con [])."""
    paths[path] += 1
    if isinstance(obj, dict):
        for k, v in obj.items():
            walk(v, f"{path}.{k}", paths, examples)
    elif isinstance(obj, list):
        for v in obj:
            walk(v, f"{path}[]", paths, examples)
    else:
        ex = examples[path]
        if len(ex) < MAX_EXAMPLES and obj not in ex:
            ex.append(obj)


def inspect_json(path: Path) -> None:
    section(f"JSON {path.relative_to(RAW)}  ({path.stat().st_size / 1e6:.1f} MB)")
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8-sig") as f:
        data = json.load(f)

    paths: Counter = Counter()
    examples: dict = defaultdict(list)
    walk(data, "$", paths, examples)
    print("Struttura (percorso: occorrenze | esempi foglia):")
    for p, n in paths.items():
        ex = examples.get(p)
        ex_s = ""
        if ex:
            ex_s = " | " + ", ".join(repr(e)[:60] for e in ex)
        print(f"  {p}: {n}{ex_s[:300]}")

    features = data.get("features") if isinstance(data, dict) else data
    if isinstance(features, list) and features and isinstance(features[0], dict):
        summarize_zones(features)


def summarize_zones(features: list[dict]) -> None:
    """Riepilogo ED-269 (tollerante a varianti di nomi)."""
    section("RIEPILOGO ZONE (ED-269)")
    print(f"Zone: {len(features)}")
    first = features[0]
    print(f"Chiavi del primo elemento: {list(first.keys())}")

    def counter(key):
        return Counter(json.dumps(f.get(key), ensure_ascii=False)[:80] for f in features)

    for key in ("type", "restriction", "reason", "uSpaceClass", "country", "regulationExemption"):
        if any(key in f for f in features):
            print(f"\n{key}: {dict(counter(key).most_common(20))}")

    geom_types, vrefs, uoms, limits = Counter(), Counter(), Counter(), Counter()
    n_geoms = Counter()
    for f in features:
        geoms = f.get("geometry") or []
        if isinstance(geoms, dict):
            geoms = [geoms]
        n_geoms[len(geoms)] += 1
        for g in geoms:
            hp = g.get("horizontalProjection", g)
            geom_types[hp.get("type")] += 1
            vrefs[(g.get("lowerVerticalReference"), g.get("upperVerticalReference"))] += 1
            uoms[g.get("uomDimensions")] += 1
            limits[(g.get("lowerLimit"), g.get("upperLimit"))] += 1
    print(f"\nGeometrie per zona: {dict(n_geoms)}")
    print(f"Tipi proiezione orizzontale: {dict(geom_types)}")
    print(f"Riferimenti verticali (lower, upper): {dict(vrefs)}")
    print(f"Unità: {dict(uoms)}")
    print(f"Limiti (lower, upper) più comuni: {limits.most_common(20)}")

    perm, sched, dated = 0, 0, 0
    for f in features:
        for a in f.get("applicability") or []:
            perm += a.get("permanent") in ("YES", True)
            sched += bool(a.get("schedule"))
            dated += bool(a.get("startDateTime") or a.get("endDateTime"))
    print(f"\nApplicability: permanent={perm} con schedule={sched} con date={dated}")

    auth_keys, auth_names = Counter(), Counter()
    for f in features:
        for a in f.get("zoneAuthority") or []:
            auth_keys.update(k for k, v in a.items() if v not in (None, "", []))
            auth_names[a.get("name")] += 1
    print(f"\nzoneAuthority campi valorizzati: {dict(auth_keys)}")
    print(f"Enti (top 20): {auth_names.most_common(20)}")


def main() -> int:
    if not RAW.exists() or not any(RAW.rglob("*")):
        print(f"Nessun file in {RAW}")
        return 1
    shps = [*RAW.rglob("*.shp"), *RAW.rglob("*.shp.zip")]
    for p in sorted(shps):
        inspect_shapefile(p)
    jsons = [*RAW.rglob("*.json"), *RAW.rglob("*.json.gz"), *RAW.rglob("*.geojson")]
    for p in sorted(jsons):
        inspect_json(p)
    skip = {".shx", ".dbf", ".prj", ".cpg", ".qmd", ".sbn", ".sbx", ".xml", ".gitkeep"}
    others = [p for p in RAW.rglob("*") if p.is_file() and p not in shps + jsons
              and p.suffix.lower() not in skip]
    if others:
        section("ALTRI FILE (non ispezionati)")
        for p in others:
            print(f"  {p.relative_to(RAW)}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
