import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 esegue i calcoli in un worker separato: Vite lo impacchetta e ne dà l'URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import './style.css'

import { attachToBasemap, FIRST_LABEL, FONT, LABEL_FONT, setBasemap, style, type Basemap } from './basemap'
import { isClosedOn, type Closures } from './closures'
import { activeCount, defaultFilters, matches, renderForm, segmented, type KmByColor } from './filters'
import { effective, isActive, today, type Effective } from './flight'
import { CATEGORIES, CATEGORY_ORDER, registerIcons } from './icons'
import { catIcon, dotDate, formatDate, h, renderPoi, renderTrail, renderZones, trailCard } from './panel'
import { photosSection } from './photos'
import { renderProfile } from './profile'
import type { AccountState } from './account'
import type { BoardsState } from './boards'
import { boardsList, inviteCards, migrationBanner, renderBoard, renderBoardPicker, renderLinkInvite, renderNotifications, type BoardsActions, type TrailInfo } from './boardsui'
import { avatarEl, expiries, renderOnboarding as renderOnboarding_, renderProfilePage, renderWelcomeInvite, validDate, type ProfileActions } from './profilepage'
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
import { hydrateIcons, icon } from './ui'

/** Colori degli stati di volo (usati solo per il volo). */
const COLORS: Record<Colore, string> = { verde: '#2FBF71', giallo: '#E9AE0B', rosso: '#E5484D' }
const ACCENT = '#0B6E84'
const TRENTINO: [number, number, number, number] = [10.45, 45.67, 11.97, 46.55]
const SNAPSHOT_STALE_DAYS = 7
const MAX_RESULTS_SHOWN = 150

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const MQ_MOBILE = window.matchMedia('(max-width: 767px)')
const MQ_WIDE = window.matchMedia('(min-width: 1024px)')
const mobile = () => MQ_MOBILE.matches
/** Conteggi con separatore delle migliaia anche a 4 cifre: "1.081". */
const fmtCount = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

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

hydrateIcons()

// Avvisi brevi in basso (errori, posizione non disponibile…).
let toastTimer = 0
function showToast(msg: string, ms = 6000): void {
  const t = $('status')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  if (ms) toastTimer = window.setTimeout(() => (t.hidden = true), ms)
}


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
// La geolocalizzazione di MapLibre resta attiva ma nascosta: la comanda il pulsante della colonna strumenti.
const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true })
map.addControl(geolocate, 'top-right')
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')
// La mappa cambia dimensione con il layout (colonne, schermate): va avvisata.
new ResizeObserver(() => map.resize()).observe($('map'))

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
  showToast(`Errore nel caricamento dei dati: ${err.message}`, 0)
  throw err
})
$('status').hidden = true
// Attribuzioni delle mappe: chiuse all'avvio (resta il pulsante ⓘ), così non coprono la legenda.
map.once('idle', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'))

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
let zonesOn = false
const kmOf = (id: string): KmByColor => trailKm.get(id) ?? { verde: 0, giallo: 0, rosso: 0 }

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
      paint: { 'text-color': '#5E6B5F', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 },
    },
    FIRST_LABEL,
  )
valleyLabel('valley-major-line', true, true, 8, 12)
valleyLabel('valley-major-point', true, false, 8, 12)
valleyLabel('valley-minor-line', false, true, 11.5, 11)
valleyLabel('valley-minor-point', false, false, 12, 11)
attachToBasemap('pulita', ['valley-major-line', 'valley-major-point', 'valley-minor-line', 'valley-minor-point'])

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
    paint: { 'line-color': ACCENT, 'line-width': 3 },
  },
  FIRST_LABEL,
)

// Sentieri: ombra scura sfumata + bordo chiaro + colore, per staccarli da qualsiasi sfondo.
// Sottili da lontano (la rete è fitta), spessi da vicino. Bordo e ombra crescono con lo zoom.
const ZOOMS = [8, 10, 12, 14, 17]
const LINE_W = [1.5, 2.1, 3.2, 4.6, 7]
const widths = (extra: number[] = [0, 0, 0, 0, 0]) => ZOOMS.flatMap((z, i) => [z, LINE_W[i] + extra[i]])
const round = { 'line-cap': 'round', 'line-join': 'round' } as const
// Alone del sentiero selezionato.
map.addLayer(
  {
    id: 'seg-sel',
    type: 'line',
    source: 'segments',
    filter: ['==', ['get', 'sentiero_id'], ''],
    layout: round,
    paint: { 'line-color': ACCENT, 'line-opacity': 0.55, 'line-blur': 1, 'line-width': byZoom(...widths([7, 8, 10, 12, 14])) },
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
    'text-color': '#1A1400',
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

// POI: icone per categoria (attivabili dal pannello Filtri), nome da vicino.
const CAT_PRIORITY = ['rifugio', 'lago', 'malga', 'bivacco', 'cascata', 'passo', 'vetta', 'panoramico']
map.addLayer({
  id: 'poi-sel',
  type: 'circle',
  source: 'pois',
  filter: ['==', ['get', 'id'], ''],
  paint: { 'circle-radius': 15, 'circle-color': 'rgba(11,110,132,0.15)', 'circle-stroke-color': ACCENT, 'circle-stroke-width': 2.5 },
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
  paint: { 'text-color': '#142024', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
})

// ---------------------------------------------------------------- strumenti mappa

let basemap: Basemap = stored<string>('sfondo', 'pulita') === 'topo' ? 'topo' : 'pulita'
function applyBasemap(): void {
  setBasemap(map, basemap)
  $('basemap-btn').setAttribute('aria-pressed', String(basemap === 'topo'))
  $('basemap-label').textContent = basemap === 'topo' ? 'TOPO' : 'PUL'
  store('sfondo', basemap)
}
applyBasemap()
$('basemap-btn').addEventListener('click', () => {
  basemap = basemap === 'pulita' ? 'topo' : 'pulita'
  applyBasemap()
})

function setZones(on: boolean): void {
  zonesOn = on
  for (const id of ['zone-fill', 'zone-line']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  for (const id of ['zones-btn', 'toggle-zones', 'notam-chip']) $(id).setAttribute('aria-pressed', String(on))
}
for (const id of ['zones-btn', 'toggle-zones', 'notam-chip']) $(id).addEventListener('click', () => setZones(!zonesOn))

$('locate-btn').addEventListener('click', () => geolocate.trigger())
geolocate.on('geolocate', () => $('locate-btn').setAttribute('aria-pressed', 'true'))
geolocate.on('trackuserlocationend', () => $('locate-btn').setAttribute('aria-pressed', 'false'))
geolocate.on('error', () => showToast('Posizione non disponibile: controlla i permessi del browser.'))
$('zoomin-btn').addEventListener('click', () => map.zoomIn())
$('zoomout-btn').addEventListener('click', () => map.zoomOut())

// ---------------------------------------------------------------- data scelta

const dayInput = $<HTMLInputElement>('day')
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
  $('notam-chip').hidden = !notam
  $('notam-label').textContent = `${notam} NOTAM`
  $('notam-chip').title = `${notam} NOTAM attivi sui sentieri in questa data: tocca per vedere le zone`
  $('day-label').textContent = dotDate(day)
  applyFilters() // il filtro "volo" dipende dalla data
  render()
}

dayInput.value = day
dayInput.addEventListener('change', () => {
  if (!dayInput.value) return
  day = dayInput.value
  applyDay()
})
// Su PC un clic sul chip apre direttamente il calendario.
dayInput.addEventListener('click', () => {
  try {
    dayInput.showPicker()
  } catch {
    // showPicker non disponibile: resta il comportamento nativo
  }
})

// ---------------------------------------------------------------- legenda

$('trail-count').textContent = `${fmtCount(trailList.length)} sentieri SAT`
if (meta.snapshot) {
  const ageDays = (Date.now() - new Date(meta.snapshot).getTime()) / 86_400_000
  const el = $('snapshot')
  el.textContent = `D-Flight ${formatDate(meta.snapshot).replace(/\//g, '.').replace(',', '')}`
  if (ageDays > SNAPSHOT_STALE_DAYS) {
    el.classList.add('stale')
    el.textContent += ` · ${Math.floor(ageDays)} gg fa: aggiorna`
  }
  el.title = 'Data dello snapshot delle zone D-Flight. I NOTAM pubblicati dopo non sono inclusi.'
}

// ---------------------------------------------------------------- pannelli: telefono (schermate) · tablet/PC (sinistra | mappa | destra)

// Telefono: una schermata intera alla volta (filtri, risultati, salvati, profilo…) + scheda in basso.
// Tablet/PC: pannello SINISTRO = scoprire (filtri; la scheda di sentiero/POI/zona li copre),
// pannello DESTRO = le mie cose (salvati, bacheche, profilo, notifiche). Tablet: uno solo alla volta.
const side = $('side')
const mine = $('mine')
const layout = document.querySelector<HTMLElement>('.layout')!
type View = 'filters' | 'results' | 'saved' | 'profile' | 'board' | 'notifs'
type Tab = 'map' | 'filters' | 'saved' | 'profile'
type RightView = 'saved' | 'board' | 'profile' | 'notifs'
const RIGHT_VIEWS: RightView[] = ['saved', 'board', 'profile', 'notifs']
const isRight = (v: View): v is RightView => (RIGHT_VIEWS as string[]).includes(v)
const VIEW_TAB: Record<View, Tab> = { filters: 'filters', results: 'filters', saved: 'saved', board: 'saved', profile: 'profile', notifs: 'profile' }
/** Tablet (768–1023): un solo pannello alla volta, sovrapposto alla mappa. */
const tablet = () => !mobile() && !MQ_WIDE.matches
let leftOpen = true
let rightView: RightView | null = null

/** Le viste "mie" si aggiornano quando diventano visibili. */
function refreshMine(): void {
  loadAccount()
  renderSavedSheet()
  renderProfileView()
  renderBoardView()
  renderNotifsView()
}

function pressHeader(view: View | null): void {
  $('open-saved').setAttribute('aria-pressed', String(view === 'saved' || view === 'board'))
  $('open-profile').setAttribute('aria-pressed', String(view === 'profile'))
  $('open-notifs').setAttribute('aria-pressed', String(view === 'notifs'))
}

function showView(view: View): void {
  if (!mobile()) {
    if (isRight(view)) setRight(view)
    else setLeft(true)
    return
  }
  for (const v of ['filters', 'results', 'saved', 'profile', 'board', 'notifs'] as View[]) $(`${v}-view`).hidden = v !== view
  side.dataset.view = view
  pressHeader(view)
  if (isRight(view)) refreshMine()
  markTab(VIEW_TAB[view])
}

/** Apre o comprime il pannello sinistro (tablet: chiude il destro). */
function setLeft(open: boolean): void {
  leftOpen = open
  if (open && tablet()) rightView = null
  syncPanels()
}

/** Apre una vista nel pannello destro, o lo chiude con null (tablet: chiude il sinistro). */
function setRight(view: RightView | null): void {
  rightView = view
  if (view && tablet()) leftOpen = false
  syncPanels()
  if (view) refreshMine()
}

function syncPanels(): void {
  layout.dataset.left = String(leftOpen)
  layout.dataset.right = String(!!rightView)
  for (const v of RIGHT_VIEWS) $(`${v}-view`).hidden = v !== rightView
  pressHeader(rightView)
  const tab = $('left-tab')
  const label = leftOpen ? 'Comprimi il pannello' : 'Mostra il pannello'
  tab.setAttribute('aria-label', label)
  tab.setAttribute('aria-expanded', String(leftOpen))
  tab.title = label
}

/** Sposta le viste "mie" tra le schermate del telefono e il pannello destro, e la scheda dove serve. */
function placePanels(): void {
  if (mobile()) {
    for (const v of RIGHT_VIEWS) side.insertBefore($(`${v}-view`), $('left-resizer'))
    side.dataset.open = 'false'
    showView(rightView ?? 'filters')
    markTab('map')
  } else {
    const was = side.dataset.view as View
    if (side.dataset.open === 'true' && isRight(was)) rightView = was
    for (const v of RIGHT_VIEWS) mine.append($(`${v}-view`))
    $('filters-view').hidden = false
    $('results-view').hidden = true
    if (tablet() && rightView) leftOpen = false
    syncPanels()
  }
  placeSheet()
}

function markTab(tab: Tab): void {
  for (const b of document.querySelectorAll<HTMLElement>('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
}

/** Telefono: MAPPA chiude le schermate, FILTRI/SALVATI/PROFILO le aprono a tutto schermo. */
function setTab(tab: Tab): void {
  side.dataset.open = String(tab !== 'map')
  if (tab !== 'map') {
    select(null)
    showView(tab)
  }
  markTab(tab)
}

/** Apre una vista: schermata intera sul telefono, pannello su tablet/PC. */
function openView(view: View): void {
  if (mobile()) {
    side.dataset.open = 'true'
    select(null)
  }
  showView(view)
}

/** Chiude una vista "mia": sul telefono torna alla mappa, altrove chiude il pannello destro. */
const closeMine = () => (mobile() ? setTab('map') : setRight(null))

for (const b of document.querySelectorAll<HTMLElement>('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab as Tab))
$('open-filters').addEventListener('click', () => setTab('filters'))
$('filters-close').addEventListener('click', () => setTab('map'))
$('saved-close').addEventListener('click', closeMine)
$('profile-close').addEventListener('click', closeMine)
$('board-close').addEventListener('click', closeMine)
$('notifs-close').addEventListener('click', () => (mobile() ? showView('profile') : setRight(null)))
$('board-back').addEventListener('click', () => showView('saved'))
$('show-results').addEventListener('click', () => showView('results'))
$('results-back').addEventListener('click', () => showView('filters'))
$('results-map').addEventListener('click', () => setTab('map'))
// Tablet/PC: le icone dell'header aprono il pannello destro; ricliccarle lo chiude.
$('open-saved').addEventListener('click', () => setRight(rightView === 'saved' ? null : 'saved')) // da una bacheca torna all'elenco
$('open-profile').addEventListener('click', () => setRight(rightView === 'profile' ? null : 'profile'))
$('open-notifs').addEventListener('click', () => setRight(rightView === 'notifs' ? null : 'notifs'))
$('profile-notifs').addEventListener('click', () => showView('notifs'))
$('left-tab').addEventListener('click', () => setLeft(!leftOpen))

// ---- maniglie per ridimensionare i pannelli (PC): trascina, doppio clic = larghezza predefinita
const PANEL_MIN = 280

function setupResizer(which: 'left' | 'right'): void {
  const handle = $(`${which}-resizer`)
  const panel = which === 'left' ? side : mine
  const key = `pannello-${which}`
  const prop = `--${which}-w`
  const clamp = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, window.innerWidth * 0.5)))
  const apply = (w: number | null) => {
    if (w == null) layout.style.removeProperty(prop)
    else layout.style.setProperty(prop, `${clamp(w)}px`)
    map.resize()
  }
  const saved = stored<number | null>(key, null)
  if (saved) layout.style.setProperty(prop, `${saved}px`)
  handle.tabIndex = 0
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    document.body.classList.add('resizing')
    let last = panel.clientWidth
    const move = (ev: PointerEvent) => {
      const r = panel.getBoundingClientRect()
      last = clamp(which === 'left' ? ev.clientX - r.left : r.right - ev.clientX)
      apply(last)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.classList.remove('dragging')
      document.body.classList.remove('resizing')
      store(key, last)
      map.resize()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end, { once: true })
    handle.addEventListener('pointercancel', end, { once: true })
  })
  handle.addEventListener('dblclick', () => {
    apply(null)
    store(key, null)
  })
  // Da tastiera: frecce sinistra/destra.
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const grow = (e.key === 'ArrowRight') === (which === 'left')
    const w = clamp(panel.clientWidth + (grow ? 24 : -24))
    apply(w)
    store(key, w)
  })
}
setupResizer('left')
setupResizer('right')

// ---------------------------------------------------------------- scheda

const sheet = $('sheet')
const body = $('panel-body')
const foot = $('panel-foot')
const hoverMarker = new maplibregl.Marker({ element: h('div', { class: 'hover-dot' }) })

/** Dove vive la scheda: telefono → in cima alla pagina (copre barra in alto e navigazione);
 *  tablet/PC → nel pannello sinistro, sopra i filtri. */
function placeSheet(): void {
  const target = mobile() ? document.body : side
  if (sheet.parentElement !== target) target.append(sheet)
  sheet.classList.remove('expanded')
}
placePanels()
MQ_WIDE.addEventListener('change', placePanels)
MQ_MOBILE.addEventListener('change', placePanels)
$('sheet-handle').addEventListener('click', () => sheet.classList.toggle('expanded'))
$('sheet-filters').addEventListener('click', () => select(null))

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
  currentSave = { trailId: trail.id, box: foot }
  return renderTrail({
    trail,
    day,
    segment: seg ? { seg, eff: eff.get(seg.id)! } : undefined,
    trailKm: kmOf(trail.id),
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
    sheet.hidden = true
    currentSave = null
    return
  }
  body.replaceChildren()
  const s = selection
  if (s.kind === 'trail') {
    body.append(trailPanel(trails.get(s.id)!, s.seg))
  } else {
    currentSave = null
    if (s.kind === 'zones') {
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
  }
  renderSaveBox()
  sheet.hidden = false
  // Tablet/PC: la scheda sta nel pannello sinistro, che va aperto (sul tablet chiude il destro).
  if (!mobile() && (!leftOpen || (tablet() && rightView))) setLeft(true)
  body.scrollTop = 0
  if (mobile()) setTabSilently('map') // su telefono la scheda sta sopra la mappa
}

/** Torna alla mappa senza deselezionare (usato quando si apre una scheda da una lista). */
function setTabSilently(tab: Tab): void {
  side.dataset.open = String(tab !== 'map')
  for (const b of document.querySelectorAll<HTMLElement>('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
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

function fitPadding(): maplibregl.PaddingOptions {
  if (mobile()) return { top: 150, left: 30, right: 70, bottom: Math.round(window.innerHeight * 0.55) }
  if (tablet()) {
    const w = Math.min(380, window.innerWidth * 0.85) + 40
    return { top: 40, left: leftOpen ? w : 40, right: rightView ? w : 70, bottom: 40 }
  }
  return { top: 40, left: 40, right: 70, bottom: 40 }
}

$('panel-close').addEventListener('click', () => select(null))
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!searchList.hidden) closeSearch()
  else select(null)
})

// ---------------------------------------------------------------- filtri

$('filters-reset').addEventListener('click', () => {
  Object.assign(filters, defaultFilters())
  drawForm()
  applyFilters()
})

function drawForm(): void {
  $('filters-form').replaceChildren(renderForm(filters, gruppi, applyFilters))
}

/** Punti sulla mappa (icone per categoria): stanno nel pannello Filtri. */
function drawPoiToggles(): void {
  const wrap = h('div', { class: 'chipgrid' })
  for (const c of CATEGORY_ORDER) {
    const b = h('button', { type: 'button', class: 'chiptoggle', 'aria-pressed': String(poiVisible.has(c)) }, catIcon(c, 16), CATEGORIES[c].plural)
    b.addEventListener('click', () => {
      if (poiVisible.has(c)) poiVisible.delete(c)
      else poiVisible.add(c)
      b.setAttribute('aria-pressed', String(poiVisible.has(c)))
      map.setFilter('poi-icons', ['in', ['get', 'categoria'], ['literal', [...poiVisible]]])
      store('poi-visibili', [...poiVisible])
    })
    wrap.append(b)
  }
  $('poi-section').replaceChildren(h('section', {}, h('p', { class: 'section-label' }, 'Punti sulla mappa'), wrap))
}

function cardFor(t: Trail, extra: { who?: string | null; onRemove?: () => void } = {}): HTMLElement {
  return trailCard(t, {
    km: kmOf(t.id),
    closed: closedIds.has(t.id),
    saved: !!acct?.miei.has(t.id) || inBoards(t.id),
    ...extra,
    onOpen: () => {
      select({ kind: 'trail', id: t.id })
      fitTrail(t)
    },
  })
}

function applyFilters(): void {
  const active = activeCount(filters)
  const ok = new Set<string>()
  const results: Trail[] = []
  for (const t of trailList) {
    const ctx = {
      km: kmOf(t.id),
      closed: closedIds.has(t.id),
      mine: acct?.miei.has(t.id) ?? false,
      shared: inBoards(t.id),
    }
    if (matches(t, ctx, filters)) {
      ok.add(t.id)
      results.push(t)
    }
  }
  for (const f of segments.features) {
    map.setFeatureState({ source: 'segments', id: f.properties.id }, { off: active > 0 && !ok.has(f.properties.sentiero_id) })
  }

  for (const id of ['filter-count', 'tab-count']) {
    $(id).hidden = active === 0
    $(id).textContent = String(active)
  }

  // Prima i più volabili nella data scelta (km verdi, poi gialli).
  results.sort((a, b) => kmOf(b.id).verde - kmOf(a.id).verde || kmOf(b.id).giallo - kmOf(a.id).giallo)
  const n = fmtCount(results.length)
  $('filters-summary').textContent =
    (active === 0 ? `${n} sentieri · nessun filtro` : `${n} di ${fmtCount(trailList.length)} sentieri`) +
    (results.length > MAX_RESULTS_SHOWN ? ` · primi ${MAX_RESULTS_SHOWN}` : '')
  $('show-results').textContent = `MOSTRA ${n} SENTIERI`
  $('results-title').textContent = `${n} sentieri`
  const shown = results.slice(0, MAX_RESULTS_SHOWN)
  $('filters-results').replaceChildren(...shown.map((t) => cardFor(t)))
  $('results-list').replaceChildren(...shown.map((t) => cardFor(t)))
}
drawForm()
drawPoiToggles()

// ---------------------------------------------------------------- ricerca

const searchInput = $<HTMLInputElement>('search-input')
const searchList = $('search-results')
const KIND_LABEL: Record<string, string> = { sentiero: 'Sentiero', paese: 'Località', valle: 'Valle' }

function closeSearch(): void {
  searchList.hidden = true
}
searchInput.addEventListener('focus', () => {
  getSearch().catch(() => showToast('Indice di ricerca non disponibile.'))
  if (searchInput.value.trim()) searchList.hidden = false
})
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('.searchwrap')) closeSearch()
})

let lastResults: SearchItem[] = []
searchInput.addEventListener('input', async () => {
  const items = await getSearch()
  lastResults = rank(items, searchInput.value)
  searchList.replaceChildren()
  searchList.hidden = !searchInput.value.trim()
  if (searchInput.value.trim() && !lastResults.length) searchList.append(h('li', { class: 'muted empty' }, 'Nessun risultato'))
  for (const it of lastResults) {
    const cat = it.t in CATEGORIES ? (it.t as PoiCategory) : null
    const btn = h(
      'button',
      { type: 'button' },
      cat ? catIcon(cat, 18) : h('span', { class: `kind ${it.t}` }, icon(it.t === 'sentiero' ? 'map' : 'locate', 16)),
      h('span', { class: 'sr-title' }, it.n),
      h('span', { class: 'sr-kind' }, cat ? CATEGORIES[cat].label : (KIND_LABEL[it.t] ?? it.t)),
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
  searchInput.blur()
  if (it.t === 'sentiero' && it.id && trails.has(it.id)) {
    select({ kind: 'trail', id: it.id })
    fitTrail(trails.get(it.id)!)
  } else if (it.id && pois.has(it.id)) {
    // Accende la categoria se era spenta, così l'icona si vede.
    const cat = pois.get(it.id)!.categoria
    if (!poiVisible.has(cat)) {
      poiVisible.add(cat)
      map.setFilter('poi-icons', ['in', ['get', 'categoria'], ['literal', [...poiVisible]]])
      store('poi-visibili', [...poiVisible])
      drawPoiToggles()
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
  if (zonesOn) {
    const ids = [...new Set(map.queryRenderedFeatures(e.point, { layers: ['zone-fill'] }).map((f) => f.properties.zona_id as string))]
    if (ids.length) {
      select({ kind: 'zones', ids })
      return
    }
  }
  select(null)
})

/** Su telefono la scheda copre metà schermo: sposta la mappa così il punto toccato resta visibile. */
function revealAbovePanel(point: maplibregl.Point): void {
  if (!mobile()) return
  const h = map.getContainer().clientHeight
  const visible = h - sheet.offsetHeight
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

// ---------------------------------------------------------------- account: login, profilo, salvati, bacheche (Firebase)

// Il modulo Firebase si scarica solo quando serve: al primo uso di Salva/Salvati/Profilo, oppure
// subito all'avvio se su questo dispositivo era già stato fatto il login (o se si apre un invito).
let acct: AccountState | null = null
let boardsSt: BoardsState | null = null
let accountModule: Promise<typeof import('./account')> | null = null
let currentSave: { trailId: string; box: HTMLElement } | null = null
type SavedTab = 'miei' | 'bacheche'
let savedTab: SavedTab = 'miei'
let currentBoard: string | null = null
const boardUi = new Map<string, { openNotes: Set<string>; lastLink: { url: string | null } }>()
let onboardingStep = 0
let onboardingClosed = false // saltato in questa visita, in attesa che arrivi il salvataggio

function loadAccount(): Promise<typeof import('./account')> {
  if (!accountModule) {
    accountModule = import('./account')
    accountModule
      .then((m) => {
        m.subscribe((st) => {
          acct = st
          store('salvati-attivo', st.status !== 'anonimo')
          renderSaveBox()
          renderSavedSheet()
          renderProfileView()
          renderAvatars()
          renderOnboarding()
          applyFilters()
          handleInviteLink()
          void handleReferral()
        })
        m.subscribeBoards((bs) => {
          boardsSt = bs
          renderSaveBox()
          renderSavedSheet()
          renderBoardView()
          renderNotifsView()
          renderBells()
          applyFilters()
        })
      })
      .catch((e) => {
        accountModule = null
        showToast(`Impossibile caricare il servizio account: ${e.message}`)
      })
  }
  return accountModule
}

/** Il sentiero è in almeno una delle mie bacheche? */
const inBoards = (trailId: string) => !!boardsSt && [...boardsSt.boards.values()].some((b) => b.sentieri.has(trailId))

function openSaved(): void {
  openView('saved')
}

function openBoard(id: string): void {
  currentBoard = id
  openView('board')
}

async function doLogin(): Promise<void> {
  try {
    const m = await loadAccount()
    await m.login()
  } catch (e) {
    const code = (e as { code?: string }).code ?? ''
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return
    showToast(
      code === 'auth/popup-blocked'
        ? 'Il browser ha bloccato la finestra di accesso: consenti i popup per questo sito.'
        : `Accesso non riuscito (${code || (e as Error).message}).`,
    )
  }
}

const accountActions = (): ProfileActions => ({
  login: doLogin,
  logout: () => void loadAccount().then((m) => m.logout()),
  retry: () => void loadAccount().then((m) => m.retry()),
  updateProfile: async (p) => (await loadAccount()).updateProfile(p),
  setSearchable: async (on) => (await loadAccount()).setSearchable(on),
  saveDrone: async (d, id) => (await loadAccount()).saveDrone(d, id),
  removeDrone: async (id) => (await loadAccount()).removeDrone(id),
  deleteAccount: async () => {
    await (await loadAccount()).deleteAccount()
    showToast('Account eliminato. Tutti i tuoi dati sono stati cancellati.')
  },
  inviteLink: async (boardId) => {
    const m = await loadAccount()
    const url = new URL(await m.myInviteLink())
    if (boardId) {
      // Invito diretto a una bacheca nello stesso link (stesso sistema dei link di bacheca).
      const inv = new URL(await m.createLink(boardId, 'editor', 30)).searchParams.get('invito')
      if (inv) url.searchParams.set('invito', inv)
    }
    return url.toString()
  },
  ownedBoards: () => [...(boardsSt?.boards.values() ?? [])].filter((b) => b.ruolo === 'owner').map((b) => ({ id: b.id, nome: b.nome })),
  toast: showToast,
  zoneSuggestions: [...gruppi, ...valleysFC.features.filter((f) => f.properties.principale).map((f) => f.properties.nome)].sort((a, b) =>
    a.localeCompare(b, 'it'),
  ),
})

const trailInfo = (): TrailInfo => ({ trails, kmOf, closed: (id) => closedIds.has(id) })

const boardsActions = (): BoardsActions => {
  const m = () => loadAccount()
  return {
    openBoard,
    openTrail: (id) => {
      const t = trails.get(id)
      if (!t) return
      if (mobile()) setTab('map')
      select({ kind: 'trail', id })
      fitTrail(t)
    },
    createBoard: async (nome, cop) => (await m()).createBoard(nome, cop),
    updateBoard: async (id, p) => (await m()).updateBoard(id, p),
    deleteBoard: async (id) => {
      await (await m()).deleteBoard(id)
      showView('saved')
    },
    leaveBoard: async (id) => {
      await (await m()).leaveBoard(id)
      showView('saved')
    },
    setRole: async (id, uid, r) => (await m()).setRole(id, uid, r),
    removeMember: async (id, uid) => (await m()).removeMember(id, uid),
    addTrail: async (id, t) => (await m()).addTrail(id, t),
    removeTrail: async (id, t) => (await m()).removeTrail(id, t),
    setTrailDate: async (id, t, d) => (await m()).setTrailDate(id, t, d),
    setCiSto: async (id, t, on) => (await m()).setCiSto(id, t, on),
    addNote: async (id, t, x) => (await m()).addNote(id, t, x),
    deleteNote: async (id, n) => (await m()).deleteNote(id, n),
    createLink: async (id, r, d) => (await m()).createLink(id, r, d),
    revokeLink: async (id, t) => (await m()).revokeLink(id, t),
    searchUsers: async (q) => (await m()).searchUsers(q),
    inviteUser: async (id, u, r) => (await m()).inviteUser(id, u, r),
    cancelInvite: async (i) => (await m()).cancelInvite(i),
    acceptInvite: async (i) => (await m()).acceptInvite(i),
    declineInvite: async (i) => (await m()).declineInvite(i),
    migrateLegacy: async () => (await m()).migrateLegacy(acct?.membri ?? new Map(), acct?.condivisi ?? new Map()),
    markRead: async (id) => (await m()).markRead(id),
    markAllRead: async () => (await m()).markAllRead(),
    toast: showToast,
  }
}

async function toggleMine(trailId: string): Promise<void> {
  const m = await loadAccount()
  if (acct?.status !== 'pronto') {
    openSaved()
    return
  }
  try {
    await (acct.miei.has(trailId) ? m.remove('miei', trailId) : m.save('miei', trailId))
  } catch (e) {
    showToast(`Salvataggio non riuscito: ${(e as Error).message}`)
  }
}

// ---- finestra (scelta bacheca, invito via link)

const modal = $('modal')
function openModal(content: HTMLElement): void {
  modal.replaceChildren(content)
  modal.hidden = false
}
function closeModal(): void {
  modal.hidden = true
  modal.replaceChildren()
}
modal.addEventListener('click', (e) => e.target === modal && closeModal())

let pickerTrail: string | null = null
function renderPicker(): void {
  if (modal.hidden || !pickerTrail || !boardsSt) return
  openModal(renderBoardPicker(pickerTrail, boardsSt, trailInfo(), boardsActions(), () => ((pickerTrail = null), closeModal())))
}

async function openBoardPicker(trailId: string): Promise<void> {
  await loadAccount()
  if (acct?.status !== 'pronto') {
    openSaved()
    return
  }
  pickerTrail = trailId
  modal.hidden = false
  renderPicker()
}

/** Pulsanti fissi in fondo alla scheda: SALVA NEI MIEI (pieno) e AGGIUNGI A BACHECA (bordo). */
function renderSaveBox(): void {
  if (!currentSave) {
    foot.hidden = true
    foot.replaceChildren()
    return
  }
  const { trailId } = currentSave
  const mine = !!acct?.miei.has(trailId)
  const shared = inBoards(trailId)
  const b1 = h('button', { type: 'button', class: 'btn-primary', 'aria-pressed': String(mine) }, icon(mine ? 'bookmarkFilled' : 'bookmark', 18), mine ? 'NEI MIEI' : 'SALVA NEI MIEI')
  b1.addEventListener('click', () => toggleMine(trailId))
  const b2 = h('button', { type: 'button', class: 'btn-outline', 'aria-pressed': String(shared) }, icon(shared ? 'check' : 'users', 18), 'AGGIUNGI A BACHECA')
  b2.addEventListener('click', () => void openBoardPicker(trailId))
  foot.classList.remove('single')
  foot.replaceChildren(b1, b2)
  foot.hidden = false
  renderPicker()
}

function loginPrompt(text: string): HTMLElement[] {
  const b = h('button', { type: 'button', class: 'btn-primary wide' }, 'ACCEDI CON GOOGLE')
  b.addEventListener('click', doLogin)
  return [h('div', { class: 'empty-state' }, icon('bookmark', 28), h('p', {}, text)), b]
}

/** Sezione "Salvati": inviti ricevuti, poi "I miei" e le bacheche. */
function renderSavedSheet(): void {
  if ($('saved-view').hidden) return
  const st = acct
  const parts: HTMLElement[] = []
  if (!st || st.status === 'caricamento') {
    parts.push(h('p', { class: 'muted' }, 'Caricamento…'))
  } else if (st.status === 'anonimo') {
    parts.push(...loginPrompt("Accedi per salvare i sentieri, creare bacheche con gli amici e ritrovare tutto su telefono e PC. L'accesso resta attivo: non serve rifarlo ogni volta."))
  } else if (st.status === 'errore') {
    const b = h('button', { type: 'button', class: 'btn-primary' }, 'RIPROVA')
    b.addEventListener('click', () => loadAccount().then((m) => m.retry()))
    parts.push(h('p', { class: 'warn' }, `Errore: ${st.errore}`), b)
  } else {
    const bs = boardsSt
    const a = boardsActions()
    const inv = bs ? inviteCards(bs.inviti, a) : null
    if (inv) parts.push(h('p', { class: 'section-label' }, `Inviti ricevuti · ${bs!.inviti.length}`), inv)
    if (bs?.migrabile && st.legacyMember) parts.push(migrationBanner(a))
    parts.push(
      segmented<SavedTab>(
        [
          ['miei', `I miei · ${st.miei.size}`],
          ['bacheche', `Bacheche · ${bs?.boards.size ?? 0}`],
        ],
        savedTab,
        (v) => {
          savedTab = v
          renderSavedSheet()
        },
      ),
    )
    if (savedTab === 'miei') {
      const known = [...st.miei].filter(([id]) => trails.has(id))
      known.sort((x, y) => (y[1].aggiunto?.getTime() ?? 0) - (x[1].aggiunto?.getTime() ?? 0))
      if (!known.length) parts.push(h('p', { class: 'muted empty-list' }, 'Nessun sentiero salvato: usa "Salva nei miei" nella scheda di un sentiero.'))
      else parts.push(h('ul', { class: 'cards' }, ...known.map(([id]) => cardFor(trails.get(id)!, { onRemove: () => toggleMine(id) }))))
    } else if (bs) {
      parts.push(...boardsList(bs, trailInfo(), a, renderSavedSheet))
    }
  }
  // Non ridisegnare sopra un modulo "nuova bacheca" aperto.
  const body = $('saved-body')
  if (body.querySelector('.boardform') && document.activeElement && body.contains(document.activeElement)) return
  body.replaceChildren(...parts)
}

/** Vista di una bacheca (colonna su PC, schermata su telefono). */
function renderBoardView(): void {
  if ($('board-view').hidden || !currentBoard) return
  const board = boardsSt?.boards.get(currentBoard)
  const body = $('board-body')
  if (!board) {
    $('board-title').textContent = 'Bacheca'
    body.replaceChildren(h('p', { class: 'muted' }, acct?.status === 'pronto' ? 'Caricamento… (o non fai più parte di questa bacheca)' : 'Accedi per vedere le bacheche.'))
    return
  }
  // Mentre si scrive (nota, ricerca, nome) gli aggiornamenti non ridisegnano la vista.
  const active = document.activeElement
  if (active && body.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.value) return
  $('board-title').textContent = board.nome
  if (!boardUi.has(board.id)) boardUi.set(board.id, { openNotes: new Set(), lastLink: { url: null } })
  const ui = boardUi.get(board.id)!
  const ctx = { board, me: acct?.user?.uid ?? '', info: trailInfo(), a: boardsActions(), rerender: renderBoardView, openNotes: ui.openNotes, lastLink: ui.lastLink }
  body.replaceChildren(...renderBoard(ctx))
}

function renderNotifsView(): void {
  if ($('notifs-view').hidden) return
  const body = $('notifs-body')
  if (acct?.status !== 'pronto') {
    body.replaceChildren(...loginPrompt('Accedi per ricevere le notifiche delle tue bacheche.'))
    return
  }
  body.replaceChildren(
    ...renderNotifications(boardsSt?.notifiche ?? [], trailInfo(), boardsActions(), (n) => {
      if (n.tipo === 'invito') openView('saved')
      else if (boardsSt?.boards.has(n.bacheca)) openBoard(n.bacheca)
    }),
  )
}

/** Campanella: contatore nell'header (PC), sulla voce Profilo e nel profilo (telefono). */
function renderBells(): void {
  const unread = (boardsSt?.notifiche.filter((n) => !n.letta).length ?? 0) + (boardsSt?.inviti.length ?? 0)
  for (const id of ['notif-count', 'tab-notif-count', 'profile-notif-count']) {
    $(id).hidden = unread === 0
    $(id).textContent = unread > 99 ? '99+' : String(unread)
  }
  $('open-notifs').setAttribute('aria-label', unread ? `Notifiche: ${unread} da leggere` : 'Notifiche')
}

/** Pagina profilo (schermata su telefono, colonna sinistra su PC). Mentre un modulo è aperto
 *  (drone o nome in modifica) gli aggiornamenti in arrivo non ridisegnano la pagina, per non
 *  cancellare quello che si sta scrivendo: si ridisegna dopo Salva/Annulla (force). */
function renderProfileView(force = false): void {
  if ($('profile-view').hidden) return
  const body = $('profile-body')
  // Non ridisegnare mentre si scrive: un modulo aperto o un campo con il cursore (es. una data
  // a metà) andrebbero persi.
  const active = document.activeElement
  const typing =
    active instanceof HTMLInputElement &&
    body.contains(active) &&
    (active.type !== 'date' || active.validity.badInput || !validDate(active.value))
  if (!force && (typing || body.querySelector('.card.editing, .identity-form'))) return
  body.replaceChildren(...renderProfilePage(acct, accountActions(), () => renderProfileView(true)))
}

document.addEventListener('profilo-aggiorna', () => setTimeout(() => renderProfileView(), 0))

/** Avatar nella barra in basso (telefono) e in alto a destra (PC), con pallino se ci sono scadenze. */
function renderAvatars(): void {
  const logged = acct?.status === 'pronto' && acct.profile
  const alerts = logged ? expiries(acct!.profile, acct!.droni).length > 0 : false
  for (const [slot, size] of [
    ['tab-avatar', 26],
    ['header-avatar', 40],
  ] as const) {
    $(slot).replaceChildren(logged ? avatarEl(acct!.profile!.avatar, acct!.profile!.nome, size) : icon('user', 22))
  }
  $('tab-alert').hidden = !alerts
  $('header-alert').hidden = !alerts
  $('open-notifs').hidden = !logged
  const label = logged ? `Profilo di ${acct!.profile!.nome}${alerts ? ' (scadenze in arrivo)' : ''}` : 'Profilo'
  $('open-profile').setAttribute('aria-label', label)
  $('open-profile').title = label
}

/** Primo accesso: onboarding finché il profilo non risulta completato o saltato. */
function renderOnboarding(): void {
  const el = $('onboarding')
  const need = acct?.status === 'pronto' && acct.profile && !acct.profile.onboarding && !onboardingClosed && !pendingInvite && !referralPending()
  el.hidden = !need
  if (!need) return
  const a = accountActions()
  el.replaceChildren(
    renderOnboarding_(acct!, a, onboardingStep, (step) => {
      if (step === 'fine') {
        onboardingClosed = true
        el.hidden = true
        void a.updateProfile({ onboarding: true }).catch(() => {})
        return
      }
      onboardingStep = step
      renderOnboarding()
    }),
  )
}

// ---- invito via link: ?invito=<bacheca>~<token>

const inviteParam = new URLSearchParams(location.search).get('invito')
let pendingInvite: { board: string; token: string } | null = (() => {
  const [board, token] = (inviteParam ?? '').split('~')
  return board && token && /^[\w-]{1,40}$/.test(board) && /^[\w-]{20,64}$/.test(token) ? { board, token } : null
})()
let inviteStage: 'attesa' | 'mostrato' | 'fatto' = 'attesa'

function clearParam(name: string): void {
  const u = new URL(location.href)
  u.searchParams.delete(name)
  history.replaceState(null, '', u.toString())
}
const clearInviteParam = () => clearParam('invito')

async function handleInviteLink(): Promise<void> {
  if (!pendingInvite || inviteStage === 'fatto') return
  if (referralPending()) return // prima il benvenuto dell'invito all'app
  const a = boardsActions()
  const close = () => {
    inviteStage = 'fatto'
    pendingInvite = null
    clearInviteParam()
    closeModal()
    renderOnboarding()
  }
  if (!acct || acct.status === 'caricamento') return void openModal(renderLinkInvite('caricamento', a, doLogin, () => {}, close))
  if (acct.status === 'anonimo') return void openModal(renderLinkInvite('login', a, doLogin, () => {}, close))
  if (acct.status !== 'pronto' || inviteStage === 'mostrato') return
  inviteStage = 'mostrato'
  const { board, token } = pendingInvite
  openModal(renderLinkInvite('caricamento', a, doLogin, () => {}, close))
  const m = await loadAccount()
  const preview = await m.previewLink(board, token).catch(() => null)
  openModal(
    renderLinkInvite(preview, a, doLogin, async () => {
      try {
        if (preview) await m.joinByLink(preview)
        close()
        openBoard(board)
      } catch (e) {
        showToast(`Non riuscito: ${(e as Error).message}`)
      }
    }, close),
  )
}

// ---- invito all'app: ?amico=<codice> ("Fabio ti ha invitato su Quota 120")

const amicoParam = new URLSearchParams(location.search).get('amico')
let referral: string | null = amicoParam && /^[\w-]{12,40}$/.test(amicoParam) ? amicoParam : null
let referralStage: 'attesa' | 'mostrato' | 'fatto' = 'attesa'
const referralPending = () => !!referral && referralStage !== 'fatto'

async function handleReferral(): Promise<void> {
  if (!referralPending() || !acct || acct.status === 'caricamento') return
  const code = referral!
  const finish = () => {
    referralStage = 'fatto'
    referral = null
    clearParam('amico')
    renderOnboarding()
    void handleInviteLink()
  }
  if (acct.status !== 'anonimo') {
    // Già dentro, o appena entrato: chi ha invitato è stato registrato alla creazione del profilo.
    const welcomed = referralStage === 'mostrato'
    if (welcomed) closeModal()
    if (welcomed && acct.profile?.invitato_da_nome) showToast(`Benvenuto! Sei entrato con l’invito di ${acct.profile.invitato_da_nome}.`)
    finish()
    return
  }
  if (referralStage === 'mostrato') return
  referralStage = 'mostrato'
  const m = await loadAccount()
  m.setReferral(code) // vale anche se si accede più tardi
  const close = () => {
    closeModal()
    finish()
  }
  openModal(renderWelcomeInvite('caricamento', !!pendingInvite, doLogin, close))
  const from = await m.previewReferral(code).catch(() => null)
  if (referralStage === 'mostrato' && acct?.status === 'anonimo') openModal(renderWelcomeInvite(from, !!pendingInvite, doLogin, close))
}

if (pendingInvite || referral || stored('salvati-attivo', false)) loadAccount()

applyDay()
