// "Trova percorsi": percorsi combinati (anche non ufficiali) da un parcheggio a una meta.
//
// La rete SAT diventa un grafo (network.json) a cui si aggiungono come nodi i parcheggi
// (finder.json, pipeline/finder.py) e i punti dei sentieri più vicini alle mete (POI dei
// sentieri). Da ogni parcheggio si cerca il cammino più breve (Dijkstra) verso ogni meta, usando
// solo i tratti che rispettano i filtri (pendenza, difficoltà, sentieri aperti). Si tiene, per
// ogni meta, il percorso più corto che sta nei limiti di lunghezza, quota e dislivello.
// La lunghezza è SOLO ANDATA: parcheggio → sentiero → meta.

import { Heap, mergePieces, type Network, type Piece } from './network'
import type { PoiCategory, PoiProps, Profile, Trail } from './types'

export interface FinderFile {
  parcheggi: [number, number, string, number, number, string | null, string | null][] // lon, lat, sentiero, m, distanza, nome, tariffa
  archi: ([number | null, number | null, number | null])[] // per arco: pendenza max %, quota min, quota max
  sentieri: Record<string, number | null> // pendenza max % del sentiero intero
}

export const SLOPE_WINDOW_M = 100 // come pipeline/finder.py
export const SPUR_MAX_M = 400 // meta al massimo a questa distanza dal sentiero

interface Sub {
  a: number
  b: number
  trail: string
  from: number // m lungo il sentiero (from < to)
  to: number
  slope: number // pendenza max (%), su finestre di ~100 m
  qmax: number
  up: number // dislivello positivo da a verso b
  down: number
}

interface Park {
  node: number
  lngLat: [number, number]
  nome: string | null
  tariffa: string | null
  dist: number // m dal parcheggio al sentiero (linea d'aria)
}

interface Target {
  node: number
  poi: string
  d: number // m dalla meta al sentiero
}

export interface FinderGraph {
  n: number
  subs: Sub[]
  adj: number[][]
  pos: { trail: string; m: number }[] // per i nodi virtuali (e per quelli della rete: primo sentiero)
  parks: Park[]
  targets: Map<number, Target[]> // nodo → mete agganciate lì
}

/** Pendenza max, quota max, salita e discesa di un tratto dal profilo LiDAR. */
function profileStats(p: Profile | undefined, a: number, b: number): Omit<Sub, 'a' | 'b' | 'trail' | 'from' | 'to'> {
  if (!p || !p.q.length) return { slope: 0, qmax: 0, up: 0, down: 0 }
  const q = p.q
  const passo = p.passo || 1
  const i0 = Math.max(0, Math.min(q.length - 1, Math.floor(a / passo)))
  const i1 = Math.max(0, Math.min(q.length - 1, Math.ceil(b / passo)))
  const k = Math.max(1, Math.round(SLOPE_WINDOW_M / passo))
  let slope = 0
  if (i1 - i0 >= k) for (let i = i0; i + k <= i1; i++) slope = Math.max(slope, (Math.abs(q[i + k] - q[i]) / (k * passo)) * 100)
  else if (i1 > i0) slope = (Math.abs(q[i1] - q[i0]) / ((i1 - i0) * passo)) * 100
  let qmax = -Infinity
  let up = 0
  let down = 0
  for (let i = i0; i <= i1; i++) {
    qmax = Math.max(qmax, q[i])
    if (i > i0) {
      const dq = q[i] - q[i - 1]
      if (dq > 0) up += dq
      else down -= dq
    }
  }
  return { slope, qmax, up, down }
}

/** Grafo della ricerca: rete SAT + parcheggi + punti delle mete, archi spezzati lì. */
export function buildFinderGraph(
  net: Network,
  f: FinderFile,
  trails: Trail[],
  profiles: Record<string, Profile>,
  lengthOf: (id: string) => number,
  /** Mete al posto dei POI dei sentieri (es. un solo punto scelto sulla mappa). */
  only?: { trail: string; m: number; poi: string; d: number }[],
): FinderGraph {
  type Pt = { m: number; kind: 'park' | 'poi'; ref: number | { poi: string; d: number } }
  const byTrail = new Map<string, Pt[]>()
  const add = (trail: string, p: Pt) => byTrail.set(trail, [...(byTrail.get(trail) ?? []), p])
  f.parcheggi.forEach((r, i) => add(r[2], { m: r[3], kind: 'park', ref: i }))
  if (only) for (const o of only) add(o.trail, { m: o.m, kind: 'poi', ref: { poi: o.poi, d: o.d } })
  else for (const t of trails) for (const tp of t.poi) if (tp.d <= SPUR_MAX_M) add(t.id, { m: tp.km * 1000, kind: 'poi', ref: { poi: tp.id, d: tp.d } })

  let n = net.nodes.length
  const pos: FinderGraph['pos'] = net.nodes.map(() => ({ trail: '', m: 0 }))
  const subs: Sub[] = []
  const parks: Park[] = []
  const targets = new Map<number, Target[]>()
  const parkNode = new Map<number, number>()
  const usedPts = new Set<Pt>()
  net.edges.forEach((e) => {
    if (!pos[e.a].trail) pos[e.a] = { trail: e.trail, m: e.from }
    if (!pos[e.b].trail) pos[e.b] = { trail: e.trail, m: e.to }
    const L = lengthOf(e.trail)
    const pts = (byTrail.get(e.trail) ?? []).filter((p) => !usedPts.has(p) && p.m >= e.from - 0.5 && (p.m < e.to || (p.m <= e.to + 0.5 && e.to >= L - 1)))
    pts.sort((x, y) => x.m - y.m)
    const chain: { node: number; m: number }[] = [{ node: e.a, m: e.from }]
    for (const p of pts) {
      usedPts.add(p)
      const m = Math.max(e.from, Math.min(e.to, p.m))
      let node: number
      const last = chain[chain.length - 1]
      if (m - last.m < 1) node = last.node
      else if (e.to - m < 1) node = e.b
      else {
        node = n++
        pos.push({ trail: e.trail, m })
        chain.push({ node, m })
      }
      if (p.kind === 'park') parkNode.set(p.ref as number, node)
      else {
        const r = p.ref as { poi: string; d: number }
        targets.set(node, [...(targets.get(node) ?? []), { node, poi: r.poi, d: r.d }])
      }
    }
    chain.push({ node: e.b, m: e.to })
    const prof = profiles[e.trail]
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1]
      const b = chain[i]
      if (a.node === b.node) continue
      subs.push({ a: a.node, b: b.node, trail: e.trail, from: a.m, to: b.m, ...profileStats(prof, a.m, b.m) })
    }
  })
  for (const [i, node] of parkNode) {
    const r = f.parcheggi[i]
    parks.push({ node, lngLat: [r[0], r[1]], nome: r[5], tariffa: r[6], dist: r[4] })
  }
  const adj: number[][] = Array.from({ length: n }, () => [])
  subs.forEach((s, i) => {
    adj[s.a].push(i)
    adj[s.b].push(i)
  })
  return { n, subs, adj, pos, parks, targets }
}

export interface FindQuery {
  cats: Set<PoiCategory> // mete cercate (vuoto = tutte)
  lenMin: number // m, solo andata
  lenMax: number
  quotaMin: number | null // quota più alta raggiunta (m), almeno
  quotaMax: number | null // … al massimo
  dislMax: number | null // D+ dell'andata (m)
  slopeMax: number | null // %
  blocked: (trail: string) => boolean // sentieri chiusi o di difficoltà esclusa
  bbox: [number, number, number, number] | null // solo mete in questa zona
  perParking?: boolean // un risultato per parcheggio (tutti i modi di arrivare a una meta) invece che uno per meta
}

export interface FoundRoute {
  poi: string
  park: Park
  pieces: Piece[]
  start: { trail: string; m: number }
  end: { trail: string; m: number }
  spur: number // m dal sentiero alla meta
  totalM: number // parcheggio → meta (linea d'aria + sentiero + deviazione)
  dplus: number
  qmax: number
  slope: number
  trailsUsed: number
}

const yieldUi = () => new Promise<void>((r) => setTimeout(r, 0))

export async function findRoutes(g: FinderGraph, q: FindQuery, pois: Map<string, PoiProps>, poiCoord: Map<string, [number, number]>, onProgress?: (share: number) => void, cancelled?: () => boolean): Promise<FoundRoute[]> {
  // Mete valide (categoria, zona) e i loro nodi.
  const wanted = new Map<number, Target[]>()
  for (const [node, list] of g.targets) {
    const ok = list.filter((t) => {
      const p = pois.get(t.poi)
      const ll = poiCoord.get(t.poi)
      if (!p || !ll) return false
      if (q.cats.size && !q.cats.has(p.categoria)) return false
      if (q.bbox && (ll[0] < q.bbox[0] || ll[0] > q.bbox[2] || ll[1] < q.bbox[1] || ll[1] > q.bbox[3])) return false
      return true
    })
    if (ok.length) wanted.set(node, ok)
  }
  if (!wanted.size) return []
  // Parcheggi abbastanza vicini (linea d'aria) ad almeno una meta.
  const goals = [...wanted.values()].flat().map((t) => poiCoord.get(t.poi)!)
  const cell = 0.05
  const gridKey = (ll: [number, number]) => `${Math.floor(ll[0] / cell)}_${Math.floor(ll[1] / cell)}`
  const goalCells = new Set(goals.map(gridKey))
  const reachCells = Math.ceil(q.lenMax / 3500) + 1 // ~3,5 km per cella in longitudine
  const near = (ll: [number, number]) => {
    const gx = Math.floor(ll[0] / cell)
    const gy = Math.floor(ll[1] / cell)
    for (let dx = -reachCells; dx <= reachCells; dx++) for (let dy = -reachCells; dy <= reachCells; dy++) if (goalCells.has(`${gx + dx}_${gy + dy}`)) return true
    return false
  }
  const parks = g.parks.filter((p) => p.dist < q.lenMax && near(p.lngLat))

  const allowed = new Uint8Array(g.subs.length)
  g.subs.forEach((s, i) => {
    allowed[i] = Number(!q.blocked(s.trail) && (q.slopeMax == null || s.slope <= q.slopeMax))
  })
  const dist = new Float64Array(g.n).fill(Infinity)
  const prev = new Int32Array(g.n).fill(-1)
  const touched: number[] = []
  const best = new Map<string, FoundRoute>()
  let lastYield = performance.now()

  for (let pi = 0; pi < parks.length; pi++) {
    if (cancelled?.()) return []
    if (performance.now() - lastYield > 30) {
      onProgress?.(pi / parks.length)
      await yieldUi()
      lastYield = performance.now()
    }
    const park = parks[pi]
    for (const v of touched) {
      dist[v] = Infinity
      prev[v] = -1
    }
    touched.length = 0
    const bound = q.lenMax - park.dist
    dist[park.node] = 0
    touched.push(park.node)
    const heap = new Heap()
    heap.push(0, park.node)
    while (heap.size) {
      const [d, u] = heap.pop()
      if (d > dist[u]) continue
      const here = wanted.get(u)
      if (here) {
        for (const t of here) {
          const total = park.dist + d + t.d
          if (total < q.lenMin || total > q.lenMax) continue
          const key = q.perParking ? `${pi}|${u}` : t.poi
          const old = best.get(key)
          if (old && old.totalM <= total) continue
          const r = trace(g, prev, park, u, t, total, pois, q.perParking ? wanted : null)
          if (!r) continue
          if (q.quotaMin != null && r.qmax < q.quotaMin) continue
          if (q.quotaMax != null && r.qmax > q.quotaMax) continue
          if (q.dislMax != null && r.dplus > q.dislMax) continue
          best.set(key, r)
        }
      }
      for (const si of g.adj[u]) {
        if (!allowed[si]) continue
        const s = g.subs[si]
        const v = s.a === u ? s.b : s.a
        const nd = d + (s.to - s.from)
        if (nd > bound || nd >= dist[v]) continue
        if (dist[v] === Infinity) touched.push(v)
        dist[v] = nd
        prev[v] = si
        heap.push(nd, v)
      }
    }
  }
  onProgress?.(1)
  const out = [...best.values()].sort((a, b) => a.totalM - b.totalM)
  if (!q.perParking) return out
  // Parcheggi diversi che finiscono sullo stesso cammino: si tiene il più corto.
  const seen = new Set<string>()
  return out.filter((r) => {
    const k = r.pieces.map((p) => `${p.trail}:${Math.round(p.to / 50)}`).join('|') + `|${r.pieces[0].trail}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Ricostruisce il cammino (pezzi di sentiero in ordine) e ne calcola D+, quota e pendenza. */
function trace(g: FinderGraph, prev: Int32Array, park: Park, goal: number, t: Target, total: number, pois: Map<string, PoiProps>, skipThrough: Map<number, Target[]> | null): FoundRoute | null {
  const raw: Piece[] = []
  let dplus = 0
  let qmax = -Infinity
  let slope = 0
  let u = goal
  let guard = 0
  while (u !== park.node && guard++ < 100000) {
    const si = prev[u]
    if (si < 0) return null
    const s = g.subs[si]
    const fwd = s.b === u // percorso da a verso b
    raw.push(fwd ? { trail: s.trail, from: s.from, to: s.to } : { trail: s.trail, from: s.to, to: s.from })
    dplus += fwd ? s.up : s.down
    qmax = Math.max(qmax, s.qmax)
    slope = Math.max(slope, s.slope)
    u = fwd ? s.a : s.b
    // passa prima da un altro punto d'arrivo: quel percorso (più corto) è già tra i risultati
    if (skipThrough && u !== park.node && skipThrough.has(u)) return null
  }
  raw.reverse()
  const pieces = mergePieces(raw)
  if (!pieces.length) return null
  const ele = pois.get(t.poi)?.ele
  if (ele != null) qmax = Math.max(qmax, ele)
  return {
    poi: t.poi,
    park,
    pieces,
    start: { trail: pieces[0].trail, m: pieces[0].from },
    end: { trail: pieces[pieces.length - 1].trail, m: pieces[pieces.length - 1].to },
    spur: t.d,
    totalM: total,
    dplus: Math.round(dplus),
    qmax: Math.round(qmax),
    slope: Math.round(slope),
    trailsUsed: new Set(pieces.map((p) => p.trail)).size,
  }
}
