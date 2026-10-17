// Geometria dei sentieri ricostruita dai tratti: linea completa, punti a una certa distanza,
// e intervalli (in metri dall'inizio) occupati da ciascun tratto.

import type { FC, SegmentProps } from './types'

export interface TrailLine {
  coords: [number, number][]
  cum: number[] // distanza cumulata (m) di ogni vertice
  segs: { id: string; from: number; to: number }[] // intervalli dei tratti, in m (lunghezze della pipeline)
  length: number // lunghezza totale secondo la pipeline (m)
}

const R = 6_371_008.8
function haversine(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLon = (b[0] - a[0]) * toRad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const order = (id: string) => Number(id.split('#')[1])

export function buildTrailLines(segments: FC<SegmentProps>): Map<string, TrailLine> {
  const groups = new Map<string, GeoJSON.Feature<GeoJSON.Geometry, SegmentProps>[]>()
  for (const f of segments.features) {
    const list = groups.get(f.properties.sentiero_id) ?? []
    list.push(f)
    groups.set(f.properties.sentiero_id, list)
  }
  const out = new Map<string, TrailLine>()
  for (const [id, feats] of groups) {
    feats.sort((a, b) => order(a.properties.id) - order(b.properties.id))
    const coords: [number, number][] = []
    const segs: TrailLine['segs'] = []
    let pos = 0
    for (const f of feats) {
      if (f.geometry?.type === 'LineString') {
        const c = f.geometry.coordinates as [number, number][]
        coords.push(...(coords.length ? c.slice(1) : c))
      }
      segs.push({ id: f.properties.id, from: pos, to: pos + f.properties.lunghezza_m })
      pos += f.properties.lunghezza_m
    }
    const cum = [0]
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]))
    out.set(id, { coords, cum, segs, length: pos })
  }
  return out
}

/** Punto sul sentiero a `m` metri dall'inizio (scala sulla lunghezza della pipeline). */
export function pointAt(line: TrailLine, m: number): [number, number] {
  const total = line.cum[line.cum.length - 1]
  const target = Math.max(0, Math.min(1, m / line.length)) * total
  let lo = 0
  let hi = line.cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (line.cum[mid] < target) lo = mid
    else hi = mid
  }
  const span = line.cum[hi] - line.cum[lo] || 1
  const t = (target - line.cum[lo]) / span
  const [a, b] = [line.coords[lo], line.coords[hi]]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Coordinate del sentiero tra `from` e `to` metri dall'inizio (scala della pipeline). */
export function sliceLine(line: TrailLine, from: number, to: number): [number, number][] {
  const total = line.cum[line.cum.length - 1]
  if (!total || line.coords.length < 2 || to - from < 1) return []
  const a = (Math.max(0, Math.min(line.length, from)) / line.length) * total
  const b = (Math.max(0, Math.min(line.length, to)) / line.length) * total
  const out: [number, number][] = [pointAt(line, from)]
  for (let i = 0; i < line.coords.length; i++) if (line.cum[i] > a && line.cum[i] < b) out.push(line.coords[i])
  out.push(pointAt(line, to))
  return out
}

/** Punto del sentiero più vicino a `p`: metri dall'inizio (scala della pipeline), distanza (m)
 *  e coordinate del punto agganciato alla linea. */
export function projectOnLine(line: TrailLine, p: [number, number]): { along: number; d: number; at: [number, number] } {
  const c = line.coords
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180)
  const ky = 110_540
  let best = Infinity
  let along = 0
  let at: [number, number] = c[0]
  for (let i = 1; i < c.length; i++) {
    const ax = c[i - 1][0] * kx
    const ay = c[i - 1][1] * ky
    const dx = c[i][0] * kx - ax
    const dy = c[i][1] * ky - ay
    const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] * kx - ax) * dx + (p[1] * ky - ay) * dy) / (dx * dx + dy * dy))) : 0
    const d = Math.hypot(p[0] * kx - (ax + t * dx), p[1] * ky - (ay + t * dy))
    if (d < best) {
      best = d
      along = line.cum[i - 1] + t * (line.cum[i] - line.cum[i - 1])
      at = [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t]
    }
  }
  const total = line.cum[line.cum.length - 1] || 1
  return { along: (along / total) * line.length, d: best, at }
}
