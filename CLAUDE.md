# Quota 120 — Trentino

**Quota 120** (repo `sentieri-drone-trentino`): app per chi fa foto/video col drone in montagna.
Sceglie dove andare (sentieri SAT), sa se e quanto può volare quel giorno (zone D-Flight, NOTAM,
meteo), si organizza con gli amici, tiene traccia di dove è stato.

L'utente non scrive codice: Claude implementa tutto e spiega le scelte in breve, in italiano.
Questo file è il riferimento per tutte le fasi. Dettagli sui dati reali: [docs/DATA.md](docs/DATA.md).

## Roadmap (sintesi) — dettagli in [docs/ROADMAP.md](docs/ROADMAP.md)

- **Uso attuale privato** (gruppo di ~10 amici), **costo zero**: GitHub Pages + Firebase Spark. Niente di commerciale (no ads, no pagamenti) finché non ci saranno permessi da D-Flight.
- **Fase 1 Fondamenta:** A login aperto + profilo + hangar ✅ → B bacheche condivise con inviti → C note sui sentieri, "segna come fatto", statistiche → D meteo e indice di volabilità.
- **Fase 2 Beta:** PWA offline, notifiche push, anteprima di volo 3D (camera a 120 m che ruota a 360°), ostacoli da OSM (cavi, linee elettriche, elisuperfici), segnalazioni con scadenza, Android in test chiuso.
- **Dopo:** luce/ora d'oro, mare di nubi, "cosa vedo da qui", punti di decollo, badge, card Instagram, lista inquadrature.
- **REGOLA FISSA: l'app non registra, chiede o mostra MAI la quota a cui l'utente ha volato, né importa log di volo. Nessuna statistica di quota volata.** Si mostrano solo i limiti dello spazio aereo.
- **Privacy:** storico e statistiche privati di default; ogni utente legge solo i propri dati.

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
docs/            documentazione (DATA.md, ROADMAP.md, ACCOUNT.md)
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
- **Fase 5** ✅ chiusure (`data/closures.yaml` → `pipeline/closures.py` → `closures.json`; `web/src/closures.ts`, filtro "Solo sentieri aperti") e sentieri salvati con Firebase (Auth Google + Firestore, progetto `sentieri-e-drone`, piano Spark).
  - Gli avvisi "Cross-Origin-Opener-Policy … window.closed" in console durante il login con popup sono noti e innocui.
- **Fase 6** ✅ redesign grafico (solo estetica e layout). Regole in "Design" qui sotto.
- **Roadmap Fase 1 · passo A** ✅ nome "Quota 120", manifest PWA (`web/public/`), login aperto, profilo, onboarding, hangar, scadenze. Vedi "Account" qui sotto.
- **Roadmap Fase 1 · passo B** ✅ bacheche condivise con ruoli, inviti (link e ricerca per nome), "ci sto", note, notifiche in-app, migrazione di "Condivisi". Vedi "Bacheche" qui sotto.

## Account (Roadmap Fase 1 · A)

- `web/src/account.ts`: Firebase Auth (Google, popup) + Firestore. Caricato solo quando serve (import dinamico; subito all'avvio se il dispositivo aveva già fatto login, flag `salvati-attivo`). Profilo creato in automatico al primo login; migrazione automatica `utenti/{uid}/salvati` → `users/{uid}/saved` (vecchi documenti lasciati).
- `web/src/fb.ts`: inizializzazione Firebase condivisa (app, auth, db, emulatori).
- Dati per utente: `users/{uid}` (profilo + scadenze documenti + `cercabile`), `users/{uid}/saved`, `users/{uid}/droni`, `users/{uid}/bacheche` (indice), `users/{uid}/notifiche`. La vecchia lista `condivisi` è ora in sola lettura (fonte della migrazione).
- `web/src/profilepage.ts`: pagina profilo, hangar (preset modelli in `web/src/drones.ts`, ~36 modelli DJI/Autel/Potensic/HoverAir + "Altro" libero), documenti pilota, avvisi a 30 giorni (`WARN_DAYS`), onboarding 3 passi, privacy (visibile nella ricerca), elimina account.
- Date documenti: valide solo tra 2000-01-01 e il 31/12 di (anno corrente + 10), stesso limite nelle regole. Si salvano solo date complete (su `change` valido o blur): durante la digitazione l'anno passa da 0002/0020/0203 e salvare ogni passo ridisegnava la pagina (bug "non riesco a mettere 2031").
- Mentre un modulo del profilo è aperto o una data è incompleta, gli aggiornamenti da Firestore non ridisegnano la pagina (`renderProfileView(force)`).

## Bacheche (Roadmap Fase 1 · B)

- `web/src/boards.ts` (dati e API) + `web/src/boardsui.ts` (viste: elenco, bacheca, selettore "Aggiungi a bacheca", notifiche, invito da link). Esportato da `account.ts`.
- Modello: `boards/{b}` + `partecipanti`, `sentieri` (con `data` e mappa `ciSto`), `note`, `links/{token}`; `inviti/{b}_{uid}`; `profili/{uid}` (rubrica pubblica per la ricerca, opt-out). Dettagli in [docs/ACCOUNT.md](docs/ACCOUNT.md).
- Niente Cloud Functions: la sicurezza degli inviti sta nelle regole (token non indovinabile, scadenza ≤ 30 giorni, revoca; si entra solo con link valido o invito diretto). Le notifiche le scrive chi compie l'azione, nello stesso batch.
- Corse note: subito dopo la creazione l'ascolto della bacheca può ricevere permission-denied finché il server non ha confermato. `watchBoard` aspetta che non ci siano scritture in sospeso e verifica con `getDocFromServer` prima di scartarla.
- **Invita amici** (profilo): codice in `codiciInvito/{codice}` (leggibile senza login), link `?amico=<codice>` (+ `&invito=<bacheca>~<token>` opzionale). `setReferral` lo tiene in localStorage 30 giorni; `ensureProfile` lo usa solo alla **creazione** del profilo (`invitato_da` + `users/{invitante}/amici/{uid}` nello stesso batch). Benvenuto: `renderWelcomeInvite` + `handleReferral` in main.ts, che ha precedenza sull'invito alla bacheca.
- Migrazione: pulsante "TRASFORMA IN BACHECA" visibile ai membri storici finché non esiste la bacheca `condivisi`; chi lo preme diventa proprietario.
- `firestore.rules`: ogni utente legge/scrive solo i propri dati, campi in whitelist (`hasOnly`), lunghezze, date AAAA-MM-GG, classe/peso validati, timestamp del server. **Vanno pubblicate a mano dalla console** dopo ogni modifica. Guida e modello dati: [docs/ACCOUNT.md](docs/ACCOUNT.md).
- Prove: emulatori Firebase (Java 21 + `firebase-tools`), `?emulatori` su localhost collega l'app agli emulatori (progetto `demo-quota120`). Mai email o dati personali nel repo.

## Design (fase 6)

- Stile "strumento di volo outdoor", tema unico chiaro. Variabili CSS su `:root` in `web/src/style.css`: `--bg #EEF0EC`, `--panel #FFF`, `--panel2 #F2F4F1`, `--line #D3D9D3`, `--ink #142024`, `--muted #4F5C59`, `--accent #0B6E84` (unico colore per elementi interattivi/attivi), `--glass`. Stati di volo SOLO per il volo: verde `#2FBF71`, giallo `#E9AE0B` (testo `#1A1400`), rosso `#E5484D`; lago `#5FA8C9`.
- **Contrasto:** testo bianco o scuro su verde/rosso non arriva a 4,5:1 → verde e rosso solo come pallini, barre e bordi, testo sempre scuro su fondo chiaro. Il giallo può essere pieno.
- Font Google: IBM Plex Sans (testo), Plex Sans Condensed 600/700 (titoli, pulsanti in maiuscolo con spaziatura .06em), Plex Mono 500/600 (tutti i dati e le etichette di sezione, classe `.mono` / `.section-label`). Le etichette sulla mappa restano Noto Sans (font di OpenFreeMap).
- Layout: telefono < 768 (barra in alto galleggiante, colonna strumenti, legenda a striscia, tabbar MAPPA/FILTRI/SALVATI/PROFILO con avatar, scheda bottom sheet spostata in `body`, tutte le viste sono schermate intere in `#side`).
- Tablet/PC ≥ 768: pannello SINISTRO `#side` = scoprire (filtri; la scheda di sentiero/POI/zona li copre con "← FILTRI", i filtri restano intatti sotto); pannello DESTRO `#mine` = le mie cose (salvati, bacheche, profilo, notifiche: `placePanels()` sposta lì le viste); un solo pannello destro, ricliccare l'icona lo chiude. Linguetta `#left-tab` sul bordo della mappa per comprimere/riaprire il sinistro. Stato in `leftOpen` / `rightView` → `.layout[data-left|data-right]`.
- PC ≥ 1024: colonne `--left-w` / `--right-w` ridimensionabili con le maniglie `.resizer` (280 px – 50 % dello schermo, doppio clic = predefinita 360/380, salvate in localStorage `pannello-left|right`). Tablet 768–1023: un solo pannello alla volta, sovrapposto alla mappa, senza maniglie.
- Su telefono `.layout` non deve creare un contesto di sovrapposizione (niente `position: fixed` su di esso), altrimenti scheda e schermate finiscono sotto barra in alto e tabbar. Su ≥ 768 `.side` torna a `z-index: auto`.
- Icone SVG a tratto in `web/src/ui.ts` (niente emoji). Target touch ≥ 44 px.
