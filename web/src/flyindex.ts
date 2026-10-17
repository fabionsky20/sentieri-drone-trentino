// Indice di volabilità 0–100 per ora: spazio aereo × vento × raffiche × pioggia × nuvole basse
// × visibilità × Kp × luce. Le soglie sono in flyconfig.ts.
// REGOLA FISSA: l'indice usa solo i LIMITI dello spazio aereo, mai quote di volo dell'utente.

import {
  INCERTEZZA,
  KP,
  LIVELLI,
  NOME_MODELLO,
  LUCE,
  NUVOLE_BASSE,
  PESO_LEGGERO_G,
  PESO_MEDIO_G,
  PIOGGIA,
  SOGLIA_FINESTRA,
  SOGLIA_MOTIVO,
  SPAZIO_AEREO,
  VENTO,
  VISIBILITA,
  type DroneProfile,
} from './flyconfig'
import type { Effective } from './flight'
import type { HourWx, PointWx } from './weather'

/** Profilo di soglie dal peso del drone (senza drone: il più prudente, sub-250 g). */
export function droneProfile(d: { peso_g: number } | null): DroneProfile {
  if (!d || d.peso_g < PESO_LEGGERO_G) return 'mini'
  return d.peso_g < PESO_MEDIO_G ? 'leggero' : 'medio'
}

/** Da 1 (fino a `buono`) a `minimo` (a `limite`), lineare; oltre il limite `oltre`. */
function ramp(v: number, buono: number, limite: number, minimo = 0, oltre = minimo): number {
  if (v <= buono) return 1
  if (v >= limite) return oltre
  return 1 - ((v - buono) / (limite - buono)) * (1 - minimo)
}

export interface Factor {
  k: 'aria' | 'vento' | 'raffiche' | 'pioggia' | 'nuvole' | 'visibilita' | 'kp' | 'luce'
  f: number // 0–1
  why: string // motivo leggibile (quando pesa)
}

/** Spazio aereo nella data scelta: il tratto migliore del sentiero (rosso 0, giallo penalità). */
export function airFactor(effs: Effective[]): Factor {
  let best: Factor = { k: 'aria', f: SPAZIO_AEREO.rosso, why: 'spazio aereo: solo tratti rossi (vietato o autorizzazione)' }
  for (const e of effs) {
    if (e.colore === 'verde') return { k: 'aria', f: SPAZIO_AEREO.verde, why: '' }
    if (e.colore === 'giallo') {
      const q = e.quota_max_m ?? 0
      const f = SPAZIO_AEREO.giallo.find((g) => q <= g.finoA)?.fattore ?? 0.5
      if (f > best.f) best = { k: 'aria', f, why: `spazio aereo: quota massima ${q} m` }
    }
  }
  return best
}

const minutes = (hm: string | null) => (hm ? Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) : null)

/** Fattori meteo di un'ora in un punto. */
function weatherFactors(w: HourWx, profile: DroneProfile): Factor[] {
  const V = VENTO[profile]
  const out: Factor[] = []
  const quota = Math.max(w.w80 ?? 0, w.w120 ?? 0, w.w10 ?? 0)
  out.push({ k: 'vento', f: ramp(quota, V.quotaBuono, V.quotaLimite), why: `vento ${Math.round(quota)} km/h in quota` })
  if (w.g10 != null) out.push({ k: 'raffiche', f: ramp(w.g10, V.raffBuono, V.raffLimite), why: `raffiche ${Math.round(w.g10)} km/h` })
  // Pioggia: contano i mm previsti nell'ora (sotto 0,2 mm/h è asciutto); la probabilità no.
  const mm = w.mm ?? 0
  const fRain = mm < PIOGGIA.asciuttoSotto ? 1 : mm < PIOGGIA.forteDa ? PIOGGIA.debole : 0
  out.push({ k: 'pioggia', f: fRain, why: `pioggia ${mm.toLocaleString('it-IT', { maximumFractionDigits: 1 })} mm/h` })
  if (w.cl != null) out.push({ k: 'nuvole', f: ramp(w.cl, NUVOLE_BASSE.buono, NUVOLE_BASSE.limite, NUVOLE_BASSE.minimo), why: `nuvole basse ${Math.round(w.cl)}% (nebbia)` })
  if (w.vis != null) {
    const f = w.vis >= VISIBILITA.buona ? 1 : w.vis <= VISIBILITA.limite ? 0 : (w.vis - VISIBILITA.limite) / (VISIBILITA.buona - VISIBILITA.limite)
    out.push({ k: 'visibilita', f, why: `visibilità ${(w.vis / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km` })
  }
  return out
}

export interface HourScore {
  h: number // ora locale 0–23
  index: number // 0–100
  night: boolean
  worst: Factor | null // il fattore che pesa di più
  kp: number | null
}

/** Indice di un'ora: per ogni fattore il punto peggiore tra quelli del sentiero. */
export function scoreHour(points: PointWx[], h: number, profile: DroneProfile, air: Factor, kp: number | null): HourScore {
  const sun = points[0]
  const rise = minutes(sun.sunrise)
  const set = minutes(sun.sunset)
  // L'ora vale come "di giorno" se almeno metà dell'ora è tra alba e tramonto.
  const mid = h * 60 + 30
  const night = rise == null || set == null ? false : mid < rise + LUCE.margineMin || mid >= set - LUCE.margineMin
  const byKind = new Map<string, Factor>()
  const add = (f: Factor) => {
    const prev = byKind.get(f.k)
    if (!prev || f.f < prev.f) byKind.set(f.k, f)
  }
  for (const p of points) for (const f of weatherFactors(p.hours[h], profile)) add(f)
  add(air)
  if (kp != null) add({ k: 'kp', f: ramp(kp, KP.buono, KP.limite, KP.minimo), why: `Kp ${kp.toLocaleString('it-IT', { maximumFractionDigits: 1 })} (disturbo a GPS e bussola)` })
  if (night) add({ k: 'luce', f: 0, why: 'buio' })
  let prod = 1
  let worst: Factor | null = null
  for (const f of byKind.values()) {
    prod *= f.f
    if (f.f < 1 && (!worst || f.f < worst.f)) worst = f
  }
  return { h, index: Math.round(prod * 100), night, worst, kp }
}

export interface DaySummary {
  index: number // indice del giorno (media delle 3 ore migliori consecutive)
  level: string // Ottimo, Buono, …
  window: [number, number] | null // ore [inizio, fine) della finestra migliore
  reason: string | null // motivo principale quando l'indice è basso
  hours: HourScore[]
  best: number // ora migliore
}

export const levelOf = (i: number) => LIVELLI.find((l) => i >= l.da)?.nome ?? 'Non volabile'

export function summarize(hours: HourScore[]): DaySummary {
  const day = hours.filter((s) => !s.night)
  let index = 0
  let start = -1
  for (let i = 0; i < day.length; i++) {
    const run = day.slice(i, i + 3)
    if (run.length < Math.min(3, day.length)) break
    const avg = run.reduce((s, x) => s + x.index, 0) / run.length
    if (avg > index) {
      index = avg
      start = i
    }
  }
  index = Math.round(index)
  // Finestra: la serie più lunga di ore sopra soglia (a parità, quella con media più alta).
  let window: [number, number] | null = null
  let bestScore = -1
  for (let i = 0; i < hours.length; i++) {
    if (hours[i].index < SOGLIA_FINESTRA) continue
    let j = i
    while (j + 1 < hours.length && hours[j + 1].index >= SOGLIA_FINESTRA) j++
    const run = hours.slice(i, j + 1)
    const score = run.length * 1000 + run.reduce((s, x) => s + x.index, 0) / run.length
    if (score > bestScore) {
      bestScore = score
      window = [hours[i].h, hours[j].h + 1]
    }
    i = j
  }
  const bestHour = day.length ? day.reduce((a, b) => (b.index > a.index ? b : a)) : hours[12]
  // Motivo: il fattore che limita di più nelle ore migliori (non "buio").
  let reason: string | null = null
  if (index < SOGLIA_MOTIVO) {
    const pool = start >= 0 ? day.slice(start, start + 3) : day
    const w = pool.map((s) => s.worst).filter((f): f is Factor => !!f && f.k !== 'luce').sort((a, b) => a.f - b.f)[0]
    reason = w?.why ?? (day.length ? null : 'nessuna ora di luce')
  }
  return { index, level: levelOf(index), window, reason, hours, best: bestHour?.h ?? 12 }
}

// ---------------------------------------------------------------- pioggia del giorno e accordo tra modelli

const dayHours = (p: PointWx, hs: HourWx[]) => {
  const rise = minutes(p.sunrise) ?? 6 * 60
  const set = minutes(p.sunset) ?? 19 * 60
  return hs.filter((_, h) => h * 60 + 30 >= rise && h * 60 + 30 < set)
}

export interface RainInfo {
  ore: number // ore di luce con pioggia (≥ 0,2 mm/h)
  mm: number // mm nelle ore di luce
  probMax: number | null // probabilità massima (informazione secondaria)
}

/** Pioggia nelle ore di luce, nel punto peggiore del sentiero. */
export function rainOfDay(points: PointWx[]): RainInfo {
  let worst: RainInfo = { ore: 0, mm: 0, probMax: null }
  for (const p of points) {
    const hs = dayHours(p, p.hours)
    const r: RainInfo = {
      ore: hs.filter((h) => (h.mm ?? 0) >= PIOGGIA.asciuttoSotto).length,
      mm: hs.reduce((s, h) => s + (h.mm ?? 0), 0),
      probMax: hs.some((h) => h.pp != null) ? Math.max(...hs.map((h) => h.pp ?? 0)) : null,
    }
    if (r.mm > worst.mm || r.ore > worst.ore) worst = { ...r, probMax: Math.max(r.probMax ?? 0, worst.probMax ?? 0) }
    else if (r.probMax != null) worst.probMax = Math.max(worst.probMax ?? 0, r.probMax)
  }
  return worst
}

export interface Agreement {
  stato: 'buono' | 'incerto' | 'nd'
  modelli: [string, string] | null // nomi leggibili
  dettaglio: string | null // es. "pioggia: ICON-CH 0 mm, ECMWF 4 mm"
}

const short = (m: string) => (NOME_MODELLO[m] ?? m).replace(/ \(.*\)$/, '').replace('MeteoSwiss ', '')

/** Confronto tra i due modelli nelle ore di luce: pioggia (mm e ore) e raffiche massime. */
export function agreement(points: PointWx[]): Agreement {
  const p = points.find((x) => x.alt && x.altModel)
  if (!p || !p.alt || !p.altModel) return { stato: 'nd', modelli: null, dettaglio: null }
  const a = dayHours(p, p.hours)
  const b = dayHours(p, p.alt)
  const mm = (hs: HourWx[]) => hs.reduce((s, h) => s + (h.mm ?? 0), 0)
  const ore = (hs: HourWx[]) => hs.filter((h) => (h.mm ?? 0) >= PIOGGIA.asciuttoSotto).length
  const raff = (hs: HourWx[]) => Math.max(0, ...hs.map((h) => h.g10 ?? 0))
  const [na, nb] = [short(p.model), short(p.altModel)]
  const fmt = (x: number) => x.toLocaleString('it-IT', { maximumFractionDigits: 1 })
  const [ma, mb, oa, ob, ga, gb] = [mm(a), mm(b), ore(a), ore(b), raff(a), raff(b)]
  const motivi: string[] = []
  const secco = (x: number) => x < 0.5
  if ((secco(ma) && mb >= INCERTEZZA.pioggiaMm) || (secco(mb) && ma >= INCERTEZZA.pioggiaMm) || Math.abs(oa - ob) >= INCERTEZZA.oreDiPioggia) {
    motivi.push(`pioggia: ${na} ${fmt(ma)} mm, ${nb} ${fmt(mb)} mm`)
  }
  if (Math.abs(ga - gb) >= INCERTEZZA.raffiche) motivi.push(`raffiche: ${na} ${Math.round(ga)} km/h, ${nb} ${Math.round(gb)} km/h`)
  return { stato: motivi.length ? 'incerto' : 'buono', modelli: [na, nb], dettaglio: motivi.join(' · ') || null }
}

export const fmtWindow = (w: [number, number]) => `${w[0]}:00–${w[1]}:00`

/** Frase del giorno: "Buono: finestra migliore 7:00–10:00" o il motivo. */
export function sentence(s: DaySummary): string {
  if (s.window && s.index >= SOGLIA_MOTIVO) return `${s.level}: finestra migliore ${fmtWindow(s.window)}`
  if (s.reason) return `${s.level}: ${s.reason}`
  return s.window ? `${s.level}: finestra ${fmtWindow(s.window)}` : s.level
}
