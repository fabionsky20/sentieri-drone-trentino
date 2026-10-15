import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapGeoJSONFeature, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 esegue i calcoli in un worker separato: Vite lo impacchetta e ne dà l'URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import './style.css'

import { effective, isActive, today, type Effective } from './flight'
import { formatDate, renderSegment, renderZones } from './panel'
import type { Colore, FC, Meta, SegmentProps, Trail, ZoneProps } from './types'

const COLORS: Record<Colore, string> = { verde: '#1f9d55', giallo: '#e0a800', rosso: '#d62f2f' }
const TRENTINO: [number, number, number, number] = [10.45, 45.67, 11.97, 46.55]
const SNAPSHOT_STALE_DAYS = 7

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// Su telefono la legenda parte chiusa per lasciare spazio alla mappa.
if (mobile()) $('legend').removeAttribute('open')

// ---------------------------------------------------------------- mappa base

const style: StyleSpecification = {
  version: 8,
  // Font per le etichette (quote sui tratti gialli), senza chiavi API.
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
  sources: {
    topo: {
      type: 'raster',
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      tileSize: 256,
      maxzoom: 17,
      attribution:
        'Mappa © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), dati © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Sentieri © SAT (ODbL) · Zone UAS © D-Flight',
    },
  },
  layers: [{ id: 'topo', type: 'raster', source: 'topo' }],
}

maplibregl.setWorkerUrl(workerUrl)

const map = new maplibregl.Map({
  container: 'map',
  style,
  bounds: TRENTINO,
  maxZoom: 18,
  hash: true, // posizione nell'URL: si può salvare o condividere un punto
  attributionControl: { compact: true },
})
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right')
map.addControl(
  new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
  'top-right',
)
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')

// ---------------------------------------------------------------- dati

async function load<T>(name: string): Promise<T> {
  const res = await fetch(`data/${name}`)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

const [segments, zonesFC, trailList, meta] = await Promise.all([
  load<FC<SegmentProps>>('segments.geojson'),
  load<FC<ZoneProps>>('zones.geojson'),
  load<Trail[]>('trails.json'),
  load<Meta>('meta.json'),
  new Promise((resolve) => map.once('load', resolve)),
]).catch((err) => {
  $('status').textContent = `Errore nel caricamento dei dati: ${err.message}`
  throw err
})

const trails = new Map(trailList.map((t) => [t.id, t]))
const zones = new Map<string, ZoneProps>()
for (const f of zonesFC.features) if (!zones.has(f.properties.zona_id)) zones.set(f.properties.zona_id, f.properties)
const segById = new Map(segments.features.map((f) => [f.properties.id, f.properties]))

// ---------------------------------------------------------------- stato

let day = today()
let eff = new Map<string, Effective>()
let trailKm = new Map<string, { verde: number; giallo: number; rosso: number }>()
type Selection = { kind: 'segment'; id: string } | { kind: 'zones'; ids: string[]; from?: string } | null
let selection: Selection = null

// ---------------------------------------------------------------- layer

map.addSource('zones', { type: 'geojson', data: zonesFC })
map.addSource('segments', { type: 'geojson', data: segments, promoteId: 'id' })

const colorExpr = (prop: string) =>
  ['match', ['get', prop], 'verde', COLORS.verde, 'giallo', COLORS.giallo, COLORS.rosso] as unknown as string

const zonesLayout = { visibility: 'none' as const }
map.addLayer({
  id: 'zone-fill',
  type: 'fill',
  source: 'zones',
  layout: zonesLayout,
  filter: ['==', ['get', 'attiva'], true],
  paint: { 'fill-color': colorExpr('colore'), 'fill-opacity': 0.12 },
})
map.addLayer({
  id: 'zone-line',
  type: 'line',
  source: 'zones',
  layout: zonesLayout,
  filter: ['==', ['get', 'attiva'], true],
  paint: {
    'line-color': colorExpr('colore'),
    'line-width': 1.2,
    'line-opacity': 0.8,
    'line-dasharray': ['case', ['==', ['get', 'tipo_rosso'], 'vietato'], ['literal', [1, 0]], ['literal', [3, 2]]],
  },
})
map.addLayer({
  id: 'zone-sel',
  type: 'line',
  source: 'zones',
  filter: ['in', ['get', 'zona_id'], ['literal', []]],
  paint: { 'line-color': '#1d4ed8', 'line-width': 3 },
})

const lineWidth = ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3, 15, 5] as unknown as number
map.addLayer({
  id: 'seg-sel',
  type: 'line',
  source: 'segments',
  filter: ['==', ['get', 'sentiero_id'], ''],
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': '#1d4ed8', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 15, 12] },
})
map.addLayer({
  id: 'seg-casing',
  type: 'line',
  source: 'segments',
  minzoom: 11,
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 8], 'line-opacity': 0.9 },
})
map.addLayer({
  id: 'seg-line',
  type: 'line',
  source: 'segments',
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': colorExpr('c'), 'line-width': lineWidth },
})
map.addLayer({
  id: 'seg-label',
  type: 'symbol',
  source: 'segments',
  minzoom: 12,
  filter: ['==', ['get', 'c'], 'giallo'],
  layout: {
    'symbol-placement': 'line',
    'symbol-spacing': 250,
    'text-field': ['concat', '≤ ', ['to-string', ['get', 'q']], ' m'],
    'text-font': ['Noto Sans Medium'],
    'text-size': 12,
    'text-offset': [0, -1],
  },
  paint: { 'text-color': '#6b4e00', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
})
// Linea invisibile larga per toccare facilmente i sentieri col dito.
map.addLayer({
  id: 'seg-hit',
  type: 'line',
  source: 'segments',
  paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 },
})

// ---------------------------------------------------------------- data scelta

function applyDay(): void {
  eff = new Map()
  trailKm = new Map()
  for (const f of segments.features) {
    const p = f.properties
    const e = effective(p, zones, day)
    eff.set(p.id, e)
    const k = trailKm.get(p.sentiero_id) ?? { verde: 0, giallo: 0, rosso: 0 }
    k[e.colore] += p.lunghezza_m / 1000
    trailKm.set(p.sentiero_id, k)
    const props = f.properties as SegmentProps & { c: Colore; q: number | null }
    props.c = e.colore
    props.q = e.quota_max_m
  }
  ;(map.getSource('segments') as GeoJSONSource).setData(segments)

  for (const f of zonesFC.features) (f.properties as ZoneProps & { attiva: boolean }).attiva = isActive(f.properties, day)
  ;(map.getSource('zones') as GeoJSONSource).setData(zonesFC)

  const notam = [...zones.values()].filter((z) => !z.permanente && z.sui_sentieri && isActive(z, day)).length
  $('status').textContent = notam ? `${notam} NOTAM attivi sui sentieri in questa data` : ''
  $('status').hidden = !notam
  render()
}

const dayInput = $<HTMLInputElement>('day')
dayInput.value = day
dayInput.addEventListener('change', () => {
  if (!dayInput.value) return
  day = dayInput.value
  applyDay()
})

// ---------------------------------------------------------------- snapshot

if (meta.snapshot) {
  const snap = new Date(meta.snapshot)
  const ageDays = (Date.now() - snap.getTime()) / 86_400_000
  const el = $('snapshot')
  el.textContent = `Zone D-Flight al ${formatDate(meta.snapshot)}`
  if (ageDays > SNAPSHOT_STALE_DAYS) {
    el.classList.add('stale')
    el.textContent += ` (${Math.floor(ageDays)} giorni fa: aggiorna i dati)`
  }
  el.title = 'I NOTAM pubblicati dopo questa data non sono inclusi.'
}

// ---------------------------------------------------------------- zone on/off

const toggle = $<HTMLButtonElement>('toggle-zones')
toggle.addEventListener('click', () => {
  const on = toggle.getAttribute('aria-pressed') !== 'true'
  toggle.setAttribute('aria-pressed', String(on))
  for (const id of ['zone-fill', 'zone-line']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
})

// ---------------------------------------------------------------- pannello

const panel = $('panel')
const body = $('panel-body')

function render(): void {
  map.setFilter('seg-sel', ['==', ['get', 'sentiero_id'], selection?.kind === 'segment' ? segById.get(selection.id)!.sentiero_id : ''])
  map.setFilter('zone-sel', ['in', ['get', 'zona_id'], ['literal', selection?.kind === 'zones' ? selection.ids : []]])
  if (!selection) {
    panel.hidden = true
    return
  }
  body.replaceChildren()
  if (selection.kind === 'segment') {
    const seg = segById.get(selection.id)!
    const trail = trails.get(seg.sentiero_id)!
    const from = selection.id
    body.append(
      renderSegment({
        seg,
        eff: eff.get(seg.id)!,
        trail,
        trailKm: trailKm.get(trail.id)!,
        zones,
        onZone: (ids) => select({ kind: 'zones', ids, from }),
        onFit: () => map.fitBounds(trail.bbox, { padding: fitPadding(), maxZoom: 15 }),
      }),
    )
  } else {
    const list = selection.ids.map((id) => zones.get(id)).filter((z): z is ZoneProps => !!z)
    const from = selection.from
    body.append(renderZones(sortZones(list), from ? () => select({ kind: 'segment', id: from }) : undefined))
  }
  panel.hidden = false
  panel.scrollTop = 0
}

function select(s: Selection): void {
  selection = s
  render()
}

/** Prima le zone più restrittive. */
function sortZones(list: ZoneProps[]): ZoneProps[] {
  const rank = (z: ZoneProps) => (z.tipo_rosso === 'vietato' ? 0 : z.colore === 'rosso' ? 1 : 2 + (z.quota_max_m ?? 0) / 1000)
  return [...list].sort((a, b) => rank(a) - rank(b))
}

function mobile(): boolean {
  return window.matchMedia('(max-width: 699px)').matches
}
const fitPadding = () =>
  mobile()
    ? { top: 70, left: 30, right: 30, bottom: Math.round(window.innerHeight * 0.5) }
    : { top: 80, left: 40, right: 440, bottom: 40 }

$('panel-close').addEventListener('click', () => select(null))
document.addEventListener('keydown', (e) => e.key === 'Escape' && select(null))

// ---------------------------------------------------------------- click

map.on('click', (e) => {
  const tol = 6
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [e.point.x - tol, e.point.y - tol],
    [e.point.x + tol, e.point.y + tol],
  ]
  const segHits = map.queryRenderedFeatures(box, { layers: ['seg-hit'] })
  if (segHits.length) {
    select({ kind: 'segment', id: nearest(segHits, e.point).properties.id as string })
    revealAbovePanel(e.point)
    return
  }
  if (map.getLayoutProperty('zone-fill', 'visibility') === 'visible') {
    const ids = [...new Set(map.queryRenderedFeatures(e.point, { layers: ['zone-fill'] }).map((f) => f.properties.zona_id as string))]
    if (ids.length) {
      select({ kind: 'zones', ids })
      return
    }
  }
  select(null)
})

/** Su telefono il pannello copre metà schermo: sposta la mappa così il punto toccato resta visibile. */
function revealAbovePanel(point: maplibregl.Point): void {
  if (!mobile()) return
  const h = map.getContainer().clientHeight
  const visible = h - panel.offsetHeight
  if (point.y > visible - 40) map.panBy([0, point.y - visible / 2])
}

/** Tra più tratti sotto il dito, quello più vicino al punto toccato. */
function nearest(features: MapGeoJSONFeature[], point: maplibregl.Point): MapGeoJSONFeature {
  let best = features[0]
  let bestD = Infinity
  for (const f of features) {
    const g = f.geometry
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const d = distToSegment(point, map.project(line[i - 1] as [number, number]), map.project(line[i] as [number, number]))
        if (d < bestD) [bestD, best] = [d, f]
      }
    }
  }
  return best
}

function distToSegment(p: maplibregl.Point, a: maplibregl.Point, b: maplibregl.Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

for (const layer of ['seg-hit', 'zone-fill']) {
  map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''))
}

applyDay()
