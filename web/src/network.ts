// Percorsi personalizzati: grafo della rete SAT (data/processed/network.json, pipeline/network.py)
// e calcolo del percorso più breve nel browser (Dijkstra con coda a priorità).
// Le posizioni sono "metri lungo la linea SAT del sentiero", come in trailgeom.ts (TrailLine).

import { projectOnLine, type TrailLine } from './trailgeom'

export interface NetworkFile {
  tolleranza_m: number
  nodi: [number, number, number][] // lon, lat, componente
  archi: [number, number, string, number, number, number, number][] // a, b, sentiero, da_m, a_m, d+, d-
}

export interface Edge {
  a: number
  b: number
  trail: string
  from: number // metri lungo il sentiero (from < to)
  to: number
}

export interface Network {
  nodes: [number, number][]
  comp: number[]
  edges: Edge[]
  adj: number[][] // archi uscenti da ogni nodo
  byTrail: Map<string, number[]> // archi di ogni sentiero, in ordine lungo la linea
}

export function buildNetwork(f: NetworkFile): Network {
  const nodes = f.nodi.map((n) => [n[0], n[1]] as [number, number])
  const comp = f.nodi.map((n) => n[2])
  const edges = f.archi.map(([a, b, trail, from, to]) => ({ a, b, trail, from, to }))
  const adj: number[][] = nodes.map(() => [])
  const byTrail = new Map<string, number[]>()
  edges.forEach((e, i) => {
    adj[e.a].push(i)
    adj[e.b].push(i)
    byTrail.set(e.trail, [...(byTrail.get(e.trail) ?? []), i])
  })
  for (const list of byTrail.values()) list.sort((x, y) => edges[x].from - edges[y].from)
  return { nodes, comp, edges, adj, byTrail }
}

/** Punto agganciato a un sentiero: l'arco che lo contiene viene "spezzato" lì. */
export interface Anchor {
  trail: string
  m: number // metri lungo il sentiero
  edge: number
  lngLat: [number, number]
}

export function anchorAt(net: Network, trail: string, m: number, lngLat: [number, number]): Anchor | null {
  const list = net.byTrail.get(trail)
  if (!list?.length) return null
  let best = list[0]
  let bestD = Infinity
  for (const i of list) {
    const e = net.edges[i]
    const d = m < e.from ? e.from - m : m > e.to ? m - e.to : 0
    if (d < bestD) [best, bestD] = [i, d]
  }
  const e = net.edges[best]
  return { trail, m: Math.max(e.from, Math.min(e.to, m)), edge: best, lngLat }
}

/** Il punto di sentiero più vicino a un luogo (es. una meta fuori sentiero). */
export function nearestAnchor(net: Network, lines: Map<string, TrailLine>, bboxes: Map<string, [number, number, number, number]>, p: [number, number], maxDeg = 0.08): Anchor | null {
  let best: { trail: string; along: number; d: number; at: [number, number] } | null = null
  for (const [id, bb] of bboxes) {
    if (p[0] < bb[0] - maxDeg || p[0] > bb[2] + maxDeg || p[1] < bb[1] - maxDeg || p[1] > bb[3] + maxDeg) continue
    const line = lines.get(id)
    if (!line || !net.byTrail.has(id)) continue
    const pr = projectOnLine(line, p)
    if (!best || pr.d < best.d) best = { trail: id, ...pr }
  }
  return best ? anchorAt(net, best.trail, best.along, best.at) : null
}

export const componentOf = (net: Network, a: Anchor) => net.comp[net.edges[a.edge].a]

/** Pezzo di percorso lungo un sentiero (from > to = percorso al contrario). */
export interface Piece {
  trail: string
  from: number
  to: number
}

// ---------------------------------------------------------------- Dijkstra

class Heap {
  private k: number[] = []
  private v: number[] = []
  get size(): number {
    return this.k.length
  }
  push(key: number, val: number): void {
    const k = this.k
    const v = this.v
    k.push(key)
    v.push(val)
    let i = k.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= k[i]) break
      ;[k[p], k[i]] = [k[i], k[p]]
      ;[v[p], v[i]] = [v[i], v[p]]
      i = p
    }
  }
  pop(): [number, number] {
    const k = this.k
    const v = this.v
    const top: [number, number] = [k[0], v[0]]
    const lk = k.pop()!
    const lv = v.pop()!
    if (k.length) {
      k[0] = lk
      v[0] = lv
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < k.length && k[l] < k[m]) m = l
        if (r < k.length && k[r] < k[m]) m = r
        if (m === i) break
        ;[k[m], k[i]] = [k[i], k[m]]
        ;[v[m], v[i]] = [v[i], v[m]]
        i = m
      }
    }
    return top
  }
}

const len = (e: Edge) => e.to - e.from
/** Costo (m) di un cambio di sentiero: tra due tracciati quasi uguali si resta sullo stesso numero. */
const CAMBIO_M = 25

/** Percorso più breve (in metri di sentiero) tra due punti agganciati; null se non collegati. */
export function shortestPath(net: Network, s: Anchor, t: Anchor): { pieces: Piece[]; length: number } | null {
  const es = net.edges[s.edge]
  const et = net.edges[t.edge]
  // Partenza e arrivo sullo stesso arco: si va diritti lungo il sentiero.
  let direct: { pieces: Piece[]; length: number } | null = null
  if (s.edge === t.edge) direct = { pieces: [{ trail: s.trail, from: s.m, to: t.m }], length: Math.abs(t.m - s.m) }

  // Dijkstra sugli ARCHI (stato = arco percorso + verso), così si sa da che sentiero si arriva e
  // cambiare sentiero costa CAMBIO_M: dove due numeri SAT condividono lo stesso tracciato si
  // resta sullo stesso, invece di saltare tra archi paralleli quasi identici.
  // Stato k = 2·arco + verso (0: da a verso b, si arriva in b; 1: da b verso a, si arriva in a).
  const S = net.edges.length * 2
  const dist = new Float64Array(S).fill(Infinity)
  const real = new Float64Array(S) // metri veri (senza penalità)
  const prev = new Int32Array(S).fill(-1)
  const heap = new Heap()
  const nodeOf = (k: number) => (k & 1 ? net.edges[k >> 1].a : net.edges[k >> 1].b)
  // Dalla partenza ai due capi del suo arco.
  const k0 = s.edge * 2
  dist[k0] = real[k0] = es.to - s.m
  dist[k0 + 1] = real[k0 + 1] = s.m - es.from
  heap.push(dist[k0], k0)
  heap.push(dist[k0 + 1], k0 + 1)
  const goal = (u: number, trail: string): number => {
    const pen = trail === t.trail ? 0 : CAMBIO_M
    if (u === et.a) return t.m - et.from + pen
    if (u === et.b) return et.to - t.m + pen
    return Infinity
  }
  let bound = direct?.length ?? Infinity
  let bestK = -1
  while (heap.size) {
    const [d, k] = heap.pop()
    if (d > dist[k] || d >= bound) continue
    const u = nodeOf(k)
    const cur = net.edges[k >> 1]
    // si può finire qui (sull'arco d'arrivo, senza ripercorrere lo stesso arco al contrario)
    const g = d + goal(u, cur.trail)
    if (g < bound) {
      bound = g
      bestK = k
    }
    for (const i of net.adj[u]) {
      if (i === k >> 1) continue // niente inversione sullo stesso arco
      const e = net.edges[i]
      const nk = i * 2 + (e.a === u ? 0 : 1)
      const step = len(e)
      const nd = d + step + (e.trail === cur.trail ? 0 : CAMBIO_M)
      if (nd < dist[nk]) {
        dist[nk] = nd
        real[nk] = real[k] + step
        prev[nk] = k
        heap.push(nd, nk)
      }
    }
  }
  if (bestK < 0) return direct
  const endNode = nodeOf(bestK)
  const length = real[bestK] + Math.abs(endNode === et.a ? t.m - et.from : et.to - t.m)
  if (direct && direct.length <= length + CAMBIO_M) return direct

  // Ricostruzione: dalla fine all'inizio, poi si gira.
  const rev: Piece[] = [{ trail: t.trail, from: endNode === et.a ? et.from : et.to, to: t.m }]
  let k = bestK
  while (k >= 0) {
    const e = net.edges[k >> 1]
    const fwd = (k & 1) === 0 // da a verso b
    if (prev[k] === -1) {
      // primo arco: dalla partenza (a metà arco) al suo capo
      rev.push({ trail: s.trail, from: s.m, to: fwd ? e.to : e.from })
      break
    }
    rev.push({ trail: e.trail, from: fwd ? e.from : e.to, to: fwd ? e.to : e.from })
    k = prev[k]
  }
  return { pieces: mergePieces(rev.reverse()), length }
}

/** Unisce i pezzi consecutivi sullo stesso sentiero e toglie quelli nulli. */
export function mergePieces(list: Piece[]): Piece[] {
  const out: Piece[] = []
  for (const p of list) {
    if (Math.abs(p.to - p.from) < 0.5) continue
    const last = out[out.length - 1]
    if (last && last.trail === p.trail && Math.abs(last.to - p.from) < 1 && Math.sign(last.to - last.from) === Math.sign(p.to - p.from)) last.to = p.to
    else out.push({ ...p })
  }
  return out
}

// ---------------------------------------------------------------- reti non collegate

/** Punti dei sentieri di una componente (con posizione lungo il sentiero), per la ricerca del buco. */
function vertices(net: Network, lines: Map<string, TrailLine>, comp: number): { p: [number, number]; trail: string; m: number }[] {
  const trails = new Set<string>()
  for (const e of net.edges) if (net.comp[e.a] === comp) trails.add(e.trail)
  const out: { p: [number, number]; trail: string; m: number }[] = []
  for (const id of trails) {
    const l = lines.get(id)
    if (!l) continue
    const total = l.cum[l.cum.length - 1] || 1
    l.coords.forEach((c, i) => out.push({ p: c, trail: id, m: (l.cum[i] / total) * l.length }))
  }
  return out
}

const KX = Math.cos((46.1 * Math.PI) / 180)
const dist2 = (a: [number, number], b: [number, number]) => ((a[0] - b[0]) * KX) ** 2 + (a[1] - b[1]) ** 2
export const metersBetween = (a: [number, number], b: [number, number]) => Math.sqrt(dist2(a, b)) * 111_195

/** La coppia di punti più vicina tra due reti separate (griglia da ~1 km per non provarle tutte). */
export function closestPair(net: Network, lines: Map<string, TrailLine>, compA: number, compB: number): { a: Anchor; b: Anchor; meters: number } | null {
  const A = vertices(net, lines, compA)
  const B = vertices(net, lines, compB)
  if (!A.length || !B.length) return null
  const CELL = 0.01
  const grid = new Map<string, number[]>()
  B.forEach((v, i) => {
    const key = `${Math.floor(v.p[0] / CELL)}:${Math.floor(v.p[1] / CELL)}`
    const list = grid.get(key)
    if (list) list.push(i)
    else grid.set(key, [i])
  })
  let best = { i: -1, j: -1, d: Infinity }
  for (let i = 0; i < A.length; i++) {
    const cx = Math.floor(A[i].p[0] / CELL)
    const cy = Math.floor(A[i].p[1] / CELL)
    for (let r = 0; r < 200; r++) {
      // oltre questo anello nessun punto può battere il migliore trovato
      const ringMin = Math.max(0, r - 1) * CELL * KX
      if (ringMin * ringMin > best.d) break
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const list = grid.get(`${cx + dx}:${cy + dy}`)
          if (!list) continue
          for (const j of list) {
            const d = dist2(A[i].p, B[j].p)
            if (d < best.d) best = { i, j, d }
          }
        }
      }
    }
  }
  if (best.i < 0) return null
  const va = A[best.i]
  const vb = B[best.j]
  const a = anchorAt(net, va.trail, va.m, va.p)
  const b = anchorAt(net, vb.trail, vb.m, vb.p)
  return a && b ? { a, b, meters: metersBetween(va.p, vb.p) } : null
}
