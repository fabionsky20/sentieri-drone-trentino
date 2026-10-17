// ============================================================================
//  SOGLIE DELL'INDICE DI VOLABILITÀ (0–100)  —  file da regolare a mano
// ============================================================================
//
// L'indice di ogni ora è 100 × (prodotto dei fattori qui sotto). Ogni fattore va da 0 a 1:
//   1 = nessun problema, 0 = non si vola.
// Tra "buono" e "limite" il fattore scende in linea retta da 1 a `minimo`; oltre il limite è 0
// (o `minimo`, dove indicato). Unità: km/h, %, mm, metri.
//
// Dopo una modifica: salva, `npm run build` (o push) e ricarica l'app.
// L'indice è un aiuto alla pianificazione: decide sempre il pilota, sul posto.

/** Profili di drone: si sceglie dal peso (e dalla classe) del drone selezionato. */
export type DroneProfile = 'mini' | 'leggero' | 'medio'

export const PROFILE_LABEL: Record<DroneProfile, string> = {
  mini: 'sub-250 g (es. DJI Mini)',
  leggero: '250–900 g (es. DJI Air)',
  medio: 'oltre 900 g (es. DJI Mavic)',
}

/** Da quale peso in su si passa al profilo successivo (grammi). */
export const PESO_LEGGERO_G = 250
export const PESO_MEDIO_G = 900

/** Vento e raffiche per profilo di drone (km/h).
 *  - vento in quota = il peggiore tra 80 m e 120 m (dove si vola);
 *  - raffiche = raffiche a 10 m (Open-Meteo non le dà in quota): pesano di più per i droni leggeri. */
export const VENTO: Record<DroneProfile, { quotaBuono: number; quotaLimite: number; raffBuono: number; raffLimite: number }> = {
  // DJI Mini: resistenza al vento dichiarata 10,7 m/s ≈ 38 km/h. Un sub-250 g soffre già prima.
  mini: { quotaBuono: 15, quotaLimite: 36, raffBuono: 22, raffLimite: 40 },
  // DJI Air 2S/3: 12 m/s ≈ 43 km/h.
  leggero: { quotaBuono: 22, quotaLimite: 43, raffBuono: 30, raffLimite: 52 },
  // Mavic 3 e simili: 12 m/s, ma più stabili e pesanti.
  medio: { quotaBuono: 28, quotaLimite: 45, raffBuono: 38, raffLimite: 60 },
}

/** Pioggia: conta quanta ne cade (mm nell'ora), non la probabilità (che resta solo un'informazione).
 *  I droni consumer non sono impermeabili: con pioggia vera si resta a terra. */
export const PIOGGIA = {
  asciuttoSotto: 0.2, // mm/h: sotto, l'ora conta come asciutta
  forteDa: 0.5, // mm/h: da qui in su fattore 0
  debole: 0.35, // fattore per pioggia debole (tra asciutto e forte)
}

/** Nuvole basse: in montagna spesso vuol dire nebbia sul sentiero. */
export const NUVOLE_BASSE = {
  buono: 40, // % di copertura bassa sotto cui non pesa
  limite: 95, // % da cui il fattore vale `minimo`
  minimo: 0.3,
}

/** Visibilità (m): serve per il volo a vista (VLOS). */
export const VISIBILITA = {
  buona: 8000, // da qui in su non pesa
  limite: 1500, // sotto: fattore 0 (non si vede il drone)
}

/** Indice geomagnetico Kp (NOAA): disturba GPS e bussola. */
export const KP = {
  buono: 4, // fino a 4 non pesa
  limite: 7, // da qui il fattore vale `minimo`
  minimo: 0.5,
}

/** Luce: di notte non si vola (indice 0 prima dell'alba e dopo il tramonto). */
export const LUCE = {
  margineMin: 0, // minuti dopo l'alba / prima del tramonto da considerare già buio
}

/** Spazio aereo nella data scelta: si prende il tratto migliore del sentiero.
 *  Rosso = 0 su quel tratto; giallo = penalità secondo la quota massima consentita. */
export const SPAZIO_AEREO = {
  verde: 1,
  giallo: [
    { finoA: 25, fattore: 0.45 }, // max 25 m AGL
    { finoA: 45, fattore: 0.6 },
    { finoA: 60, fattore: 0.75 },
    { finoA: Infinity, fattore: 0.85 },
  ],
  rosso: 0,
}

/** Frasi per l'indice del giorno. */
export const LIVELLI = [
  { da: 75, nome: 'Ottimo' },
  { da: 60, nome: 'Buono' },
  { da: 40, nome: 'Discreto' },
  { da: 20, nome: 'Scarso' },
  { da: 0, nome: 'Non volabile' },
]

/** Una "finestra buona" è una serie di ore con indice almeno pari a questo. */
export const SOGLIA_FINESTRA = 60

/** Sotto questo indice la scheda spiega il motivo principale. */
export const SOGLIA_MOTIVO = 60

// ---------------------------------------------------------------- dati e prestazioni

/** Griglia per raggruppare i punti in una sola previsione (gradi) e fasce di quota (m). */
export const GRIGLIA_GRADI = 0.05
export const FASCIA_QUOTA_M = 200

/** Modelli meteo (Open-Meteo). Nei primi giorni MeteoSwiss ICON-CH (1–2 km, ottimo sulle Alpi,
 *  copre il Trentino); dopo, ECMWF IFS (9 km). Il secondo modello serve per l'"accordo tra modelli"
 *  e per i dati che il primo non ha (vento a 80/120 m e visibilità mancano in ICON-CH). */
export const MODELLI = {
  vicino: { primario: 'meteoswiss_icon_seamless', secondo: 'ecmwf_ifs' },
  lontano: { primario: 'ecmwf_ifs', secondo: 'gfs_seamless' },
}
/** Fino a quanti giorni da oggi si usa il modello "vicino" (oggi = 0). ICON-CH arriva a ~5 giorni. */
export const GIORNI_MODELLO_VICINO = 4

export const NOME_MODELLO: Record<string, string> = {
  meteoswiss_icon_seamless: 'MeteoSwiss ICON-CH (1–2 km)',
  ecmwf_ifs: 'ECMWF IFS (9 km)',
  gfs_seamless: 'NOAA GFS',
}

/** Disaccordo forte tra i due modelli nelle ore di luce → "previsione incerta". */
export const INCERTEZZA = {
  pioggiaMm: 2, // un modello asciutto (< 0,5 mm) e l'altro con almeno questi mm nel giorno
  oreDiPioggia: 3, // differenza di ore di pioggia (≥ 0,2 mm/h)
  raffiche: 20, // differenza delle raffiche massime (km/h)
}

/** Quanti giorni avanti prevede Open-Meteo (oltre: "nessuna previsione"). */
export const GIORNI_PREVISIONE = 15

/** Validità della cache (minuti). */
export const CACHE_MINUTI = 60

/** Massimo di sentieri per cui calcolare l'indice in una volta (i più vicini al centro mappa).
 *  Open-Meteo gratuito: 10.000 punti al giorno; ogni sentiero usa fino a 2 punti (molti condivisi). */
export const MAX_SENTIERI = 150

/** Quanti sentieri in cima alla lista dei risultati ricevono sempre l'indice (oltre a quelli in mappa). */
export const LISTA_METEO = 60

/** Punti per richiesta multi-punto a Open-Meteo. */
export const PUNTI_PER_RICHIESTA = 80
