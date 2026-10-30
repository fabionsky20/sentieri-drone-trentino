"""Accesso in auto ai sentieri: parcheggi e strade da OpenStreetMap (Overpass, solo in build).

Scarica UNA volta, per il riquadro del Trentino:
- tutti gli amenity=parking (nodi, way, relation → centroide) con i tag utili;
- le strade percorribili in auto (escluse track/path e quelle vietate o private).

Le risposte grezze restano in data/raw/osm/ (cache, non versionata). Nel repo finiscono due file
compatti e compressi in data/osm/ (con data e attribuzione), così la build si rifà senza
interrogare di nuovo Overpass. Da questi si calcola, per ENTRAMBE le estremità di ogni sentiero,
il punto dove arrivare in auto: il parcheggio più vicino entro ~1 km, altrimenti il punto più
vicino sulla strada percorribile.

Uso:  .venv\\Scripts\\python -m pipeline.access [--refresh]
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points
from shapely.strtree import STRtree

from . import config, dem

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "sentieri-drone-trentino/1.0 (accesso ai sentieri; https://github.com/fabionsky20/sentieri-drone-trentino)"
PAUSE_S = 10  # tra una richiesta e l'altra: una sola query alla volta
RETRY_WAIT_S = [30, 90, 240]  # attese crescenti dopo un errore o un 429
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"

RAW = config.RAW / "osm"
OUT_DIR = config.ROOT / "data" / "osm"
PARKING_FILE = OUT_DIR / "parcheggi.json.gz"
ROADS_FILE = OUT_DIR / "strade.json.gz"

PARKING_TAGS = ["name", "fee", "capacity", "surface", "access", "parking", "opening_hours", "maxstay"]
# Strade percorribili in auto (gli svincoli seguono la loro classe).
ROAD_CLASSES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street"
NO_CARS = "no|private|forestry|agricultural|destination"
# Service che non sono un punto di arrivo (vialetti privati, corsie dei parcheggi, accessi d'emergenza).
SERVICE_SKIP = "driveway|parking_aisle|drive-through|emergency_access"
# Da qui non si sceglie il punto "bordo strada": non ci si può fermare.
NO_STOP = {"motorway", "trunk", "motorway_link", "trunk_link"}
# Parcheggi non pubblici: non si propongono come arrivo.
PARKING_PRIVATE = {"no", "private", "customers", "permit", "delivery"}

PARKING_MAX_M = 1000  # parcheggi entro questa distanza in linea d'aria dalla partenza
ROAD_MAX_M = 3000  # oltre: "nessuna strada vicina", meglio di un punto in un'altra valle
ROAD_SIMPLIFY_M = 5

_to_work = Transformer.from_crs(config.WEB_CRS, config.WORK_CRS, always_xy=True)
_to_wgs = Transformer.from_crs(config.WORK_CRS, config.WEB_CRS, always_xy=True)


# ---------------------------------------------------------------- Overpass

class OverpassError(RuntimeError):
    pass


def _post(query: str) -> dict:
    """Una query, con nuovi tentativi. Un 'remark' di timeout/memoria con risposta vuota conta
    come errore (Overpass risponde 200 ma senza dati)."""
    data = urllib.parse.urlencode({"data": query}).encode()
    last: str = ""
    for attempt, wait in enumerate([0, *RETRY_WAIT_S]):
        if wait:
            print(f"    nuovo tentativo tra {wait} s ({last})")
            time.sleep(wait)
        req = urllib.request.Request(ENDPOINTS[attempt % len(ENDPOINTS)], data=data, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                out = json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}" + (" (troppe richieste)" if e.code == 429 else "")
            continue
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = str(e)
            continue
        remark = out.get("remark", "")
        if remark and ("timed out" in remark or "out of memory" in remark or "runtime error" in remark):
            last = f"remark: {remark[:80]}"
            # Riprovare uguale non serve: chi chiama dividerà il riquadro.
            raise OverpassError(last)
        return out
    raise OverpassError(f"Overpass non risponde: {last}")


def _bbox(b: tuple[float, float, float, float]) -> str:
    w, s, e, n = b
    return f"{s:.4f},{w:.4f},{n:.4f},{e:.4f}"


def _split(b):
    w, s, e, n = b
    mx, my = (w + e) / 2, (s + n) / 2
    return [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]


def _fetch_tiled(name: str, query_for, bounds, cols: int, rows: int, depth_max: int = 2) -> list[dict]:
    """Scarica a tasselli (una query alla volta); un tassello che va in timeout si divide in 4."""
    w, s, e, n = bounds
    dx, dy = (e - w) / cols, (n - s) / rows
    todo = [(w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy, 0) for j in range(rows) for i in range(cols)]
    elements: dict[tuple[str, int], dict] = {}
    k = 0
    while todo:
        *b, depth = todo.pop(0)
        if k:
            time.sleep(PAUSE_S)
        k += 1
        print(f"  Overpass {name}: tassello {k} ({_bbox(b)})…")
        try:
            out = _post(query_for(_bbox(b)))
        except OverpassError as err:
            if depth >= depth_max:
                raise
            print(f"    {err} → divido in 4")
            todo[0:0] = [(*q, depth + 1) for q in _split(tuple(b))]
            continue
        for el in out.get("elements", []):
            elements[(el["type"], el["id"])] = el  # gli elementi a cavallo dei tasselli una volta sola
        print(f"    {len(out.get('elements', []))} elementi")
    return list(elements.values())


def _parking_query(bbox: str) -> str:
    return f'[out:json][timeout:180];\nnwr["amenity"="parking"]({bbox});\nout center tags qt;'


def _roads_query(bbox: str) -> str:
    return (
        "[out:json][timeout:180];\n"
        f'way["highway"~"^({ROAD_CLASSES})$"]'
        f'["access"!~"^({NO_CARS})$"]["motor_vehicle"!~"^({NO_CARS})$"]["motorcar"!~"^({NO_CARS})$"]'
        f'["service"!~"^({SERVICE_SKIP})$"]({bbox});\n'
        "out tags geom qt;"
    )


def download(bounds, refresh: bool = False) -> None:
    """Scarica in data/raw/osm/ (se mancano o con refresh) e scrive i file compatti in data/osm/."""
    if not refresh and PARKING_FILE.exists() and ROADS_FILE.exists():
        return  # i file compatti nel repo bastano: niente richieste a Overpass
    RAW.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    p_raw, r_raw = RAW / "parcheggi.json", RAW / "strade.json"
    if refresh or not p_raw.exists():
        els = _fetch_tiled("parcheggi", _parking_query, bounds, 2, 2)
        p_raw.write_text(json.dumps({"_scaricato": now, "_bbox": _bbox(bounds), "elements": els}), encoding="utf-8")
    if refresh or not r_raw.exists():
        time.sleep(PAUSE_S)
        els = _fetch_tiled("strade", _roads_query, bounds, 3, 3)
        r_raw.write_text(json.dumps({"_scaricato": now, "_bbox": _bbox(bounds), "elements": els}), encoding="utf-8")
    write_compact()


# ---------------------------------------------------------------- file compatti (nel repo)

def _r(v: float) -> float:
    return round(v, config.COORD_PRECISION)


def write_compact() -> dict[str, int]:
    """data/osm/parcheggi.json.gz e strade.json.gz: righe compatte, data e attribuzione."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = json.loads((RAW / "parcheggi.json").read_text(encoding="utf-8"))
    rows = []
    for el in p["elements"]:
        c = el if el["type"] == "node" else el.get("center")
        if not c:
            continue
        tags = el.get("tags", {})
        rows.append([f"{el['type'][0]}{el['id']}", _r(c["lon"]), _r(c["lat"]), *[tags.get(k) for k in PARKING_TAGS]])
    parking = {"aggiornato": p["_scaricato"], "attribuzione": ATTRIBUTION, "fonte": "Overpass API",
               "campi": ["osm", "lon", "lat", *PARKING_TAGS], "dati": rows}

    r = json.loads((RAW / "strade.json").read_text(encoding="utf-8"))
    lines = []
    for el in r["elements"]:
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        xs, ys = _to_work.transform([g["lon"] for g in geom], [g["lat"] for g in geom])
        simple = LineString(list(zip(xs, ys))).simplify(ROAD_SIMPLIFY_M)
        lon, lat = _to_wgs.transform(*simple.xy)
        lines.append([el.get("tags", {}).get("highway"), [[_r(a), _r(b)] for a, b in zip(lon, lat)]])
    roads = {"aggiornato": r["_scaricato"], "attribuzione": ATTRIBUTION, "fonte": "Overpass API",
             "semplificazione_m": ROAD_SIMPLIFY_M, "campi": ["highway", "coordinate"], "dati": lines}

    sizes = {}
    for path, obj in ((PARKING_FILE, parking), (ROADS_FILE, roads)):
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        # mtime fisso: lo stesso contenuto dà lo stesso file (niente modifiche inutili nel repo)
        with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as f:
            f.write(raw)
        sizes[path.name] = path.stat().st_size
    print(f"  {len(rows)} parcheggi, {len(lines)} strade → " + ", ".join(f"{k} {v / 1e6:.1f} MB" for k, v in sizes.items()))
    return sizes


def load() -> tuple[dict, dict]:
    with gzip.open(PARKING_FILE, "rt", encoding="utf-8") as f:
        parking = json.load(f)
    with gzip.open(ROADS_FILE, "rt", encoding="utf-8") as f:
        roads = json.load(f)
    return parking, roads


# ---------------------------------------------------------------- punto di accesso per sentiero

def _endpoints(line) -> tuple[Point, Point]:
    """Prima e ultima coordinata del sentiero (WORK_CRS): partenza e arrivo come da SAT."""
    if line.geom_type == "MultiLineString":
        parts = list(line.geoms)
        return Point(parts[0].coords[0]), Point(parts[-1].coords[-1])
    return Point(line.coords[0]), Point(line.coords[-1])


def _fee(v: str | None) -> str:
    if v is None:
        return "sconosciuto"
    v = v.strip().lower()
    if v in ("no", "free", "0"):
        return "gratuito"
    if v in ("yes", "ticket", "donation", "interval"):
        return "a pagamento"
    return "a pagamento" if any(ch.isdigit() for ch in v) else "sconosciuto"


def _capacity(v: str | None) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def compute(trails) -> dict[str, dict]:
    """Per ogni sentiero: {"inizio": {...}, "fine": {...}} con il punto dove arrivare in auto."""
    parking, roads = load()
    f = {k: i for i, k in enumerate(parking["campi"])}
    pk = [row for row in parking["dati"] if (row[f["access"]] or "").lower() not in PARKING_PRIVATE]
    pxs, pys = _to_work.transform([row[f["lon"]] for row in pk], [row[f["lat"]] for row in pk])
    p_pts = [Point(x, y) for x, y in zip(pxs, pys)]
    p_tree = STRtree(p_pts)

    road_geoms = []
    for cls, coords in roads["dati"]:
        if cls in NO_STOP:
            continue
        xs, ys = _to_work.transform([c[0] for c in coords], [c[1] for c in coords])
        road_geoms.append(LineString(list(zip(xs, ys))))
    r_tree = STRtree(road_geoms)

    # Quote: tile DEM per partenze e destinazioni (stesse tile della pipeline).
    pending: list[tuple[str, str, Point, dict]] = []
    out: dict[str, dict] = {}
    for _, t in trails.iterrows():
        start, end = _endpoints(t.geometry)
        out[t.id] = {}
        for which, pt in (("inizio", start), ("fine", end)):
            i = p_tree.query_nearest(pt, max_distance=PARKING_MAX_M, return_distance=False)
            if len(i):
                j = int(i[0])
                row = pk[j]
                dest = p_pts[j]
                info = {
                    "tipo": "parcheggio",
                    "nome": row[f["name"]],
                    "tariffa": _fee(row[f["fee"]]),
                    "posti": _capacity(row[f["capacity"]]),
                    "fondo": row[f["surface"]],
                    "orari": row[f["opening_hours"]],
                    "sosta_max": row[f["maxstay"]],
                    "osm": row[f["osm"]],
                }
            else:
                k = r_tree.query_nearest(pt, max_distance=ROAD_MAX_M, return_distance=False)
                if not len(k):
                    out[t.id][which] = {"tipo": "nessuno"}
                    continue
                dest = nearest_points(road_geoms[int(k[0])], pt)[0]
                info = {"tipo": "strada"}
            pending.append((t.id, which, pt, info))
            info["_dest"] = dest
            info["distanza_m"] = int(round(dest.distance(pt)))
            out[t.id][which] = info

    pts = [p for _, _, p, info in pending] + [info["_dest"] for _, _, _, info in pending]
    lines = [LineString([p, p]) for p in pts]
    print(f"  tile DEM per gli accessi: {dem.fetch(dem.tiles_for(lines))}")
    xs, ys = _to_wgs.transform([p.x for p in pts], [p.y for p in pts])
    ele = dem.sample(np.asarray(xs), np.asarray(ys))
    n = len(pending)
    for i, (tid, which, _, info) in enumerate(pending):
        e_start, e_dest = ele[i], ele[n + i]
        lon, lat = xs[n + i], ys[n + i]
        info["lat"], info["lon"] = _r(lat), _r(lon)
        info["quota"] = None if math.isnan(e_dest) else int(round(e_dest))
        # Dislivello dal punto d'arrivo in auto alla partenza del sentiero (+ = si sale).
        info["dislivello_m"] = None if math.isnan(e_start) or math.isnan(e_dest) else int(round(e_start - e_dest))
        del info["_dest"]
        out[tid][which] = {k: v for k, v in info.items() if v is not None}
    return out


CELL_DEG = 0.1  # celle per il calcolo nel browser (percorsi personalizzati)


def write_cells(out_dir: Path) -> dict[str, int]:
    """data/processed/accesso/<x>_<y>.json (x = floor(lon/0,1), y = floor(lat/0,1)): parcheggi pubblici
    e strade dove fermarsi, stessi filtri di compute(). Il browser carica le 9 celle attorno alla partenza.
    Parcheggio: [lon, lat, nome, tariffa, posti, sosta_max]; strada: [[lon, lat], ...] (in ogni cella che tocca)."""
    parking, roads = load()
    f = {k: i for i, k in enumerate(parking["campi"])}
    cells: dict[tuple[int, int], dict] = {}
    cell = lambda x, y: cells.setdefault((x, y), {"p": [], "s": []})  # noqa: E731
    for row in parking["dati"]:
        if (row[f["access"]] or "").lower() in PARKING_PRIVATE:
            continue
        lon, lat = row[f["lon"]], row[f["lat"]]
        cell(math.floor(lon / CELL_DEG), math.floor(lat / CELL_DEG))["p"].append(
            [lon, lat, row[f["name"]], _fee(row[f["fee"]]), _capacity(row[f["capacity"]]), row[f["maxstay"]]])
    for cls, coords in roads["dati"]:
        if cls in NO_STOP:
            continue
        xs = [math.floor(c[0] / CELL_DEG) for c in coords]
        ys = [math.floor(c[1] / CELL_DEG) for c in coords]
        for x in range(min(xs), max(xs) + 1):
            for y in range(min(ys), max(ys) + 1):
                cell(x, y)["s"].append(coords)
    if out_dir.exists():
        for old in out_dir.glob("*.json"):
            old.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for (x, y), c in cells.items():
        path = out_dir / f"{x}_{y}.json"
        path.write_text(json.dumps(c, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
        total += path.stat().st_size
    return {"celle": len(cells), "byte": total}


def meta() -> dict:
    parking, roads = load()
    return {"aggiornato": parking["aggiornato"], "attribuzione": ATTRIBUTION,
            "parcheggi": len(parking["dati"]), "strade": len(roads["dati"])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="riscarica da Overpass anche se c'è la cache")
    args = ap.parse_args()
    # Riquadro dai sentieri già elaborati (stesso margine dei POI in build.py).
    rows = json.loads((config.PROCESSED / "trails.json").read_text(encoding="utf-8"))
    arr = np.array([r["bbox"] for r in rows])
    bounds = (arr[:, 0].min() - 0.04, arr[:, 1].min() - 0.03, arr[:, 2].max() + 0.04, arr[:, 3].max() + 0.03)
    download(tuple(float(v) for v in bounds), refresh=args.refresh)
    print(json.dumps(meta(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
