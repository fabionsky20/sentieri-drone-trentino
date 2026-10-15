# Dati grezzi — risultati dell'ispezione (fase 0)

Ispezione del 2026-10-15. Report ripetibile con:
`.venv\Scripts\python pipeline\inspect_raw.py`

## File in `data/raw/`

| File | Contenuto | Uso |
|---|---|---|
| `sentierisat.shp.zip` → `sat_shp/sentieri_tratte.*` | Sentieri SAT, shapefile | **fonte principale** |
| `sentierisat.gpx.zip`, `sentierisat.kml.zip` | Stessi sentieri in GPX/KML, stessi attributi, nessuna quota | ignorati (ridondanti) |
| `dflight_geozones_20261015_191610.json.gz` → `dflight/dflight_geozones_20261015.json` | Zone geografiche UAS di tutta Italia, ED-269 | **fonte principale** |

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

## Dati mancanti, riassunto

1. Stato aperto/chiuso dei sentieri → solo `data/closures.yaml`.
2. Dislivello cumulato e profilo → DEM (es. LiDAR / DTM della Provincia di Trento, o Copernicus 30 m).
3. Contatti enti per i permessi → `data/authorities.yaml` manuale.
4. Nome leggibile per il 64% dei sentieri → nome sintetico da località di partenza e arrivo.
