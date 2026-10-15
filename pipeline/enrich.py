"""Arricchimento dei sentieri: POI vicini (badge), dislivello e profilo, indice di ricerca."""

from __future__ import annotations

import re
import unicodedata

import numpy as np
import shapely
from shapely.ops import nearest_points

from . import config, dem

# ---------------------------------------------------------------- POI vicini


def nearby_pois(trails, pois) -> dict[str, list[dict]]:
    """Per ogni sentiero, i POI entro POI_DISTANCE_M (per categoria), in ordine lungo il percorso.

    La distanza è calcolata dalla forma del POI (es. riva del lago), non dal suo punto centrale.
    `km` è la posizione lungo il sentiero del punto più vicino al POI.
    """
    if len(pois) == 0:
        return {}
    shapes = list(pois.forma)
    tree = shapely.STRtree(shapes)
    max_d = max(config.POI_DISTANCE_M.values())
    out: dict[str, list[dict]] = {}
    for t in trails.itertuples():
        found = []
        for i in tree.query(t.geometry, predicate="dwithin", distance=max_d):
            p = pois.iloc[i]
            d = t.geometry.distance(shapes[i])
            if d > config.POI_DISTANCE_M.get(p.categoria, 150):
                continue
            on_line = nearest_points(t.geometry, shapes[i])[0]
            found.append({"id": p.id, "d": round(d), "km": round(t.geometry.project(on_line) / 1000, 2)})
        out[t.id] = sorted(found, key=lambda f: f["km"])
    return out


# ---------------------------------------------------------------- profili


def profiles(trails) -> tuple[dict[str, dict], dict[str, dict]]:
    """Dislivelli (per trails.json) e profili ridotti (per profiles.json), per sentiero."""
    stats: dict[str, dict] = {}
    profs: dict[str, dict] = {}
    for t in trails.itertuples():
        d, e = dem.profile(t.geometry)
        if np.isnan(e).all():
            continue
        e = dem.smooth(e)
        up, down = dem.gain_loss(e)
        stats[t.id] = {
            "dislivello_pos": round(up),
            "dislivello_neg": round(down),
            "quota_min_dem": round(float(np.nanmin(e))),
            "quota_max_dem": round(float(np.nanmax(e))),
        }
        # Profilo per la web app: al massimo PROFILE_MAX_POINTS punti a passo costante.
        step = max(config.PROFILE_STEP_M, t.geometry.length / (config.PROFILE_MAX_POINTS - 1))
        dd = np.append(np.arange(0, t.geometry.length, step), t.geometry.length)
        ee = np.interp(dd, d, np.nan_to_num(e, nan=float(np.nanmean(e))))
        profs[t.id] = {"passo": round(step, 1), "lung": round(t.geometry.length, 1), "q": [round(v) for v in ee]}
    return stats, profs


# ---------------------------------------------------------------- ricerca


def normalize(s: str) -> str:
    """Minuscolo, senza accenti né punteggiatura: 'Passo del MÀNGHEN' → 'passo del manghen'."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def search_index(trail_rows, pois_wgs, valleys_wgs, places_wgs) -> list[dict]:
    """Voci di ricerca: t=tipo, n=nome mostrato, k=chiave normalizzata, c=[lon,lat], id/b opzionali."""
    items: list[dict] = []
    for t in trail_rows:
        w, s, e, n = t["bbox"]
        name = f"{t['numero']} · {t['titolo']}"
        extra = " ".join(filter(None, [t.get("loc_inizio"), t.get("loc_fine"), t.get("gruppo_montuoso")]))
        items.append({"t": "sentiero", "n": name, "k": normalize(f"{t['numero']} {t['titolo']} {extra}"),
                      "id": t["id"], "c": [round((w + e) / 2, 5), round((s + n) / 2, 5)], "b": t["bbox"]})
    for p in pois_wgs.itertuples():
        items.append({"t": p.categoria, "n": p.nome, "k": normalize(p.nome), "id": p.id,
                      "c": [round(p.geometry.x, 5), round(p.geometry.y, 5)]})
    for v in valleys_wgs.itertuples():
        c = v.geometry.representative_point() if v.geometry.geom_type != "Point" else v.geometry
        items.append({"t": "valle", "n": v.nome, "k": normalize(v.nome), "c": [round(c.x, 5), round(c.y, 5)],
                      **({"b": [round(x, 5) for x in v.geometry.bounds]} if v.geometry.geom_type != "Point" else {})})
    for p in places_wgs.itertuples():
        items.append({"t": "paese", "n": p.nome, "k": normalize(p.nome), "c": [round(p.geometry.x, 5), round(p.geometry.y, 5)]})
    return items
