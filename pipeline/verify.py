"""Verifica a campione dei risultati in data/processed/.

Uso:  .venv\\Scripts\\python -m pipeline.verify

Stampa i controlli su casi noti (da confrontare con la mappa D-Flight) e controlli
di coerenza automatici. Esce con codice 1 se un controllo automatico fallisce.
"""

from __future__ import annotations

import json
import sys

import geopandas as gpd
import pandas as pd

from . import config

FAILS: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(f"  [{'OK' if ok else 'ERRORE'}] {msg}")
    if not ok:
        FAILS.append(msg)


def label(s) -> str:
    if s.colore == "giallo":
        return f"giallo≤{s.quota_max_m:.0f}m"
    if s.colore == "rosso":
        return f"rosso({s.tipo_rosso})"
    return "verde"


def sequence(segs, trail_id: str) -> str:
    rows = segs[segs.sentiero_id == trail_id]
    rows = rows.assign(n=rows.id.str.split("#").str[1].astype(int)).sort_values("n")
    return " → ".join(f"{label(s)} {s.lunghezza_m / 1000:.2f}km" for s in rows.itertuples())


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    P = config.PROCESSED
    segs = gpd.read_file(P / "segments.geojson").to_crs(config.WORK_CRS)
    zones = gpd.read_file(P / "zones.geojson").to_crs(config.WORK_CRS)
    trails = pd.DataFrame(json.loads((P / "trails.json").read_text(encoding="utf-8")))
    meta = json.loads((P / "meta.json").read_text(encoding="utf-8"))
    print(f"Snapshot D-Flight: {meta['titolo']}\n")

    print("1. Sentieri duplicati")
    ids = trails.id.tolist()
    check(ids.count("E731") == 1, "E731 presente una sola volta")
    check({"E396", "E396-b"} <= set(ids), "E396 ed E396-b presenti come varianti")
    check(len(ids) == len(set(ids)), "id dei sentieri univoci")

    print("\n2. Coerenza lunghezze (tratti vs lunghezza planimetrica SAT)")
    seg_len = segs.groupby("sentiero_id").lunghezza_m.sum()
    ratio = seg_len / trails.set_index("id").lunghezza_m
    check(ratio.between(0.95, 1.05).mean() > 0.99,
          f"lunghezza entro ±5% per {ratio.between(0.95, 1.05).mean():.1%} dei sentieri")

    print("\n3. Elisuperficie Pozza di Fassa (verifica sul campo: 0 m al centro, anelli 25 m e 45 m, libero oltre ~3,5 km)")
    fassa = zones[zones.nome.str.contains("FASSA", case=False)]
    for nome, g in fassa.groupby("nome"):
        core = g[g.quota_min_m == 0].geometry.union_all()
        center = core.centroid
        print(f"  {nome}:")
        for lim, ring in g.groupby("quota_min_m"):
            geom = ring.geometry.union_all()
            r_out = center.hausdorff_distance(geom.exterior if hasattr(geom, "exterior") else geom)
            print(f"    anello da {lim:>2} m → {label(ring.iloc[0])}, raggio esterno ≈ {r_out / 1000:.2f} km")
        check(set(g.quota_min_m) == {0, 25, 45}, "tre anelli 0 / 25 / 45 m")
        crossing = segs[segs.zone.str.contains("|".join(g.zona_id))]
        for tid in sorted(crossing.sentiero_id.unique())[:3]:
            print(f"    {tid}: {sequence(segs, tid)}")

    print("\n4. Passo del Manghen (E310)")
    print(f"  {sequence(segs, 'E310')}")

    print("\n5. Parco Naturale Adamello Brenta (ATM09 da 0 m → rosso autorizzazione)")
    park = zones[zones.nome.str.contains("ADAMELLO BRENTA")]
    in_park = segs[segs.zone.str.contains("|".join(park.zona_id))]
    check((in_park.colore == "rosso").all() and (in_park.tipo_rosso == "autorizzazione").all(),
          f"{len(in_park)} tratti nel parco ({in_park.lunghezza_m.sum() / 1000:.0f} km), tutti rosso/autorizzazione")
    full = trails[(trails.km_rosso > 0) & (trails.km_verde == 0) & (trails.km_giallo == 0)
                  & trails.id.isin(in_park.sentiero_id)]
    print(f"  {len(full)} sentieri interamente nel parco, es.: "
          + ", ".join(f"{r.id} ({r.titolo})" for r in full.head(3).itertuples()))
    border = [t for t in in_park.sentiero_id.unique() if (segs[segs.sentiero_id == t].colore != "rosso").any()]
    if border:
        print(f"  sentiero a cavallo del confine: {border[0]}: {sequence(segs, border[0])}")

    print("\n6. Rosso 'vietato' (NFZ permanenti)")
    vietato = segs[segs.tipo_rosso == "vietato"]
    for s in vietato.itertuples():
        nomi = zones[zones.zona_id.isin(s.zone.split(","))].nome.unique()
        print(f"  {s.id}: {s.lunghezza_m:.0f} m in {', '.join(nomi)}")
    check(len(vietato) > 0, "almeno un tratto 'vietato' distinto da 'autorizzazione'")

    print("\n7. Zone temporanee (NOTAM) sui sentieri — colore fisso invariato, applicate dall'app per data")
    temp = segs[segs.zone_temporanee != ""]
    for zid, g in temp.assign(z=temp.zone_temporanee.str.split(",")).explode("z").groupby("z"):
        z = zones[zones.zona_id == zid].iloc[0]
        print(f"  {z.nome}: {z.inizio} → {z.fine}, 0–{z.quota_sup_m:.0f} m, "
              f"{len(g)} tratti su {g.sentiero_id.nunique()} sentieri ({g.lunghezza_m.sum() / 1000:.1f} km)")

    print("\n8. Sovrapposizioni: vince la zona più restrittiva")
    zinfo = zones.drop_duplicates("zona_id").set_index("zona_id")
    bad = 0
    mixed = 0
    for s in segs[segs.zone.str.contains(",")].itertuples():
        z = zinfo.loc[s.zone.split(",")]
        if (z.colore == "rosso").any():
            ok = s.colore == "rosso"
        else:
            ok = s.colore == "giallo" and s.quota_max_m == z.quota_max_m.min()
        mixed += z.colore.nunique() > 1 or z.quota_max_m.nunique() > 1
        bad += not ok
    check(bad == 0, f"{mixed} tratti coperti da zone di livello diverso, tutti col colore più restrittivo")

    print("\n9. Quote dal DEM (confronto con le quote dichiarate dalla SAT)")
    t = trails.set_index("id")
    has = t.quota_max_dem.notna()
    err_max = (t.quota_max_dem - t.quota_max)[has]
    err_min = (t.quota_min_dem - t.quota_min)[has]
    check(has.mean() > 0.99, f"profilo calcolato per {has.mean():.1%} dei sentieri")
    check(err_max.abs().median() < 10 and err_min.abs().median() < 10,
          f"scarto mediano quota max {err_max.abs().median():.0f} m, quota min {err_min.abs().median():.0f} m")
    for tid in ("E101", "E542"):
        r = t.loc[tid]
        up_expected = r.quota_fine - r.quota_inizio
        check(abs(r.dislivello_pos - up_expected) < 0.1 * up_expected + 20,
              f"{tid}: D+ {r.dislivello_pos:.0f} m (salita da {r.quota_inizio} a {r.quota_fine} m)")

    print("\n10. POI vicini ai sentieri")
    pois = gpd.read_file(P / "pois.geojson")
    print(f"  {len(pois)} POI: {pois.categoria.value_counts().to_dict()}")
    names = dict(zip(pois.id, pois.nome))
    e310 = [names[p["id"]] for p in t.loc["E310"].poi]
    check("Passo Manghen" in e310, f"E310 passa dal Passo Manghen (POI: {', '.join(e310[:5])}…)")
    check(trails.badge.map(len).gt(0).mean() > 0.5,
          f"{trails.badge.map(len).gt(0).mean():.0%} dei sentieri ha almeno un badge")

    print("\n11. Totali")
    for c, km in meta["km_per_colore"].items():
        print(f"  {c:7s} {km:7.1f} km")

    print(f"\n{'Tutti i controlli superati' if not FAILS else f'{len(FAILS)} controlli FALLITI'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
