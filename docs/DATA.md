# Dati grezzi — risultati dell'ispezione (fase 0)

Ispezione del 2026-10-15. Report ripetibile con:
`.venv\Scripts\python pipeline\inspect_raw.py`

## File in `data/raw/`

| File | Contenuto | Uso |
|---|---|---|
| `sentierisat.shp.zip` (contiene `sentieri_tratte.*`) | Sentieri SAT, shapefile | **fonte principale** |
| `sentierisat.gpx.zip`, `sentierisat.kml.zip` | Stessi sentieri in GPX/KML, stessi attributi, nessuna quota | ignorati (ridondanti) |
| `dflight_geozones_20261015_191610.json.gz` | Zone geografiche UAS di tutta Italia, ED-269 | **fonte principale** |

La pipeline legge direttamente zip e gz, non serve estrarli. Se ci sono più file usa il più recente.

Licenza SAT: **ODbL 1.0** (database) + DbCL (contenuti). Uso interno ok; se un giorno si
pubblica, serve l'attribuzione "Sentieri SAT" e la condivisione dei dati derivati con la stessa licenza.

---

## 1. Sentieri SAT (`sentieri_tratte.shp`)

- **CRS**: EPSG:25832 (ETRS89 / UTM 32N), metrico. Coincide in pratica con il CRS di lavoro previsto (32632).
- **Feature**: 1082 `LineString` (nessuna MultiLineString, nessuna geometria vuota o non valida).
- **Una feature = un sentiero numerato intero** (la lunghezza geometrica coincide con `lun_planim` entro il 3%), nonostante il nome "tratte".
- **Lunghezza totale**: 5470 km, 387 468 vertici.
- **Nessuna coordinata Z** → il profilo altimetrico richiede un DEM.
- **BBox WGS84**: lon 10.47–11.95, lat 45.70–46.54.

### Campi

| Campo | Tipo | Contenuto | Esempi | Note |
|---|---|---|---|---|
| `numero` | str | numero SAT | `E101`, `E102A` | prefisso `E` (554) = settore Est, `O` (528) = Ovest; suffisso lettera per varianti |
| `denominaz` | str | nome proprio | `SENTIERO DELLE CRESTINE`, `VIA FERRATA "PASQUALE BAGLIONI"` | **vuoto nel 64%** dei casi |
| `difficolta` | str | scala CAI | `E` 784, `EE` 191, `T` 35, `EEA-F` 19, `EEA-PD` 23, `EEA-D` 26, `EEA-MD` 4 | sempre presente |
| `loc_inizio`, `loc_fine` | str | località di partenza e arrivo | `PASSO DEL MÀNGHEN`, `RIFUGIO "VINCENZO LANCIA"` | sempre presenti, MAIUSCOLO con accenti tonici |
| `quota_iniz`, `quota_fine` | int | quota in m dei due estremi | 66 – 3530 | |
| `quota_min`, `quota_max` | int | quota minima e massima del percorso | | |
| `lun_planim` | int | lunghezza planimetrica in m | 120 – 64 350 | |
| `lun_inclin` | int | lunghezza reale (inclinata) in m | | sempre ≥ planimetrica |
| `t_andata`, `t_ritorno` | str | tempo `HH:MM` | `02:40` | formato sempre valido |
| `gr_mont` | str | gruppo montuoso | `LAGORAI / Fravòrt - Sette Selle` | 95 valori, utile come filtro o ricerca |
| `comuni_toc` | str | comuni attraversati, separati da virgola | `ALA, VALLARSA` | |
| `competenza` | str | sezione SAT o rifugio responsabile | `SEZ. SAT ROVERETO` | |

### Domande della specifica

| Serve | Presente? |
|---|---|
| numero | ✅ `numero` |
| nome | ⚠️ `denominaz` solo nel 36%; per gli altri si usa "`loc_inizio` → `loc_fine`" |
| difficoltà | ✅ `difficolta` |
| lunghezza | ✅ `lun_planim` / `lun_inclin` |
| dislivello | ⚠️ solo indiretto: `quota_max − quota_min` è la differenza fra punto più alto e più basso, **non** il dislivello positivo cumulato. Quello vero richiede il DEM |
| tempi | ✅ `t_andata` / `t_ritorno` |
| stato / chiusura | ❌ **nessun campo**. Le chiusure verranno solo da `data/closures.yaml` |

### Anomalie

- **Duplicati di `numero`** (2):
  - `E731` è un duplicato esatto (geometria e attributi identici) → in pipeline si scarta una copia.
  - `E396` ("Trodo dei Fiori") ha due geometrie diverse (3,1 km e 4,2 km, sovrapposte per 3,1 km) con gli stessi attributi: è probabilmente una variante non numerata a parte. In pipeline si tengono entrambe con id distinti (`E396`, `E396#2`).
- **Quote incoerenti** in 172 sentieri: `quota_iniz` o `quota_fine` cade fuori da [`quota_min`, `quota_max`] di qualche metro (scarto massimo 41 m). Si tratta di arrotondamenti; non è un problema, ma va ricordato se si confrontano con il DEM.
- Campi testuali in MAIUSCOLO: la ricerca deve ignorare maiuscole e accenti (`MÀNGHEN` ↔ "manghen"). Verificato: "passo Manghen" → `E310` (Passo del Manghen → Passo Cadin).

---

## 2. Zone D-Flight (`dflight_geozones_*.json`)

Formato **ED-269** (EUROCAE), il file JSON è un unico oggetto:
```
{ title, description, features: [ zona, ... ] }
zona = { identifier, country, name, type, restriction, reason[], otherReasonInfo,
         message?, zoneAuthority[], applicability[], geometry[] }
geometry[i] = { uomDimensions, lowerLimit, lowerVerticalReference,
                upperLimit, upperVerticalReference,
                horizontalProjection: { type: "Polygon", coordinates } }
```

- **Snapshot**: `ITA ZoneVersion 15/10/2026 19:16:10`, **4521 zone** in tutta Italia.
- `otherReasonInfo` (categoria D-Flight): **ATM09** 3763, **NFZ** 758. In descrizione compare anche `NOTAM[0]`, ma i NOTAM sono in realtà dentro NFZ (nome `NOTAM Wxxxx/26`).
- `type`: sempre `COMMON`. `country`: sempre `ITA`.
- `restriction`: `REQ_AUTHORISATION` (= tutte le ATM09), `PROHIBITED` (= tutte le NFZ). Nessun `CONDITIONAL` o `NO_RESTRICTION`.
- `reason`: combinazioni di `EMERGENCY`, `AIR_TRAFFIC`, `SENSITIVE`, `PRIVACY`, `POPULATION`, `NOISE`, `NATURE`, `OTHER`.

### Geometrie

- Solo **`Polygon`** in WGS84 (nessun `Circle`). 4882 poligoni: una zona può avere da 1 a 6 parti, tutte con gli stessi limiti verticali.
- 1037 poligoni hanno **buchi**: gli anelli concentrici delle aviosuperfici sono "ciambelle".
- **6 poligoni non validi** (auto-intersezioni) → `make_valid` in pipeline.

### Limiti verticali

- Unità sempre **metri** (`M`), riferimento sempre **AGL** sia sotto sia sopra. **Nessun AMSL** → nessuna conversione con il DEM.
- `lowerLimit` ∈ {0, 25, 45, 60}. **È la quota fino alla quale si vola liberamente**: la zona si applica *sopra* `lowerLimit`.
  - ATM09 con `lowerLimit` 0 → autorizzazione richiesta già da terra.
  - ATM09 con 25 / 45 / 60 → si vola liberamente fino a 25 / 45 / 60 m AGL.
  - Esempio: le aviosuperfici ed elisuperfici (`avio_NNNN_NOME`) hanno 3 anelli concentrici, 0 m al centro, poi 25 m, poi 45 m.
- `upperLimit` di solito 120; valori fuori scala come 99999 o **1000120** (`ENV002K-PN Fanes-Sennes-Braies`, errore di battitura) significano "illimitato". Per un drone in categoria Open (max 120 m) l'upper non conta.

### Validità temporale (`applicability`)

- **ATM09**: sempre `permanent: "YES"`, senza date.
- **NFZ**: sempre `startDateTime` / `endDateTime` (ISO UTC). 394 hanno `permanent: "YES"` (fine 2099), 364 `"NO"` (NOTAM temporanei, anche di 1–2 giorni). Nessun `schedule` (fasce orarie).
- ⚠️ Lo snapshot invecchia in fretta: i NOTAM cambiano ogni settimana. L'app deve mostrare la **data dello snapshot** e filtrare le NFZ per data.

### Contatti dell'ente (`zoneAuthority[]`)

- Campi: `name`, `service`, `email`, `contactName`, `phone`, `purpose` (`AUTHORIZATION`), `siteURL` mai presente.
- ⚠️ **Valorizzati solo nel 7% dei casi**: 4221 su 4541 hanno `"N.A."` ovunque. Gli enti reali presenti in Italia sono Ministero della Giustizia (carceri), Aeronautica Militare, prefetture, ecc.
- ⚠️ **Per tutte le 115 zone che toccano sentieri SAT i contatti sono `N.A.`**. La funzionalità 2 (contatti per i permessi) va quindi alimentata da una tabella manuale, es. `data/authorities.yaml`:
  - parchi → Ente Parco;
  - aviosuperfici ed elisuperfici → gestore / Trentino Emergenza 118;
  - ATZ e aeroporti → ENAV;
  - biotopi → Provincia;

  con `name` della zona come chiave (o un suo prefisso).
- `message` (HTML, solo NFZ, 321 non vuoti) contiene le regole testuali. Per le NFZ che toccano sentieri è vuoto.

---

## 3. Incrocio preliminare sentieri × zone (stima per la fase 1)

Zone che toccano almeno un sentiero: **115** (79 aviosuperfici/elisuperfici `avio_`,
~25 aree protette `LIPROT`, aeroporti di Trento e Bolzano con ATZ, 6 NFZ di cui 5 NOTAM temporanei).

Km di sentiero per colore, regola "vince la zona più restrittiva", NOTAM inclusi a prescindere dalla data:

| Colore | Km | % |
|---|---|---|
| 🔴 rosso | 1429 | 26% |
| 🟡 giallo max 25 m | 266 | 5% |
| 🟡 giallo max 45 m | 462 | 8% |
| 🟡 giallo max 60 m | 52 | 1% |
| 🟢 verde | 3237 | 59% |

Il rosso è dominato dai **parchi**, che sono zone ATM09 con `REQ_AUTHORISATION` da 0 m:
Adamello Brenta, Paneveggio–Pale di S. Martino, Stelvio settore trentino, riserve e biotopi.

Bonus: i poligoni `LIPROT…` dei parchi possono alimentare direttamente il layer parchi
(funzionalità 8) senza una fonte esterna.

## 4. Output della pipeline (`data/processed/`)

Generati da `.venv\Scripts\python -m pipeline.build` e verificati da `-m pipeline.verify`.
Coordinate WGS84 a 5 decimali (~1 m); geometrie semplificate a 2 m.

**`segments.geojson`**: un `LineString` per tratto omogeneo (stesso insieme di zone).
| Proprietà | Significato |
|---|---|
| `id` | `<sentiero_id>#<n>`, n crescente lungo il sentiero |
| `sentiero_id`, `numero` | id univoco (con varianti `-b`) e numero SAT |
| `colore` | `verde` / `giallo` / `rosso`, solo zone **permanenti** |
| `tipo_rosso` | `vietato` (NFZ) / `autorizzazione` (ATM09 da 0 m) / null |
| `quota_max_m` | quota libera AGL per i gialli (25/45/60), null altrimenti |
| `zone` | id delle zone permanenti che coprono il tratto, separati da virgola |
| `zone_temporanee` | id delle NOTAM che coprono il tratto: l'app le applica in base alla data |
| `lunghezza_m` | lunghezza del tratto |

Le liste sono stringhe separate da virgola perché MapLibre non gestisce bene gli array nelle proprietà.

**`zones.geojson`**: un poligono per parte di zona, nell'area dei sentieri + 5 km, NOTAM già scaduti esclusi.
Contiene: `zona_id`, `nome`, `categoria` (ATM09/NFZ), `restrizione`, `motivi`, `messaggio`
(HTML), `permanente`, `inizio`/`fine`, `quota_min_m`, `quota_sup_m` (null = illimitato),
`colore`/`tipo_rosso`/`quota_max_m` della singola zona, `ente*` (null se "N.A."), `sui_sentieri`.

**`trails.json`**: array, uno per sentiero. Contiene gli attributi SAT rinominati in italiano
leggibile, `titolo` (nome oppure "partenza → arrivo"), `comuni` come lista, `km_verde`/`km_giallo`/`km_rosso`,
`zone_temporanee`, `bbox` [ovest, sud, est, nord].

**`meta.json`**: snapshot D-Flight, file sorgente, conteggi, km per colore.

**`data/authorities.yaml`**: scheletro dei contatti, una voce per nome di zona permanente
sui sentieri (58 voci). Da compilare a mano; la build aggiunge solo le voci nuove.

Note sul risultato della fase 1:
- I tratti rossi consecutivi possono restare separati se cambiano le zone sottostanti
  (es. elisuperficie e poi parco): stesso colore, informazioni diverse al click.
- Sul bordo di una zona, un sentiero che la sfiora può generare tratti di pochi metri
  (es. `E594`, 3 m nella NFZ Sciliar). Sono reali secondo i poligoni D-Flight e vengono tenuti per prudenza.

## 5. POI, valli e quote (fase 4)

### POI e valli da OpenStreetMap (`pipeline/osm.py`)

- **Fonte principale: Overpass API.** Una query per categoria nel riquadro dei sentieri più circa 3 km, in sequenza, con 10 s di pausa tra le query e attese di 30/90/240 s dopo un errore. Cache in `data/raw/osm/<categoria>.json`. La build scarica solo le categorie mancanti; `python -m pipeline.osm --refresh` le riscarica tutte, `--max-age N` solo quelle più vecchie di N giorni.
- **Piano B automatico: estratto regionale** OSM France `trentino_alto_adige-latest.osm.pbf` (~140 MB, aggiornato ogni giorno), letto in locale con pyosmium (`pipeline/osm_extract.py`). Si usa se Overpass non risponde.
  - Il 2026-10-15 Overpass era irraggiungibile (overpass-api.de non accettava connessioni, i mirror davano 500/504), quindi **i POI attuali vengono dall'estratto**. Il campo `_fonte` di ogni file di cache dice da dove arriva.
  - ⚠️ L'estratto copre solo il Trentino-Alto Adige: mancano i POI appena oltre il confine regionale (es. lati veneti di Lessinia, Pasubio, Altopiano di Asiago, Lagorai orientale). Con Overpass funzionante, `--refresh` li recupera.

| Categoria | Regola OSM | Note |
|---|---|---|
| lago | `natural=water` con nome, escluso `water=river/canal/stream/…` | distanza calcolata dalla riva |
| vetta | nodo `natural=peak/volcano` con nome | quota da `ele` |
| malga | nome che inizia con "Malga/Malghetta/Casera/Malghe ", esclusi strade e corsi d'acqua | in OSM le malghe non hanno un tag univoco: la regola sul nome è l'unica affidabile |
| rifugio | `tourism=alpine_hut` | |
| bivacco | `tourism=wilderness_hut`, `amenity=shelter` con nome "Bivacc…" | |
| cascata | `waterway=waterfall`, `natural=waterfall` | senza nome → "Cascata" |
| panoramico | `tourism=viewpoint` | senza nome → "Punto panoramico" |
| passo | nodo `mountain_pass=yes`, oppure `natural=saddle` con nome | |
| valle | `natural=valley` con nome | linee: "principale" se ≥ 8 km (etichetta da lontano) |
| paese | nodo `place=city/town/village/hamlet` | solo per la ricerca |

Doppioni (stesso nome entro 200 m, es. rifugio mappato come punto e come edificio): ne resta uno.
Il 2026-10-15 risultavano 7217 POI (2696 vette, 1212 panoramici, 1010 malghe, 923 passi,
522 laghi, 314 rifugi, 302 cascate, 238 bivacchi) e 874 valli (40 principali).

### Prossimità (badge)

Un POI è "lungo il sentiero" se la sua forma (riva del lago, edificio, punto) è entro
`POI_DISTANCE_M` (in `pipeline/config.py`): laghi 300 m, tutto il resto 150 m. In
`trails.json` ogni sentiero ha `poi: [{id, d, km}]` (distanza in m, posizione lungo il percorso)
e `badge` (categorie presenti). L'83% dei sentieri ha almeno un badge.

### Quote, dislivello e profilo (`pipeline/dem.py`)

- **DEM: tile Mapterhorn** (terrarium, z13 ≈ 6,6 m/pixel). In Trentino derivano dal **LiDAR della Provincia** (DTM terreno nudo, ricampionato a 5 m, CC BY 2.5), in Alto Adige dal DTM provinciale 2,5 m (CC0), altrove da Copernicus GLO-30. Si scaricano solo le 568 tile che toccano i sentieri (78 MB, cache in `data/raw/dem/`).
  - Scartati il LiDAR PAT originale (1 m, centinaia di riquadri da scaricare a mano) e Copernicus GLO-30 da solo (30 m, è un modello di superficie: nei boschi misura la cima degli alberi).
- Campionamento ogni 10 m con interpolazione bilineare, media mobile su 3 punti, dislivello con **isteresi di 5 m**: le oscillazioni sotto soglia non si sommano, come fanno i GPS da escursionismo.
- **Verifica:** confrontando con le quote dichiarate dalla SAT, lo scarto mediano è 1 m sulla quota massima e 0 m sulla minima, con solo 3 sentieri oltre 50 m. Esempi: E101 D+ 709 m (SAT 1092→1800), E542 D+ 464 m (SAT 2265→2734).
- `trails.json`: `dislivello_pos`, `dislivello_neg`, `quota_min_dem`, `quota_max_dem`.
- `profiles.json`: `{id: {passo, lung, q: [quote…]}}`, al massimo 300 punti per sentiero; l'app lo carica alla prima apertura di una scheda.

### Ricerca (`search.json`)

Voci `{t: tipo, n: nome, k: chiave normalizzata, c: [lon, lat], id?, b?: bbox}` per sentieri
(numero, nome, località, gruppo), POI, valli e paesi. La chiave è minuscola e senza accenti:
"passo manghen" trova "Passo Manghen" e "PASSO DEL MÀNGHEN".

### Foto

Le foto non sono nella pipeline: l'app le chiede al momento all'API pubblica di Wikimedia
Commons (ricerca geografica, 1,5 km attorno a 3 punti del sentiero o 400 m attorno al POI),
e mostra autore e licenza di ciascuna. Servono la connessione e foto geolocalizzate nella
zona: in alcune valli poco fotografate non c'è nulla.

## 6. Chiusure (fase 5)

I dati SAT non hanno un campo di stato: le chiusure stanno solo in **`data/closures.yaml`**,
gestito a mano (le istruzioni sono in testa al file). Due tipi:

- **stagionale**: si ripete ogni anno, `dal`/`al` come "1 novembre" o "11-01", può scavalcare il capodanno;
- **puntuale**: una volta sola, `dal`/`al` come AAAA-MM-GG; senza `al` resta chiuso fino a nuovo avviso.

Un numero SAT chiude tutte le sue varianti (E396 → E396 ed E396-b); un id di variante solo
quella. La build valida il file e si ferma con un messaggio chiaro se c'è un errore: sentiero
inesistente, data impossibile, fine prima dell'inizio. Output: `data/processed/closures.json`,
`{id_sentiero: [{tipo, dal, al, motivo, fonte}]}`. L'app calcola chi è chiuso nella data
scelta: riquadro "Chiuso" nella scheda, "CHIUSO" nella lista dei risultati, filtro "Solo
sentieri aperti".

## Dati mancanti, riassunto

1. Stato aperto/chiuso dei sentieri → solo `data/closures.yaml`.
2. ~~Dislivello cumulato e profilo~~ → risolto in fase 4 con il DEM Mapterhorn (LiDAR PAT).
3. Contatti enti per i permessi → `data/authorities.yaml` manuale.
4. Nome leggibile per il 64% dei sentieri → nome sintetico da località di partenza e arrivo.
