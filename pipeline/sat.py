"""Caricamento e pulizia dei sentieri SAT."""

from __future__ import annotations

import string
from pathlib import Path

import geopandas as gpd
import pandas as pd

from . import config


def find_source() -> Path:
    """Shapefile SAT più recente: lo zip scaricato o un .shp già estratto."""
    candidates = [*config.RAW.glob("*.shp.zip"), *config.RAW.rglob("*.shp")]
    if not candidates:
        raise FileNotFoundError(f"Nessuno shapefile SAT in {config.RAW}")
    return max(candidates, key=lambda p: (p.stat().st_mtime, p.suffix == ".zip"))


def load(path: Path) -> tuple[gpd.GeoDataFrame, list[str]]:
    """Ritorna i sentieri in WORK_CRS con un `id` univoco e il log delle correzioni.

    Duplicati di `numero`:
    - copie identiche (geometria e attributi) → si tiene la prima;
    - tracciati diversi con lo stesso numero → varianti `E396`, `E396-b`, `E396-c`, ...
    """
    gdf = gpd.read_file(path).to_crs(config.WORK_CRS)
    log: list[str] = []
    attrs = [c for c in gdf.columns if c != "geometry"]

    keep = []
    ids = []
    for numero, group in gdf.groupby("numero", sort=False):
        kept: list[int] = []
        for idx, row in group.iterrows():
            twin = next((k for k in kept
                         if gdf.geometry[k].equals(row.geometry)
                         and gdf.loc[k, attrs].equals(row[attrs])), None)
            if twin is not None:
                log.append(f"{numero}: copia identica scartata")
                continue
            kept.append(idx)
        if len(kept) > 1:
            log.append(f"{numero}: {len(kept)} tracciati diversi → varianti "
                       + ", ".join(_variant_id(numero, i) for i in range(len(kept))))
        for i, idx in enumerate(kept):
            keep.append(idx)
            ids.append(_variant_id(numero, i))

    out = gdf.loc[keep].copy()
    out.insert(0, "id", ids)
    out = out.sort_index().reset_index(drop=True)
    return out, log


def _variant_id(numero: str, i: int) -> str:
    return numero if i == 0 else f"{numero}-{string.ascii_lowercase[i]}"


def _clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v.item() if hasattr(v, "item") else v


def summary(row) -> dict:
    """Attributi del sentiero per l'app (senza geometria)."""
    name = _clean(row.denominaz)
    return {
        "id": row.id,
        "numero": row.numero,
        "nome": name,
        "titolo": name or f"{row.loc_inizio} → {row.loc_fine}",
        "difficolta": _clean(row.difficolta),
        "loc_inizio": _clean(row.loc_inizio),
        "loc_fine": _clean(row.loc_fine),
        "quota_inizio": _clean(row.quota_iniz),
        "quota_fine": _clean(row.quota_fine),
        "quota_min": _clean(row.quota_min),
        "quota_max": _clean(row.quota_max),
        "lunghezza_m": _clean(row.lun_planim),
        "lunghezza_inclinata_m": _clean(row.lun_inclin),
        "tempo_andata": _clean(row.t_andata),
        "tempo_ritorno": _clean(row.t_ritorno),
        "gruppo_montuoso": _clean(row.gr_mont),
        "comuni": [c.strip() for c in (row.comuni_toc or "").split(",") if c.strip()],
        "competenza": _clean(row.competenza),
    }
