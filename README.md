# Quota 120

App web per chi fa foto e video con il drone in montagna, in Trentino: sceglie il sentiero,
vede dove e fino a che quota si può volare nel giorno scelto, si organizza con gli amici.

**App:** https://fabionsky20.github.io/sentieri-drone-trentino/

- Sentieri SAT colorati secondo le zone geografiche UAS di D-Flight: verde (libero fino a 120 m),
  giallo (libero fino a una quota ridotta), rosso (vietato o con autorizzazione); NOTAM applicati per data.
- Punti di interesse da OpenStreetMap, profilo altimetrico, foto vicine, filtri e ricerca.
- Account Google facoltativo: profilo, hangar dei droni con scadenze, sentieri salvati.

> Ausilio alla pianificazione per uso privato: il riferimento ufficiale per lo spazio aereo resta
> [D-Flight](https://www.d-flight.it/). L'app non registra mai la quota a cui si è volato.

## Struttura

| Cartella | Contenuto |
|---|---|
| `pipeline/` | Python: elaborazione dei dati (sentieri × zone, POI, quote, ricerca) |
| `data/processed/` | file statici usati dall'app |
| `web/` | app (Vite + TypeScript + MapLibre GL), pubblicata su GitHub Pages |
| `firestore.rules` | regole di sicurezza di Firebase |
| `docs/` | [dati](docs/DATA.md), [account](docs/ACCOUNT.md), [roadmap](docs/ROADMAP.md) |

## Comandi

```
.venv\Scripts\python -m pipeline.build     # rigenera i dati
.venv\Scripts\python -m pipeline.verify    # controlli
cd web && npm run dev                      # app in locale
```

## Fonti e licenze dei dati

Sentieri © SAT (ODbL) · Zone UAS © D-Flight/ENAC · POI e mappa © OpenStreetMap (ODbL),
OpenFreeMap, OpenTopoMap (CC-BY-SA) · Quote © Mapterhorn (LiDAR Provincia Autonoma di Trento
CC BY 2.5, Provincia di Bolzano CC0, Copernicus) · Foto © autori su Wikimedia Commons.
