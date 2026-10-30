// Anteprima di volo 3D: la stessa mappa con il terreno vero (DEM Mapterhorn) e il cielo.
// La camera segue il percorso (cursore lungo il tracciato, play/pausa) a un'altezza scelta sopra
// il terreno in QUEL punto, guarda nella direzione di marcia (o fissa, o gira); in modalità libera
// ci si stacca dal percorso. La luce del rilievo segue il sole.
// Nessun dato salvato: alla fine la mappa torna com'era, nello stesso punto.
// REGOLA FISSA: l'altezza scelta qui è solo per l'anteprima, non viene registrata.

import type { GeoJSONSource, LngLat, Map as MlMap } from 'maplibre-gl'
import { HIGHLIGHT } from './highlight'
import { h } from './panel'
import { hhmm, sunPosition, sunTimes } from './sun'
import { pointAt, sliceLine, type TrailLine } from './trailgeom'
import { icon } from './ui'

export interface PreviewPoi {
  nome: string
  categoria: string
  lngLat: [number, number]
  ele: number | null
}

/** Il tracciato da seguire: sentiero SAT o percorso personalizzato (metri in scala `line.length`). */
export interface PreviewPath {
  line: TrailLine
  ground: (m: number) => number // quota del terreno (m s.l.m.) dal profilo altimetrico (LiDAR)
  straight: { from: number; to: number }[] // pezzi in linea retta (buchi, deviazioni): tratteggiati
}

export interface PreviewOptions {
  map: MlMap
  path: PreviewPath
  at: number // da dove si parte, in m lungo il percorso
  name: string // "E325 · Sentiero…" o nome del percorso
  trail: string // riga sotto il titolo
  day: string // AAAA-MM-GG (data scelta in VOLO)
  pois: PreviewPoi[] // vicini al percorso, per "Guarda verso…"
  mobile: boolean
  /** Prima di entrare: sfondo pulito e zone attive visibili; restituisce come ripristinare. */
  prepare: () => () => void
  onExit: () => void
}

const R = 6_371_008.8
function distance(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180
  const s = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
function bearingTo(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r)
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r)
  return (Math.atan2(y, x) / r + 360) % 360
}
/** Punto a `dist` metri da `a` in direzione `brg` (gradi da nord). */
function destination(a: [number, number], brg: number, dist: number): [number, number] {
  const r = Math.PI / 180
  const d = dist / R
  const lat1 = a[1] * r
  const lon1 = a[0] * r
  const th = brg * r
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(th))
  const lon2 = lon1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 / r, lat2 / r]
}

/** Distanza (m) del punto guardato lungo la linea di vista: tiene il centro della vista vicino e
 *  alla quota giusta. Con il centro lontano (a livello del mare) MapLibre allontana il piano di
 *  ritaglio vicino fino a centinaia di metri: il rilievo vicino veniva tagliato (pareti striate)
 *  e la camera sollevata di continuo (salti). */
const LOOK_M = 400

const it = (n: number, d = 0) => n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d })
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Campo visivo verticale per avere ~80° in orizzontale (come una camera da drone). */
function verticalFov(w: number, hgt: number): number {
  const hfov = 80
  const v = (2 * Math.atan(Math.tan(((hfov / 2) * Math.PI) / 180) * (hgt / Math.max(1, w))) * 180) / Math.PI
  return clamp(v, 35, 85)
}

/** Altezza della camera sul terreno: oltre 120 m solo visualizzazione (limite di volo). */
const H_MIN = 20
const H_MAX = 500
const H_DEFAULT = 120
const H_LIMIT = 120
/** Direzione di marcia: verso un punto così avanti lungo il tracciato (curve smussate). */
const AHEAD_M = 150
/** Velocità della simulazione lungo il percorso (m/s). */
const SPEEDS: [string, number][] = [
  ['LENTA', 10],
  ['MEDIA', 30],
  ['VELOCE', 80],
]
const GIRO_DEG_S = 12
type Heading = 'marcia' | 'fissa' | 'giro'
const PATH = 'fly-path'
const POS = 'fly-pos'
const HILL = 'fly-hill'
const HILL_DEM = 'fly-hill-dem'

let active: (() => void) | null = null

// ---------------------------------------------------------------- colori: satellite o copertura del suolo

/** EOX Sentinel-2 cloudless (WMTS, ordine {z}/{y}/{x}): licenza CC BY-NC-SA 4.0, va bene per
 *  l'uso non commerciale. Risoluzione 10 m: oltre z14 si ingrandisce. */
const SAT = 'fly-sat'
const SAT_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'
export const SAT_CREDIT = 'Immagini: Sentinel-2 cloudless 2024 di EOX IT Services (dati Copernicus Sentinel modificati), CC BY-NC-SA 4.0'
const SAT_ATTR = '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless – s2maps.eu</a> di EOX IT Services GmbH (dati Copernicus Sentinel 2024 modificati), CC BY-NC-SA 4.0'

/** Ripiego senza satellite: colori della copertura del suolo di OpenFreeMap (non il bianco). */
const LANDCOVER_COLORS: [string, string, unknown][] = [
  ['bg', 'background-color', '#A9B88E'], // prati e pascoli d'alta quota (dove non c'è altro)
  ['landcover-wood', 'fill-color', '#5E7F4E'],
  ['landcover-wood', 'fill-opacity', 1],
  ['landcover-grass', 'fill-color', '#9DB57A'],
  ['landcover-grass', 'fill-opacity', 1],
  ['landcover-rock', 'fill-color', '#ABA59A'],
  ['landcover-rock', 'fill-opacity', 1],
  ['landcover-ice', 'fill-color', '#EEF3F5'],
  ['water', 'fill-color', '#4F8FB3'],
]

/** Ombreggiatura sopra i colori: solo ombre (le luci trasparenti non "sbiancano" le montagne). */
const SHADE_PAINT: [string, unknown][] = [
  ['hillshade-highlight-color', 'rgba(255,255,255,0)'],
  ['hillshade-accent-color', 'rgba(0,0,0,0)'],
  ['hillshade-shadow-color', 'rgba(18,26,22,0.45)'],
]

// ---------------------------------------------------------------- quota del terreno dal DEM

const DEM_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
const DEM_ZOOM = 14 // massimo dettaglio di Mapterhorn sul Trentino (LiDAR PAT)
const DEM_TILE = 512
/** Margine minimo (m) tra la camera e il terreno più alto lì intorno (entro 60 m). */
const CLEARANCE_M = 10

/** Sorgente DEM per il terreno 3D: esattamente come la pubblica Mapterhorn (tilejson):
 *  codifica terrarium, tile da 512 px, dettaglio fino a z14 sul Trentino. La sorgente "terrain"
 *  dell'ombreggiatura 2D si ferma a z12 apposta (ingrandisce i tile e scarica meno dati). */
const TERRAIN_3D = 'terrain3d'
const TERRAIN_3D_SOURCE = {
  type: 'raster-dem' as const,
  tiles: [DEM_URL],
  encoding: 'terrarium' as const,
  tileSize: DEM_TILE,
  maxzoom: DEM_ZOOM,
  attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
}

/** Quota (m) nel punto e la massima entro `radius` metri, letta UNA volta dal tile DEM a z14
 *  (codifica terrarium: quota = R·256 + G + B/256 − 32768). null se il tile non arriva. */
export async function demElevation(lon: number, lat: number, radius = 60): Promise<{ at: number; max: number } | null> {
  const n = 2 ** DEM_ZOOM
  const fx = ((lon + 180) / 360) * n
  const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  try {
    const res = await fetch(DEM_URL.replace('{z}', String(DEM_ZOOM)).replace('{x}', String(tx)).replace('{y}', String(ty)))
    if (!res.ok) return null
    const bmp = await createImageBitmap(await res.blob())
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(bmp, 0, 0)
    const size = bmp.width || DEM_TILE
    const px = Math.min(size - 1, Math.floor((fx - tx) * size))
    const py = Math.min(size - 1, Math.floor((fy - ty) * size))
    const mPerPx = (40_075_016 * Math.cos((lat * Math.PI) / 180)) / n / size
    const r = Math.max(1, Math.ceil(radius / mPerPx))
    const x0 = Math.max(0, px - r)
    const y0 = Math.max(0, py - r)
    const w = Math.min(size, px + r + 1) - x0
    const hh = Math.min(size, py + r + 1) - y0
    const data = g.getImageData(x0, y0, w, hh).data
    const ele = (i: number) => data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768
    let max = -Infinity
    for (let yy = 0; yy < hh; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if ((xx + x0 - px) ** 2 + (yy + y0 - py) ** 2 > r * r) continue
        max = Math.max(max, ele((yy * w + xx) * 4))
      }
    }
    const at = ele(((py - y0) * w + (px - x0)) * 4)
    return Number.isFinite(at) && at > -500 && at < 5000 ? { at, max } : null
  } catch {
    return null
  }
}

/** Apre l'anteprima. Restituisce la funzione per chiuderla. */
export function startPreview(o: PreviewOptions): () => void {
  active?.()
  const { map, path } = o
  const line = path.line
  const L = line.length
  const before = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    maxPitch: map.getMaxPitch(),
    maxZoom: map.getMaxZoom(),
    pixelRatio: map.getPixelRatio(),
    clamped: map.getCenterClampedToGround(),
  }
  const restore = o.prepare()

  // --- stato
  let at = clamp(o.at, 0, L) // posizione del cursore lungo il percorso (m)
  let height = H_DEFAULT // m sopra il terreno
  let gimbal = o.mobile ? -25 : -15 // gradi: 0 = orizzontale, -90 = verso il basso (telefono: il pannello copre il basso)
  let heading: Heading = 'marcia'
  let yaw = 0 // scarto dalla direzione di marcia (trascinando la scena)
  let fixedBearing = map.getBearing()
  let bearing: number | null = null // della camera, smussato
  let alt: number | null = null // quota della camera (m s.l.m.), smussata
  let playing = false
  let dir: 1 | -1 = 1
  let speed = SPEEDS[1][1]
  let free = false
  let freePos: [number, number] = pointAt(line, at)
  let freeGround = path.ground(at)
  let lookAt: PreviewPoi | null = null
  const keys = new Set<string>()
  const start = pointAt(line, at)
  const [y, m, d] = o.day.split('-').map(Number)
  const now = new Date()
  const isToday = now.getFullYear() === y && now.getMonth() + 1 === m && now.getDate() === d
  const times = sunTimes(new Date(y, m - 1, d, 12), start[1], start[0])
  // Oggi, se è giorno: l'ora attuale; altrimenti (notte o altro giorno) le 10:00.
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const light0 = !!times.sunrise && !!times.sunset && now >= times.sunrise && now <= times.sunset
  let minutes = isToday && light0 ? clamp(Math.round(nowMin / 15) * 15, 300, 1260) : 600

  // --- terreno, cielo, qualità
  map.setMaxPitch(85)
  map.setMaxZoom(24)
  // La camera sta a quota assoluta: MapLibre non deve riagganciare il centro al terreno a ogni
  // tile che arriva (con la camera quasi orizzontale il centro è lontano e la sua quota cambia,
  // e con lei quella della camera: era il "salto su e giù").
  map.setCenterClampedToGround(false)
  if (o.mobile) map.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25))
  if (!map.getSource(TERRAIN_3D)) map.addSource(TERRAIN_3D, TERRAIN_3D_SOURCE)
  map.setTerrain({ source: TERRAIN_3D, exaggeration: 1 })

  // Colori reali: satellite sotto l'ombreggiatura (sentiero, zone e acqua restano sopra).
  const saved: [string, string, unknown][] = []
  const paint = (id: string, prop: string, value: unknown) => {
    if (!map.getLayer(id)) return
    saved.push([id, prop, map.getPaintProperty(id, prop as never)])
    map.setPaintProperty(id, prop as never, value as never)
  }
  const hiddenLayers: [string, unknown][] = []
  const hide = (id: string) => {
    if (!map.getLayer(id)) return
    hiddenLayers.push([id, map.getLayoutProperty(id, 'visibility')])
    map.setLayoutProperty(id, 'visibility', 'none')
  }
  if (!map.getSource(SAT)) map.addSource(SAT, { type: 'raster', tiles: [SAT_URL], tileSize: 256, maxzoom: 14, attribution: SAT_ATTR })
  if (!map.getLayer(SAT)) map.addLayer({ id: SAT, type: 'raster', source: SAT, paint: { 'raster-fade-duration': 0, 'raster-brightness-min': 0.1, 'raster-contrast': 0.08, 'raster-saturation': 0.12 } }, map.getLayer('hillshade') ? 'hillshade' : undefined)
  // Ombreggiatura dal DEM a z14 (LiDAR 5 m) invece di quella 2D a z12: è il rilievo che si vede
  // da vicino. Sorgente propria (stesse tile del terreno, già in cache), solo ombre.
  if (!map.getSource(HILL_DEM)) map.addSource(HILL_DEM, { ...TERRAIN_3D_SOURCE })
  if (!map.getLayer(HILL)) {
    map.addLayer(
      { id: HILL, type: 'hillshade', source: HILL_DEM, paint: Object.fromEntries(SHADE_PAINT) as never },
      map.getLayer('hillshade') ? 'hillshade' : undefined,
    )
  }
  hide('hillshade')
  // PC: più tile ad alto dettaglio verso l'orizzonte (MapLibre: 9,314 / 3). Telefono: come prima.
  if (!o.mobile) for (const s of [SAT, TERRAIN_3D, HILL_DEM]) map.setSourceTileLodParams(9.314, 5, s)
  paint('water', 'fill-opacity', 0.35) // i laghi si vedono già nel satellite
  let satFallback = false
  let satErrors = 0
  /** Satellite non disponibile: si passa ai colori della copertura del suolo. */
  const fallbackColors = () => {
    if (satFallback) return
    satFallback = true
    if (map.getLayer(SAT)) map.setLayoutProperty(SAT, 'visibility', 'none')
    for (const [id, prop, v] of LANDCOVER_COLORS) paint(id, prop, v)
    paint('water', 'fill-opacity', 1)
    credit.textContent = 'Satellite non disponibile: colori della copertura del suolo (OpenStreetMap). Terreno © Mapterhorn.'
  }
  const onError = (e: unknown) => {
    if ((e as { sourceId?: string }).sourceId === SAT && ++satErrors >= 3) fallbackColors()
  }
  map.on('error', onError)
  for (const hd of [map.dragPan, map.dragRotate, map.scrollZoom, map.touchZoomRotate, map.doubleClickZoom, map.keyboard, map.touchPitch, map.boxZoom]) hd.disable()
  document.body.classList.add('fly3d')

  // --- il percorso in evidenza sul terreno (tratteggiati i pezzi in linea retta) e il punto del cursore
  const straightAt = (x: number) => path.straight.some((s) => x >= s.from - 0.5 && x <= s.to + 0.5)
  const pathFeatures: GeoJSON.Feature[] = []
  let cursor = 0
  for (const s of [...path.straight].sort((a, b) => a.from - b.from)) {
    if (s.from - cursor > 1) pathFeatures.push(lineFeature(sliceLine(line, cursor, s.from), 'walk'))
    pathFeatures.push(lineFeature(sliceLine(line, s.from, s.to), 'straight'))
    cursor = s.to
  }
  if (L - cursor > 1) pathFeatures.push(lineFeature(sliceLine(line, cursor, L), 'walk'))
  map.addSource(PATH, { type: 'geojson', data: { type: 'FeatureCollection', features: pathFeatures.filter((f) => (f.geometry as GeoJSON.LineString).coordinates.length > 1) } })
  map.addSource(POS, { type: 'geojson', data: pointFeature(start) })
  const round = { 'line-cap': 'round', 'line-join': 'round' } as const
  map.addLayer({ id: `${PATH}-casing`, type: 'line', source: PATH, layout: round, paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.95 } })
  map.addLayer({ id: `${PATH}-line`, type: 'line', source: PATH, filter: ['==', ['get', 'kind'], 'walk'], layout: round, paint: { 'line-color': HIGHLIGHT, 'line-width': 5.5 } })
  map.addLayer({ id: `${PATH}-dash`, type: 'line', source: PATH, filter: ['==', ['get', 'kind'], 'straight'], paint: { 'line-color': HIGHLIGHT, 'line-width': 5, 'line-dasharray': [1.2, 1.2] } })
  map.addLayer({ id: POS, type: 'circle', source: POS, paint: { 'circle-radius': 7, 'circle-color': HIGHLIGHT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } })

  // --- dove sta la camera
  /** Direzione di marcia nel punto: verso un punto 150 m avanti (indietro se si va al contrario). */
  function travel(x: number): number {
    const ahead = clamp(x + dir * AHEAD_M, 0, L)
    if (Math.abs(ahead - x) < 20) return bearingTo(pointAt(line, clamp(x - dir * AHEAD_M, 0, L)), pointAt(line, x))
    return bearingTo(pointAt(line, x), pointAt(line, ahead))
  }
  /** Terreno più alto sotto la camera e attorno (50 m) secondo i tile caricati, + margine. */
  function floorAt(p: [number, number]): number {
    let top = -Infinity
    for (const [b, dd] of [[0, 0], [0, 50], [90, 50], [180, 50], [270, 50]]) {
      const e = map.queryTerrainElevation((dd ? destination(p, b, dd) : p) as never)
      if (e != null && Number.isFinite(e)) top = Math.max(top, e)
    }
    return top + CLEARANCE_M
  }
  function target(): { pos: [number, number]; ground: number; brg: number } {
    if (free) {
      const e = map.queryTerrainElevation(freePos as never)
      if (e != null && Number.isFinite(e)) freeGround = e
      return { pos: freePos, ground: freeGround, brg: fixedBearing }
    }
    return { pos: pointAt(line, at), ground: path.ground(at), brg: heading === 'marcia' ? (travel(at) + yaw + 360) % 360 : fixedBearing }
  }

  // --- interfaccia
  const shade = h('div', { class: 'fly-shade', 'aria-hidden': 'true' })
  const title = h('div', { class: 'fly-title' }, h('p', { class: 'section-label' }, 'Anteprima di volo 3D'), h('h2', {}, o.name), h('p', { class: 'small muted' }, o.trail))
  const exit = h('button', { type: 'button', class: 'btn-primary fly-exit' }, icon('close', 18), 'ESCI')
  const readout = h('p', { class: 'mono small fly-read' })
  const sunOut = h('p', { class: 'mono small fly-sun' })
  const credit = h('p', { class: 'small muted fly-credit' }, `${SAT_CREDIT}. Terreno © Mapterhorn.`)

  const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void) => {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label }) as HTMLInputElement
    input.value = String(value)
    const out = h('span', { class: 'mono' }, fmt(value))
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value))
      onInput(Number(input.value))
    })
    const set = (v: number) => {
      input.value = String(v)
      out.textContent = fmt(v)
    }
    return { el: h('label', { class: 'fly-slider' }, h('span', { class: 'fly-k' }, label, out), input), input, out, set }
  }

  // Cursore lungo il percorso, con la traccia del profilo dietro.
  const track = h('canvas', { class: 'fly-trace', 'aria-hidden': 'true' }) as HTMLCanvasElement
  const fmtAt = (x: number) => `km ${it(x / 1000, 2)} · ${it(Math.round(path.ground(x)))} m${straightAt(x) ? ' · in linea retta' : ''}`
  const aSlider = slider('Lungo il percorso', 0, Math.round(L), 1, Math.round(at), fmtAt, (v) => {
    at = v
    free = false
    drawFree()
    kick()
  })
  aSlider.el.classList.add('fly-along')
  aSlider.input.classList.add('fly-along-input')
  aSlider.el.insertBefore(h('div', { class: 'fly-track' }, track, aSlider.input), null)
  const drawTrace = () => {
    const w = track.clientWidth
    const hgt = track.clientHeight
    if (!w || !hgt) return
    const dpr = window.devicePixelRatio || 1
    track.width = Math.round(w * dpr)
    track.height = Math.round(hgt * dpr)
    const g = track.getContext('2d')!
    g.scale(dpr, dpr)
    const N = 160
    const xs = Array.from({ length: N + 1 }, (_, i) => (i / N) * L)
    const qs = xs.map((x) => path.ground(x))
    const lo = Math.min(...qs)
    const hi = Math.max(...qs, lo + 20)
    const px = (x: number) => 10 + (x / L) * (w - 20) // il centro del pallino (20 px) va da 10 a w-10
    const py = (q: number) => hgt - 3 - ((q - lo) / (hi - lo)) * (hgt - 8)
    g.beginPath()
    xs.forEach((x, i) => (i ? g.lineTo(px(x), py(qs[i])) : g.moveTo(px(x), py(qs[i]))))
    g.lineTo(px(L), hgt)
    g.lineTo(px(0), hgt)
    g.closePath()
    g.fillStyle = 'rgba(124, 58, 237, 0.16)'
    g.fill()
    // linea: piena sul sentiero, tratteggiata nei pezzi in linea retta
    for (let i = 1; i <= N; i++) {
      const s = straightAt((xs[i - 1] + xs[i]) / 2)
      g.beginPath()
      g.setLineDash(s ? [3, 3] : [])
      g.strokeStyle = s ? '#4F5C59' : HIGHLIGHT
      g.lineWidth = 2
      g.moveTo(px(xs[i - 1]), py(qs[i - 1]))
      g.lineTo(px(xs[i]), py(qs[i]))
      g.stroke()
    }
  }

  const hWarn = h('p', { class: 'fly-warn', role: 'status' }, icon('shield', 16), 'Solo visualizzazione — oltre il limite di volo (120 m)')
  const hSlider = slider('Altezza sul terreno', H_MIN, H_MAX, 5, height, (v) => `${v} m`, (v) => setHeight(v))
  function setHeight(v: number): void {
    height = clamp(Math.round(v / 5) * 5, H_MIN, H_MAX)
    hSlider.set(height)
    hWarn.hidden = height <= H_LIMIT
    kick()
  }
  hWarn.hidden = true
  const tSlider = slider('Inclinazione camera', -90, -2, 1, gimbal, (v) => (v > -5 ? 'orizzontale' : v < -85 ? 'verso il basso' : `${Math.round(-v)}° in giù`), (v) => {
    gimbal = v
    lookAt = null
    kick()
  })
  const lSlider = slider('Ora del giorno', 300, 1260, 15, minutes, (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`, (v) => {
    minutes = v
    light()
  })

  // Simulazione del volo lungo il percorso
  const play = h('button', { type: 'button', class: 'btn-primary fly-play', 'aria-pressed': 'false' }) as HTMLButtonElement
  const drawPlay = () => {
    play.replaceChildren(icon(playing ? 'pause' : 'play', 18), playing ? 'PAUSA' : 'PLAY')
    play.setAttribute('aria-pressed', String(playing))
  }
  play.addEventListener('click', () => {
    if (!playing && ((dir > 0 && at >= L - 1) || (dir < 0 && at <= 1))) at = dir > 0 ? 0 : L // dalla fine: si riparte
    playing = !playing
    if (playing) free = false
    drawPlay()
    drawFree()
    kick()
  })
  const choice = <T extends string | number>(label: string, opts: [string, T][], get: () => T, set: (v: T) => void) => {
    const box = h('div', { class: 'segmented small', role: 'radiogroup', 'aria-label': label })
    const draw = () => {
      for (const b of box.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === String(get())))
    }
    for (const [lbl, v] of opts) {
      const b = h('button', { type: 'button', role: 'radio', 'data-v': String(v) }, lbl)
      b.addEventListener('click', () => {
        set(v)
        draw()
        kick()
      })
      box.append(b)
    }
    draw()
    return { el: box, draw }
  }
  const dirSel = choice<1 | -1>('Verso', [['AVANTI', 1], ['INDIETRO', -1]], () => dir, (v) => (dir = v))
  const speedSel = choice<number>('Velocità', SPEEDS.map(([l, v]) => [l, v] as [string, number]), () => speed, (v) => (speed = v))
  const headSel = choice<Heading>(
    'Orientamento',
    [
      ['DIREZIONE DI MARCIA', 'marcia'],
      ['FISSO', 'fissa'],
      ['GIRA 360°', 'giro'],
    ],
    () => heading,
    (v) => {
      if (v !== 'marcia' && heading === 'marcia' && bearing != null) fixedBearing = bearing
      heading = v
      yaw = 0
      slow.hidden = true
    },
  )
  const slow = h('p', { class: 'small muted' }, 'Rotazione fermata: il dispositivo fatica. Trascina per guardare in giro.')
  slow.hidden = true

  // Modalità libera
  const freeBtn = h('button', { type: 'button', class: 'btn-outline fly-free' }) as HTMLButtonElement
  // In modalità libera anche un pulsante fisso sulla scena: il pannello può essere scorso via.
  const backBtn = h('button', { type: 'button', class: 'btn-primary fly-back' }, icon('route', 18), 'TORNA SUL PERCORSO') as HTMLButtonElement
  backBtn.addEventListener('click', () => setFree(false))
  const freeHint = h('p', { class: 'hint fly-free-hint' }, o.mobile ? 'Un dito: guarda in giro · due dita: spostati · pizzica: altezza.' : 'Mouse: guarda in giro · W A S D o frecce: spostati (Maiusc = più veloce) · rotella: altezza.')
  function drawFree(): void {
    freeBtn.replaceChildren(free ? icon('route', 18) : icon('drone', 18), free ? 'TORNA SUL PERCORSO' : 'MODALITÀ LIBERA')
    freeBtn.classList.toggle('btn-primary', free)
    freeBtn.classList.toggle('btn-outline', !free)
    freeBtn.setAttribute('aria-pressed', String(free))
    freeHint.hidden = !free
    backBtn.hidden = !free
    root.classList.toggle('is-free', free)
  }
  function setFree(v: boolean): void {
    if (v && !free) {
      // si parte da dove si è, guardando dove si guardava
      freePos = pointAt(line, at)
      freeGround = path.ground(at)
      if (bearing != null) fixedBearing = bearing
      playing = false
      drawPlay()
    }
    free = v
    if (!v) yaw = 0
    drawFree()
    kick()
  }
  freeBtn.addEventListener('click', () => setFree(!free))

  const lookSel = h('select', { 'aria-label': 'Guarda verso' }) as HTMLSelectElement
  const fillLook = () => {
    const here = free ? freePos : pointAt(line, at)
    const near = o.pois
      .map((p) => ({ p, dist: distance(here, p.lngLat) }))
      .filter((x) => x.dist > 40 && x.dist < 8000)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 12)
    lookSel.replaceChildren(h('option', { value: '' }, 'Guarda verso…'), ...near.map((x) => h('option', { value: x.p.nome }, `${x.p.nome} · ${it(x.dist / 1000, 1)} km`)))
  }
  lookSel.addEventListener('focus', fillLook)
  lookSel.addEventListener('change', () => {
    const p = o.pois.find((x) => x.nome === lookSel.value)
    if (!p) return
    const here = free ? freePos : pointAt(line, at)
    lookAt = p
    if (heading === 'giro') heading = 'fissa'
    if (heading === 'marcia') yaw = (bearingTo(here, p.lngLat) - travel(at) + 540) % 360 - 180
    else fixedBearing = bearingTo(here, p.lngLat)
    headSel.draw()
    // Inclinazione per inquadrare il punto (dalla quota del drone a quella del POI).
    const tq = p.ele ?? map.queryTerrainElevation(p.lngLat as never) ?? (alt ?? 0) - 100
    gimbal = clamp((-Math.atan2((alt ?? tq + height) - tq, distance(here, p.lngLat)) * 180) / Math.PI, -90, -2)
    tSlider.set(Math.round(gimbal))
    kick()
  })
  fillLook()

  const shot = h('button', { type: 'button', class: 'btn-outline' }, icon('share', 16), 'SALVA IMMAGINE')
  shot.addEventListener('click', () => screenshot())

  const panel = h(
    'div',
    { class: 'fly-panel', role: 'dialog', 'aria-label': 'Anteprima di volo 3D' },
    h('div', { class: 'fly-head' }, title, exit),
    aSlider.el,
    h('div', { class: 'fly-row' }, play, dirSel.el),
    h('div', { class: 'fly-row' }, h('span', { class: 'fly-k' }, 'Velocità'), speedSel.el),
    hSlider.el,
    hWarn,
    readout,
    h('div', { class: 'fly-field' }, h('span', { class: 'fly-k' }, 'Orientamento'), headSel.el),
    slow,
    tSlider.el,
    h('div', { class: 'fly-row' }, freeBtn),
    freeHint,
    lookSel,
    lSlider.el,
    sunOut,
    h('p', { class: 'mono small muted' }, `Alba ${hhmm(times.sunrise)} · Tramonto ${hhmm(times.sunset)}`),
    h('div', { class: 'fly-row' }, shot),
    h('p', { class: 'hint' }, 'Trascina sulla scena per guardare in giro. Percorso (in viola) e zone D-Flight attive nella data scelta sono disegnati sul terreno.'),
    credit,
  )
  const root = h('div', { class: 'fly' }, shade, backBtn, panel)
  document.body.append(root)
  drawPlay()
  drawFree()

  function info(ground: number): void {
    if (alt == null) return
    const raised = alt > ground + height + 1
    const parts = [
      free ? 'Modalità libera' : `Terreno ${it(Math.round(ground))} m`,
      `drone ${Math.round(alt - ground)} m sopra (${it(Math.round(alt))} m s.l.m.)`,
      ...(raised ? ['alzato: pendio vicino più alto'] : []),
    ]
    if (lookAt) parts.push(`${lookAt.nome} a ${it(distance(free ? freePos : pointAt(line, at), lookAt.lngLat) / 1000, 1)} km`)
    readout.textContent = parts.join(' · ')
  }

  // --- luce del sole e cielo
  function light(): void {
    const when = new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
    const sp = sunPosition(when, start[1], start[0])
    const elev = sp.altitude
    if (map.getLayer(HILL)) {
      map.setPaintProperty(HILL, 'hillshade-method', 'basic')
      map.setPaintProperty(HILL, 'hillshade-illumination-anchor', 'map')
      map.setPaintProperty(HILL, 'hillshade-illumination-direction', Math.round(sp.azimuth) % 360)
      map.setPaintProperty(HILL, 'hillshade-illumination-altitude', clamp(elev, 2, 90))
      map.setPaintProperty(HILL, 'hillshade-exaggeration', elev < 15 ? 0.6 : 0.4)
    }
    const night = elev < -6
    const golden = elev >= -6 && elev < 8
    map.setSky({
      'sky-color': night ? '#0b1a2e' : golden ? '#f2b27a' : '#7fb6e0',
      'horizon-color': night ? '#1d2c44' : golden ? '#f7d9b0' : '#dcebf5',
      // Foschia: comincia a metà distanza e sfuma l'orizzonte, per dare profondità.
      'fog-color': night ? '#1d2c44' : golden ? '#efd9c0' : '#d4e1ea',
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.55,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0.5],
    })
    // Prima dell'alba e dopo il tramonto: velo scuro sulla scena.
    shade.style.opacity = String(night ? 0.55 : elev < 0 ? 0.3 : 0)
    sunOut.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} · sole ${elev < 0 ? 'sotto l’orizzonte' : `alto ${it(elev)}°, da ${compass(sp.azimuth)}`}`
  }
  const compass = (az: number) => ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'][Math.round(az / 45) % 8]

  // --- un fotogramma: avanza (play, giro, tasti), smussa quota e direzione, posiziona la camera.
  // Si ridisegna solo finché qualcosa si muove: a camera ferma la scena resta immobile.
  let raf = 0
  let last = 0
  let lastWant = 0 // per le prove: quota e direzione verso cui la camera si sta assestando
  let lastBrg = 0
  const frames: number[] = []
  function kick(): void {
    if (raf || closed) return
    last = performance.now()
    raf = requestAnimationFrame(step)
  }
  function step(t: number): void {
    raf = 0
    if (closed) return
    // tempo vero (fino a 1 s): su un dispositivo lento il volo va a scatti ma alla velocità giusta
    const dt = Math.min(1, Math.max(0.001, (t - last) / 1000))
    last = t
    let moving = false
    if (playing && !free) {
      at = clamp(at + dir * speed * dt, 0, L)
      if (at <= 0 || at >= L) {
        playing = false
        drawPlay()
      }
      aSlider.set(Math.round(at))
      moving = true
    }
    if (heading === 'giro' && !dragging) {
      fixedBearing = (fixedBearing + GIRO_DEG_S * dt) % 360
      moving = true
    }
    if (free && keys.size) {
      const fwd = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0)
      const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0)
      const v = clamp(height * 0.6, 15, 200) * (keys.has('shift') ? 3 : 1) * dt
      if (fwd) freePos = destination(freePos, fixedBearing, fwd * v)
      if (side) freePos = destination(freePos, fixedBearing + 90, side * v)
      moving = true
    }
    const tg = target()
    const floor = floorAt(tg.pos)
    const want = Math.max(tg.ground + height, floor)
    lastWant = want
    lastBrg = tg.brg
    const k = (rate: number) => 1 - Math.exp(-dt * rate)
    alt = alt == null ? want : alt + (want - alt) * k(4)
    alt = Math.max(alt, floor) // mai dentro il pendio
    const diff = bearing == null ? 0 : ((tg.brg - bearing + 540) % 360) - 180
    bearing = bearing == null ? tg.brg : (bearing + diff * k(heading === 'marcia' && !free && !dragging ? 2.5 : 14) + 360) % 360
    apply(tg.pos, tg.ground)
    // dispositivo lento: la rotazione automatica si ferma (la simulazione continua, a scatti)
    frames.push(dt * 1000)
    if (frames.length > 40) frames.shift()
    if (heading === 'giro' && frames.length >= 40 && frames.reduce((s, x) => s + x, 0) / frames.length > 70) {
      heading = 'fissa'
      headSel.draw()
      slow.hidden = false
    }
    const settled = Math.abs(want - alt) < 0.05 && Math.abs(diff) < 0.05
    if (moving || !settled || dragging) raf = requestAnimationFrame(step)
  }
  function apply(pos: [number, number], ground: number): void {
    const g = (gimbal * Math.PI) / 180
    const b = bearing ?? 0
    const a = alt ?? ground + height
    const look = destination(pos, b, Math.max(0.5, LOOK_M * Math.cos(g)))
    const ll = (c: [number, number]) => ({ lng: c[0], lat: c[1] }) as unknown as LngLat
    const cam = map.calculateCameraOptionsFromTo(ll(pos), a, ll(look), a + LOOK_M * Math.sin(g))
    // `cam` porta anche l'elevation del centro: con l'aggancio al suolo spento resta quella.
    map.jumpTo({ ...cam, bearing: b, pitch: 90 + gimbal })
    ;(map.getSource(POS) as GeoJSONSource | undefined)?.setData(pointFeature(pointAt(line, at)))
    info(ground)
  }
  // Nuovi tile del terreno: si ricontrolla il margine sotto la camera.
  const onIdle = () => kick()
  map.on('idle', onIdle)

  // --- trascinare: un dito/mouse guarda in giro; due dita spostano (modalità libera) e il
  // pizzico cambia l'altezza
  const surface = map.getCanvasContainer()
  const pointers = new Map<number, { x: number; y: number }>()
  let dragging = false
  let pinch = 0
  const centroid = () => {
    const v = [...pointers.values()]
    return { x: v.reduce((s, p) => s + p.x, 0) / v.length, y: v.reduce((s, p) => s + p.y, 0) / v.length }
  }
  const spread = () => {
    const [a, b] = [...pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  let c0 = { x: 0, y: 0 }
  const down = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    surface.setPointerCapture(e.pointerId)
    dragging = true
    c0 = centroid()
    pinch = spread()
    kick()
  }
  const move = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return
    const prev = pointers.get(e.pointerId)!
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 1) {
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      if (heading === 'marcia' && !free) yaw = (yaw - dx * 0.25) % 360
      else fixedBearing = (fixedBearing - dx * 0.25 + 360) % 360
      gimbal = clamp(gimbal + dy * 0.15, -90, -2)
      tSlider.set(Math.round(gimbal))
      lookAt = null
    } else if (pointers.size === 2) {
      const c = centroid()
      const sp = spread()
      if (free) {
        const mpp = clamp(height / 150, 0.3, 4) // metri per pixel, più in alto si va più veloci
        freePos = destination(freePos, fixedBearing, (c.y - c0.y) * mpp)
        freePos = destination(freePos, fixedBearing + 90, -(c.x - c0.x) * mpp)
      }
      if (pinch > 0 && sp > 0) setHeight(height * (pinch / sp))
      c0 = c
      pinch = sp
    }
    kick()
  }
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    c0 = centroid()
    pinch = spread()
    dragging = pointers.size > 0
    kick()
  }
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    setHeight(height - Math.sign(e.deltaY) * (e.shiftKey ? 25 : 10))
  }
  // Gesti solo nostri: con i comandi di MapLibre spenti il browser si prenderebbe il pizzico e lo
  // scorrimento a due dita (pointercancel a metà gesto).
  const touchAction = surface.style.touchAction
  surface.style.touchAction = 'none'
  surface.addEventListener('pointerdown', down)
  surface.addEventListener('pointermove', move)
  surface.addEventListener('pointerup', up)
  surface.addEventListener('pointercancel', up)
  surface.addEventListener('wheel', wheel, { passive: false })

  const onResize = () => {
    map.setVerticalFieldOfView(verticalFov(map.getCanvas().clientWidth, map.getCanvas().clientHeight))
    drawTrace()
  }

  // --- salva immagine (scena + didascalia)
  function screenshot(): void {
    map.once('render', () => {
      const src = map.getCanvas()
      const c = document.createElement('canvas')
      c.width = src.width
      c.height = src.height
      const g = c.getContext('2d')!
      g.drawImage(src, 0, 0)
      const s = c.width / src.clientWidth
      const pad = 14 * s
      const where = free ? 'vista libera' : `km ${it(at / 1000, 1)}`
      const lines = [`QUOTA 120 · ${o.name}`, `${o.trail} · ${where} · ${height} m sul terreno · ${o.day.split('-').reverse().join('.')} ${lSlider.out.textContent}`]
      g.font = `500 ${10 * s}px "IBM Plex Sans", sans-serif`
      g.fillStyle = 'rgba(255,255,255,0.85)'
      g.fillText(satFallback ? 'Terreno © Mapterhorn · © OpenStreetMap' : `Sentinel-2 cloudless 2024 by EOX (CC BY-NC-SA 4.0) · Terreno © Mapterhorn`, pad * 2, c.height - pad - 4 * s)
      g.font = `600 ${16 * s}px "IBM Plex Sans Condensed", sans-serif`
      const w = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2
      g.fillStyle = 'rgba(20,32,36,0.72)'
      g.fillRect(pad, c.height - pad - 52 * s, w, 44 * s)
      g.fillStyle = '#fff'
      g.fillText(lines[0], pad * 2, c.height - pad - 34 * s)
      g.font = `500 ${12 * s}px "IBM Plex Mono", monospace`
      g.fillText(lines[1], pad * 2, c.height - pad - 16 * s)
      c.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = h('a', { href: url, download: `anteprima-${o.name.replace(/[^\w]+/g, '-').toLowerCase()}.png` }) as HTMLAnchorElement
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
      }, 'image/png')
    })
    map.triggerRepaint()
  }

  // --- tastiera: Esc esce; W A S D / frecce spostano (portano in modalità libera)
  const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']
  const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return close()
    const k = e.key.toLowerCase()
    if (k === 'shift') keys.add('shift')
    if (!MOVE_KEYS.includes(k) || typing(e)) return
    e.preventDefault()
    if (!free) setFree(true)
    keys.add(k)
    kick()
  }
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase())
  const onBlur = () => keys.clear()

  // --- uscita: tutto come prima, nello stesso punto
  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    active = null
    debug.state = null
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    playing = false
    cancelAnimationFrame(raf)
    raf = 0
    map.off('idle', onIdle)
    surface.removeEventListener('pointerdown', down)
    surface.removeEventListener('pointermove', move)
    surface.removeEventListener('pointerup', up)
    surface.removeEventListener('pointercancel', up)
    surface.removeEventListener('wheel', wheel)
    surface.style.touchAction = touchAction
    window.removeEventListener('resize', onResize)
    root.remove()
    document.body.classList.remove('fly3d')
    map.off('error', onError)
    for (const [id, prop, v] of saved.reverse()) if (map.getLayer(id)) map.setPaintProperty(id, prop as never, v as never)
    for (const [id, v] of hiddenLayers.reverse()) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v as never)
    for (const id of [POS, `${PATH}-dash`, `${PATH}-line`, `${PATH}-casing`, HILL, SAT]) if (map.getLayer(id)) map.removeLayer(id)
    for (const id of [POS, PATH, HILL_DEM, SAT]) if (map.getSource(id)) map.removeSource(id)
    map.setTerrain(null)
    if (map.getSource(TERRAIN_3D)) map.removeSource(TERRAIN_3D)
    map.setCenterClampedToGround(before.clamped)
    map.setSky({ 'sky-color': '#88C6FC', 'horizon-color': '#ffffff', 'fog-color': '#ffffff', 'atmosphere-blend': 0 })
    map.setVerticalFieldOfView(36.87)
    if (o.mobile) map.setPixelRatio(before.pixelRatio)
    for (const hd of [map.dragPan, map.dragRotate, map.scrollZoom, map.touchZoomRotate, map.doubleClickZoom, map.keyboard, map.touchPitch, map.boxZoom]) hd.enable()
    map.resize()
    map.setMaxZoom(before.maxZoom)
    map.jumpTo({ center: before.center, zoom: before.zoom, bearing: before.bearing, pitch: Math.min(before.pitch, before.maxPitch) })
    map.setMaxPitch(before.maxPitch)
    restore()
    o.onExit()
  }
  exit.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  active = close
  // Solo per le prove automatiche (come window.__q120map): lo stato della camera.
  debug.state = () => ({ at, L, height, alt, ground: free ? freeGround : path.ground(at), free, playing, heading, bearing, want: lastWant, brg: lastBrg, pos: free ? freePos : pointAt(line, at) })

  // --- partenza
  map.resize()
  onResize()
  window.addEventListener('resize', onResize)
  light()
  readout.textContent = 'Preparo il terreno…'
  exit.focus()
  kick()
  return active
}

/** Stato per le prove automatiche (window.__q120fly). */
export const debug: { state: (() => Record<string, unknown>) | null } = { state: null }

function lineFeature(coords: [number, number][], kind: 'walk' | 'straight'): GeoJSON.Feature {
  return { type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: coords } }
}
function pointFeature(c: [number, number]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }] }
}
