"""Avvisi di chiusura/riapertura dei sentieri da fonti pubbliche, per lo stato "aperto/chiuso".

Fonti (solo testo pubblico, nessun login):
- Ufficio stampa della Provincia autonoma di Trento: elenco dei comunicati, poi il testo di quelli
  che parlano di sentieri, ferrate, frane, chiusure e riaperture.
- Google News (RSS di ricerca): titoli delle notizie su sentieri chiusi/riaperti in Trentino.

Ogni avviso viene collegato ai sentieri:
- "forte": il testo cita il numero SAT (E546, O207, "sentiero 301", "SAT 215"…);
- "debole": il testo cita un luogo d'inizio/fine del sentiero abbastanza specifico (Gardeccia…).
Lo stato dell'avviso viene dal titolo (poi dal testo): riaperto / chiuso / info.

Gira nella GitHub Action ogni giorno, prima della build della web app (il sito della Provincia
non si può leggere dal browser). Usa solo la libreria standard. La cache in data/raw/avvisi/
(salvata tra un'esecuzione e l'altra dalla Action) tiene anche gli avvisi più vecchi della
finestra letta. Se una fonte non risponde, il file lo dice ("ok": false) e l'app lo mostra.

Uso:  python -m pipeline.avvisi [--pagine 40]
Scrive data/processed/avvisi.json (formato in docs/DATA.md §10).
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from . import config

BASE = "https://www.ufficiostampa.provincia.tn.it"
LIST_URL = BASE + "/Comunicati"
NEWS_QUERIES = [
    "sentiero chiuso Trentino",
    "sentiero interrotto Trentino",
    "sentiero riaperto Trentino",
    "frana sentiero Trentino",
    "ferrata chiusa Trentino",
    "divieto di transito sentiero Trentino",
]
USER_AGENT = "Quota120/1.0 (stato dei sentieri; https://github.com/fabionsky20/sentieri-drone-trentino)"
PAUSE_S = 1.0
KEEP_DAYS = 400  # avvisi più vecchi di così si scartano
CACHE = config.RAW / "avvisi" / "cache.json"
OUT = config.PROCESSED / "avvisi.json"

# Parole che rendono un comunicato interessante (titolo o anteprima).
TOPIC = re.compile(r"sentier|ferrat|tracciat|escursion|frana|crollo|smottament|percorribil|rifugi", re.I)
REOPEN = re.compile(r"riapert|ripristinat|riapre|riaprono|tornan[oa] percorribil|nuovamente percorribil|revocat[ao] l.ordinanza|revoca dell.ordinanza|di nuovo percorribil", re.I)
CLOSED = re.compile(r"chius[oaie]|chiusura|interrott|divieto di transito|vietat|inagibil|non percorribil|impercorribil|franat|crollo|frana\b", re.I)
MESI = {m: i + 1 for i, m in enumerate(["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"])}
DATE_RE = re.compile(r"(\d{1,2})\s+(" + "|".join(MESI) + r")\s+(\d{4})", re.I)
DATE_NUM = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")
# Parole generiche nei nomi dei luoghi: da sole non identificano un sentiero.
GENERIC = {
    "rifugio", "malga", "passo", "lago", "laghi", "monte", "cima", "bivacco", "forcella", "forcellina", "valle",
    "sentiero", "località", "localita", "ponte", "chiesa", "bocca", "croce", "strada", "forestale", "baita",
    "capanna", "colle", "dosso", "doss", "parcheggio", "paese", "abitato", "centro", "bivio", "incrocio",
    "sella", "punta", "pian", "piano", "prati", "prato", "maso", "masi", "fontana", "fonte", "torrente", "rio",
    "sorgente", "albergo", "hotel", "cappella", "chiesetta", "capitello", "santuario", "fondovalle", "alta",
    "alto", "bassa", "basso", "nord", "sud", "est", "ovest", "vecchia", "vecchio", "nuova", "nuovo", "grande",
    "piccolo", "piccola", "trento", "trentino", "provincia", "comune", "frazione", "stazione", "funivia",
    "seggiovia", "cabinovia", "impianti", "sentieri", "alpino", "alpina", "galleria",
    "ristorante", "osteria", "agritur", "agriturismo", "camping", "campeggio", "parco", "giardino",
}


def _get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "it"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        enc = r.headers.get_content_charset() or "utf-8"
    return raw.decode(enc, errors="replace")


def _text(fragment: str) -> str:
    fragment = re.sub(r"(?is)<(script|style|nav|header|footer)[^>]*>.*?</\1>", " ", fragment)
    fragment = re.sub(r"(?s)<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(fragment)).strip()


def _date(text: str) -> str | None:
    m = DATE_RE.search(text)
    if m:
        try:
            return date(int(m.group(3)), MESI[m.group(2).lower()], int(m.group(1))).isoformat()
        except ValueError:
            pass
    m = DATE_NUM.search(text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass
    return None


def _stato(title: str, body: str) -> str:
    """riaperto / chiuso / info: prima il titolo, poi l'inizio del testo."""
    for t in (title, body[:1200]):
        if REOPEN.search(t):
            return "riaperto"
        if CLOSED.search(t):
            return "chiuso"
    return "info"


# ---------------------------------------------------------------- sentieri e luoghi

def load_trails() -> list[dict]:
    return json.loads((config.PROCESSED / "trails.json").read_text(encoding="utf-8"))


def index_trails(trails: list[dict]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """numero SAT (anche senza E/O) → id; parola di luogo specifica → id."""
    by_num: dict[str, list[str]] = {}
    words: dict[str, set[str]] = {}
    for t in trails:
        num = t["numero"]  # E310, O207, E102A …
        for key in {num, num[1:]}:
            by_num.setdefault(key.upper(), []).append(t["id"])
        for field in ("loc_inizio", "loc_fine", "nome"):
            for w in re.findall(r"[A-ZÀ-Ý][a-zà-ÿ'’]{4,}", t.get(field) or ""):
                lw = w.lower().strip("'’")
                if lw not in GENERIC:
                    words.setdefault(w, set()).add(t["id"])
    # una parola che compare in troppi sentieri non identifica niente
    specific = {w: sorted(ids) for w, ids in words.items() if len(ids) <= 6}
    return by_num, specific


NUM_RE = re.compile(r"\b([EO])\s?-?\s?(\d{3}[A-Z]?)\b")
NUM_CTX = re.compile(r"(?i)\b(?:sentier[oi]|segnavia|sat|tracciat[oi]|ferrata)\s+(?:sat\s+)?(?:n\.?\s*|numero\s+)?([EO]?\s?\d{3}[A-Z]?)\b")


def match(text: str, by_num, words) -> tuple[list[str], list[str]]:
    strong: set[str] = set()
    for m in NUM_RE.finditer(text):
        strong.update(by_num.get((m.group(1) + m.group(2)).upper(), []))
    for m in NUM_CTX.finditer(text):
        strong.update(by_num.get(m.group(1).replace(" ", "").upper(), []))
    weak: set[str] = set()
    for w, ids in words.items():
        if re.search(r"\b" + re.escape(w) + r"\b", text):
            weak.update(ids)
    return sorted(strong), sorted(weak - strong)


# ---------------------------------------------------------------- Provincia

LINK_RE = re.compile(r'(?is)<a[^>]+href="((?:https?://www\.ufficiostampa\.provincia\.tn\.it)?/Comunicati/(?!\()[^"#?]+)"[^>]*>(.*?)</a>')


def provincia(pages: int, seen: dict[str, dict], by_num, words, log) -> tuple[list[dict], bool]:
    found: list[dict] = []
    ok = False
    for p in range(pages):
        url = LIST_URL if p == 0 else f"{LIST_URL}/(offset)/{p * 20}"
        try:
            page = _get(url)
            ok = True
        except Exception as e:  # noqa: BLE001
            log(f"Provincia: pagina {p} non letta ({e})")
            break
        items: dict[str, str] = {}
        for href, inner in LINK_RE.findall(page):
            title = _text(inner)
            full = urllib.parse.urljoin(BASE, href)
            if len(title) > 15 and full not in items:
                items[full] = title
        if not items:
            log(f"Provincia: nessun comunicato nella pagina {p} (struttura cambiata?)")
            break
        for full, title in items.items():
            if full in seen or not TOPIC.search(title):
                continue
            slug = full.split("/Comunicati/", 1)[1]
            body = ""
            for candidate in (f"{BASE}/layout/set/print/Comunicati/{slug}", full):
                try:
                    body = _text(_get(candidate))
                    break
                except Exception:  # noqa: BLE001
                    continue
            time.sleep(PAUSE_S)
            if not body:
                continue
            text = title + " " + body[:6000]
            strong, weak = match(text, by_num, words)
            if not strong and not weak:
                seen[full] = {"skip": True}
                continue
            item = {
                "fonte": "provincia",
                "data": _date(body[:600]) or _date(body),
                "titolo": title[:200],
                "url": full,
                "stato": _stato(title, body),
                "forte": strong,
                "debole": weak if len(weak) <= 12 else [],
            }
            seen[full] = item
            found.append(item)
        time.sleep(PAUSE_S)
    return found, ok


# ---------------------------------------------------------------- Google News

def news(seen: dict[str, dict], by_num, words, log) -> tuple[list[dict], bool]:
    found: list[dict] = []
    ok = False
    for q in NEWS_QUERIES:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": f"{q} when:180d", "hl": "it", "gl": "IT", "ceid": "IT:it"})
        try:
            root = ET.fromstring(_get(url))
            ok = True
        except Exception as e:  # noqa: BLE001
            log(f"Google News: '{q}' non letto ({e})")
            continue
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            if not title or not link or link in seen:
                continue
            desc = _text(it.findtext("description") or "")
            try:
                d = parsedate_to_datetime(it.findtext("pubDate") or "").date().isoformat()
            except (TypeError, ValueError):
                d = None
            strong, weak = match(title + " " + desc, by_num, words)
            if not strong and not weak:
                seen[link] = {"skip": True}
                continue
            src = it.find("source")
            item = {
                "fonte": "notizie",
                "testata": (src.text or "").strip() if src is not None and src.text else None,
                "data": d,
                "titolo": title[:200],
                "url": link,
                "stato": _stato(title, desc),
                "forte": strong,
                "debole": weak if len(weak) <= 12 else [],
            }
            seen[link] = item
            found.append(item)
        time.sleep(PAUSE_S)
    return found, ok


# ---------------------------------------------------------------- main

def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pagine", type=int, default=40, help="pagine dell'elenco comunicati da leggere (20 per pagina)")
    args = ap.parse_args()
    log_lines: list[str] = []

    def log(s: str) -> None:
        log_lines.append(s)
        print(s)

    trails = load_trails()
    by_num, words = index_trails(trails)
    seen: dict[str, dict] = {}
    if CACHE.exists():
        seen = json.loads(CACHE.read_text(encoding="utf-8"))
    prov, prov_ok = provincia(args.pagine, seen, by_num, words, log)
    nws, news_ok = news(seen, by_num, words, log)

    cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    keep = {k: v for k, v in seen.items() if not v.get("skip") and (v.get("data") or "9999") >= cutoff}
    # le voci scartate restano in cache solo come "già viste" (per non rileggerle ogni giorno)
    skips = dict(list({k: v for k, v in seen.items() if v.get("skip")}.items())[-3000:])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps({**skips, **keep}, ensure_ascii=False), encoding="utf-8")

    avvisi = sorted(keep.values(), key=lambda a: a.get("data") or "", reverse=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = {
        "aggiornato": now,
        "fonti": {
            "provincia": {"ok": prov_ok, "nuovi": len(prov), "url": LIST_URL},
            "notizie": {"ok": news_ok, "nuovi": len(nws), "url": "https://news.google.com/"},
        },
        "avvisi": avvisi,
        "log": log_lines[-20:],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
    print(f"avvisi.json: {len(avvisi)} avvisi collegati a sentieri (provincia ok={prov_ok}, notizie ok={news_ok})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
