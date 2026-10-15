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
- Deploy: GitHub Pages via GitHub Actions. Repo pubblico su GitHub (vedi Fase 2).
- Aggiornamento dati: file nuovi in `data/raw/` → un comando unico della pipeline → push.

## Ambiente

- Windows, Python 3.14 in `.venv/` (`.venv\Scripts\python`), dipendenze in `requirements.txt` (versioni fissate).
- Node 24 / npm 11 per `web/`.
- Ispezione dati grezzi: `.venv\Scripts\python pipeline\inspect_raw.py`.
- **Build dati (comando unico)**: `.venv\Scripts\python -m pipeline.build`. Legge i file più recenti in `data/raw/` (zip/gz) e scrive `data/processed/` + `data/authorities.yaml`. Scarica solo ciò che manca nelle cache (POI OSM in `data/raw/osm/`, tile DEM in `data/raw/dem/`). Opzioni: `--offline`, `--refresh-osm`.
- POI: Overpass come fonte principale, con piano B automatico sull'estratto regionale OSM France (`pipeline/osm_extract.py`). Mai interrogare Overpass in parallelo o in ciclo stretto.
- DEM: tile Mapterhorn z13 (in Trentino = LiDAR PAT 5 m). Distanze dei badge per categoria in `pipeline/config.py` (`POI_DISTANCE_M`).
- **Verifica a campione**: `.venv\Scripts\python -m pipeline.verify` (esce con errore se un controllo fallisce).
- Formato dei file prodotti: `docs/DATA.md` §4.
- **Web app** (in `web/`): `npm run dev` (sviluppo, serve anche `data/processed/` su `/data/`), `npm run build` (→ `web/dist/`, con i dati copiati in `dist/data/`).
- CI: `.github/workflows/deploy.yml` builda a ogni push; il deploy su Pages parte solo con la variabile di repo `DEPLOY_PAGES=true`.

## Web app (fase 2)

- `web/src/main.ts`: mappa, layer, click, data scelta. `flight.ts`: regola dei colori per data (stessa logica di `pipeline/dflight.py`, da tenere allineate). `panel.ts`: contenuto del pannello (solo `textContent`, nessun HTML dei dati interpretato).
- Sfondi in `web/src/basemap.ts` (fase 3), selettore "Pulita / Topo" sulla mappa, scelta salvata nel browser:
  - **pulita** (default): stile scritto da zero su tile vettoriali OpenFreeMap (schema OpenMapTiles) + rilievo da Mapterhorn (terrarium). Niente path/track OSM; etichette graduali per zoom (città → paesi → vette/laghi/rifugi/passi). Icone disegnate al volo, nessuno sprite esterno. Lo schema non contiene i nomi delle valli.
  - **topo**: OpenTopoMap raster (max zoom 17), leggermente desaturato.
  - Font: `tiles.openfreemap.org/fonts` (Noto Sans Regular/Bold/Italic). I layer dei sentieri vanno inseriti prima di `FIRST_LABEL`.
- MapLibre 6: il worker va impacchettato da Vite (`?worker&url` + `setWorkerUrl`), altrimenti la mappa resta vuota.
- `base: './'` in Vite: la stessa build funziona sotto `/nome-repo/` (Pages) o alla radice di un dominio.
- Data scelta: un NOTAM è attivo se la sua validità si sovrappone anche in parte al giorno locale scelto.
- Fase 4: `icons.ts` (icone su canvas; in MapLibre 6 vanno registrate con `setMissingStyleImageResolver` o subito al `style.load`, l'evento `styleimagemissing` arriva troppo tardi), `trailgeom.ts`, `profile.ts`, `photos.ts` (Wikimedia Commons al momento), `filters.ts` (tutti i filtri in AND; i sentieri esclusi sono attenuati con feature-state `off`), `search.ts`. `profiles.json` e `search.json` si caricano solo al primo uso.

## Decisioni prese

- Sentieri con lo stesso `numero`: copie identiche scartate (E731); tracciati diversi tenuti come varianti `E396`, `E396-b`.
- Rosso distinto in `tipo_rosso`: `vietato` (NFZ) vs `autorizzazione` (ATM09). Stesso colore, l'app mostra la differenza.
- Il colore nei file è calcolato solo sulle zone **permanenti**. Le NOTAM temporanee sono elencate per tratto (`zone_temporanee`) e l'app le applica in base alla data scelta.
- Contatti degli enti in `data/authorities.yaml` (scheletro generato, compilazione manuale).
- Verifica sul campo (utente, 2026-10-15): elisuperficie Pozza di Fassa, centro 0 m, anelli 25 m e 45 m, libero oltre ~3,5 km. Regola dei colori confermata.

## Fasi

- **Fase 0** ✅ setup repo, venv, ispezione dati, `docs/DATA.md`, questo file, primo push.
- **Fase 1** ✅ incrocio sentieri × zone D-Flight → tratti colorati (`pipeline/build.py`).
- **Fase 2** ✅ web app base: mappa, tratti colorati, zone, pannelli, data NOTAM, CI.
  Hosting: repo reso **pubblico** (scelta dell'utente, 2026-10-15) perché Pages non è disponibile su repo privati col piano Free.
  Sito: https://fabionsky20.github.io/sentieri-drone-trentino/ (deploy automatico a ogni push su main, variabile `DEPLOY_PAGES=true`).
  Niente segreti nel repo: non aggiungere mai token o dati personali.
- **Fase 3** ✅ mappa pulita: sfondo vettoriale + rilievo, selettore sfondo, tratti con ombra e bordo chiaro.
- **Fase 4** ✅ POI OSM + valli, badge di prossimità, dislivello e profilo dal DEM, filtri, ricerca, foto Wikimedia, icone POI. Dettagli dati in `docs/DATA.md` §5. Il design dell'app si rifà alla fine: per ora lo stile è funzionale.
- Fasi successive da pianificare (POI, ricerca, filtri, chiusure, PWA, meteo).
