// Anteprima di volo 3D: la stessa mappa con il terreno vero (DEM Mapterhorn) e il cielo.
// La camera sta sopra un punto, da 20 a 120 m sul terreno, con un campo visivo da drone; si
// ruota da sola o si guarda in giro trascinando; la luce del rilievo segue il sole.
// Nessun dato salvato: alla fine la mappa torna com'era, nello stesso punto.
// REGOLA FISSA: l'altezza scelta qui è solo per l'anteprima, non viene registrata.

import type { LngLat, Map as MlMap } from 'maplibre-gl'
import { h } from './panel'
import { hhmm, sunPosition, sunTimes } from './sun'
import { icon } from './ui'

export interface PreviewPoi {
  nome: string
  categoria: string
  lngLat: [number, number]
  ele: number | null
}

export interface PreviewOptions {
  map: MlMap
  point: [number, number] // lon, lat
  ground: number // quota del terreno (m s.l.m.) dal profilo
  name: string // "Lago di Erdemolo", "km 3,2 del sentiero"
  trail: string // "E325 · Sentiero …"
  day: string // AAAA-MM-GG (data scelta in VOLO)
  pois: PreviewPoi[] // vicini, per "Guarda verso…"
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

const SPEEDS: [string, number][] = [
  ['Lenta', 6],
  ['Media', 12],
  ['Veloce', 24],
]

let active: (() => void) | null = null

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
  const { map } = o
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
  let height = 120 // m sul terreno
  let gimbal = -12 // gradi: 0 = orizzontale, -90 = verso il basso
  let bearing = map.getBearing()
  let rotating = !o.mobile || !matchMedia('(prefers-reduced-motion: reduce)').matches
  let speed = 12
  let lookAt: PreviewPoi | null = null
  const [y, m, d] = o.day.split('-').map(Number)
  const now = new Date()
  const isToday = now.getFullYear() === y && now.getMonth() + 1 === m && now.getDate() === d
  const times = sunTimes(new Date(y, m - 1, d, 12), o.point[1], o.point[0])
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
  for (const hd of [map.dragPan, map.dragRotate, map.scrollZoom, map.touchZoomRotate, map.doubleClickZoom, map.keyboard, map.touchPitch, map.boxZoom]) hd.disable()
  document.body.classList.add('fly3d')

  // Quota del terreno: calcolata una volta sola (profilo altimetrico, poi DEM z14 appena arriva).
  let ground = o.ground
  let around = -Infinity // terreno più alto entro 60 m
  let ready = false
  // Sempre sopra il terreno lì intorno: un pendio vicino più alto si vede come montagna, mai
  // con la camera dentro.
  const camAlt = () => Math.max(ground + height, around + CLEARANCE_M)
  function place(): void {
    if (!ready) return
    // Posizione e quota fisse; cambiano solo direzione (bearing) e inclinazione (pitch).
    const g = (gimbal * Math.PI) / 180
    const target = destination(o.point, bearing, Math.max(0.5, LOOK_M * Math.cos(g)))
    const ll = (c: [number, number]) => ({ lng: c[0], lat: c[1] }) as unknown as LngLat
    const cam = map.calculateCameraOptionsFromTo(ll(o.point), camAlt(), ll(target), camAlt() + LOOK_M * Math.sin(g))
    // `cam` porta anche l'elevation del centro: con l'aggancio al suolo spento resta quella.
    map.jumpTo({ ...cam, bearing, pitch: 90 + gimbal })
    info()
  }

  // --- luce del sole e cielo
  function light(): void {
    const when = new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
    const sp = sunPosition(when, o.point[1], o.point[0])
    const alt = sp.altitude
    if (map.getLayer('hillshade')) {
      map.setPaintProperty('hillshade', 'hillshade-method', 'basic')
      map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', 'map')
      map.setPaintProperty('hillshade', 'hillshade-illumination-direction', Math.round(sp.azimuth) % 360)
      map.setPaintProperty('hillshade', 'hillshade-illumination-altitude', clamp(alt, 2, 90))
      map.setPaintProperty('hillshade', 'hillshade-exaggeration', alt < 15 ? 0.75 : 0.55)
    }
    const night = alt < -6
    const golden = alt >= -6 && alt < 8
    map.setSky({
      'sky-color': night ? '#0b1a2e' : golden ? '#f2b27a' : '#7fb6e0',
      'horizon-color': night ? '#1d2c44' : golden ? '#f7d9b0' : '#dcebf5',
      'fog-color': night ? '#1d2c44' : '#e8eef0',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.85,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0.4],
    })
    // Prima dell'alba e dopo il tramonto: velo scuro sulla scena.
    shade.style.opacity = String(night ? 0.55 : alt < 0 ? 0.3 : 0)
    sunOut.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} · sole ${alt < 0 ? 'sotto l’orizzonte' : `alto ${it(alt)}°, da ${compass(sp.azimuth)}`}`
  }
  const compass = (az: number) => ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'][Math.round(az / 45) % 8]

  // --- interfaccia
  const shade = h('div', { class: 'fly-shade', 'aria-hidden': 'true' })
  const title = h('div', { class: 'fly-title' }, h('p', { class: 'section-label' }, 'Anteprima di volo 3D'), h('h2', {}, o.name), h('p', { class: 'small muted' }, o.trail))
  const exit = h('button', { type: 'button', class: 'btn-primary fly-exit' }, icon('close', 18), 'ESCI')
  const readout = h('p', { class: 'mono small fly-read' })
  const sunOut = h('p', { class: 'mono small fly-sun' })

  const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void) => {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label }) as HTMLInputElement
    input.value = String(value)
    const out = h('span', { class: 'mono' }, fmt(value))
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value))
      onInput(Number(input.value))
    })
    return { el: h('label', { class: 'fly-slider' }, h('span', { class: 'fly-k' }, label, out), input), input, out }
  }
  const hSlider = slider('Altezza sul terreno', 20, 120, 5, height, (v) => `${v} m`, (v) => {
    height = v
    place()
  })
  const tSlider = slider('Inclinazione camera', -90, -2, 1, gimbal, (v) => (v > -5 ? 'orizzontale' : v < -85 ? 'verso il basso' : `${Math.round(-v)}° in giù`), (v) => {
    gimbal = v
    lookAt = null
    place()
  })
  const lSlider = slider('Ora del giorno', 300, 1260, 15, minutes, (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`, (v) => {
    minutes = v
    light()
  })

  const play = h('button', { type: 'button', class: 'btn-outline fly-play', 'aria-pressed': String(rotating) }) as HTMLButtonElement
  const drawPlay = () => {
    play.replaceChildren(rotating ? 'PAUSA' : 'RUOTA 360°')
    play.setAttribute('aria-pressed', String(rotating))
  }
  play.addEventListener('click', () => {
    rotating = !rotating
    slow.hidden = true
    drawPlay()
    if (rotating) loop()
  })
  drawPlay()
  const speedSel = h('div', { class: 'segmented small', role: 'radiogroup', 'aria-label': 'Velocità di rotazione' })
  for (const [lbl, v] of SPEEDS) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === speed) }, lbl)
    b.addEventListener('click', () => {
      speed = v
      for (const x of speedSel.children) x.setAttribute('aria-checked', String(x === b))
    })
    speedSel.append(b)
  }
  const slow = h('p', { class: 'small muted' }, 'Rotazione automatica fermata: il dispositivo fatica. Trascina per guardare in giro.')
  slow.hidden = true

  const near = o.pois
    .map((p) => ({ p, dist: distance(o.point, p.lngLat) }))
    .filter((x) => x.dist > 40 && x.dist < 8000)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 12)
  const lookSel = h('select', { 'aria-label': 'Guarda verso' }, h('option', { value: '' }, 'Guarda verso…'), ...near.map((x, i) => h('option', { value: String(i) }, `${x.p.nome} · ${it(x.dist / 1000, 1)} km`))) as HTMLSelectElement
  lookSel.addEventListener('change', () => {
    const x = near[Number(lookSel.value)]
    if (!x) return
    lookAt = x.p
    rotating = false
    drawPlay()
    bearing = bearingTo(o.point, x.p.lngLat)
    // Inclinazione per inquadrare il punto (dalla quota del drone a quella del POI).
    const target = x.p.ele ?? map.queryTerrainElevation(x.p.lngLat) ?? camAlt() - 100
    gimbal = clamp((-Math.atan2(camAlt() - target, x.dist) * 180) / Math.PI, -90, -2)
    tSlider.input.value = String(Math.round(gimbal))
    tSlider.input.dispatchEvent(new Event('input'))
    lookAt = x.p
    place()
  })

  const shot = h('button', { type: 'button', class: 'btn-outline' }, icon('share', 16), 'SALVA IMMAGINE')
  shot.addEventListener('click', () => screenshot())

  const panel = h(
    'div',
    { class: 'fly-panel', role: 'dialog', 'aria-label': 'Anteprima di volo 3D' },
    h('div', { class: 'fly-head' }, title, exit),
    readout,
    hSlider.el,
    tSlider.el,
    h('div', { class: 'fly-row' }, play, speedSel),
    slow,
    near.length ? lookSel : null,
    lSlider.el,
    sunOut,
    h('p', { class: 'mono small muted' }, `Alba ${hhmm(times.sunrise)} · Tramonto ${hhmm(times.sunset)}`),
    h('div', { class: 'fly-row' }, shot),
    h('p', { class: 'hint' }, 'Trascina sulla scena per guardare in giro. Sentiero e zone D-Flight attive nella data scelta sono disegnati sul terreno.'),
  )
  const root = h('div', { class: 'fly' }, shade, panel)
  document.body.append(root)

  function info(): void {
    const raised = camAlt() > ground + height + 0.5
    const parts = [
      `Terreno ${it(Math.round(ground))} m`,
      `drone ${height} m sopra (${it(Math.round(camAlt()))} m s.l.m.)`,
      ...(raised ? [`alzato a ${Math.round(camAlt() - ground)} m: pendio vicino più alto`] : []),
    ]
    if (lookAt) parts.push(`${lookAt.nome} a ${it(distance(o.point, lookAt.lngLat) / 1000, 1)} km`)
    readout.textContent = parts.join(' · ')
  }

  // --- rotazione automatica; si ferma da sola se il dispositivo arranca
  let raf = 0
  let last = 0
  const frames: number[] = []
  function loop(): void {
    cancelAnimationFrame(raf)
    last = performance.now()
    const step = (t: number) => {
      if (!rotating || dragging) return
      const dt = Math.min(0.1, (t - last) / 1000)
      frames.push(t - last)
      if (frames.length > 40) frames.shift()
      last = t
      bearing = (bearing + speed * dt) % 360
      place()
      const avg = frames.reduce((s, x) => s + x, 0) / frames.length
      if (frames.length >= 40 && avg > 70) {
        rotating = false
        slow.hidden = false
        drawPlay()
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  // --- trascinare per guardare in giro (la camera resta ferma sopra il punto)
  const surface = map.getCanvasContainer()
  let dragging = false
  let px = 0
  let py = 0
  const down = (e: PointerEvent) => {
    dragging = true
    px = e.clientX
    py = e.clientY
    surface.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!dragging) return
    bearing = (bearing - (e.clientX - px) * 0.25 + 360) % 360
    gimbal = clamp(gimbal + (e.clientY - py) * 0.15, -90, -2)
    tSlider.input.value = String(Math.round(gimbal))
    tSlider.out.textContent = gimbal > -5 ? 'orizzontale' : gimbal < -85 ? 'verso il basso' : `${Math.round(-gimbal)}° in giù`
    px = e.clientX
    py = e.clientY
    lookAt = null
    place()
  }
  const up = () => {
    if (!dragging) return
    dragging = false
    if (rotating) loop()
  }
  surface.addEventListener('pointerdown', down)
  surface.addEventListener('pointermove', move)
  surface.addEventListener('pointerup', up)
  surface.addEventListener('pointercancel', up)

  const onResize = () => map.setVerticalFieldOfView(verticalFov(map.getCanvas().clientWidth, map.getCanvas().clientHeight))

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
      const lines = [`QUOTA 120 · ${o.name}`, `${o.trail} · ${height} m sul terreno · ${o.day.split('-').reverse().join('.')} ${lSlider.out.textContent}`]
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

  // --- uscita: tutto come prima, nello stesso punto
  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    active = null
    document.removeEventListener('keydown', onKey)
    rotating = false
    cancelAnimationFrame(raf)
    surface.removeEventListener('pointerdown', down)
    surface.removeEventListener('pointermove', move)
    surface.removeEventListener('pointerup', up)
    surface.removeEventListener('pointercancel', up)
    window.removeEventListener('resize', onResize)
    root.remove()
    document.body.classList.remove('fly3d')
    map.setTerrain(null)
    if (map.getSource(TERRAIN_3D)) map.removeSource(TERRAIN_3D)
    map.setCenterClampedToGround(before.clamped)
    map.setSky({ 'sky-color': '#88C6FC', 'horizon-color': '#ffffff', 'fog-color': '#ffffff', 'atmosphere-blend': 0 })
    if (map.getLayer('hillshade')) {
      for (const p of ['hillshade-method', 'hillshade-illumination-anchor', 'hillshade-illumination-direction', 'hillshade-illumination-altitude'] as const) map.setPaintProperty('hillshade', p, undefined)
      map.setPaintProperty('hillshade', 'hillshade-exaggeration', ['interpolate', ['linear'], ['zoom'], 6, 0.3, 10, 0.42, 14, 0.3])
    }
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  exit.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  active = close

  // --- partenza
  map.resize()
  onResize()
  window.addEventListener('resize', onResize)
  light()
  readout.textContent = 'Calcolo la quota del terreno…'
  exit.focus()
  // Prima la quota dal DEM (al massimo 4 s, altrimenti resta quella del profilo), poi la camera.
  void Promise.race([demElevation(o.point[0], o.point[1]), new Promise<null>((r) => setTimeout(() => r(null), 4000))]).then((dem) => {
    if (closed) return
    if (dem) {
      ground = dem.at
      around = dem.max
    }
    ready = true
    place()
    if (rotating) loop()
  })
  return active
}
