// Regola dei tre colori applicata a una data (stessa logica di pipeline/dflight.py).

import type { Restriction, SegmentProps, ZoneProps } from './types'

export const VERDE: Restriction = { colore: 'verde', tipo_rosso: null, quota_max_m: null }

/** Vince la zona più restrittiva: rosso > giallo (quota minore) > verde. */
export function combine(list: Restriction[]): Restriction {
  const active = list.filter((r) => r.colore !== 'verde')
  if (!active.length) return VERDE
  const reds = active.filter((r) => r.colore === 'rosso')
  if (reds.length) {
    const vietato = reds.some((r) => r.tipo_rosso === 'vietato')
    return { colore: 'rosso', tipo_rosso: vietato ? 'vietato' : 'autorizzazione', quota_max_m: null }
  }
  return { colore: 'giallo', tipo_rosso: null, quota_max_m: Math.min(...active.map((r) => r.quota_max_m ?? 0)) }
}

/** Data locale di oggi in formato YYYY-MM-DD. */
export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Inizio e fine (ms) della giornata locale. */
function dayRange(day: string): [number, number] {
  const [y, m, d] = day.split('-').map(Number)
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()]
}

/** Una zona è attiva nel giorno se la sua validità si sovrappone anche solo in parte alla giornata. */
export function isActive(z: ZoneProps, day: string): boolean {
  if (z.permanente) return true
  const [from, to] = dayRange(day)
  const start = z.inizio ? Date.parse(z.inizio) : -Infinity
  const end = z.fine ? Date.parse(z.fine) : Infinity
  return start < to && end > from
}

export interface Effective extends Restriction {
  notam: string[] // NOTAM attivi nel giorno che coprono il tratto
}

/** Colore del tratto nel giorno: colore fisso + NOTAM attivi. */
export function effective(seg: SegmentProps, zones: Map<string, ZoneProps>, day: string): Effective {
  const notam = split(seg.zone_temporanee).filter((id) => {
    const z = zones.get(id)
    return z !== undefined && isActive(z, day)
  })
  const r = combine([seg, ...notam.map((id) => zones.get(id)!)])
  return { ...r, notam }
}

export function split(list: string | null | undefined): string[] {
  return list ? list.split(',').filter(Boolean) : []
}
