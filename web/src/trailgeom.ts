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
