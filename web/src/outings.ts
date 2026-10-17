// Uscite ("segna come fatto"): tracce GPX, sentiero più vicino, statistiche personali.
// REGOLA FISSA: nessun dato sulla quota a cui si è volato. Dal GPX si prendono SOLO km e
// dislivello a piedi; la "quota più alta" delle statistiche è quella del sentiero, a piedi.

import type { TrailLine } from './trailgeom'
import type { PoiCategory, PoiProps, Trail } from './types'

export interface Outing {
  id: string
  sentiero: string
  data: string // AAAA-MM-GG
  con: string[] // nomi (amici dell'app o scritti a mano)
  conUid: string[] // uid degli amici dell'app scelti
  commento: string | null
  drone: boolean // ho portato il drone (nessun altro dato di volo)
  gpxKm: number | null // km reali dell'uscita, da GPX
  gpxDplus: number | null // dislivello positivo reale (m), da GPX
}

export type OutingInput = Omit<Outing, 'id'>

// ---------------------------------------------------------------- GPX

export interface GpxTrack {
  points: [number, number][] // lon, lat
  km: number
  dplus: number | null // null se la traccia non ha quote
  date: string | null // AAAA-MM-GG locale del primo punto con orario
  name: string | null
}

const R = 6_371_008.8
function haversine(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLon = (b[0] - a[0]) * toRad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Legge un file GPX (Strava, Garmin…): punti della traccia (o del percorso), km e D+. */
export function parseGpx(text: string): GpxTrack {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Il file non è un GPX valido.')
  let nodes = [...doc.getElementsByTagName('trkpt')]
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')]
  const pts: { c: [number, number]; ele: number | null; time: string | null }[] = []
  for (const n of nodes) {
    const lat = Number(n.getAttribute('lat'))
    const lon = Number(n.getAttribute('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const e = n.getElementsByTagName('ele')[0]?.textContent
    const t = n.getElementsByTagName('time')[0]?.textContent
    pts.push({ c: [lon, lat], ele: e != null && e.trim() !== '' && Number.isFinite(Number(e)) ? Number(e) : null, time: t ?? null })
  }
  if (pts.length < 2) throw new Error('La traccia GPX non contiene punti.')
  let m = 0
  for (let i = 1; i < pts.length; i++) m += haversine(pts[i - 1].c, pts[i].c)
  // D+ con soglia (3 m) per non sommare il rumore del GPS/barometro.
  const eles = pts.map((p) => p.ele).filter((e): e is number => e != null)
  let dplus: number | null = null
  if (eles.length > 1) {
    dplus = 0
    let ref = eles[0]
    for (const e of eles) {
      if (e - ref >= 3) {
        dplus += e - ref
        ref = e
      } else if (ref - e >= 3) ref = e
    }
    dplus = Math.round(dplus)
  }
  const first = pts.find((p) => p.time)?.time
  const when = first ? new Date(first) : null
  const name = doc.getElementsByTagName('name')[0]?.textContent?.trim() || null
  return { points: pts.map((p) => p.c), km: Math.round(m / 10) / 100, dplus, date: when && !isNaN(when.getTime()) ? isoDay(when) : null, name }
}

/** Distanza (m) di un punto da una polilinea, in proiezione locale (va bene a scala di km). */
function distToLine(p: [number, number], line: [number, number][], kx: number, ky: number): number {
  let best = Infinity
  const px = p[0] * kx
  const py = p[1] * ky
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0] * kx
    const ay = line[i - 1][1] * ky
    const bx = line[i][0] * kx
    const by = line[i][1] * ky
    const dx = bx - ax
    const dy = by - ay
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) best = d
  }
  return best
}

const NEAR_M = 80

export interface TrailMatch {
  trail: Trail
  share: number // quota di punti della traccia entro 80 m dal sentiero (0–1)
  mean: number // distanza media (m)
}

function sample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list
  const step = list.length / max
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)])
}

function scale(lat: number): [number, number] {
  return [(Math.PI / 180) * R * Math.cos((lat * Math.PI) / 180), (Math.PI / 180) * R]
}

/** Quanto la traccia segue un certo sentiero. */
export function matchTrail(track: GpxTrack, trail: Trail, line: TrailLine): TrailMatch {
  const pts = sample(track.points, 200)
  const [kx, ky] = scale(pts[0][1])
  let near = 0
  let sum = 0
  for (const p of pts) {
    const d = distToLine(p, line.coords, kx, ky)
    sum += Math.min(d, 5000)
    if (d <= NEAR_M) near++
  }
  return { trail, share: near / pts.length, mean: sum / pts.length }
}

/** Il sentiero SAT che la traccia segue di più (null se nessuno la tocca davvero). */
export function nearestTrail(track: GpxTrack, trails: Trail[], lines: Map<string, TrailLine>): TrailMatch | null {
  const lon = track.points.map((p) => p[0])
  const lat = track.points.map((p) => p[1])
  const pad = 0.01
  const bb = [Math.min(...lon) - pad, Math.min(...lat) - pad, Math.max(...lon) + pad, Math.max(...lat) + pad]
  let best: TrailMatch | null = null
  for (const t of trails) {
    const [w, s, e, n] = t.bbox
    if (e < bb[0] || w > bb[2] || n < bb[1] || s > bb[3]) continue
    const line = lines.get(t.id)
    if (!line || line.coords.length < 2) continue
    const m = matchTrail(track, t, line)
    if (!best || m.share > best.share + 1e-9 || (Math.abs(m.share - best.share) < 1e-9 && m.mean < best.mean)) best = m
  }
  return best && best.share >= 0.15 ? best : null
}

// ---------------------------------------------------------------- statistiche

export const COLLECT: PoiCategory[] = ['lago', 'vetta', 'rifugio', 'malga']

export interface Stats {
  anno: number | null // null = tutti gli anni
  uscite: number
  sentieri: number
  km: number
  dplus: number
  conDrone: number
  mesi: { km: number; dplus: number; uscite: number }[] // 12 mesi (solo per un anno)
  raccolti: Record<string, { id: string; nome: string }[]> // POI vicini ai sentieri fatti
  piuLunga: { km: number; trail: Trail; data: string } | null
  piuAlta: { quota: number; trail: Trail } | null // quota massima del sentiero, a piedi
  fatti: Set<string> // sentieri fatti nel periodo
}

export const outingKm = (o: Outing, t: Trail | undefined) => o.gpxKm ?? (t?.lunghezza_m ?? 0) / 1000
export const outingDplus = (o: Outing, t: Trail | undefined) => o.gpxDplus ?? t?.dislivello_pos ?? 0

export function yearsOf(list: Outing[]): number[] {
  const ys = new Set(list.map((o) => Number(o.data.slice(0, 4))))
  ys.add(new Date().getFullYear())
  return [...ys].sort((a, b) => b - a)
}

export function computeStats(all: Outing[], anno: number | null, trails: Map<string, Trail>, pois: Map<string, PoiProps>): Stats {
  const list = all.filter((o) => trails.has(o.sentiero) && (anno == null || o.data.startsWith(`${anno}-`)))
  const mesi = Array.from({ length: 12 }, () => ({ km: 0, dplus: 0, uscite: 0 }))
  let km = 0
  let dplus = 0
  let piuLunga: Stats['piuLunga'] = null
  const fatti = new Set<string>()
  for (const o of list) {
    const t = trails.get(o.sentiero)!
    const k = outingKm(o, t)
    const d = outingDplus(o, t)
    km += k
    dplus += d
    fatti.add(o.sentiero)
    const mi = Number(o.data.slice(5, 7)) - 1
    if (mi >= 0 && mi < 12) {
      mesi[mi].km += k
      mesi[mi].dplus += d
      mesi[mi].uscite++
    }
    if (!piuLunga || k > piuLunga.km) piuLunga = { km: k, trail: t, data: o.data }
  }
  let piuAlta: Stats['piuAlta'] = null
  const raccolti: Stats['raccolti'] = Object.fromEntries(COLLECT.map((c) => [c, []]))
  const seen = new Set<string>()
  for (const id of fatti) {
    const t = trails.get(id)!
    const q = t.quota_max_dem ?? t.quota_max
    if (q != null && (!piuAlta || q > piuAlta.quota)) piuAlta = { quota: Math.round(q), trail: t }
    for (const p of t.poi) {
      const info = pois.get(p.id)
      if (!info || seen.has(p.id) || !(info.categoria in raccolti)) continue
      seen.add(p.id)
      raccolti[info.categoria].push({ id: p.id, nome: info.nome })
    }
  }
  for (const c of COLLECT) raccolti[c].sort((a, b) => a.nome.localeCompare(b.nome, 'it'))
  return {
    anno,
    uscite: list.length,
    sentieri: fatti.size,
    km,
    dplus: Math.round(dplus),
    conDrone: list.filter((o) => o.drone).length,
    mesi,
    raccolti,
    piuLunga,
    piuAlta,
    fatti,
  }
}
