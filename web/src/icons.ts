// Icone disegnate al volo su canvas (niente sprite esterni): sfondo (vetta, passo, rifugio)
// e categorie dei POI. Registrate quando MapLibre le chiede la prima volta.

import type { Map } from 'maplibre-gl'
import type { PoiCategory } from './types'

type Draw = (c: CanvasRenderingContext2D, s: number) => void

export interface CategoryInfo {
  label: string // singolare
  plural: string
  color: string
  visible: boolean // acceso di default sulla mappa
}

/** Categorie dei POI: nome, colore, visibilità iniziale. */
export const CATEGORIES: Record<PoiCategory, CategoryInfo> = {
  lago: { label: 'Lago', plural: 'Laghi', color: '#2b7bb9', visible: true },
  cascata: { label: 'Cascata', plural: 'Cascate', color: '#1aa3b8', visible: true },
  malga: { label: 'Malga', plural: 'Malghe', color: '#4d8b31', visible: true },
  rifugio: { label: 'Rifugio', plural: 'Rifugi', color: '#b5401c', visible: true },
  bivacco: { label: 'Bivacco', plural: 'Bivacchi', color: '#d9822b', visible: true },
  panoramico: { label: 'Punto panoramico', plural: 'Panoramici', color: '#7a4fb3', visible: true },
  // Vette e passi sono già sullo sfondo pulito: spenti di default per non raddoppiarli.
  vetta: { label: 'Vetta', plural: 'Vette', color: '#7a5230', visible: false },
  passo: { label: 'Passo', plural: 'Passi', color: '#8a6a3a', visible: false },
}
export const CATEGORY_ORDER = Object.keys(CATEGORIES) as PoiCategory[]

function triangle(c: CanvasRenderingContext2D, s: number, color: string) {
  c.fillStyle = color
  c.strokeStyle = '#ffffff'
  c.lineWidth = s * 0.12
  c.beginPath()
  c.moveTo(s / 2, s * 0.12)
  c.lineTo(s * 0.9, s * 0.85)
  c.lineTo(s * 0.1, s * 0.85)
  c.closePath()
  c.stroke()
  c.fill()
}

function house(c: CanvasRenderingContext2D, s: number, color: string) {
  c.fillStyle = color
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
}

function pass(c: CanvasRenderingContext2D, s: number, color: string) {
  c.strokeStyle = color
  c.lineWidth = s * 0.14
  c.lineCap = 'round'
  c.beginPath()
  c.arc(s * 0.1, s / 2, s * 0.35, -Math.PI / 3, Math.PI / 3)
  c.stroke()
  c.beginPath()
  c.arc(s * 0.9, s / 2, s * 0.35, (2 * Math.PI) / 3, (4 * Math.PI) / 3)
  c.stroke()
}

/** Cerchio colorato con un simbolo bianco: lo stile comune delle icone POI. */
function badge(color: string, glyph: (c: CanvasRenderingContext2D, s: number) => void): Draw {
  return (c, s) => {
    c.fillStyle = color
    c.strokeStyle = '#ffffff'
    c.lineWidth = s * 0.09
    c.beginPath()
    c.arc(s / 2, s / 2, s * 0.44, 0, Math.PI * 2)
    c.fill()
    c.stroke()
    c.fillStyle = '#ffffff'
    c.strokeStyle = '#ffffff'
    glyph(c, s)
  }
}

const GLYPHS: Record<PoiCategory, (c: CanvasRenderingContext2D, s: number) => void> = {
  lago: (c, s) => {
    // onde
    c.lineWidth = s * 0.08
    c.lineCap = 'round'
    for (const dy of [-0.1, 0.1]) {
      c.beginPath()
      c.moveTo(s * 0.27, s * (0.5 + dy))
      c.quadraticCurveTo(s * 0.385, s * (0.42 + dy), s * 0.5, s * (0.5 + dy))
      c.quadraticCurveTo(s * 0.615, s * (0.58 + dy), s * 0.73, s * (0.5 + dy))
      c.stroke()
    }
  },
  cascata: (c, s) => {
    c.lineWidth = s * 0.08
    c.lineCap = 'round'
    for (const x of [0.38, 0.5, 0.62]) {
      c.beginPath()
      c.moveTo(s * x, s * 0.28)
      c.lineTo(s * x, s * 0.72)
      c.stroke()
    }
  },
  malga: (c, s) => {
    c.font = `bold ${s * 0.5}px system-ui, sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText('M', s / 2, s * 0.53)
  },
  rifugio: (c, s) => {
    c.beginPath()
    c.moveTo(s / 2, s * 0.24)
    c.lineTo(s * 0.74, s * 0.48)
    c.lineTo(s * 0.68, s * 0.48)
    c.lineTo(s * 0.68, s * 0.74)
    c.lineTo(s * 0.32, s * 0.74)
    c.lineTo(s * 0.32, s * 0.48)
    c.lineTo(s * 0.26, s * 0.48)
    c.closePath()
    c.fill()
  },
  bivacco: (c, s) => {
    // tenda / bivacco semicircolare
    c.beginPath()
    c.moveTo(s * 0.26, s * 0.7)
    c.lineTo(s * 0.5, s * 0.28)
    c.lineTo(s * 0.74, s * 0.7)
    c.closePath()
    c.fill()
  },
  panoramico: (c, s) => {
    // occhio
    c.beginPath()
    c.moveTo(s * 0.22, s * 0.5)
    c.quadraticCurveTo(s * 0.5, s * 0.22, s * 0.78, s * 0.5)
    c.quadraticCurveTo(s * 0.5, s * 0.78, s * 0.22, s * 0.5)
    c.fill()
    c.fillStyle = CATEGORIES.panoramico.color
    c.beginPath()
    c.arc(s / 2, s / 2, s * 0.09, 0, Math.PI * 2)
    c.fill()
  },
  vetta: (c, s) => {
    c.beginPath()
    c.moveTo(s / 2, s * 0.27)
    c.lineTo(s * 0.73, s * 0.7)
    c.lineTo(s * 0.27, s * 0.7)
    c.closePath()
    c.fill()
  },
  passo: (c, s) => {
    c.lineWidth = s * 0.08
    c.lineCap = 'round'
    c.beginPath()
    c.arc(s * 0.26, s / 2, s * 0.2, -Math.PI / 3, Math.PI / 3)
    c.stroke()
    c.beginPath()
    c.arc(s * 0.74, s / 2, s * 0.2, (2 * Math.PI) / 3, (4 * Math.PI) / 3)
    c.stroke()
  },
}

const DRAW: Record<string, Draw> = {
  peak: (c, s) => triangle(c, s, '#7a5230'),
  pass: (c, s) => pass(c, s, '#7a5230'),
  hut: (c, s) => house(c, s, '#b5401c'),
  ...Object.fromEntries(CATEGORY_ORDER.map((cat) => [`poi-${cat}`, badge(CATEGORIES[cat].color, GLYPHS[cat])])),
}

const RATIO = 2

/** Immagine di un'icona (per usarla anche fuori dalla mappa, es. nei badge della scheda). */
export function iconDataUrl(id: string, size = 18): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size * RATIO
  DRAW[id]?.(canvas.getContext('2d')!, size * RATIO)
  return canvas.toDataURL()
}

function addIcon(map: Map, id: string): void {
  const draw = DRAW[id]
  if (!draw || map.hasImage(id)) return
  const size = (id.startsWith('poi-') ? 18 : 14) * RATIO
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  draw(ctx, size)
  map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: RATIO })
}

/** Le icone sono poche: tutte registrate appena lo stile è pronto, più il resolver di
 *  MapLibre 6 per quelle chieste prima (l'evento `styleimagemissing` arriva troppo tardi). */
export function registerIcons(map: Map): void {
  map.setMissingStyleImageResolver((id) => addIcon(map, id))
  map.once('style.load', () => Object.keys(DRAW).forEach((id) => addIcon(map, id)))
}
