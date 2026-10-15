"""Chiusure dei sentieri da data/closures.yaml (gestito a mano).

Valida il file e produce, per ogni sentiero, la lista delle sue chiusure in un formato
semplice per l'app: stagionali con "MM-GG", puntuali con "AAAA-MM-GG".
Gli errori (sentiero inesistente, date non valide) fermano la build con un messaggio chiaro.
"""

from __future__ import annotations

import re
from datetime import date

import yaml

from . import config

PATH = config.ROOT / "data" / "closures.yaml"

MESI = {
    "gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6,
    "luglio": 7, "agosto": 8, "settembre": 9, "ottobre": 10, "novembre": 11, "dicembre": 12,
}
GIORNI_MESE = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


class ClosureError(ValueError):
    pass


def _month_day(value, where: str) -> str:
    """'1 novembre' / '11-01' → '11-01'."""
    s = str(value).strip().lower()
    m = re.fullmatch(r"(\d{1,2})\s+([a-z]+)", s)
    if m and m.group(2) in MESI:
        day, month = int(m.group(1)), MESI[m.group(2)]
    elif re.fullmatch(r"\d{1,2}-\d{1,2}", s):
        month, day = map(int, s.split("-"))
    else:
        raise ClosureError(f"{where}: data stagionale '{value}' non valida (usa es. '1 novembre' o '11-01')")
    if not (1 <= month <= 12 and 1 <= day <= GIORNI_MESE[month - 1]):
        raise ClosureError(f"{where}: data stagionale '{value}' inesistente")
    return f"{month:02d}-{day:02d}"


def _full_date(value, where: str) -> str:
    if isinstance(value, date):
        return value.isoformat()
    try:
        return date.fromisoformat(str(value).strip()).isoformat()
    except ValueError as e:
        raise ClosureError(f"{where}: data '{value}' non valida (usa AAAA-MM-GG)") from e


def load(trail_ids: list[str], numeri: dict[str, str]) -> dict[str, list[dict]]:
    """{id_sentiero: [chiusure]}. `numeri` mappa id → numero SAT (per le varianti)."""
    if not PATH.exists():
        return {}
    data = yaml.safe_load(PATH.read_text(encoding="utf-8")) or {}
    voci = data.get("chiusure") or []
    # Confronto senza distinguere maiuscole: "e310" = "E310", "E396-B" = "E396-b".
    by_id = {tid.lower(): tid for tid in trail_ids}
    by_numero: dict[str, list[str]] = {}
    for tid in trail_ids:
        by_numero.setdefault(numeri[tid].lower(), []).append(tid)

    out: dict[str, list[dict]] = {}
    for i, v in enumerate(voci, start=1):
        where = f"closures.yaml, voce {i}"
        if not isinstance(v, dict):
            raise ClosureError(f"{where}: formato non valido")
        sentieri = v.get("sentieri")
        if isinstance(sentieri, str):
            sentieri = [sentieri]
        if not sentieri:
            raise ClosureError(f"{where}: manca 'sentieri'")
        tipo = str(v.get("tipo", "")).strip()
        if tipo == "stagionale":
            if v.get("dal") is None or v.get("al") is None:
                raise ClosureError(f"{where}: una chiusura stagionale vuole sia 'dal' che 'al'")
            dal, al = _month_day(v["dal"], where), _month_day(v["al"], where)
        elif tipo == "puntuale":
            if v.get("dal") is None:
                raise ClosureError(f"{where}: manca 'dal'")
            dal = _full_date(v["dal"], where)
            al = _full_date(v["al"], where) if v.get("al") is not None else None
            if al and al < dal:
                raise ClosureError(f"{where}: 'al' ({al}) è prima di 'dal' ({dal})")
        else:
            raise ClosureError(f"{where}: 'tipo' deve essere 'stagionale' o 'puntuale'")

        voce = {"tipo": tipo, "dal": dal, "al": al, "motivo": str(v.get("motivo") or "").strip() or None,
                "fonte": str(v.get("fonte") or "").strip() or None}
        for s in sentieri:
            key = str(s).strip().lower()
            # Prima il numero SAT (tutte le varianti), poi l'id esatto di una variante (E396-b).
            targets = by_numero.get(key) or ([by_id[key]] if key in by_id else None)
            if not targets:
                raise ClosureError(f"{where}: sentiero '{s}' non trovato nei dati SAT")
            for t in targets:
                out.setdefault(t, []).append(voce)
    return out
