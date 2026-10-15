# Sentieri & Drone — Trentino

Web app personale (uso interno, 2 utenti, non pubblica) per scegliere sentieri SAT in
Trentino dove volare con un drone DJI Mini (categoria Open, <250 g) e fare foto/video.

L'utente non scrive codice: Claude implementa tutto e spiega le scelte in breve, in italiano.
Questo file è il riferimento per tutte le fasi. Dettagli sui dati reali: [docs/DATA.md](docs/DATA.md).

## Fonti dati

| Fonte | Formato | Dove | Note |
|---|---|---|---|
| Sentieri SAT | Shapefile | `data/raw/` (manuale) | rete sentieristica SAT |
| Zone geografiche UAS D-Flight | JSON ED-269 | `data/raw/` (manuale) | zone geografiche UAS Italia |
| OpenStreetMap | POI (Overpass o estratto .pbf) | da definire | laghi, malghe, rifugi, cascate, panorami, passi |
| DEM | raster | da definire | altimetria e profili |
| Open-Meteo | API HTTP | runtime (browser) | futuro, meteo per data |
| Confini parchi | vettoriale | da definire | layer solo informativo |
| Chiusure | `data/closures.yaml` | versionato, a mano | chiusure stagionali e puntuali |
| Contatti enti | `data/authorities.yaml` | versionato, a mano | D-Flight ha contatti `N.A.` per tutte le zone sui sentieri |

`data/raw/` non è versionato (vedi `.gitignore`). `data/processed/` è versionato ed è
l'unico input della web app.

## Regola dei tre colori (cuore dell'app)

Ogni sentiero viene spezzato in tratti in base all'intersezione con le zone D-Flight.
Ogni tratto prende il colore della zona **più restrittiva** che lo copre:

- **Verde**: nessuna zona geografica UAS.
- **Giallo**: zona con condizioni / quota massima ridotta → mostrare la quota (es. "max 60 m AGL").
- **Rosso**: volo vietato oppure autorizzazione richiesta.

Ordine di severità: rosso > giallo > verde. In caso di dubbio si sceglie il colore più restrittivo.

Mappatura dai campi ED-269 (dati D-Flight reali, vedi `docs/DATA.md`; limiti sempre in m AGL):
- `restriction = PROHIBITED` (NFZ, inclusi i NOTAM) attiva nella data considerata → **rosso**.
- `restriction = REQ_AUTHORISATION` con `lowerLimit = 0` → **rosso**.
- `restriction = REQ_AUTHORISATION` con `lowerLimit > 0` → **giallo, quota max = `lowerLimit`** (25/45/60 m).
- Valori `restriction` sconosciuti (es. `CONDITIONAL`) → giallo se `lowerLimit > 0`, altrimenti rosso.
- Se più gialli si sovrappongono vince la quota minore.
L'app è un ausilio alla pianificazione: il riferimento ufficiale resta D-Flight.

## Funzionalità finali

1. **Mappa** con i sentieri spezzati in tratti colorati (regola dei tre colori), quota visibile sui tratti gialli.
2. **Click su una zona**: regole, quota, validità e contatti dell'ente per i permessi (dai campi ED-269).
3. **Click su un sentiero**: km, dislivello, difficoltà, tempi, profilo altimetrico, POI lungo il percorso, stato aperto/chiuso.
4. **Ricerca testuale locale** (sentieri, rifugi, passi, laghi, malghe), es. "passo Manghen". Indice JSON precalcolato, nessun server.
5. **POI da OSM**: laghi/specchi d'acqua, malghe, rifugi, cascate, punti panoramici, passi. Per ogni sentiero si calcolano i POI entro una distanza configurabile e si assegnano badge.
6. **Filtri**: per badge, difficoltà, aperto/chiuso, "ha tratti volabili", stato del volo.
7. **Chiusure**: `data/closures.yaml` gestito a mano (stagionali e puntuali) + eventuali campi di stato nei dati SAT.
8. **Layer parchi** opzionale (solo informativo).
9. **PWA** utilizzabile offline in montagna.
10. **Futuro**: meteo per data scelta (Open-Meteo) per filtrare i sentieri con bel tempo.

## Architettura

```
pipeline/        Python (geopandas, shapely, pyproj): tutto il lavoro geografico pesante, offline
data/raw/        input scaricati a mano (non versionato)
data/processed/  output statici: GeoJSON (o PMTiles se troppo grandi) + indice di ricerca JSON
data/closures.yaml  chiusure gestite a mano
web/             app statica Vite + TypeScript + MapLibre GL, nessun backend
docs/            documentazione (DATA.md, ...)
```

- Calcoli geometrici in un CRS metrico (EPSG:32632 / ETRS89-UTM32N), output in WGS84 (EPSG:4326) per il web.
- La web app legge solo file statici da `data/processed/` (copiati/serviti da Vite).
- Deploy: GitHub Pages via GitHub Actions. Repo privato su GitHub.
- Aggiornamento dati: file nuovi in `data/raw/` → un comando unico della pipeline → push.

## Ambiente

- Windows, Python 3.14 in `.venv/` (`.venv\Scripts\python`), dipendenze in `requirements.txt` (versioni fissate).
- Node 24 / npm 11 per `web/`.
- Ispezione dati grezzi: `.venv\Scripts\python pipeline\inspect_raw.py`.

## Fasi

- **Fase 0** — setup repo, venv, ispezione dati, `docs/DATA.md`, questo file, primo push.
- **Fase 1** — incrocio sentieri × zone D-Flight → tratti colorati.
- Fasi successive da pianificare (web app base, POI, ricerca, filtri, chiusure, PWA, meteo).
