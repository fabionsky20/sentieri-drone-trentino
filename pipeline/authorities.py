"""Scheletro di data/authorities.yaml: contatti degli enti per le zone sui sentieri.

D-Flight riporta 'N.A.' come contatto per tutte le zone che toccano i sentieri SAT,
quindi i contatti si compilano a mano. Il file non viene mai sovrascritto: a ogni build
si aggiungono solo le zone nuove, i valori già compilati restano.
"""

from __future__ import annotations

import yaml

from . import config

HEADER = """\
# Contatti degli enti per le zone D-Flight permanenti che toccano i sentieri SAT.
# D-Flight riporta "N.A." per tutte queste zone: i contatti vanno compilati a mano.
#
# Chiave = nome della zona D-Flight (le zone con più anelli, es. le elisuperfici,
# condividono lo stesso nome). `zone_id` e `descrizione` sono generati dalla pipeline;
# gli altri campi sono da compilare. Le zone temporanee (NOTAM) non sono incluse.
# La pipeline aggiunge le zone nuove senza toccare quelle già presenti.
# Commenti scritti a mano in questo file vengono persi: usa il campo `note`.

"""

EMPTY = {"ente": "", "email": "", "telefono": "", "sito": "", "note": ""}


def describe(zones) -> str:
    """Es. 'ATM09 · autorizzazione da 0 m / giallo fino a 25 m'."""
    parts = []
    for _, z in zones.drop_duplicates(["colore", "quota_max_m", "tipo_rosso"]).iterrows():
        if z.colore == "rosso":
            parts.append("vietato" if z.tipo_rosso == "vietato" else "autorizzazione da 0 m")
        else:
            parts.append(f"libero fino a {z.quota_max_m:.0f} m")
    return f"{zones.categoria.iloc[0]} · " + " / ".join(sorted(parts))


def update(zones_on_trails) -> tuple[int, int]:
    """Aggiorna lo scheletro. Ritorna (zone totali nel file, zone aggiunte)."""
    existing = {}
    if config.AUTHORITIES_YAML.exists():
        existing = (yaml.safe_load(config.AUTHORITIES_YAML.read_text(encoding="utf-8")) or {}).get("zone", {})

    perm = zones_on_trails[zones_on_trails.permanente]
    added = 0
    for nome, group in perm.groupby("nome", sort=True):
        entry = existing.get(nome)
        if entry is None:
            entry = dict(EMPTY)
            added += 1
        entry["zone_id"] = sorted(set(group.zona_id))
        entry["descrizione"] = describe(group)
        existing[nome] = {k: entry[k] for k in ["descrizione", "zone_id", *EMPTY, *entry] if k in entry}

    body = yaml.safe_dump({"zone": dict(sorted(existing.items()))}, allow_unicode=True,
                          sort_keys=False, width=120)
    config.AUTHORITIES_YAML.write_text(HEADER + body, encoding="utf-8")
    return len(existing), added
