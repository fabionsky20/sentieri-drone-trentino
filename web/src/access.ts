// "Come arrivare": punto dove arrivare in auto per ciascuna estremità del sentiero, precalcolato
// dalla pipeline (pipeline/access.py → data/processed/access.json) con parcheggi e strade OSM.

import { segmented } from './filters'
import { h } from './panel'
import type { Trail } from './types'
import { icon } from './ui'

export interface AccessPoint {
  tipo: 'parcheggio' | 'strada' | 'nessuno'
  lat?: number
  lon?: number
  nome?: string
  tariffa?: 'gratuito' | 'a pagamento' | 'sconosciuto'
  posti?: number
  fondo?: string
  orari?: string
  sosta_max?: string
  quota?: number
  distanza_m?: number // in linea d'aria fino alla partenza del sentiero
  dislivello_m?: number // dalla destinazione alla partenza (+ = si sale)
}

export type TrailAccess = { inizio?: AccessPoint; fine?: AccessPoint }
export type AccessData = Record<string, TrailAccess>

/** Link universale di Google Maps: sul telefono apre l'app, altrove il sito. */
export const mapsUrl = (lat: number, lon: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`

const it = (n: number) => n.toLocaleString('it-IT')

function walkLine(a: AccessPoint): string | null {
  if (a.distanza_m == null) return null
  const d = a.distanza_m < 30 ? 'Sei già alla partenza del sentiero' : `~${it(Math.round(a.distanza_m / 10) * 10)} m a piedi (in linea d'aria) fino alla partenza`
  const z = a.dislivello_m
  const dz = z == null || Math.abs(z) < 5 ? '' : z > 0 ? ` (+${it(z)} m di dislivello)` : ` (−${it(-z)} m, in discesa)`
  return d + dz
}

export interface AccessCtx {
  trail: Trail
  access: TrailAccess | null | undefined // undefined = in caricamento
  from: 'inizio' | 'fine'
  onFrom: (v: 'inizio' | 'fine') => void
  updated: string | null // data dei dati OSM
}

export function renderAccess(c: AccessCtx): HTMLElement {
  const sec = h('div', { class: 'access' })
  sec.append(h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, 'Come arrivare')))
  if (c.access === undefined) {
    sec.append(h('p', { class: 'muted small' }, 'Carico i parcheggi…'))
    return sec
  }
  const t = c.trail
  const name = (w: 'inizio' | 'fine') => (w === 'inizio' ? t.loc_inizio : t.loc_fine) ?? (w === 'inizio' ? 'inizio' : 'fine')
  sec.append(
    h(
      'div',
      { class: 'field', role: 'group', 'aria-label': 'Da dove parto' },
      h('span', { class: 'field-k' }, 'Parto da'),
      segmented<'inizio' | 'fine'>(
        [
          ['inizio', name('inizio')],
          ['fine', name('fine')],
        ],
        c.from,
        c.onFrom,
        'small',
      ),
    ),
  )
  const a = c.access?.[c.from]
  if (!a || a.tipo === 'nessuno' || a.lat == null || a.lon == null) {
    sec.append(h('p', { class: 'small' }, 'Nessuna strada percorribile in auto entro 3 km da questa partenza: ci si arriva solo a piedi, da un altro sentiero.'))
    return sec
  }
  if (a.tipo === 'parcheggio') {
    const facts = [a.tariffa === 'gratuito' ? 'gratuito' : a.tariffa === 'a pagamento' ? 'a pagamento' : 'tariffa sconosciuta', a.posti ? `${it(a.posti)} posti` : null, a.sosta_max ? `sosta max ${a.sosta_max}` : null].filter(Boolean).join(' · ')
    sec.append(
      h(
        'div',
        { class: 'access-card' },
        h('span', { class: 'pmark', 'aria-hidden': 'true' }, 'P'),
        h('div', {}, h('p', { class: 'access-name' }, a.nome ?? 'Parcheggio'), h('p', { class: 'small muted' }, facts), a.orari ? h('p', { class: 'small muted' }, `Orari: ${a.orari}`) : null),
      ),
    )
  } else {
    sec.append(
      h(
        'div',
        { class: 'access-card' },
        h('span', { class: 'pmark road', 'aria-hidden': 'true' }, icon('map', 16)),
        h('div', {}, h('p', { class: 'access-name' }, 'Solo bordo strada'), h('p', { class: 'small muted' }, 'Nessun parcheggio entro 1 km: il punto è sulla strada percorribile più vicina. Controlla dove fermarti.')),
      ),
    )
  }
  const walk = walkLine(a)
  if (walk) sec.append(h('p', { class: 'small' }, walk))
  // Punto stradale lontano: può essere in un'altra valle. Meglio dirlo e proporre l'altro capo.
  if (a.tipo === 'strada' && (a.distanza_m ?? 0) > 1500) {
    const other = c.access?.[c.from === 'inizio' ? 'fine' : 'inizio']
    const hint = other?.tipo === 'parcheggio' ? ` Dall'altra estremità (${name(c.from === 'inizio' ? 'fine' : 'inizio')}) c'è un parcheggio a ~${it(Math.round((other.distanza_m ?? 0) / 10) * 10)} m.` : ''
    sec.append(h('p', { class: 'small warn' }, `La strada più vicina è lontana dalla partenza e potrebbe essere in un'altra valle: controlla il percorso a piedi.${hint}`))
  }
  sec.append(h('a', { class: 'btn-primary wide access-go', href: mapsUrl(a.lat, a.lon), target: '_blank', rel: 'noopener' }, icon('locate', 18), 'NAVIGA CON GOOGLE MAPS'))
  sec.append(h('p', { class: 'hint' }, `Parcheggi e strade © OpenStreetMap contributors (ODbL)${c.updated ? `, dati del ${c.updated.slice(0, 10).split('-').reverse().join('.')}` : ''}. Distanza in linea d'aria: il percorso a piedi può essere più lungo.`))
  return sec
}
