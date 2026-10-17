// Uscite ("segna come fatto"): tracce GPX, sentiero più vicino, statistiche personali.
// REGOLA FISSA: nessun dato sulla quota a cui si è volato. Dal GPX si prendono SOLO km e
// dislivello a piedi; la "quota più alta" delle statistiche è quella del sentiero, a piedi.

import type { TrailLine } from './trailgeom'
import type { PoiCategory, PoiProps, Profile, Trail } from './types'

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
  // Uscita parziale: capo di partenza e metri di sentiero fatti da lì. Le uscite salvate prima
  // di questa funzione non hanno questi campi: valgono come complete, solo andata.
  parziale: boolean
  partenza: 'inizio' | 'fine'
  finoM: number | null
  ar: boolean // andata e ritorno: km e dislivello contati nei due versi
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

const NEAR_M = 80

export interface TrailMatch {
  trail: Trail
  share: number // quota di punti della traccia entro 80 m dal sentiero (0–1)
  mean: number // distanza media (m)
  from: number // parte del sentiero coperta dalla traccia (m dall'inizio del sentiero)
  to: number
  firstAlong: number | null // dove la traccia tocca il sentiero la prima volta
}

function sample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list
  const step = list.length / max
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)])
}

function scale(lat: number): [number, number] {
  return [(Math.PI / 180) * R * Math.cos((lat * Math.PI) / 180), (Math.PI / 180) * R]
}

/** Distanza (m) di un punto dalla linea del sentiero e posizione del punto più vicino lungo di
 *  essa (m, sulla lunghezza della pipeline). Proiezione locale: va bene a scala di km. */
function nearestOnLine(p: [number, number], line: TrailLine, kx: number, ky: number): { d: number; along: number } {
  const c = line.coords
  let best = Infinity
  let along = 0
  const px = p[0] * kx
  const py = p[1] * ky
  for (let i = 1; i < c.length; i++) {
    const ax = c[i - 1][0] * kx
    const ay = c[i - 1][1] * ky
    const dx = c[i][0] * kx - ax
    const dy = c[i][1] * ky - ay
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) {
      best = d
      along = line.cum[i - 1] + t * (line.cum[i] - line.cum[i - 1])
    }
  }
  const total = line.cum[line.cum.length - 1] || 1
  return { d: best, along: (along / total) * line.length }
}

/** Quanto la traccia segue un certo sentiero, e quale parte ne copre. */
export function matchTrail(track: GpxTrack, trail: Trail, line: TrailLine): TrailMatch {
  const pts = sample(track.points, 300)
  const [kx, ky] = scale(pts[0][1])
  let near = 0
  let sum = 0
  let from = Infinity
  let to = -Infinity
  let firstAlong: number | null = null
  for (const p of pts) {
    const { d, along } = nearestOnLine(p, line, kx, ky)
    sum += Math.min(d, 5000)
    if (d <= NEAR_M) {
      near++
      from = Math.min(from, along)
      to = Math.max(to, along)
      firstAlong ??= along
    }
  }
  return { trail, share: near / pts.length, mean: sum / pts.length, from: near ? from : 0, to: near ? to : 0, firstAlong }
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

export interface RouteChoice {
  parziale: boolean
  partenza: 'inizio' | 'fine'
  finoM: number
  ar: boolean
}

/** Proposta di uscita dalla traccia: completa, oppure parziale dal capo più vicino alla parte
 *  coperta; andata e ritorno se la traccia è lunga circa il doppio di quella parte. */
export function proposeFromGpx(m: TrailMatch, track: GpxTrack, length: number): RouteChoice {
  const covered = Math.max(0, m.to - m.from)
  const ar = covered > 200 && track.km * 1000 > covered * 1.6
  if (m.from <= length * 0.03 && m.to >= length * 0.97) return { parziale: false, partenza: 'inizio', finoM: Math.round(length), ar }
  const gapStart = m.from
  const gapEnd = length - m.to
  const partenza: 'inizio' | 'fine' = gapStart < gapEnd || (gapStart === gapEnd && (m.firstAlong ?? 0) < length / 2) ? 'inizio' : 'fine'
  return { parziale: true, partenza, finoM: Math.round(partenza === 'inizio' ? m.to : length - m.from), ar }
}

// ---------------------------------------------------------------- parte fatta di un sentiero

export const DONE_SHARE = 0.97 // da questa quota in su il sentiero conta come completato

/** Intervallo del sentiero percorso da un'uscita (m dall'inizio del sentiero). */
export function outingRange(o: Pick<Outing, 'parziale' | 'partenza' | 'finoM'>, length: number): [number, number] {
  if (!o.parziale || o.finoM == null) return [0, length]
  const f = Math.max(0, Math.min(length, o.finoM))
  return o.partenza === 'fine' ? [length - f, length] : [0, f]
}

/** Unione delle parti fatte di un sentiero. */
export function coverage(list: Outing[], length: number): { ranges: [number, number][]; done: number; complete: boolean } {
  const rs = list.map((o) => outingRange(o, length)).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of rs) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  const done = out.reduce((s, r) => s + r[1] - r[0], 0)
  return { ranges: out, done, complete: length > 0 && done >= length * DONE_SHARE }
}

/** Quota (m) a `m` metri dall'inizio (scala della pipeline), dal profilo altimetrico. */
export function elevAt(p: Profile, m: number, length: number): number {
  const i = Math.max(0, Math.min(p.q.length - 1, Math.round(((m / (length || 1)) * p.lung) / p.passo)))
  return p.q[i]
}

/** Dislivello positivo nel verso di marcia, da `a` a `b` (m del profilo). */
function climb(p: Profile, a: number, b: number): number {
  const i0 = Math.round(Math.min(a, b) / p.passo)
  const i1 = Math.min(p.q.length - 1, Math.round(Math.max(a, b) / p.passo))
  let up = 0
  if (a <= b) for (let i = i0 + 1; i <= i1; i++) up += Math.max(0, p.q[i] - p.q[i - 1])
  else for (let i = i1 - 1; i >= i0; i--) up += Math.max(0, p.q[i] - p.q[i + 1])
  return up
}

/** Km dell'uscita: dal GPX, altrimenti la parte di sentiero fatta (× 2 se andata e ritorno). */
export function outingKm(o: Outing, t: Trail | undefined, length?: number): number {
  if (o.gpxKm != null) return o.gpxKm
  const L = length ?? t?.lunghezza_m ?? 0
  const [a, b] = outingRange(o, L)
  return ((b - a) / 1000) * (o.ar ? 2 : 1)
}

/** Dislivello positivo dell'uscita: dal GPX, altrimenti dal profilo della parte fatta. */
export function outingDplus(o: Outing, t: Trail | undefined, profile?: Profile, length?: number): number {
  if (o.gpxDplus != null) return o.gpxDplus
  if (!t) return 0
  const L = length ?? t.lunghezza_m ?? 0
  const [a, b] = outingRange(o, L)
  const back = o.parziale && o.partenza === 'fine'
  if (profile) {
    const r = profile.lung / (L || 1)
    const [s, e] = back ? [b * r, a * r] : [a * r, b * r]
    const up = climb(profile, s, e)
    return Math.round(o.ar ? up + climb(profile, e, s) : up)
  }
  // Senza profilo: in proporzione alla parte fatta.
  const f = L ? (b - a) / L : 1
  const pos = (t.dislivello_pos ?? 0) * f
  const neg = (t.dislivello_neg ?? 0) * f
  return Math.round(o.ar ? pos + neg : back ? neg : pos)
}

// ---------------------------------------------------------------- statistiche

export const COLLECT: PoiCategory[] = ['lago', 'vetta', 'rifugio', 'malga']

export interface Stats {
  anno: number | null // null = tutti gli anni
  uscite: number
  sentieri: number // sentieri toccati (completati + iniziati)
  completati: number
  iniziati: number // iniziati ma non finiti
  km: number
  dplus: number
  conDrone: number
  mesi: { km: number; dplus: number; uscite: number }[] // 12 mesi (solo per un anno)
  raccolti: Record<string, { id: string; nome: string }[]> // POI vicini alle parti fatte
  piuLunga: { km: number; trail: Trail; data: string } | null
  piuAlta: { quota: number; trail: Trail } | null // quota massima raggiunta a piedi
  fatti: Set<string> // sentieri toccati nel periodo
  parti: Map<string, [number, number][]> // parti fatte per sentiero (m)
}

export function yearsOf(list: Outing[]): number[] {
  const ys = new Set(list.map((o) => Number(o.data.slice(0, 4))))
  ys.add(new Date().getFullYear())
  return [...ys].sort((a, b) => b - a)
}

export function computeStats(
  all: Outing[],
  anno: number | null,
  trails: Map<string, Trail>,
  pois: Map<string, PoiProps>,
  lines: Map<string, TrailLine>,
  profiles?: Record<string, Profile> | null,
): Stats {
  const list = all.filter((o) => trails.has(o.sentiero) && (anno == null || o.data.startsWith(`${anno}-`)))
  const mesi = Array.from({ length: 12 }, () => ({ km: 0, dplus: 0, uscite: 0 }))
  const lenOf = (id: string) => lines.get(id)?.length ?? trails.get(id)?.lunghezza_m ?? 0
  let km = 0
  let dplus = 0
  let piuLunga: Stats['piuLunga'] = null
  const byTrail = new Map<string, Outing[]>()
  for (const o of list) {
    const t = trails.get(o.sentiero)!
    const L = lenOf(o.sentiero)
    const k = outingKm(o, t, L)
    const d = outingDplus(o, t, profiles?.[o.sentiero], L)
    km += k
    dplus += d
    byTrail.set(o.sentiero, [...(byTrail.get(o.sentiero) ?? []), o])
    const mi = Number(o.data.slice(5, 7)) - 1
    if (mi >= 0 && mi < 12) {
      mesi[mi].km += k
      mesi[mi].dplus += d
      mesi[mi].uscite++
    }
    if (!piuLunga || k > piuLunga.km) piuLunga = { km: k, trail: t, data: o.data }
  }
  let piuAlta: Stats['piuAlta'] = null
  let completati = 0
  const parti = new Map<string, [number, number][]>()
  const raccolti: Stats['raccolti'] = Object.fromEntries(COLLECT.map((c) => [c, []]))
  const seen = new Set<string>()
  for (const [id, outs] of byTrail) {
    const t = trails.get(id)!
    const L = lenOf(id)
    const cov = coverage(outs, L)
    parti.set(id, cov.ranges)
    if (cov.complete) completati++
    const inside = (m: number) => cov.ranges.some(([a, b]) => m >= a - 1 && m <= b + 1)
    // Quota più alta raggiunta a piedi: dal profilo nelle parti fatte; senza profilo solo se completo.
    const p = profiles?.[id]
    let q: number | null = null
    if (p) {
      const r = p.lung / (L || 1)
      for (let i = 0; i < p.q.length; i++) if (inside((i * p.passo) / r)) q = Math.max(q ?? -Infinity, p.q[i])
    } else if (cov.complete) q = t.quota_max_dem ?? t.quota_max
    if (q != null && (!piuAlta || q > piuAlta.quota)) piuAlta = { quota: Math.round(q), trail: t }
    for (const tp of t.poi) {
      const info = pois.get(tp.id)
      if (!info || seen.has(tp.id) || !(info.categoria in raccolti) || !inside(tp.km * 1000)) continue
      seen.add(tp.id)
      raccolti[info.categoria].push({ id: tp.id, nome: info.nome })
    }
  }
  for (const c of COLLECT) raccolti[c].sort((a, b) => a.nome.localeCompare(b.nome, 'it'))
  return {
    anno,
    uscite: list.length,
    sentieri: byTrail.size,
    completati,
    iniziati: byTrail.size - completati,
    km,
    dplus: Math.round(dplus),
    conDrone: list.filter((o) => o.drone).length,
    mesi,
    raccolti,
    piuLunga,
    piuAlta,
    fatti: new Set(byTrail.keys()),
    parti,
  }
}
