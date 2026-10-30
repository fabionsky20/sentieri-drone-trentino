// Percorso personalizzato → "sentiero sintetico": stessa forma dei sentieri SAT (Trail, TrailLine,
// profilo) così la scheda, il profilo, il meteo, i POI e l'anteprima 3D funzionano uguali.

import { componentOf, closestPair, mergePieces, metersBetween, nearestAnchor, shortestPath, type Anchor, type Network, type Piece } from './network'
import { sliceLine, type TrailLine } from './trailgeom'
import type { PoiProps, Profile, Trail, TrailPoi } from './types'

export const ROUTE_PREFIX = 'percorso:'
export const isRoute = (id: string) => id.startsWith(ROUTE_PREFIX)

/** Dove finisce il percorso: un punto di sentiero oppure una meta (POI) fuori sentiero. */
export interface RouteEnd {
  anchor: Anchor
  poi?: { id: string; nome: string; lngLat: [number, number] }
}

export interface RoutePlan {
  start: Anchor
  end: RouteEnd
  legs: Piece[][] // 1 tratto continuo, o 2 se le reti non sono collegate
  gap?: { a: [number, number]; b: [number, number]; meters: number } // "buco" non coperto da sentieri SAT
  tail?: { a: [number, number]; b: [number, number]; meters: number } // ultimo pezzo fino alla meta
}

/** Calcola il percorso: più breve sul grafo; se le reti non sono collegate, due mezzi percorsi
 *  verso la coppia di punti più vicini e il "buco" in mezzo. */
export function planRoute(net: Network, lines: Map<string, TrailLine>, start: Anchor, end: RouteEnd): RoutePlan {
  const ca = componentOf(net, start)
  const cb = componentOf(net, end.anchor)
  const tail = end.poi && metersBetween(end.anchor.lngLat, end.poi.lngLat) > 15 ? { a: end.anchor.lngLat, b: end.poi.lngLat, meters: metersBetween(end.anchor.lngLat, end.poi.lngLat) } : undefined
  if (ca === cb) {
    const p = shortestPath(net, start, end.anchor)
    if (p) return { start, end, legs: [p.pieces], tail }
  }
  const pair = closestPair(net, lines, ca, cb)
  if (!pair) return { start, end, legs: [], tail }
  const first = shortestPath(net, start, pair.a)
  const second = shortestPath(net, pair.b, end.anchor)
  return { start, end, legs: [first?.pieces ?? [], second?.pieces ?? []], gap: { a: pair.a.lngLat, b: pair.b.lngLat, meters: pair.meters }, tail }
}

/** Ricalcolo da tratti salvati (se i sentieri esistono ancora con la stessa lunghezza). */
export function piecesValid(pieces: Piece[], lines: Map<string, TrailLine>): boolean {
  return pieces.every((p) => {
    const l = lines.get(p.trail)
    return !!l && Math.max(p.from, p.to) <= l.length + 2 && Math.min(p.from, p.to) >= -2
  })
}

// ---------------------------------------------------------------- sentiero sintetico

/** T < E < EE < EEA (le varianti EEA-F/PD/D contano come EEA). */
const diffRank = (d: string | null) => (d == null ? -1 : d.startsWith('EEA') ? 3 : ['T', 'E', 'EE'].indexOf(d))

/** Dislivello con isteresi (5 m), come pipeline/dem.gain_loss. */
function gainLoss(q: number[], th = 5): [number, number] {
  let up = 0
  let down = 0
  let ref = q[0]
  for (const v of q) {
    if (v - ref >= th) {
      up += v - ref
      ref = v
    } else if (ref - v >= th) {
      down += ref - v
      ref = v
    }
  }
  return [Math.round(up), Math.round(down)]
}

const hm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
/** Stima del tempo di cammino (4 km/h in piano, 400 m/h in salita, 800 m/h in discesa). */
const walkTime = (km: number, up: number, down: number) => {
  const h = km / 4
  const v = up / 400 + down / 800
  return Math.max(h, v) + Math.min(h, v) / 2
}

export interface RouteBuild {
  trail: Trail
  line: TrailLine
  profile: Profile
  pieces: Piece[] // tutti i pezzi in ordine (anche dopo il buco)
  walkedM: number // metri su sentiero (senza buco e ultimo pezzo)
}

export interface RouteCtx {
  trails: Map<string, Trail>
  lines: Map<string, TrailLine>
  profiles: Record<string, Profile> | null
  pois: Map<string, PoiProps>
}

function elevAt(p: Profile | undefined, m: number, L: number): number | null {
  if (!p || !p.q.length) return null
  const x = (m / (L || 1)) * p.lung
  const i = x / p.passo
  const i0 = Math.max(0, Math.min(p.q.length - 1, Math.floor(i)))
  const i1 = Math.min(p.q.length - 1, i0 + 1)
  return p.q[i0] + (p.q[i1] - p.q[i0]) * (i - i0)
}

export function buildRoute(id: string, name: string, plan: RoutePlan, c: RouteCtx): RouteBuild {
  const coords: [number, number][] = []
  const segs: TrailLine['segs'] = []
  const q: number[] = []
  const STEP = 20
  let pos = 0 // metri lungo il percorso (sentiero + buco)
  let walked = 0
  const poi: TrailPoi[] = []
  const used = new Set<string>()
  const push = (pts: [number, number][]) => {
    for (const p of pts) {
      const last = coords[coords.length - 1]
      if (!last || last[0] !== p[0] || last[1] !== p[1]) coords.push(p)
    }
  }
  const addPiece = (p: Piece) => {
    const line = c.lines.get(p.trail)
    const t = c.trails.get(p.trail)
    if (!line) return
    used.add(p.trail)
    const lo = Math.min(p.from, p.to)
    const hi = Math.max(p.from, p.to)
    const fwd = p.to >= p.from
    const pts = sliceLine(line, lo, hi)
    push(fwd ? pts : pts.reverse())
    // tratti D-Flight (stessi id dei segmenti: colori e NOTAM per data)
    for (const s of line.segs) {
      const a = Math.max(s.from, lo)
      const b = Math.min(s.to, hi)
      if (b - a < 0.5) continue
      const ra = fwd ? a - lo : hi - b
      segs.push({ id: s.id, from: pos + ra, to: pos + ra + (b - a) })
    }
    // profilo ogni 20 m
    const prof = c.profiles?.[p.trail]
    const L = line.length
    for (let d = 0; d <= hi - lo; d += STEP) {
      const v = elevAt(prof, fwd ? lo + d : hi - d, L)
      if (v != null) q.push(v)
    }
    // POI lungo il pezzo
    for (const tp of t?.poi ?? []) {
      const m = tp.km * 1000
      if (m < lo - 1 || m > hi + 1 || poi.some((x) => x.id === tp.id)) continue
      poi.push({ id: tp.id, d: tp.d, km: Math.round(((pos + (fwd ? m - lo : hi - m)) / 1000) * 100) / 100 })
    }
    pos += hi - lo
    walked += hi - lo
  }
  plan.legs.forEach((leg, i) => {
    if (i > 0 && plan.gap) {
      // buco: linea dritta (non camminata su sentiero SAT), quota interpolata
      const qa = q[q.length - 1]
      push([plan.gap.a, plan.gap.b])
      const n = Math.max(1, Math.round(plan.gap.meters / STEP))
      const first = leg[0]
      const qb = first ? elevAt(c.profiles?.[first.trail], first.from, c.lines.get(first.trail)?.length ?? 1) : null
      for (let k = 1; k < n; k++) if (qa != null && qb != null) q.push(qa + ((qb - qa) * k) / n)
      pos += plan.gap.meters
    }
    for (const p of leg) addPiece(p)
  })
  if (plan.end.poi) {
    const inList = poi.find((x) => x.id === plan.end.poi!.id)
    if (!inList) poi.push({ id: plan.end.poi.id, d: Math.round(plan.tail?.meters ?? 0), km: Math.round((pos / 1000) * 100) / 100 })
  }
  // TrailLine del percorso (cum geodetico come in trailgeom.buildTrailLines)
  const cum = [0]
  const R = 6_371_008.8
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]]
    const r = Math.PI / 180
    const s = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2
    cum.push(cum[i - 1] + 2 * R * Math.asin(Math.sqrt(s)))
  }
  const line: TrailLine = { coords, cum, segs, length: pos || 1 }
  const qq = q.length ? q : [0]
  const profile: Profile = { passo: STEP, lung: Math.max(pos, STEP), q: qq.map((v) => Math.round(v)) }
  const [up, down] = gainLoss(qq)
  const lons = coords.map((p) => p[0])
  const lats = coords.map((p) => p[1])
  const usedTrails = [...used].map((x) => c.trails.get(x)).filter((x): x is Trail => !!x)
  const diff = usedTrails.map((t) => t.difficolta).reduce<string | null>((a, b) => (diffRank(b) > diffRank(a) ? b : a), null)
  const startLbl = labelOf(plan.start, c.trails)
  const endLbl = plan.end.poi?.nome ?? labelOf(plan.end.anchor, c.trails)
  const km = walked / 1000
  const allPieces = mergePieces(plan.legs.flat())
  const trail: Trail = {
    id,
    numero: 'PERCORSO',
    nome: name,
    titolo: name || `${startLbl} → ${endLbl}`,
    difficolta: diff,
    loc_inizio: startLbl,
    loc_fine: endLbl,
    quota_inizio: Math.round(qq[0]),
    quota_fine: Math.round(qq[qq.length - 1]),
    quota_min: Math.round(Math.min(...qq)),
    quota_max: Math.round(Math.max(...qq)),
    lunghezza_m: Math.round(walked),
    lunghezza_inclinata_m: null,
    tempo_andata: hm(walkTime(km, up, down)),
    tempo_ritorno: hm(walkTime(km, down, up)),
    gruppo_montuoso: usedTrails[0]?.gruppo_montuoso ?? null,
    comuni: [],
    competenza: null,
    km_verde: 0,
    km_giallo: 0,
    km_rosso: 0,
    zone_temporanee: [...new Set(usedTrails.flatMap((t) => t.zone_temporanee))],
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    poi,
    badge: [...new Set(poi.map((p) => c.pois.get(p.id)?.categoria).filter((x): x is NonNullable<typeof x> => !!x))],
    dislivello_pos: up,
    dislivello_neg: down,
    quota_min_dem: Math.round(Math.min(...qq)),
    quota_max_dem: Math.round(Math.max(...qq)),
  }
  return { trail, line, profile, pieces: allPieces, walkedM: walked }
}

/** "km 3,2 di E325" (o nome della località se è un estremo del sentiero). */
export function labelOf(a: Anchor, trails: Map<string, Trail>): string {
  const t = trails.get(a.trail)
  if (t && a.m < 30 && t.loc_inizio) return t.loc_inizio
  if (t && t.lunghezza_m && Math.abs(a.m - t.lunghezza_m) < 30 && t.loc_fine) return t.loc_fine
  return `km ${(a.m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} di ${t?.numero ?? a.trail}`
}

/** "E327 per 2,1 km → E343 per 3,0 km". */
export function piecesText(pieces: Piece[], trails: Map<string, Trail>): string {
  return pieces.map((p) => `${trails.get(p.trail)?.numero ?? p.trail} per ${(Math.abs(p.to - p.from) / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`).join(' → ')
}

// ---------------------------------------------------------------- geometria compatta (polyline)

/** Codifica "encoded polyline" (precisione 1e-5), compatta per Firestore. */
export function encodePolyline(coords: [number, number][]): string {
  let out = ''
  let pLat = 0
  let pLon = 0
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1
    let r = ''
    while (s >= 0x20) {
      r += String.fromCharCode((0x20 | (s & 0x1f)) + 63)
      s >>= 5
    }
    return r + String.fromCharCode(s + 63)
  }
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e5)
    const lo = Math.round(lon * 1e5)
    out += enc(la - pLat) + enc(lo - pLon)
    pLat = la
    pLon = lo
  }
  return out
}

export function decodePolyline(s: string): [number, number][] {
  const out: [number, number][] = []
  let i = 0
  let lat = 0
  let lon = 0
  const dec = () => {
    let r = 0
    let shift = 0
    let b: number
    do {
      b = s.charCodeAt(i++) - 63
      r |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    return r & 1 ? ~(r >> 1) : r >> 1
  }
  while (i < s.length) {
    lat += dec()
    lon += dec()
    out.push([lon / 1e5, lat / 1e5])
  }
  return out
}

export { nearestAnchor }
