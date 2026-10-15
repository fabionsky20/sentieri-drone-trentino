"""Taglio dei sentieri in tratti omogenei rispetto alle zone D-Flight.

Per ogni sentiero:
1. si trovano i punti in cui la linea attraversa il bordo di una zona (anche più volte,
   anche su sentieri ad anello o andata-ritorno sovrapposti);
2. si taglia la linea in quei punti;
3. ogni pezzo eredita l'insieme delle zone che contengono il suo punto medio;
4. pezzi consecutivi con lo stesso insieme di zone vengono riuniti.

Le zone permanenti determinano il colore "fisso"; le temporanee (NOTAM) vengono solo
elencate, così l'app può applicarle in base alla data scelta.
"""

from __future__ import annotations

import numpy as np
import shapely
from shapely.geometry import LineString
from shapely.ops import substring

from . import config, dflight


def _cut_distances(line: LineString, boundary) -> list[float]:
    """Distanze lungo `line` dei punti in cui incrocia `boundary`."""
    coords = shapely.get_coordinates(line)
    segs = shapely.linestrings(np.stack([coords[:-1], coords[1:]], axis=1))
    seg_len = shapely.length(segs)
    offsets = np.concatenate([[0.0], np.cumsum(seg_len)[:-1]])

    shapely.prepare(boundary)
    hit = np.flatnonzero(shapely.intersects(segs, boundary))
    cuts = {0.0, line.length}
    for i in hit:
        pts = shapely.get_coordinates(shapely.intersection(segs[i], boundary))
        if len(pts):
            start = coords[i]
            d = np.hypot(pts[:, 0] - start[0], pts[:, 1] - start[1])
            cuts.update((offsets[i] + np.clip(d, 0, seg_len[i])).tolist())
    return sorted(cuts)


def split_trail(line: LineString, zones) -> list[tuple[LineString, frozenset[int]]]:
    """Ritorna [(pezzo, indici_zone_che_lo_coprono)] in ordine lungo il sentiero."""
    if len(zones) == 0:
        return [(line, frozenset())]

    geoms = list(zones.geometry)
    for g in geoms:
        shapely.prepare(g)
    boundary = shapely.union_all([g.boundary for g in geoms])
    cuts = _cut_distances(line, boundary)

    # Frammenti sotto MIN_PIECE_M (artefatti numerici) vengono accorpati al pezzo dopo.
    starts = [a for a, b in zip(cuts[:-1], cuts[1:]) if b - a >= config.MIN_PIECE_M] or [0.0]
    starts[0] = 0.0
    bounds = zip(starts, [*starts[1:], line.length])

    pieces: list[tuple[float, float, frozenset[int]]] = []
    for a, b in bounds:
        mid = line.interpolate((a + b) / 2)
        # covers: un pezzo che corre esattamente sul bordo conta come dentro (prudenza)
        inside = frozenset(int(i) for i, g in zip(zones.index, geoms) if g.covers(mid))
        if pieces and pieces[-1][2] == inside:
            pieces[-1] = (pieces[-1][0], b, inside)
        else:
            pieces.append((a, b, inside))

    return [(substring(line, a, b), ids) for a, b, ids in pieces]


def build(trails, zones) -> list[dict]:
    """Tutti i tratti di tutti i sentieri, con colore e zone.

    `trails` e `zones` in WORK_CRS; `zones` ha una riga per parte geometrica.
    """
    tree = shapely.STRtree(zones.geometry.values)
    out = []
    for _, t in trails.iterrows():
        idx = tree.query(t.geometry, predicate="intersects")
        local = zones.iloc[idx]
        for n, (geom, ids) in enumerate(split_trail(t.geometry, local)):
            covering = zones.loc[sorted(ids)]
            perm = covering[covering.permanente]
            temp = covering[~covering.permanente]
            colore, tipo_rosso, quota_max = dflight.combine(perm.to_dict("records"))
            out.append({
                "id": f"{t.id}#{n}",
                "sentiero_id": t.id,
                "numero": t.numero,
                "colore": colore,
                "tipo_rosso": tipo_rosso,
                "quota_max_m": quota_max,
                "zone": ",".join(sorted(set(perm.zona_id))),
                "zone_temporanee": ",".join(sorted(set(temp.zona_id))),
                "lunghezza_m": round(geom.length, 1),
                "geometry": geom,
            })
    return out
