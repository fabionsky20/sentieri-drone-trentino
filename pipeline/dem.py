"""Quote dal DEM: tile di elevazione Mapterhorn (codifica terrarium), cache in data/raw/dem/.

In Trentino Mapterhorn usa il LiDAR della Provincia (DTM, terreno nudo, 5 m, CC BY 2.5),
in Alto Adige il DTM provinciale 2,5 m; altrove Copernicus GLO-30. Si scaricano solo le
tile allo zoom DEM_ZOOM che toccano i sentieri, una volta sola.

Uso diretto (solo download della cache):  .venv\\Scripts\\python -m pipeline.dem
"""

from __future__ import annotations

import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer

from . import config

URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
USER_AGENT = "sentieri-drone-trentino/1.0 (https://github.com/fabionsky20/sentieri-drone-trentino)"
TILE = 512
CACHE = config.RAW / "dem"
ATTRIBUTION = "Quote: Mapterhorn (LiDAR Provincia Autonoma di Trento CC BY 2.5, DTM Provincia di Bolzano CC0, Copernicus GLO-30)"

_to_wgs84 = Transformer.from_crs(config.WORK_CRS, config.WEB_CRS, always_xy=True)


def _pixels(lon: np.ndarray, lat: np.ndarray, z: int) -> tuple[np.ndarray, np.ndarray]:
    """Coordinate pixel globali (Web Mercator) allo zoom z."""
    n = 2**z * TILE
    x = (lon + 180) / 360 * n
    lat_r = np.radians(lat)
    y = (1 - np.arcsinh(np.tan(lat_r)) / math.pi) / 2 * n
    return x, y


def _path(z: int, x: int, y: int) -> Path:
    return CACHE / str(z) / str(x) / f"{y}.webp"


def tiles_for(lines_work_crs, z: int = config.DEM_ZOOM, step_m: float = 50) -> set[tuple[int, int]]:
    """Tile che coprono le linee (campionate ogni step_m, con i vicini per l'interpolazione)."""
    out: set[tuple[int, int]] = set()
    for line in lines_work_crs:
        d = np.append(np.arange(0, line.length, step_m), line.length)
        pts = np.array([line.interpolate(v).coords[0] for v in d])
        lon, lat = _to_wgs84.transform(pts[:, 0], pts[:, 1])
        px, py = _pixels(np.asarray(lon), np.asarray(lat), z)
        for dx in (-1, 1):
            for dy in (-1, 1):
                tx = ((px + dx) // TILE).astype(int)
                ty = ((py + dy) // TILE).astype(int)
                out.update(zip(tx.tolist(), ty.tolist()))
    return out


def _download(z: int, x: int, y: int) -> str:
    path = _path(z, x, y)
    if path.exists():
        return "cache"
    path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": USER_AGENT})
    for wait in (0, 5, 20, 60):
        time.sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(r.read())
                tmp.replace(path)
                return "ok"
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "assente"
        except (urllib.error.URLError, TimeoutError):
            pass
    return "errore"


def fetch(tiles: set[tuple[int, int]], z: int = config.DEM_ZOOM) -> dict[str, int]:
    """Scarica le tile mancanti (4 in parallelo: rispettoso del servizio gratuito)."""
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda t: _download(z, *t), sorted(tiles)))
    return {k: results.count(k) for k in set(results)}


@lru_cache(maxsize=96)
def _tile(z: int, x: int, y: int) -> np.ndarray | None:
    path = _path(z, x, y)
    if not path.exists():
        return None
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def sample(lon: np.ndarray, lat: np.ndarray, z: int = config.DEM_ZOOM) -> np.ndarray:
    """Quota (m) nei punti dati, interpolazione bilineare. NaN dove manca la tile."""
    px, py = _pixels(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float), z)
    px, py = px - 0.5, py - 0.5  # il valore di un pixel sta al suo centro
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
    fx, fy = px - x0, py - y0

    def at(gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
        out = np.full(gx.shape, np.nan)
        tx, ty = gx // TILE, gy // TILE
        for key in set(zip(tx.tolist(), ty.tolist())):
            arr = _tile(z, *key)
            if arr is None:
                continue
            m = (tx == key[0]) & (ty == key[1])
            out[m] = arr[gy[m] - key[1] * TILE, gx[m] - key[0] * TILE]
        return out

    v00, v10 = at(x0, y0), at(x0 + 1, y0)
    v01, v11 = at(x0, y0 + 1), at(x0 + 1, y0 + 1)
    return (v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy)


def profile(line, step_m: float = config.PROFILE_STEP_M) -> tuple[np.ndarray, np.ndarray]:
    """Distanze (m) e quote (m) lungo una linea in WORK_CRS, ogni step_m."""
    d = np.append(np.arange(0, line.length, step_m), line.length)
    pts = np.array([line.interpolate(v).coords[0] for v in d])
    lon, lat = _to_wgs84.transform(pts[:, 0], pts[:, 1])
    return d, sample(np.asarray(lon), np.asarray(lat))


def gain_loss(elev: np.ndarray, threshold_m: float = config.GAIN_THRESHOLD_M) -> tuple[float, float]:
    """Dislivello positivo e negativo con isteresi: le oscillazioni sotto soglia (rumore del
    DEM, piccoli saliscendi) non vengono sommate. Metodo usato dai GPS da escursionismo."""
    e = elev[~np.isnan(elev)]
    if len(e) < 2:
        return 0.0, 0.0
    up = down = 0.0
    ref = e[0]
    for v in e[1:]:
        if v - ref >= threshold_m:
            up += v - ref
            ref = v
        elif ref - v >= threshold_m:
            down += ref - v
            ref = v
    return up, down


def smooth(elev: np.ndarray, window: int = 3) -> np.ndarray:
    """Media mobile corta: toglie il rumore pixel-a-pixel mantenendo la forma del profilo."""
    if len(elev) <= window:
        return elev
    k = np.ones(window) / window
    padded = np.pad(elev, window // 2, mode="edge")
    return np.convolve(padded, k, mode="valid")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    from . import sat
    trails, _ = sat.load(sat.find_source())
    tiles = tiles_for(trails.geometry)
    print(f"Tile DEM z{config.DEM_ZOOM} necessarie: {len(tiles)}")
    print(fetch(tiles))
    return 0


if __name__ == "__main__":
    sys.exit(main())
