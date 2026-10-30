// Percorso personalizzato → "sentiero sintetico": stessa forma dei sentieri SAT (Trail, TrailLine,
// profilo) così la scheda, il profilo, il meteo, i POI e l'anteprima 3D funzionano uguali.

import { anchorAt as anchorAtFn, componentOf, closestPair, mergePieces, metersBetween, nearestAnchor, shortestPath, type Anchor, type Network, type Piece } from './network'
import { sliceLine, type TrailLine } from './trailgeom'
import type { PoiProps, Profile, Trail, TrailPoi } from './types'

export const ROUTE_PREFIX = 'percorso:'
export const isRoute = (id: string) => id.startsWith(ROUTE_PREFIX)

/** Una tappa del percorso (partenza, punto intermedio, arrivo): un punto di sentiero, oppure una
 *  meta (POI) fuori sentiero agganciata al punto di sentiero più vicino. */
export interface RouteStop {
  anchor: Anchor
  poi?: { id: string; nome: string; lngLat: [number, number] }
}
export type RouteEnd = RouteStop

/** Pezzo in linea retta: "buco" tra reti non collegate o deviazione fino a una meta fuori sentiero. */
export interface StraightSeg {
  a: [number, number]
  b: [number, number]
  meters: number
}

/** Da una tappa alla successiva. */
export interface RouteStage {
  legs: Piece[][] // 1 tratto continuo, o 2 se le reti non sono collegate
  gap?: StraightSeg // "buco" non coperto da sentieri SAT
  spur?: StraightSeg // dal sentiero fino alla meta della tappa d'arrivo (se è fuori sentiero)
}

export interface RoutePlan {
  stops: RouteStop[] // almeno 2: partenza, intermedi, arrivo
  stages: RouteStage[] // stops.length - 1
  start: Anchor // = stops[0].anchor
  end: RouteStop // = ultima tappa
}

const spurOf = (s: RouteStop): StraightSeg | undefined =>
  s.poi && metersBetween(s.anchor.lngLat, s.poi.lngLat) > 15 ? { a: s.anchor.lngLat, b: s.poi.lngLat, meters: metersBetween(s.anchor.lngLat, s.poi.lngLat) } : undefined

/** Più breve sul grafo tra due punti; se le reti non sono collegate, due mezzi percorsi verso la
 *  coppia di punti più vicini e il "buco" in mezzo. */
function planStage(net: Network, lines: Map<string, TrailLine>, from: Anchor, to: RouteStop): RouteStage {
  const spur = spurOf(to)
  const ca = componentOf(net, from)
  const cb = componentOf(net, to.anchor)
  if (ca === cb) {
    const p = shortestPath(net, from, to.anchor)
    if (p) return { legs: [p.pieces], spur }
  }
  const pair = closestPair(net, lines, ca, cb)
  if (!pair) return { legs: [], spur }
  const first = shortestPath(net, from, pair.a)
  const second = shortestPath(net, pair.b, to.anchor)
  return { legs: [first?.pieces ?? [], second?.pieces ?? []], gap: { a: pair.a.lngLat, b: pair.b.lngLat, meters: pair.meters }, spur }
}

/** Calcola il percorso tappa per tappa (il più breve tra una tappa e la successiva), poi le unisce. */
export function planRoute(net: Network, lines: Map<string, TrailLine>, stops: RouteStop[]): RoutePlan {
  const stages = stops.slice(1).map((s, i) => planStage(net, lines, stops[i].anchor, s))
  return { stops, stages, start: stops[0].anchor, end: stops[stops.length - 1] }
}

/** Tutti i pezzi di sentiero in ordine. */
export const planPieces = (plan: RoutePlan): Piece[] => plan.stages.flatMap((s) => s.legs.flat())
/** Percorso vuoto (tappe coincidenti). */
export const planEmpty = (plan: RoutePlan) => !plan.stages.some((s) => s.gap || s.legs.some((l) => l.some((p) => Math.abs(p.to - p.from) > 1)))
/** Nome della tappa: la meta, o "km 3,2 di E325" / località. */
export const stopLabel = (s: RouteStop, trails: Map<string, Trail>) => s.poi?.nome ?? labelOf(s.anchor, trails)

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

const hm = (h: number) => {
  const m = Math.round(h * 60) // arrotondo i minuti totali: niente "0:60"
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
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
  plan.stages.forEach((stage, si) => {
    stage.legs.forEach((leg, i) => {
      if (i > 0 && stage.gap) {
        // buco: linea dritta (non camminata su sentiero SAT), quota interpolata
        const qa = q[q.length - 1]
        push([stage.gap.a, stage.gap.b])
        const n = Math.max(1, Math.round(stage.gap.meters / STEP))
        const first = leg[0]
        const qb = first ? elevAt(c.profiles?.[first.trail], first.from, c.lines.get(first.trail)?.length ?? 1) : null
        for (let k = 1; k < n; k++) if (qa != null && qb != null) q.push(qa + ((qb - qa) * k) / n)
        pos += stage.gap.meters
      }
      for (const p of leg) addPiece(p)
    })
    // meta della tappa (anche intermedia) tra i POI del percorso
    const stop = plan.stops[si + 1]
    if (stop.poi && !poi.some((x) => x.id === stop.poi!.id)) poi.push({ id: stop.poi.id, d: Math.round(stage.spur?.meters ?? 0), km: Math.round((pos / 1000) * 100) / 100 })
  })
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
  const endLbl = stopLabel(plan.end, c.trails)
  const km = walked / 1000
  const allPieces = mergePieces(planPieces(plan))
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
  // pezzi di pochi metri (partenza su un incrocio, tracciati condivisi) non dicono nulla: nascosti
  const shown = pieces.filter((p) => Math.abs(p.to - p.from) >= 50)
  return (shown.length ? shown : pieces).map((p) => `${trails.get(p.trail)?.numero ?? p.trail} per ${(Math.abs(p.to - p.from) / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`).join(' → ')
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

// ---------------------------------------------------------------- salvataggio (Firestore)

/** Percorso salvato: abbastanza per ridisegnarlo (geometria) e per ricalcolarlo se i sentieri SAT
 *  cambiano (tratti usati + partenza e arrivo). Nessun dato di volo. */
export interface RoutePoint {
  lon: number
  lat: number
  sentiero: string
  m: number
  poi?: string | null
  poiNome?: string | null
}

export interface RouteDoc {
  nome: string
  partenza: RoutePoint
  arrivo: RoutePoint
  tappe?: RoutePoint[] // punti intermedi in ordine (assente nei percorsi salvati prima)
  tratti: { s: string; da: number; a: number; g: number }[] // g = tratto continuo (cambia dopo ogni buco)
  geometria: string // encoded polyline
  km: number
  dplus: number
  buco_m: number | null
}

export interface SavedRoute extends RouteDoc {
  id: string
  da?: string // in una bacheca: chi l'ha aggiunto
  daNome?: string
  aggiunto?: Date | null
}

const r1 = (v: number) => Math.round(v * 10) / 10
const r5 = (v: number) => Math.round(v * 1e5) / 1e5

function toPoint(s: RouteStop, withPoi: boolean): RoutePoint {
  const a = s.anchor
  const p: RoutePoint = { lon: r5(a.lngLat[0]), lat: r5(a.lngLat[1]), sentiero: a.trail, m: r1(a.m) }
  return withPoi ? { ...p, poi: s.poi?.id ?? null, poiNome: s.poi?.nome.slice(0, 80) ?? null } : p
}

export function toDoc(name: string, plan: RoutePlan, build: RouteBuild): RouteDoc {
  const tratti: RouteDoc['tratti'] = []
  let g = 0
  for (const st of plan.stages) {
    st.legs.forEach((leg, i) => {
      if (i > 0) g++ // dopo un buco
      for (const p of leg) tratti.push({ s: p.trail, da: r1(p.from), a: r1(p.to), g })
    })
  }
  const gaps = plan.stages.reduce((sum, s) => sum + (s.gap?.meters ?? 0), 0)
  return {
    nome: (name || build.trail.titolo).slice(0, 80),
    partenza: toPoint(plan.stops[0], false),
    arrivo: toPoint(plan.end, true),
    tappe: plan.stops.slice(1, -1).map((s) => toPoint(s, true)),
    tratti,
    geometria: encodePolyline(build.line.coords),
    km: Math.round(build.walkedM / 10) / 100,
    dplus: build.trail.dislivello_pos ?? 0,
    buco_m: gaps ? Math.round(gaps) : null,
  }
}

/** Ricostruisce il piano da un percorso salvato, tappa per tappa (partenza, `tappe` se ci sono,
 *  arrivo) sul grafo attuale; i percorsi salvati senza `tappe` funzionano uguale. `ricalcolato` =
 *  i tratti salvati non esistono più (shapefile SAT cambiato) e il percorso è diverso: l'app lo dice. */
export function planFromDoc(d: RouteDoc, net: Network, lines: Map<string, TrailLine>, bboxes: Map<string, [number, number, number, number]>, poiCoord: Map<string, [number, number]>): { plan: RoutePlan; ricalcolato: boolean } | null {
  const anchorFor = (p: RoutePoint) => (lines.has(p.sentiero) && net.byTrail.has(p.sentiero) ? anchorAtSafe(net, p) : null) ?? nearestAnchor(net, lines, bboxes, [p.lon, p.lat])
  const stops: RouteStop[] = []
  for (const p of [d.partenza, ...(d.tappe ?? []), d.arrivo]) {
    const anchor = anchorFor(p)
    if (!anchor) return null
    const ll = p.poi ? poiCoord.get(p.poi) : undefined
    stops.push({ anchor, poi: p.poi && ll ? { id: p.poi, nome: p.poiNome ?? 'Meta', lngLat: ll } : undefined })
  }
  const plan = planRoute(net, lines, stops)
  const now = planPieces(plan)
  const same = now.length === d.tratti.length && now.every((p, k) => p.trail === d.tratti[k].s && Math.abs(p.from - d.tratti[k].da) < 3 && Math.abs(p.to - d.tratti[k].a) < 3)
  const stillThere = piecesValid(d.tratti.map((x) => ({ trail: x.s, from: x.da, to: x.a })), lines)
  return { plan, ricalcolato: !same && !stillThere }
}

function anchorAtSafe(net: Network, p: { lon: number; lat: number; sentiero: string; m: number }): Anchor | null {
  return anchorAtFn(net, p.sentiero, p.m, [p.lon, p.lat])
}

export { nearestAnchor }
