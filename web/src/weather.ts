// Meteo da Open-Meteo (gratuito, uso non commerciale) e indice Kp da NOAA SWPC.
// Tutto nel browser: nessun dato meteo va su Firestore. I punti si raggruppano in una griglia
// (con fascia di quota, perché in montagna il meteo dipende dall'altezza) e si chiedono con
// richieste multi-punto; cache in memoria e nel browser per un'ora.

import { CACHE_MINUTI, FASCIA_QUOTA_M, GIORNI_PREVISIONE, GRIGLIA_GRADI, PUNTI_PER_RICHIESTA } from './flyconfig'

/** Meteo di un'ora in un punto. */
export interface HourWx {
  temp: number | null // °C a 2 m
  pp: number | null // probabilità di pioggia %
  mm: number | null // pioggia mm nell'ora
  w10: number | null // vento a 10 m, km/h
  w80: number | null
  w120: number | null
  g10: number | null // raffiche a 10 m, km/h
  cl: number | null // nuvole basse %
  vis: number | null // visibilità m
}

export interface PointWx {
  hours: HourWx[] // 24 ore locali (0–23)
  sunrise: string | null // "HH:MM" locale
  sunset: string | null
  utcOffset: number // secondi (ora legale compresa)
}

/** Punto per la previsione, già agganciato alla griglia. */
export interface WxPoint {
  key: string
  lat: number
  lon: number
  ele: number
}

export function gridPoint(lon: number, lat: number, ele: number): WxPoint {
  const gy = Math.round(lat / GRIGLIA_GRADI)
  const gx = Math.round(lon / GRIGLIA_GRADI)
  const band = Math.round(ele / FASCIA_QUOTA_M)
  return { key: `${gy}:${gx}:${band}`, lat: +(gy * GRIGLIA_GRADI).toFixed(4), lon: +(gx * GRIGLIA_GRADI).toFixed(4), ele: band * FASCIA_QUOTA_M }
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** C'è una previsione per questo giorno? (passato o troppo lontano: no) */
export function forecastState(day: string): 'ok' | 'passato' | 'lontano' {
  const today = iso(new Date())
  if (day < today) return 'passato'
  const max = new Date()
  max.setDate(max.getDate() + GIORNI_PREVISIONE)
  return day > iso(max) ? 'lontano' : 'ok'
}

// ---------------------------------------------------------------- cache

type Entry = { at: number; d: PointWx | null }
const mem = new Map<string, Entry>() // `${giorno}|${chiave}`
const STORE_KEY = 'meteo-cache-v1'
const fresh = (e: Entry | undefined) => !!e && Date.now() - e.at < CACHE_MINUTI * 60_000

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Entry>
  for (const [k, e] of Object.entries(saved)) if (fresh(e)) mem.set(k, e)
} catch {
  // archiviazione non disponibile: solo cache in memoria
}

let saveTimer = 0
function persist(): void {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const out: Record<string, Entry> = {}
    for (const [k, e] of mem) if (fresh(e)) out[k] = e
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(out))
    } catch {
      // spazio finito: si tiene solo la cache in memoria
      try {
        localStorage.removeItem(STORE_KEY)
      } catch {
        /* niente */
      }
    }
  }, 500)
}

// ---------------------------------------------------------------- Open-Meteo

const HOURLY = ['temperature_2m', 'precipitation_probability', 'precipitation', 'wind_speed_10m', 'wind_speed_80m', 'wind_speed_120m', 'wind_gusts_10m', 'cloud_cover_low', 'visibility']

interface OmLocation {
  utc_offset_seconds: number
  hourly: Record<string, (number | null)[]> & { time: string[] }
  daily?: { sunrise?: string[]; sunset?: string[] }
}

function parseLocation(l: OmLocation): PointWx {
  const H = l.hourly
  const v = (name: string, i: number) => {
    const x = H[name]?.[i]
    return x == null || Number.isNaN(x) ? null : Number(x)
  }
  const hours: HourWx[] = []
  for (let i = 0; i < 24; i++) {
    hours.push({
      temp: v('temperature_2m', i),
      pp: v('precipitation_probability', i),
      mm: v('precipitation', i),
      w10: v('wind_speed_10m', i),
      w80: v('wind_speed_80m', i),
      w120: v('wind_speed_120m', i),
      g10: v('wind_gusts_10m', i),
      cl: v('cloud_cover_low', i),
      vis: v('visibility', i),
    })
  }
  const hm = (s: string | undefined) => (s ? s.slice(11, 16) : null)
  return { hours, sunrise: hm(l.daily?.sunrise?.[0]), sunset: hm(l.daily?.sunset?.[0]), utcOffset: l.utc_offset_seconds ?? 0 }
}

const inflight = new Map<string, Promise<void>>()

// Open-Meteo gratuito ha limiti al minuto: se risponde "troppe richieste" (429) o è occupato
// (503) ci si ferma un minuto invece di insistere.
let pausedUntil = 0
export const weatherPaused = () => Date.now() < pausedUntil

async function fetchBatch(day: string, pts: WxPoint[]): Promise<void> {
  const u = new URL('https://api.open-meteo.com/v1/forecast')
  u.searchParams.set('latitude', pts.map((p) => p.lat).join(','))
  u.searchParams.set('longitude', pts.map((p) => p.lon).join(','))
  u.searchParams.set('elevation', pts.map((p) => p.ele).join(','))
  u.searchParams.set('hourly', HOURLY.join(','))
  u.searchParams.set('daily', 'sunrise,sunset')
  u.searchParams.set('timezone', 'Europe/Rome')
  u.searchParams.set('wind_speed_unit', 'kmh')
  u.searchParams.set('start_date', day)
  u.searchParams.set('end_date', day)
  const res = await fetch(u)
  if (res.status === 429 || res.status === 503) pausedUntil = Date.now() + 60_000
  if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`)
  const json = (await res.json()) as OmLocation | OmLocation[]
  const list = Array.isArray(json) ? json : [json]
  const at = Date.now()
  pts.forEach((p, i) => mem.set(`${day}|${p.key}`, { at, d: list[i] ? parseLocation(list[i]) : null }))
  persist()
}

/** Meteo del giorno nei punti richiesti (dalla cache quando possibile). */
export async function getWeather(day: string, pts: WxPoint[]): Promise<Map<string, PointWx | null>> {
  const out = new Map<string, PointWx | null>()
  if (forecastState(day) !== 'ok') return out
  const unique = [...new Map(pts.map((p) => [p.key, p])).values()]
  const missing = weatherPaused() ? [] : unique.filter((p) => !fresh(mem.get(`${day}|${p.key}`)) && !inflight.has(`${day}|${p.key}`))
  for (let i = 0; i < missing.length; i += PUNTI_PER_RICHIESTA) {
    const batch = missing.slice(i, i + PUNTI_PER_RICHIESTA)
    const job = fetchBatch(day, batch).finally(() => batch.forEach((p) => inflight.delete(`${day}|${p.key}`)))
    batch.forEach((p) => inflight.set(`${day}|${p.key}`, job))
  }
  await Promise.allSettled(unique.map((p) => inflight.get(`${day}|${p.key}`)).filter(Boolean))
  for (const p of unique) {
    const e = mem.get(`${day}|${p.key}`)
    if (e) out.set(p.key, e.d)
  }
  return out
}

/** Dalla sola cache (senza richieste): per ridisegnare subito. */
export function cachedWeather(day: string, key: string): PointWx | null | undefined {
  const e = mem.get(`${day}|${key}`)
  return fresh(e) ? e!.d : undefined
}

// ---------------------------------------------------------------- Kp (NOAA SWPC)

let kpCache: { at: number; byUtc3h: Map<number, number> } | null = null
let kpJob: Promise<Map<number, number>> | null = null

/** Previsione Kp a blocchi di 3 ore (UTC). Mappa: inizio del blocco (ms) → Kp. */
export async function getKp(): Promise<Map<number, number>> {
  if (kpCache && Date.now() - kpCache.at < CACHE_MINUTI * 60_000) return kpCache.byUtc3h
  kpJob ??= fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`NOAA: HTTP ${r.status}`))))
    .then((rows: unknown) => {
      const map = new Map<number, number>()
      for (const row of rows as unknown[]) {
        // Formato attuale: { time_tag, kp }; vecchio: ["time_tag", "kp", ...] con intestazione.
        const [tag, kp] = Array.isArray(row) ? [row[0], row[1]] : [(row as { time_tag: string }).time_tag, (row as { kp: number }).kp]
        const t = Date.parse(`${String(tag).replace(' ', 'T').slice(0, 19)}Z`)
        const k = Number(kp)
        if (Number.isFinite(t) && Number.isFinite(k)) map.set(t, k)
      }
      kpCache = { at: Date.now(), byUtc3h: map }
      return map
    })
    .finally(() => (kpJob = null))
  return kpJob
}

/** Kp per un'ora locale del giorno (null se fuori dalla previsione NOAA, circa 3 giorni). */
export function kpAt(kp: Map<number, number> | null, day: string, hour: number, utcOffset: number): number | null {
  if (!kp) return null
  const [y, m, d] = day.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d, hour) - utcOffset * 1000
  const block = utc - (utc % (3 * 3_600_000))
  return kp.get(block) ?? null
}
