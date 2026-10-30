"""Grafo della rete sentieristica SAT, per i percorsi personalizzati (calcolati nel browser).

Nodi: estremi dei sentieri, incroci, innesti "a T" (un estremo che tocca un altro sentiero a
metà) e inizio/fine dei tratti in comune tra due sentieri. I punti più vicini di
`config.RETE_TOLLERANZA_M` si uniscono in un nodo solo (gli estremi SAT spesso non coincidono
esattamente). Archi: il pezzo di un sentiero tra due nodi consecutivi.

La geometria degli archi NON è duplicata: ogni arco dice "sentiero E325 dal metro 1200 al 3450"
(metri lungo la linea SAT, la stessa scala di profiles.json e dei tratti), e la web app la
ritaglia dalle linee che ha già. File piccolo e sempre allineato ai sentieri.

Uscita: data/processed/network.json
  {"tolleranza_m": 15,
   "nodi":  [[lon, lat, componente], ...],
   "archi": [[nodo_a, nodo_b, sentiero_id, da_m, a_m, dislivello_pos, dislivello_neg], ...]}
"""

from __future__ import annotations

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from . import config, dem

_to_wgs = Transformer.from_crs(config.WORK_CRS, config.WEB_CRS, always_xy=True)


class _UF:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, a: int) -> int:
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def _points_of(geom) -> list[Point]:
    """Punti significativi di un'intersezione: punti, e capi dei tratti in comune."""
    out: list[Point] = []
    if geom.is_empty:
        return out
    if geom.geom_type == "Point":
        return [geom]
    if geom.geom_type == "LineString":
        return [Point(geom.coords[0]), Point(geom.coords[-1])]
    if hasattr(geom, "geoms"):
        for g in geom.geoms:
            out += _points_of(g)
    return out


def build(trails, tol: float = config.RETE_TOLLERANZA_M) -> dict:
    """trails: GeoDataFrame in WORK_CRS con `id` e geometria LineString."""
    lines: list[LineString] = list(trails.geometry)
    ids: list[str] = list(trails.id)
    tree = STRtree(lines)

    # 1. Punti candidati: (indice sentiero, posizione lungo la linea, punto)
    cand: list[tuple[int, float, Point]] = []
    for i, ln in enumerate(lines):
        a, b = Point(ln.coords[0]), Point(ln.coords[-1])
        cand += [(i, 0.0, a), (i, ln.length, b)]
        # innesti: i miei estremi su altri sentieri (anche a metà)
        for end in (a, b):
            for j in tree.query(end.buffer(tol)):
                j = int(j)
                if j != i and lines[j].distance(end) <= tol:
                    cand.append((j, lines[j].project(end), end))
        # incroci e tratti in comune con gli altri sentieri
        for j in tree.query(ln):
            j = int(j)
            if j <= i:
                continue
            inter = ln.intersection(lines[j])
            for p in _points_of(inter):
                cand.append((i, ln.project(p), p))
                cand.append((j, lines[j].project(p), p))

    # 2. Unione dei punti vicini (entro la tolleranza) in nodi
    pts = [c[2] for c in cand]
    ptree = STRtree(pts)
    uf = _UF(len(pts))
    for k, p in enumerate(pts):
        for m in ptree.query(p.buffer(tol)):
            m = int(m)
            if m > k and pts[m].distance(p) <= tol:
                uf.union(k, m)
    roots = sorted({uf.find(k) for k in range(len(pts))})
    node_of_root = {r: n for n, r in enumerate(roots)}
    members: dict[int, list[Point]] = {}
    for k in range(len(pts)):
        members.setdefault(node_of_root[uf.find(k)], []).append(pts[k])
    node_xy = [(float(np.mean([p.x for p in ps])), float(np.mean([p.y for p in ps]))) for n, ps in sorted(members.items())]

    # 3. Archi: nodi consecutivi lungo ogni sentiero
    per_trail: dict[int, list[tuple[float, int]]] = {}
    for k, (i, pos, _) in enumerate(cand):
        per_trail.setdefault(i, []).append((pos, node_of_root[uf.find(k)]))
    edges = []
    for i, items in per_trail.items():
        ln = lines[i]
        d, e = dem.profile(ln)
        e = dem.smooth(e) if not np.isnan(e).all() else e
        # stesso nodo più volte sullo stesso sentiero (punti uniti): si tiene la posizione media
        by_node: dict[int, list[float]] = {}
        for pos, node in items:
            by_node.setdefault(node, []).append(pos)
        seq = sorted((float(np.mean(v)), n) for n, v in by_node.items())
        for (p0, n0), (p1, n1) in zip(seq, seq[1:]):
            if p1 - p0 < 0.5 or n0 == n1:
                continue
            m = (d >= p0) & (d <= p1)
            seg = np.concatenate([[np.interp(p0, d, e)], e[m], [np.interp(p1, d, e)]]) if len(e) else np.array([])
            up, down = dem.gain_loss(seg) if len(seg) > 1 else (0.0, 0.0)
            edges.append([n0, n1, ids[i], round(p0, 1), round(p1, 1), int(round(up)), int(round(down))])

    # 4. Componenti connesse
    cuf = _UF(len(node_xy))
    for a, b, *_ in edges:
        cuf.union(a, b)
    comp_ids: dict[int, int] = {}
    comp = []
    for n in range(len(node_xy)):
        comp.append(comp_ids.setdefault(cuf.find(n), len(comp_ids)))
    lon, lat = _to_wgs.transform([x for x, _ in node_xy], [y for _, y in node_xy])
    nodes = [[round(a, config.COORD_PRECISION), round(b, config.COORD_PRECISION), c] for a, b, c in zip(lon, lat, comp)]
    return {"tolleranza_m": tol, "nodi": nodes, "archi": edges}


def summary(net: dict) -> str:
    from collections import Counter

    sizes = Counter(n[2] for n in net["nodi"])
    big = sizes.most_common(1)[0][1] if sizes else 0
    return f"{len(net['nodi'])} nodi, {len(net['archi'])} archi, {len(sizes)} componenti (la più grande: {big} nodi)"


# Per l'uso diretto: tolleranza diversa senza rifare tutta la build.
if __name__ == "__main__":
    import json
    import sys

    from . import sat

    trails, _ = sat.load(sat.find_source())
    net = build(trails, float(sys.argv[1]) if len(sys.argv) > 1 else config.RETE_TOLLERANZA_M)
    print(summary(net))
    (config.PROCESSED / "network.json").write_text(json.dumps(net, separators=(",", ":")), encoding="utf-8")
