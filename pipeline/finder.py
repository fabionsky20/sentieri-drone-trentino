"""Dati per la ricerca di percorsi combinati ("Trova percorsi") e per il filtro di pendenza.

Legge solo file già prodotti (data/processed/ + data/osm/parcheggi.json.gz), quindi gira anche
senza i dati grezzi:  .venv\\Scripts\\python -m pipeline.finder
La build completa (pipeline.build) lo richiama alla fine.

Scrive data/processed/finder.json (formato in docs/DATA.md §9):
- parcheggi  parcheggi pubblici OSM entro PARK_MAX_M da un sentiero, agganciati al punto più
             vicino della rete: [lon, lat, sentiero, m lungo il sentiero, distanza m, nome, tariffa]
- archi      per ogni arco di network.json (stesso ordine): [pendenza max %, quota min, quota max]
- sentieri   pendenza massima (%) di ogni sentiero, per il filtro "Pendenza max"

Pendenza: dal profilo altimetrico LiDAR (profiles.json), su finestre di ~SLOPE_WINDOW_M metri,
così i salti di un singolo campione non contano. Valore assoluto: conta anche in discesa.
"""

from __future__ import annotations

import gzip
import json
import math
import sys
from collections import defaultdict

from . import config

PARK_MAX_M = 400  # parcheggio al massimo a questa distanza (linea d'aria) dal sentiero
PARK_DEDUP_M = 120  # sullo stesso sentiero, parcheggi più vicini di così: si tiene il più vicino
SLOPE_WINDOW_M = 100
PRIVATE = {"no", "private", "customers", "permit", "delivery"}

R = 6_371_008.8


def _hav(a, b) -> float:
    r = math.pi / 180
    s = math.sin((b[1] - a[1]) * r / 2) ** 2 + math.cos(a[1] * r) * math.cos(b[1] * r) * math.sin((b[0] - a[0]) * r / 2) ** 2
    return 2 * R * math.asin(math.sqrt(s))


def trail_lines() -> dict[str, dict]:
    """Come web/src/trailgeom.ts: linea intera del sentiero, distanze cumulate, lunghezza pipeline."""
    fc = json.loads((config.PROCESSED / "segments.geojson").read_text(encoding="utf-8"))
    groups: dict[str, list] = defaultdict(list)
    for f in fc["features"]:
        groups[f["properties"]["sentiero_id"]].append(f)
    out = {}
    for tid, feats in groups.items():
        feats.sort(key=lambda f: int(f["properties"]["id"].split("#")[1]))
        coords: list = []
        length = 0.0
        for f in feats:
            g = f.get("geometry")
            if g and g["type"] == "LineString":
                c = g["coordinates"]
                coords.extend(c[1:] if coords else c)
            length += f["properties"]["lunghezza_m"]
        cum = [0.0]
        for i in range(1, len(coords)):
            cum.append(cum[-1] + _hav(coords[i - 1], coords[i]))
        out[tid] = {"coords": coords, "cum": cum, "length": length}
    return out


def _project(p, a, b, kx, ky):
    """Punto più vicino a p sul segmento a-b (coordinate locali in metri)."""
    ax, ay = a[0] * kx, a[1] * ky
    bx, by = b[0] * kx, b[1] * ky
    px, py = p[0] * kx, p[1] * ky
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy), t


def parkings(lines: dict[str, dict]) -> list[list]:
    src = json.loads(gzip.open(config.ROOT / "data" / "osm" / "parcheggi.json.gz").read())
    fields = src["campi"] if isinstance(src["campi"], list) else json.loads(src["campi"].replace("'", '"'))
    idx = {k: i for i, k in enumerate(fields)}
    lat0 = 46.2
    ky = math.pi / 180 * R
    kx = ky * math.cos(lat0 * math.pi / 180)
    cell = 0.01  # griglia ~1 km sui segmenti dei sentieri
    grid: dict[tuple[int, int], list] = defaultdict(list)
    for tid, ln in lines.items():
        c = ln["coords"]
        for i in range(1, len(c)):
            x0, x1 = sorted((c[i - 1][0], c[i][0]))
            y0, y1 = sorted((c[i - 1][1], c[i][1]))
            for gx in range(int(x0 // cell), int(x1 // cell) + 1):
                for gy in range(int(y0 // cell), int(y1 // cell) + 1):
                    grid[(gx, gy)].append((tid, i))
    best: dict[str, list] = defaultdict(list)
    for row in src["dati"]:
        acc = row[idx["access"]]
        if acc in PRIVATE:
            continue
        p = (row[idx["lon"]], row[idx["lat"]])
        gx, gy = int(p[0] // cell), int(p[1] // cell)
        top = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for tid, i in grid.get((gx + dx, gy + dy), ()):
                    c = lines[tid]["coords"]
                    d, t = _project(p, c[i - 1], c[i], kx, ky)
                    if d <= PARK_MAX_M and (top is None or d < top[0]):
                        top = (d, tid, i, t)
        if top is None:
            continue
        d, tid, i, t = top
        ln = lines[tid]
        total = ln["cum"][-1] or 1
        at = ln["cum"][i - 1] + t * (ln["cum"][i] - ln["cum"][i - 1])
        m = at / total * ln["length"]
        fee = row[idx["fee"]]
        tariffa = "gratuito" if fee in ("no", "free") else "a pagamento" if fee else None
        best[tid].append([round(p[0], 5), round(p[1], 5), tid, round(m, 1), round(d), row[idx["name"]], tariffa])
    out = []
    for tid, lst in best.items():
        kept: list = []
        for r in sorted(lst, key=lambda r: r[4]):
            if all(abs(r[3] - k[3]) > PARK_DEDUP_M for k in kept):
                kept.append(r)
        out.extend(kept)
    return out


def slopes() -> tuple[list, dict]:
    net = json.loads((config.PROCESSED / "network.json").read_text(encoding="utf-8"))
    prof = json.loads((config.PROCESSED / "profiles.json").read_text(encoding="utf-8"))

    def stats(tid: str, a: float, b: float):
        p = prof.get(tid)
        if not p or not p["q"]:
            return [None, None, None]
        q, passo = p["q"], p["passo"] or 1
        i0 = max(0, min(len(q) - 1, int(math.floor(a / passo))))
        i1 = max(0, min(len(q) - 1, int(math.ceil(b / passo))))
        part = q[i0:i1 + 1]
        k = max(1, round(SLOPE_WINDOW_M / passo))
        worst = 0.0
        if i1 - i0 >= k:
            for i in range(i0, i1 - k + 1):
                worst = max(worst, abs(q[i + k] - q[i]) / (k * passo) * 100)
        elif i1 > i0:
            worst = abs(q[i1] - q[i0]) / ((i1 - i0) * passo) * 100
        return [round(worst, 1), round(min(part)), round(max(part))]

    archi = [stats(tid, f, t) for _, _, tid, f, t, _, _ in net["archi"]]
    per_trail = {tid: stats(tid, 0, p["lung"])[0] for tid, p in prof.items()}
    return archi, per_trail


def build() -> dict:
    lines = trail_lines()
    archi, per_trail = slopes()
    return {
        "snapshot": json.loads((config.PROCESSED / "meta.json").read_text(encoding="utf-8")).get("snapshot"),
        "attribuzione_parcheggi": "© OpenStreetMap contributors (ODbL)",
        "parcheggi": parkings(lines),
        "archi": archi,
        "sentieri": per_trail,
    }


def write() -> int:
    data = build()
    path = config.PROCESSED / "finder.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
    return path.stat().st_size


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    size = write()
    d = json.loads((config.PROCESSED / "finder.json").read_text(encoding="utf-8"))
    print(f"finder.json: {len(d['parcheggi'])} parcheggi agganciati, {len(d['archi'])} archi, {size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
