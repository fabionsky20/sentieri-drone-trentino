import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 esegue i calcoli in un worker separato: Vite lo impacchetta e ne dà l'URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import './style.css'

import { attachToBasemap, FIRST_LABEL, FONT, LABEL_FONT, setBasemap, style, type Basemap } from './basemap'
import { isClosedOn, type Closures } from './closures'
import { activeCount, defaultFilters, matches, renderForm, type KmByColor } from './filters'
import { effective, isActive, today, type Effective } from './flight'
import { CATEGORIES, CATEGORY_ORDER, registerIcons } from './icons'
import { badgeRow, catIcon, formatDate, h, kmVal, renderPoi, renderTrail, renderZones } from './panel'
import { photosSection } from './photos'
import { renderProfile } from './profile'
import type { ListName, SavedState } from './saved'
import { rank } from './search'
import { buildTrailLines, pointAt } from './trailgeom'
import type {
  Colore,
  FC,
  Meta,
  PoiCategory,
  PoiProps,
  Profile,
  SearchItem,
  SegmentProps,
  Trail,
  ValleyProps,
  ZoneProps,
} from './types'

const COLORS: Record<Colore, string> = { verde: '#1f9d55', giallo: '#e0a800', rosso: '#d62f2f' }
const TRENTINO: [number, number, number, number] = [10.45, 45.67, 11.97, 46.55]
const SNAPSHOT_STALE_DAYS = 7
const MAX_RESULTS_SHOWN = 150

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function mobile(): boolean {
  return window.matchMedia('(max-width: 699px)').matches
}

/** Lettura/scrittura sicura di preferenze nel browser (può non essere disponibile). */
function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // archiviazione non disponibile: la scelta vale solo per questa visita
  }
}

// Su telefono la legenda parte chiusa per lasciare spazio alla mappa.
if (mobile()) $('legend').removeAttribute('open')

// ---------------------------------------------------------------- mappa base

maplibregl.setWorkerUrl(workerUrl)

const map = new maplibregl.Map({
  container: 'map',
  style,
  bounds: TRENTINO,
  maxZoom: 18,
  hash: true, // posizione nell'URL: si può salvare o condividere un punto
  attributionControl: { compact: true },
})
registerIcons(map)
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right')
map.addControl(
  new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
  'top-right',
)
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')

/** Pulsanti "Pulita / Topo" sulla mappa; la scelta resta salvata nel browser. */
class BasemapControl implements maplibregl.IControl {
  private el = document.createElement('div')
  onAdd(m: maplibregl.Map): HTMLElement {
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-switch'
    this.el.setAttribute('role', 'group')
    this.el.setAttribute('aria-label', 'Sfondo della mappa')
    const options: [Basemap, string][] = [
      ['pulita', 'Pulita'],
      ['topo', 'Topo'],
    ]
    const buttons = options.map(([value, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = value === 'pulita' ? 'Mappa pulita con rilievo' : 'Mappa topografica (OpenTopoMap)'
      b.addEventListener('click', () => apply(value))
      return [value, b] as const
    })
    const apply = (value: Basemap) => {
      setBasemap(m, value)
      for (const [v, b] of buttons) b.setAttribute('aria-pressed', String(v === value))
      store('sfondo', value)
    }
    this.el.append(...buttons.map(([, b]) => b))
    const saved = stored<string>('sfondo', 'pulita')
    apply(saved === 'topo' ? 'topo' : 'pulita')
    return this.el
  }
  onRemove(): void {
    this.el.remove()
  }
}

// ---------------------------------------------------------------- dati

async function load<T>(name: string): Promise<T> {
  const res = await fetch(`data/${name}`)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

const [segments, zonesFC, trailList, meta, poisFC, valleysFC, closures] = await Promise.all([
  load<FC<SegmentProps>>('segments.geojson'),
  load<FC<ZoneProps>>('zones.geojson'),
  load<Trail[]>('trails.json'),
  load<Meta>('meta.json'),
  load<FC<PoiProps>>('pois.geojson'),
  load<FC<ValleyProps>>('valleys.geojson'),
  load<Closures>('closures.json'),
  new Promise((resolve) => map.once('load', resolve)),
]).catch((err) => {
  $('status').textContent = `Errore nel caricamento dei dati: ${err.message}`
  throw err
})

// Profili e indice di ricerca servono solo quando si aprono: caricati alla prima richiesta.
let profilesP: Promise<Record<string, Profile>> | null = null
const getProfiles = () => (profilesP ??= load<Record<string, Profile>>('profiles.json'))
let searchP: Promise<SearchItem[]> | null = null
const getSearch = () => (searchP ??= load<SearchItem[]>('search.json'))

const trails = new Map(trailList.map((t) => [t.id, t]))
const zones = new Map<string, ZoneProps>()
for (const f of zonesFC.features) if (!zones.has(f.properties.zona_id)) zones.set(f.properties.zona_id, f.properties)
const segById = new Map(segments.features.map((f) => [f.properties.id, f.properties]))
const pois = new Map(poisFC.features.map((f) => [f.properties.id, f.properties]))
const poiCoord = new Map(
  poisFC.features.map((f) => [f.properties.id, (f.geometry as GeoJSON.Point).coordinates as [number, number]]),
)
const trailLines = buildTrailLines(segments)
// Per ogni POI, i sentieri che ci passano vicino.
const poiTrails = new Map<string, { trail: Trail; d: number; km: number }[]>()
for (const t of trailList) {
  for (const p of t.poi) {
    const list = poiTrails.get(p.id) ?? []
    list.push({ trail: t, d: p.d, km: p.km })
    poiTrails.set(p.id, list)
  }
}
const gruppi = [...new Set(trailList.map((t) => t.gruppo_montuoso).filter((g): g is string => !!g))].sort((a, b) =>
  a.localeCompare(b, 'it'),
)

// ---------------------------------------------------------------- stato

let day = today()
let eff = new Map<string, Effective>()
let trailKm = new Map<string, KmByColor>()
let closedIds = new Set<string>() // sentieri chiusi nella data scelta
type Selection =
  | { kind: 'trail'; id: string; seg?: string }
  | { kind: 'zones'; ids: string[]; back?: Selection }
  | { kind: 'poi'; id: string; back?: Selection }
  | null
let selection: Selection = null
const filters = defaultFilters()
const poiVisible = new Set<PoiCategory>(
  stored<PoiCategory[]>(
    'poi-visibili',
    CATEGORY_ORDER.filter((c) => CATEGORIES[c].visible),
  ),
)

// ---------------------------------------------------------------- layer

map.addSource('zones', { type: 'geojson', data: zonesFC })
map.addSource('segments', {
  type: 'geojson',
  data: segments,
  promoteId: 'id',
  attribution: 'Sentieri © SAT (ODbL) · Zone UAS © D-Flight',
})
map.addSource('pois', { type: 'geojson', data: poisFC, promoteId: 'id', attribution: 'POI © OpenStreetMap' })
map.addSource('valleys', { type: 'geojson', data: valleysFC })

const colorExpr = (prop: string) =>
  ['match', ['get', prop], 'verde', COLORS.verde, 'giallo', COLORS.giallo, COLORS.rosso] as unknown as string
const byZoom = (...stops: number[]) => ['interpolate', ['linear'], ['zoom'], ...stops] as unknown as number
// Sentieri esclusi dai filtri: attenuati (feature-state "off").
const dimmed = (on: number, off: number) =>
  ['case', ['boolean', ['feature-state', 'off'], false], off, on] as unknown as number

// Valli: etichette lungo la valle, le principali già da lontano. Solo sullo sfondo pulito.
const valleyLabel = (id: string, principale: boolean, line: boolean, minzoom: number, size: number) =>
  map.addLayer(
    {
      id,
      type: 'symbol',
      source: 'valleys',
      minzoom,
      filter: [
        'all',
        ['==', ['get', 'principale'], principale],
        line ? ['==', ['geometry-type'], 'LineString'] : ['==', ['geometry-type'], 'Point'],
      ],
      layout: {
        'symbol-placement': line ? 'line' : 'point',
        'symbol-spacing': 600,
        'text-max-angle': 40,
        'text-field': ['get', 'nome'],
        'text-font': FONT.italic,
        'text-size': size,
        'text-letter-spacing': principale ? 0.12 : 0.05,
        'text-transform': principale ? 'uppercase' : 'none',
      },
      paint: { 'text-color': '#7a6a55', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 },
    },
    FIRST_LABEL,
  )
valleyLabel('valley-major-line', true, true, 8, 12)
valleyLabel('valley-major-point', true, false, 8, 12)
valleyLabel('valley-minor-line', false, true, 11.5, 11)
valleyLabel('valley-minor-point', false, false, 12, 11)
attachToBasemap('pulita', ['valley-major-line', 'valley-major-point', 'valley-minor-line', 'valley-minor-point'])
map.addControl(new BasemapControl(), 'top-right')

// Zone e linee dei sentieri stanno sotto le etichette dello sfondo (FIRST_LABEL),
// così nomi di paesi e vette restano leggibili.
const zonesLayout = { visibility: 'none' as const }
map.addLayer(
  {
    id: 'zone-fill',
    type: 'fill',
    source: 'zones',
    layout: zonesLayout,
    filter: ['==', ['get', 'attiva'], true],
    paint: { 'fill-color': colorExpr('colore'), 'fill-opacity': 0.12 },
  },
  FIRST_LABEL,
)
map.addLayer(
  {
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
  },
  FIRST_LABEL,
)
map.addLayer(
  {
    id: 'zone-sel',
    type: 'line',
    source: 'zones',
    filter: ['in', ['get', 'zona_id'], ['literal', []]],
    paint: { 'line-color': '#1d4ed8', 'line-width': 3 },
  },
  FIRST_LABEL,
)

// Sentieri: ombra scura sfumata + bordo chiaro + colore, per staccarli da qualsiasi sfondo.
// Sottili da lontano (la rete è fitta), spessi da vicino. Bordo e ombra crescono con lo zoom.
const ZOOMS = [8, 10, 12, 14, 17]
const LINE_W = [1.5, 2.1, 3.2, 4.6, 7]
const widths = (extra: number[] = [0, 0, 0, 0, 0]) => ZOOMS.flatMap((z, i) => [z, LINE_W[i] + extra[i]])
const round = { 'line-cap': 'round', 'line-join': 'round' } as const
map.addLayer(
  {
    id: 'seg-sel',
    type: 'line',
    source: 'segments',
    filter: ['==', ['get', 'sentiero_id'], ''],
    layout: round,
    paint: { 'line-color': '#1d4ed8', 'line-width': byZoom(...widths([4, 5, 7, 8, 9])) },
  },
  FIRST_LABEL,
)
map.addLayer(
  {
    id: 'seg-shadow',
    type: 'line',
    source: 'segments',
    layout: round,
    paint: {
      'line-color': '#000000',
      'line-opacity': dimmed(0.28, 0.04),
      'line-width': byZoom(...widths([1.5, 2.5, 4, 5, 6])),
      'line-blur': 2,
    },
  },
  FIRST_LABEL,
)
map.addLayer(
  {
    id: 'seg-casing',
    type: 'line',
    source: 'segments',
    layout: round,
    paint: { 'line-color': '#ffffff', 'line-opacity': dimmed(1, 0.25), 'line-width': byZoom(...widths([1, 1.6, 2.4, 2.8, 3.2])) },
  },
  FIRST_LABEL,
)
map.addLayer(
  {
    id: 'seg-line',
    type: 'line',
    source: 'segments',
    layout: round,
    paint: { 'line-color': colorExpr('c'), 'line-opacity': dimmed(1, 0.2), 'line-width': byZoom(...widths()) },
  },
  FIRST_LABEL,
)
// La quota dei tratti gialli sta sopra tutto: è l'informazione più importante.
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
    'text-font': LABEL_FONT,
    'text-size': 12,
    'text-offset': [0, -1.1],
  },
  paint: {
    'text-color': '#6b4e00',
    'text-halo-color': '#ffffff',
    'text-halo-width': 1.8,
    'text-opacity': dimmed(1, 0.25),
  },
})
// Linea invisibile larga per toccare facilmente i sentieri col dito.
map.addLayer({
  id: 'seg-hit',
  type: 'line',
  source: 'segments',
  paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 22 },
})

// POI: icone per categoria (attivabili dalla legenda), nome da vicino.
const CAT_PRIORITY = ['rifugio', 'lago', 'malga', 'bivacco', 'cascata', 'passo', 'vetta', 'panoramico']
map.addLayer({
  id: 'poi-sel',
  type: 'circle',
  source: 'pois',
  filter: ['==', ['get', 'id'], ''],
  paint: { 'circle-radius': 15, 'circle-color': 'rgba(29,78,216,0.15)', 'circle-stroke-color': '#1d4ed8', 'circle-stroke-width': 2.5 },
})
map.addLayer({
  id: 'poi-icons',
  type: 'symbol',
  source: 'pois',
  minzoom: 10.5,
  filter: ['in', ['get', 'categoria'], ['literal', [...poiVisible]]],
  layout: {
    'icon-image': ['concat', 'poi-', ['get', 'categoria']],
    'icon-size': byZoom(10.5, 0.75, 14, 1),
    'symbol-sort-key': ['index-of', ['get', 'categoria'], ['literal', CAT_PRIORITY]],
    'text-field': ['step', ['zoom'], '', 13.5, ['get', 'nome']],
    'text-font': FONT.regular,
    'text-size': 11,
    'text-offset': [0, 1.1],
    'text-anchor': 'top',
    'text-optional': true,
    'text-max-width': 8,
  },
  paint: { 'text-color': '#2b2f2c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
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

  closedIds = new Set(Object.entries(closures).filter(([, list]) => list.some((c) => isClosedOn(c, day))).map(([id]) => id))

  const notam = [...zones.values()].filter((z) => !z.permanente && z.sui_sentieri && isActive(z, day)).length
  $('status').textContent = notam ? `${notam} NOTAM attivi sui sentieri in questa data` : ''
  $('status').hidden = !notam
  applyFilters() // il filtro "volo" dipende dalla data
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

// ---------------------------------------------------------------- POI on/off (legenda)

const poiToggles = $('poi-toggles')
for (const c of CATEGORY_ORDER) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement
  input.checked = poiVisible.has(c)
  input.addEventListener('change', () => {
    if (input.checked) poiVisible.add(c)
    else poiVisible.delete(c)
    map.setFilter('poi-icons', ['in', ['get', 'categoria'], ['literal', [...poiVisible]]])
    store('poi-visibili', [...poiVisible])
  })
  poiToggles.append(h('label', { class: 'check' }, input, catIcon(c, 16), CATEGORIES[c].plural))
}

// ---------------------------------------------------------------- pannello

const panel = $('panel')
const body = $('panel-body')
const hoverMarker = new maplibregl.Marker({ element: h('div', { class: 'hover-dot' }) })

function trailPanel(trail: Trail, segId?: string): HTMLElement {
  const line = trailLines.get(trail.id)
  const profileBox = h('div', { class: 'profile-box' }, h('p', { class: 'muted small' }, 'Carico il profilo…'))
  getProfiles()
    .then((all) => {
      const profile = all[trail.id]
      if (!profile || !line) {
        profileBox.replaceChildren(h('p', { class: 'muted small' }, 'Profilo non disponibile.'))
        return
      }
      profileBox.replaceChildren(
        renderProfile({
          profile,
          ranges: line.segs.map((s) => ({ from: s.from, to: s.to, color: COLORS[eff.get(s.id)?.colore ?? 'verde'] })),
          pois: trail.poi.flatMap((p) => (pois.has(p.id) ? [{ km: p.km, cat: pois.get(p.id)!.categoria }] : [])),
          onHover: (m) => {
            if (m == null) hoverMarker.remove()
            else hoverMarker.setLngLat(pointAt(line, m)).addTo(map)
          },
        }),
      )
    })
    .catch(() => profileBox.replaceChildren(h('p', { class: 'muted small' }, 'Profilo non disponibile.')))

  const photoPoints = line ? [0.2, 0.5, 0.8].map((f) => pointAt(line, f * line.length)) : []
  const back: Selection = { kind: 'trail', id: trail.id, seg: segId }
  const seg = segId ? segById.get(segId) : undefined
  const saveBox = h('div', { class: 'savebox' })
  currentSave = { trailId: trail.id, box: saveBox }
  renderSaveBox()
  return renderTrail({
    trail,
    save: saveBox,
    segment: seg ? { seg, eff: eff.get(seg.id)! } : undefined,
    trailKm: trailKm.get(trail.id)!,
    closures: {
      all: closures[trail.id] ?? [],
      active: (closures[trail.id] ?? []).filter((c) => isClosedOn(c, day)),
    },
    zones,
    pois,
    profile: profileBox,
    photos: photosSection(photoPoints, 1500),
    onZone: (ids) => select({ kind: 'zones', ids, back }),
    onPoi: (id) => select({ kind: 'poi', id, back }),
    onFit: () => fitTrail(trail),
  })
}

function render(): void {
  hoverMarker.remove()
  const trailId = selection?.kind === 'trail' ? selection.id : ''
  map.setFilter('seg-sel', ['==', ['get', 'sentiero_id'], trailId])
  map.setFilter('zone-sel', ['in', ['get', 'zona_id'], ['literal', selection?.kind === 'zones' ? selection.ids : []]])
  map.setFilter('poi-sel', ['==', ['get', 'id'], selection?.kind === 'poi' ? selection.id : ''])
  if (!selection) {
    panel.hidden = true
    return
  }
  body.replaceChildren()
  const s = selection
  if (s.kind === 'trail') {
    body.append(trailPanel(trails.get(s.id)!, s.seg))
  } else if (s.kind === 'zones') {
    const list = s.ids.map((id) => zones.get(id)).filter((z): z is ZoneProps => !!z)
    body.append(renderZones(sortZones(list), s.back ? () => select(s.back!) : undefined))
  } else {
    const poi = pois.get(s.id)!
    body.append(
      renderPoi({
        poi,
        near: (poiTrails.get(poi.id) ?? []).sort((a, b) => a.d - b.d),
        photos: photosSection([poiCoord.get(poi.id)!], 400),
        onTrail: (id) => {
          select({ kind: 'trail', id })
          fitTrail(trails.get(id)!)
        },
        onBack: s.back ? () => select(s.back!) : undefined,
      }),
    )
  }
  panel.hidden = false
  panel.scrollTop = 0
  if (mobile()) closeFilters() // su telefono un solo foglio alla volta
}

function select(s: Selection): void {
  selection = s
  render()
}

function fitTrail(trail: Trail): void {
  map.fitBounds(trail.bbox, { padding: fitPadding(), maxZoom: 15 })
}

/** Prima le zone più restrittive. */
function sortZones(list: ZoneProps[]): ZoneProps[] {
  const rank = (z: ZoneProps) => (z.tipo_rosso === 'vietato' ? 0 : z.colore === 'rosso' ? 1 : 2 + (z.quota_max_m ?? 0) / 1000)
  return [...list].sort((a, b) => rank(a) - rank(b))
}

const fitPadding = () =>
  mobile()
    ? { top: 70, left: 30, right: 30, bottom: Math.round(window.innerHeight * 0.5) }
    : { top: 80, left: filtersOpen() ? 400 : 40, right: 440, bottom: 40 }

$('panel-close').addEventListener('click', () => select(null))
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!$('search').hidden) closeSearch()
  else select(null)
})

// ---------------------------------------------------------------- filtri

const filtersEl = $('filters')
const filtersOpen = () => !filtersEl.hidden

function openFilters(): void {
  filtersEl.hidden = false
  $('legend').hidden = !mobile() // su PC il pannello filtri prende il posto della legenda
  if (mobile()) select(null)
}
function closeFilters(): void {
  filtersEl.hidden = true
  $('legend').hidden = false
}
$('open-filters').addEventListener('click', () => (filtersOpen() ? closeFilters() : openFilters()))
$('filters-close').addEventListener('click', closeFilters)
$('filters-reset').addEventListener('click', () => {
  Object.assign(filters, defaultFilters())
  drawForm()
  applyFilters()
})

function drawForm(): void {
  $('filters-form').replaceChildren(renderForm(filters, gruppi, applyFilters))
}

function applyFilters(): void {
  const active = activeCount(filters)
  const ok = new Set<string>()
  const results: Trail[] = []
  for (const t of trailList) {
    const ctx = {
      km: trailKm.get(t.id) ?? { verde: 0, giallo: 0, rosso: 0 },
      closed: closedIds.has(t.id),
      mine: saved?.miei.has(t.id) ?? false,
      shared: saved?.condivisi.has(t.id) ?? false,
    }
    if (matches(t, ctx, filters)) {
      ok.add(t.id)
      results.push(t)
    }
  }
  for (const f of segments.features) {
    map.setFeatureState({ source: 'segments', id: f.properties.id }, { off: active > 0 && !ok.has(f.properties.sentiero_id) })
  }

  const count = $('filter-count')
  count.hidden = active === 0
  count.textContent = String(active)

  // Prima i più volabili nella data scelta (km verdi, poi gialli).
  const km = (t: Trail) => trailKm.get(t.id) ?? { verde: 0, giallo: 0, rosso: 0 }
  results.sort((a, b) => km(b).verde - km(a).verde || km(b).giallo - km(a).giallo)
  $('filters-summary').textContent =
    active === 0
      ? `${results.length} sentieri (nessun filtro attivo)`
      : `${results.length} sentieri su ${trailList.length}` + (results.length > MAX_RESULTS_SHOWN ? `, mostrati i primi ${MAX_RESULTS_SHOWN}` : '')
  const list = $('filters-results')
  list.replaceChildren()
  for (const t of results.slice(0, MAX_RESULTS_SHOWN)) {
    const k = km(t)
    const meta = [
      closedIds.has(t.id) ? 'CHIUSO' : null,
      saved?.miei.has(t.id) || saved?.condivisi.has(t.id) ? '★ salvato' : null,
      kmVal((t.lunghezza_m ?? 0) / 1000),
      t.dislivello_pos != null ? `+${t.dislivello_pos} m` : null,
      t.difficolta,
      `verde ${kmVal(k.verde)}`,
    ].filter(Boolean)
    const btn = h(
      'button',
      { type: 'button' },
      h('span', { class: 'r-title' }, `${t.numero} · ${t.titolo}`),
      h('span', { class: 'r-meta' }, meta.join(' · ')),
      t.badge.length ? badgeRow(t.badge) : null,
    )
    btn.addEventListener('click', () => {
      select({ kind: 'trail', id: t.id })
      fitTrail(t)
    })
    list.append(h('li', {}, btn))
  }
}
drawForm()

// ---------------------------------------------------------------- ricerca

const searchEl = $('search')
const searchInput = $<HTMLInputElement>('search-input')
const searchList = $('search-results')
const KIND_LABEL: Record<string, string> = { sentiero: 'Sentiero', paese: 'Località', valle: 'Valle' }

function openSearch(): void {
  searchEl.hidden = false
  searchInput.focus()
  searchInput.select()
  getSearch().catch(() => {
    searchList.replaceChildren(h('li', { class: 'muted' }, 'Indice di ricerca non disponibile.'))
  })
}
function closeSearch(): void {
  searchEl.hidden = true
}
$('open-search').addEventListener('click', openSearch)
$('search-close').addEventListener('click', closeSearch)

let lastResults: SearchItem[] = []
searchInput.addEventListener('input', async () => {
  const items = await getSearch()
  lastResults = rank(items, searchInput.value)
  searchList.replaceChildren()
  if (searchInput.value.trim() && !lastResults.length) searchList.append(h('li', { class: 'muted' }, 'Nessun risultato'))
  for (const it of lastResults) {
    const cat = it.t in CATEGORIES ? (it.t as PoiCategory) : null
    const btn = h(
      'button',
      { type: 'button' },
      cat ? catIcon(cat, 16) : h('span', { class: 'kind-dot' }),
      h('span', { class: 'r-title' }, it.n),
      h('span', { class: 'r-meta' }, cat ? CATEGORIES[cat].label : (KIND_LABEL[it.t] ?? it.t)),
    )
    btn.addEventListener('click', () => pick(it))
    searchList.append(h('li', {}, btn))
  }
})
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && lastResults[0]) pick(lastResults[0])
})

function pick(it: SearchItem): void {
  closeSearch()
  if (it.t === 'sentiero' && it.id && trails.has(it.id)) {
    select({ kind: 'trail', id: it.id })
    fitTrail(trails.get(it.id)!)
  } else if (it.id && pois.has(it.id)) {
    // Accende la categoria se era spenta, così l'icona si vede.
    const cat = pois.get(it.id)!.categoria
    if (!poiVisible.has(cat)) {
      poiVisible.add(cat)
      map.setFilter('poi-icons', ['in', ['get', 'categoria'], ['literal', [...poiVisible]]])
      const box = [...poiToggles.querySelectorAll('input')][CATEGORY_ORDER.indexOf(cat)]
      if (box) box.checked = true
    }
    select({ kind: 'poi', id: it.id })
    map.flyTo({ center: it.c, zoom: 14, padding: fitPadding() })
  } else if (it.b) {
    map.fitBounds(it.b, { padding: fitPadding(), maxZoom: 13 })
  } else {
    map.flyTo({ center: it.c, zoom: it.t === 'valle' ? 12 : 13.5 })
  }
}

// ---------------------------------------------------------------- click sulla mappa

map.on('click', (e) => {
  const tol = 6
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [e.point.x - tol, e.point.y - tol],
    [e.point.x + tol, e.point.y + tol],
  ]
  const poiHits = map.queryRenderedFeatures(box, { layers: ['poi-icons'] })
  if (poiHits.length) {
    select({ kind: 'poi', id: poiHits[0].properties.id as string })
    revealAbovePanel(e.point)
    return
  }
  const segHits = map.queryRenderedFeatures(box, { layers: ['seg-hit'] })
  if (segHits.length) {
    const segId = nearest(segHits, e.point).properties.id as string
    select({ kind: 'trail', id: segById.get(segId)!.sentiero_id, seg: segId })
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

for (const layer of ['seg-hit', 'zone-fill', 'poi-icons']) {
  map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''))
}

// ---------------------------------------------------------------- sentieri salvati (Firebase)

// Il modulo Firebase si scarica solo quando serve: al primo uso di "Salva"/"Salvati", oppure
// subito all'avvio se su questo dispositivo era già stato fatto il login.
let saved: SavedState | null = null
let savedModule: Promise<typeof import('./saved')> | null = null
let currentSave: { trailId: string; box: HTMLElement } | null = null

function loadSaved(): Promise<typeof import('./saved')> {
  if (!savedModule) {
    savedModule = import('./saved')
    savedModule
      .then((m) =>
        m.subscribe((st) => {
          saved = st
          store('salvati-attivo', st.status !== 'anonimo')
          renderSaveBox()
          renderSavedSheet()
          applyFilters()
        }),
      )
      .catch((e) => {
        savedModule = null
        showSavedError(`Impossibile caricare il servizio dei salvati: ${e.message}`)
      })
  }
  return savedModule
}

const savedEl = $('saved')
const savedBody = $('saved-body')

function openSaved(): void {
  closeFilters()
  savedEl.hidden = false
  $('legend').hidden = !mobile()
  if (mobile()) select(null)
  loadSaved()
  renderSavedSheet()
}
function closeSaved(): void {
  savedEl.hidden = true
  $('legend').hidden = filtersOpen() && !mobile()
}
$('open-saved').addEventListener('click', () => (savedEl.hidden ? openSaved() : closeSaved()))
$('saved-close').addEventListener('click', closeSaved)
$('open-filters').addEventListener('click', closeSaved)

function showSavedError(msg: string): void {
  const status = $('status')
  status.textContent = msg
  status.hidden = false
  setTimeout(() => applyDay(), 6000) // poi torna l'avviso dei NOTAM
}

async function doLogin(): Promise<void> {
  try {
    const m = await loadSaved()
    await m.login()
  } catch (e) {
    const code = (e as { code?: string }).code ?? ''
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return
    showSavedError(
      code === 'auth/popup-blocked'
        ? 'Il browser ha bloccato la finestra di accesso: consenti i popup per questo sito.'
        : `Accesso non riuscito (${code || (e as Error).message}).`,
    )
  }
}

async function toggleSaved(list: ListName, trailId: string): Promise<void> {
  const m = await loadSaved()
  if (saved?.status !== 'membro') {
    openSaved()
    return
  }
  const has = list === 'miei' ? saved.miei.has(trailId) : saved.condivisi.has(trailId)
  try {
    await (has ? m.remove(list, trailId) : m.save(list, trailId))
  } catch (e) {
    showSavedError(`Salvataggio non riuscito: ${(e as Error).message}`)
  }
}

/** Pulsanti "Salva" nella scheda del sentiero. */
function renderSaveBox(): void {
  if (!currentSave) return
  const { trailId, box } = currentSave
  const button = (list: ListName, label: string) => {
    const on = list === 'miei' ? saved?.miei.has(trailId) : saved?.condivisi.has(trailId)
    const b = h('button', { type: 'button', class: 'savebtn', 'aria-pressed': String(!!on) }, `${on ? '★' : '☆'} ${label}`)
    b.addEventListener('click', () => toggleSaved(list, trailId))
    return b
  }
  box.replaceChildren(button('miei', 'Miei'), button('condivisi', 'Condivisi'))
}

function savedList(entries: [string, { aggiunto: Date | null; da?: string }][], list: ListName): HTMLElement {
  const known = entries.filter(([id]) => trails.has(id))
  if (!known.length) {
    return h(
      'p',
      { class: 'muted small' },
      list === 'miei' ? 'Nessun sentiero salvato: usa "☆ Miei" nella scheda di un sentiero.' : 'La lista condivisa è vuota.',
    )
  }
  const ul = h('ul', { class: 'results' })
  known.sort((a, b) => (b[1].aggiunto?.getTime() ?? 0) - (a[1].aggiunto?.getTime() ?? 0))
  for (const [id, info] of known) {
    const t = trails.get(id)!
    const who = info.da ? `aggiunto da ${saved?.membri.get(info.da) ?? 'un membro'}` : null
    const open = h(
      'button',
      { type: 'button' },
      h('span', { class: 'r-title' }, `${t.numero} · ${t.titolo}`),
      h('span', { class: 'r-meta' }, [kmVal((t.lunghezza_m ?? 0) / 1000), closedIds.has(id) ? 'CHIUSO' : null, who].filter(Boolean).join(' · ')),
    )
    open.addEventListener('click', () => {
      if (mobile()) closeSaved()
      select({ kind: 'trail', id })
      fitTrail(t)
    })
    const del = h('button', { type: 'button', class: 'remove', 'aria-label': `Togli ${t.numero} dalla lista`, title: 'Togli dalla lista' }, '×')
    del.addEventListener('click', () => toggleSaved(list, id))
    ul.append(h('li', { class: 'saved-item' }, open, del))
  }
  return ul
}

/** Contenuto della sezione "Salvati" secondo lo stato del login. */
function renderSavedSheet(): void {
  if (savedEl.hidden) return
  const st = saved
  const parts: HTMLElement[] = []
  const retry = () => {
    const b = h('button', { type: 'button', class: 'primary' }, 'Riprova')
    b.addEventListener('click', () => loadSaved().then((m) => m.retry()))
    return b
  }
  if (!st || st.status === 'caricamento') {
    parts.push(h('p', { class: 'muted' }, 'Caricamento…'))
  } else if (st.status === 'anonimo') {
    const b = h('button', { type: 'button', class: 'primary' }, 'Accedi con Google')
    b.addEventListener('click', doLogin)
    parts.push(
      h('p', {}, "Accedi per salvare i sentieri e ritrovarli sincronizzati su telefono e PC. L'accesso resta attivo: non serve rifarlo ogni volta."),
      b,
    )
  } else if (st.status === 'non-membro') {
    const uid = st.user?.uid ?? ''
    const copy = h('button', { type: 'button', class: 'link' }, 'Copia')
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(uid)
        copy.textContent = 'Copiato'
      } catch {
        copy.textContent = 'Selezionalo e copialo a mano'
      }
    })
    parts.push(
      h('p', {}, `Accesso fatto come ${st.user?.nome ?? st.user?.email ?? 'utente Google'}, ma questo account non è ancora tra i membri dell'app.`),
      h('p', { class: 'small' }, 'Il tuo ID utente, da aggiungere ai membri:'),
      h('p', { class: 'uid' }, h('code', {}, uid), ' ', copy),
      retry(),
    )
  } else if (st.status === 'errore') {
    parts.push(h('p', { class: 'warn' }, `Errore: ${st.errore}`), retry())
  } else {
    parts.push(
      h('h3', {}, `I miei (${st.miei.size})`),
      savedList([...st.miei], 'miei'),
      h('h3', {}, `Condivisi (${st.condivisi.size})`),
      h('p', { class: 'muted small' }, `Lista comune a tutti i membri: ${[...st.membri.values()].join(', ')}.`),
      savedList([...st.condivisi], 'condivisi'),
    )
  }
  if (st?.user) {
    const out = h('button', { type: 'button', class: 'link' }, 'Esci')
    out.addEventListener('click', () => loadSaved().then((m) => m.logout()))
    parts.push(h('p', { class: 'muted small account' }, `Account: ${st.user.nome ?? ''}${st.user.email ? ` (${st.user.email})` : ''} · `, out))
  }
  savedBody.replaceChildren(...parts)
}

if (stored('salvati-attivo', false)) loadSaved()

applyDay()
