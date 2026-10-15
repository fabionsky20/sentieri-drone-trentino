// Sfondi della mappa: "pulita" (vettoriale OpenFreeMap + rilievo Mapterhorn) e
// "topografica" (OpenTopoMap raster). Tutti gratuiti e senza chiavi API.
//
// Lo stile pulito è scritto da zero sullo schema OpenMapTiles invece di partire da uno
// stile pronto: così controlliamo cosa appare. Niente sentieri/tracce OSM (si vedono solo
// i sentieri SAT), colori tenui, etichette che compaiono gradualmente con lo zoom.

import type { ExpressionSpecification, LayerSpecification, Map, StyleSpecification } from 'maplibre-gl'

export type Basemap = 'pulita' | 'topo'

const FONT = {
  regular: ['Noto Sans Regular'],
  bold: ['Noto Sans Bold'],
  italic: ['Noto Sans Italic'],
}
export const LABEL_FONT = FONT.bold

const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:it'], ['get', 'name']]
const HALO = { 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.4 }
const zoom = (...stops: number[]) => ['interpolate', ['linear'], ['zoom'], ...stops] as unknown as number

// ---------------------------------------------------------------- sfondo pulito

const clean: LayerSpecification[] = [
  { id: 'bg', type: 'background', paint: { 'background-color': '#f3f1ea' } },
  {
    id: 'landcover-wood',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], 'wood'],
    paint: { 'fill-color': '#d6e4cb', 'fill-opacity': 0.8 },
  },
  {
    id: 'landcover-grass',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'landcover',
    filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland']]],
    paint: { 'fill-color': '#e9eedd', 'fill-opacity': 0.7 },
  },
  {
    id: 'landcover-rock',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'landcover',
    filter: ['in', ['get', 'class'], ['literal', ['rock', 'sand']]],
    paint: { 'fill-color': '#e4e0d8', 'fill-opacity': 0.8 },
  },
  {
    id: 'landcover-ice',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'landcover',
    filter: ['==', ['get', 'class'], 'ice'],
    paint: { 'fill-color': '#f5f9fc', 'fill-outline-color': '#c9dcea' },
  },
  {
    id: 'landuse-urban',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'landuse',
    minzoom: 9,
    filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial']]],
    paint: { 'fill-color': '#e7e1d8', 'fill-opacity': 0.8 },
  },
  {
    id: 'hillshade',
    type: 'hillshade',
    source: 'terrain',
    paint: {
      // Più leggero da vicino, dove le pareti ripide diventerebbero macchie scure.
      'hillshade-exaggeration': zoom(6, 0.3, 10, 0.42, 14, 0.3),
      'hillshade-shadow-color': '#62665b',
      'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#6f7366',
    },
  },
  {
    id: 'water',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'water',
    paint: { 'fill-color': '#b7d3e6' },
  },
  {
    id: 'waterway-river',
    type: 'line',
    source: 'ofm',
    'source-layer': 'waterway',
    minzoom: 8,
    filter: ['==', ['get', 'class'], 'river'],
    paint: { 'line-color': '#9cc0db', 'line-width': zoom(8, 0.6, 12, 1.4, 16, 2.5) },
  },
  {
    id: 'waterway-stream',
    type: 'line',
    source: 'ofm',
    'source-layer': 'waterway',
    minzoom: 13,
    filter: ['!=', ['get', 'class'], 'river'],
    paint: { 'line-color': '#a9c9e0', 'line-width': zoom(13, 0.6, 16, 1.4) },
  },
  {
    id: 'boundary-region',
    type: 'line',
    source: 'ofm',
    'source-layer': 'boundary',
    minzoom: 7,
    filter: ['all', ['in', ['get', 'admin_level'], ['literal', [4, 6]]], ['!=', ['get', 'maritime'], 1]],
    // Viola e a trattini lunghi: non deve sembrare un sentiero.
    paint: { 'line-color': '#9a6fc4', 'line-width': zoom(7, 0.8, 12, 1.4), 'line-dasharray': [6, 3], 'line-opacity': 0.55 },
  },
  {
    id: 'boundary-country',
    type: 'line',
    source: 'ofm',
    'source-layer': 'boundary',
    filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
    paint: { 'line-color': '#8a7c9f', 'line-width': zoom(5, 1, 12, 2) },
  },
  {
    id: 'rail',
    type: 'line',
    source: 'ofm',
    'source-layer': 'transportation',
    minzoom: 10,
    filter: ['==', ['get', 'class'], 'rail'],
    paint: { 'line-color': '#b3aca2', 'line-width': 1, 'line-dasharray': [4, 2] },
  },
  // Strade: solo la rete carrabile, mai path/track/footway. Le minori compaiono da vicino.
  {
    id: 'road-minor',
    type: 'line',
    source: 'ofm',
    'source-layer': 'transportation',
    minzoom: 12,
    filter: ['all', ['in', ['get', 'class'], ['literal', ['tertiary', 'minor']]], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': zoom(12, 0.8, 16, 4), 'line-opacity': 0.9 },
  },
  {
    id: 'road-main',
    type: 'line',
    source: 'ofm',
    'source-layer': 'transportation',
    minzoom: 7,
    filter: ['all', ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fbf3e2', 'line-width': zoom(7, 0.6, 12, 2.2, 16, 6) },
  },
  {
    id: 'road-major',
    type: 'line',
    source: 'ofm',
    'source-layer': 'transportation',
    filter: ['all', ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]], ['!=', ['get', 'brunnel'], 'tunnel']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f0c98f', 'line-width': zoom(6, 0.8, 12, 2.6, 16, 7) },
  },
  {
    id: 'building',
    type: 'fill',
    source: 'ofm',
    'source-layer': 'building',
    minzoom: 14,
    paint: { 'fill-color': '#dcd4c8', 'fill-opacity': 0.8 },
  },

  // ---- etichette (le linee dei sentieri vengono inserite subito sotto questa prima) ----
  {
    id: 'lbl-waterway',
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'waterway',
    minzoom: 11,
    filter: ['==', ['get', 'class'], 'river'],
    layout: {
      'symbol-placement': 'line',
      'text-field': NAME,
      'text-font': FONT.italic,
      'text-size': 11,
      'symbol-spacing': 400,
    },
    paint: { 'text-color': '#4a7ca3', ...HALO },
  },
  {
    id: 'lbl-lake',
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'water_name',
    minzoom: 9,
    filter: ['in', ['get', 'class'], ['literal', ['lake', 'reservoir', 'water']]],
    layout: { 'text-field': NAME, 'text-font': FONT.italic, 'text-size': zoom(9, 11, 14, 13), 'text-max-width': 8 },
    paint: { 'text-color': '#3f74a0', ...HALO },
  },
  // Vette: da zoom 11 solo le più importanti del riquadro (rank basso), da 13 tutte, con quota.
  peakLayer('lbl-peak-major', 11, 13, 2, false),
  peakLayer('lbl-peak', 13, 24, 99, true),
  {
    id: 'lbl-pass',
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'mountain_peak',
    minzoom: 12,
    filter: ['==', ['get', 'class'], 'saddle'],
    layout: {
      'icon-image': 'pass',
      'icon-size': 0.9,
      'text-field': NAME,
      'text-font': FONT.italic,
      'text-size': 11,
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#5b4a3a', ...HALO },
  },
  {
    id: 'lbl-hut',
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'poi',
    minzoom: 12,
    filter: ['in', ['get', 'subclass'], ['literal', ['alpine_hut', 'wilderness_hut']]],
    layout: {
      'icon-image': 'hut',
      'icon-size': 1,
      'text-field': ['step', ['zoom'], '', 13, NAME],
      'text-font': FONT.bold,
      'text-size': 11,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-optional': true,
      'text-max-width': 8,
    },
    paint: { 'text-color': '#8a2f16', ...HALO },
  },
  placeLayer('lbl-hamlet', ['hamlet', 'isolated_dwelling', 'locality'], 13, zoom(13, 10.5, 16, 12), FONT.regular, '#5f5a52'),
  placeLayer('lbl-village', ['village', 'suburb'], 11, zoom(11, 11, 15, 13), FONT.regular, '#3d3a34'),
  placeLayer('lbl-town', ['town'], 9, zoom(9, 12, 14, 15), FONT.bold, '#2f2c27'),
  placeLayer('lbl-city', ['city'], 5, zoom(6, 13, 12, 18), FONT.bold, '#1f1d1a'),
]

function peakLayer(id: string, minzoom: number, maxzoom: number, maxRank: number, withEle: boolean): LayerSpecification {
  const label: ExpressionSpecification = withEle
    ? ['case', ['has', 'ele'], ['format', NAME, {}, '\n', {}, ['concat', ['to-string', ['get', 'ele']], ' m'], { 'font-scale': 0.85 }], NAME]
    : NAME
  return {
    id,
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'mountain_peak',
    minzoom,
    maxzoom,
    filter: ['all', ['in', ['get', 'class'], ['literal', ['peak', 'volcano']]], ['<=', ['get', 'rank'], maxRank]],
    layout: {
      'icon-image': 'peak',
      'text-field': label,
      'text-font': FONT.bold,
      'text-size': 11,
      'text-offset': [0, 0.7],
      'text-anchor': 'top',
      'text-optional': true,
      'text-max-width': 8,
    },
    paint: { 'text-color': '#5b3d22', ...HALO },
  }
}

function placeLayer(
  id: string,
  classes: string[],
  minzoom: number,
  size: number,
  font: string[],
  color: string,
): LayerSpecification {
  return {
    id,
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'place',
    minzoom,
    filter: ['in', ['get', 'class'], ['literal', classes]],
    layout: {
      'text-field': NAME,
      'text-font': font,
      'text-size': size,
      'text-max-width': 8,
      'symbol-sort-key': ['get', 'rank'],
    },
    paint: { 'text-color': color, ...HALO },
  }
}

/** Le linee dei sentieri vanno sotto le etichette, sopra tutto il resto. */
export const FIRST_LABEL = 'lbl-waterway'

const topo: LayerSpecification[] = [
  {
    id: 'topo',
    type: 'raster',
    source: 'topo',
    layout: { visibility: 'none' },
    // Leggermente desaturata: i colori dei sentieri risaltano di più.
    paint: { 'raster-saturation': -0.3 },
  },
]

export const LAYERS: Record<Basemap, string[]> = {
  pulita: clean.map((l) => l.id),
  topo: topo.map((l) => l.id),
}

export const style: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    terrain: {
      type: 'raster-dem',
      tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
      encoding: 'terrarium',
      tileSize: 512,
      maxzoom: 12,
      attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
    },
    topo: {
      type: 'raster',
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      tileSize: 256,
      maxzoom: 17,
      attribution:
        'Mappa © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), dati © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  // Il raster topografico sta sotto: quando è attivo, lo sfondo pulito viene nascosto.
  layers: [...topo, ...clean],
}

export function setBasemap(map: Map, which: Basemap): void {
  for (const [name, ids] of Object.entries(LAYERS)) {
    for (const id of ids) map.setLayoutProperty(id, 'visibility', name === which ? 'visible' : 'none')
  }
}

// ---------------------------------------------------------------- icone

/** Icone disegnate al volo (niente sprite esterni): vetta, passo, rifugio. */
export function registerIcons(map: Map): void {
  const draw: Record<string, (c: CanvasRenderingContext2D, s: number) => void> = {
    peak: (c, s) => {
      c.fillStyle = '#7a5230'
      c.strokeStyle = '#ffffff'
      c.lineWidth = s * 0.12
      c.beginPath()
      c.moveTo(s / 2, s * 0.12)
      c.lineTo(s * 0.9, s * 0.85)
      c.lineTo(s * 0.1, s * 0.85)
      c.closePath()
      c.stroke()
      c.fill()
    },
    pass: (c, s) => {
      c.strokeStyle = '#7a5230'
      c.lineWidth = s * 0.14
      c.lineCap = 'round'
      c.beginPath()
      c.arc(s * 0.1, s / 2, s * 0.35, -Math.PI / 3, Math.PI / 3)
      c.stroke()
      c.beginPath()
      c.arc(s * 0.9, s / 2, s * 0.35, (2 * Math.PI) / 3, (4 * Math.PI) / 3)
      c.stroke()
    },
    hut: (c, s) => {
      c.fillStyle = '#b5401c'
      c.strokeStyle = '#ffffff'
      c.lineWidth = s * 0.1
      c.beginPath()
      c.moveTo(s / 2, s * 0.08)
      c.lineTo(s * 0.92, s * 0.48)
      c.lineTo(s * 0.8, s * 0.48)
      c.lineTo(s * 0.8, s * 0.9)
      c.lineTo(s * 0.2, s * 0.9)
      c.lineTo(s * 0.2, s * 0.48)
      c.lineTo(s * 0.08, s * 0.48)
      c.closePath()
      c.stroke()
      c.fill()
    },
  }
  const ratio = 2
  const size = 14 * ratio
  map.on('styleimagemissing', (e) => {
    const paint = draw[e.id]
    if (!paint || map.hasImage(e.id)) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    paint(ctx, size)
    map.addImage(e.id, ctx.getImageData(0, 0, size, size), { pixelRatio: ratio })
  })
}
