// "Come arrivare" calcolato nel browser per i percorsi personalizzati (partenza qualsiasi): stessa
// logica di pipeline/access.py (parcheggio pubblico entro 1 km, altrimenti la strada più vicina entro
// 3 km, escluse autostrade e superstrade) sulle celle 0,1° di data/processed/accesso/.

import type { AccessPoint } from './access'

const CELL_DEG = 0.1
const PARKING_MAX_M = 1000
const ROAD_MAX_M = 3000

type Cell = { p: [number, number, string | null, AccessPoint['tariffa'], number | null, string | null][]; s: [number, number][][] }

const cells = new Map<string, Promise<Cell | null>>()

function getCell(base: string, x: number, y: number): Promise<Cell | null> {
  const key = `${x}_${y}`
  if (!cells.has(key)) {
    // cella assente = nessun parcheggio né strada lì (fuori dal Trentino)
    cells.set(key, fetch(`${base}accesso/${key}.json`).then((r) => (r.ok ? (r.json() as Promise<Cell>) : null)).catch(() => null))
  }
  return cells.get(key)!
}

/** Punto d'arrivo in auto più adatto per `p` (lon, lat), senza quote. */
export async function nearestAccess(base: string, p: [number, number]): Promise<AccessPoint> {
  const cx = Math.floor(p[0] / CELL_DEG)
  const cy = Math.floor(p[1] / CELL_DEG)
  const around: Promise<Cell | null>[] = []
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) around.push(getCell(base, cx + dx, cy + dy))
  const list = (await Promise.all(around)).filter((c): c is Cell => !!c)
  // metri locali (equirettangolare: errore trascurabile entro pochi km)
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180)
  const ky = 110_540
  const xy = (c: readonly unknown[]) => [((c[0] as number) - p[0]) * kx, ((c[1] as number) - p[1]) * ky]

  let best: Cell['p'][number] | null = null
  let bestD = PARKING_MAX_M
  for (const c of list) {
    for (const row of c.p) {
      const [x, y] = xy(row)
      const d = Math.hypot(x, y)
      if (d <= bestD) {
        bestD = d
        best = row
      }
    }
  }
  if (best) {
    const [lon, lat, nome, tariffa, posti, sosta] = best
    return { tipo: 'parcheggio', lon, lat, nome: nome ?? undefined, tariffa, posti: posti ?? undefined, sosta_max: sosta ?? undefined, distanza_m: Math.round(bestD) }
  }

  // la strada più vicina: proiezione su ciascun segmento (le strade possono stare in più celle: nessun problema)
  let rd = ROAD_MAX_M
  let rp: [number, number] | null = null
  for (const c of list) {
    for (const line of c.s) {
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = xy(line[i - 1])
        const [bx, by] = xy(line[i])
        const vx = bx - ax
        const vy = by - ay
        const len2 = vx * vx + vy * vy
        const t = len2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0
        const qx = ax + t * vx
        const qy = ay + t * vy
        const d = Math.hypot(qx, qy)
        if (d < rd) {
          rd = d
          rp = [p[0] + qx / kx, p[1] + qy / ky]
        }
      }
    }
  }
  if (!rp) return { tipo: 'nessuno' }
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5
  return { tipo: 'strada', lon: r5(rp[0]), lat: r5(rp[1]), distanza_m: Math.round(rd) }
}
