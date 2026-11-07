// Sezione "Percorsi combinati" nel pannello Filtri: avvio della ricerca e risultati.

import { CATEGORIES } from './icons'
import type { FoundRoute } from './finder'
import { h } from './panel'
import type { PoiProps, Trail } from './types'
import { icon } from './ui'

const km = (m: number) => (m / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const it = (n: number) => Math.round(n).toLocaleString('it-IT')

export interface FinderView {
  state: 'idle' | 'running' | 'done' | 'error'
  progress: number
  results: FoundRoute[]
  message: string | null
  onlyView: boolean // solo mete nella zona visibile della mappa
  summary: string // riassunto dei filtri usati
}

export interface FinderActions {
  run: () => void
  setOnlyView: (on: boolean) => void
  open: (r: FoundRoute) => void
  hover: (r: FoundRoute | null) => void
}

const MAX_SHOWN = 60

export function renderFinder(v: FinderView, pois: Map<string, PoiProps>, trails: Map<string, Trail>, a: FinderActions): HTMLElement {
  const sec = h('section', { class: 'finder' })
  sec.append(
    h('p', { class: 'section-label' }, 'Percorsi combinati'),
    h('p', { class: 'hint' }, 'Cerca anche percorsi non ufficiali: dal parcheggio più comodo alla meta, unendo pezzi di sentieri diversi agli incroci. Mete = le categorie di “Passa vicino a” (nessuna scelta = tutte). Usa lunghezza (solo andata), quota, dislivello, pendenza, difficoltà e “solo aperti”.'),
    h('p', { class: 'small mono finder-sum' }, v.summary),
  )
  const only = h('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement
  only.checked = v.onlyView
  only.addEventListener('change', () => a.setOnlyView(only.checked))
  sec.append(h('label', { class: 'switchrow' }, h('span', {}, 'Solo mete nella zona visibile della mappa'), only))
  const run = h('button', { type: 'button', class: 'btn-primary wide' }, icon('route', 18), v.state === 'running' ? `CERCO… ${Math.round(v.progress * 100)} %` : 'TROVA PERCORSI') as HTMLButtonElement
  run.disabled = v.state === 'running'
  run.addEventListener('click', a.run)
  sec.append(run)
  if (v.message) sec.append(h('p', { class: v.state === 'error' ? 'warn small' : 'muted small' }, v.message))
  if (v.state === 'done') {
    if (!v.results.length) {
      sec.append(h('p', { class: 'muted small' }, 'Nessun percorso con questi limiti. Prova ad allargare lunghezza o pendenza, o a spostare la mappa.'))
      return sec
    }
    const combined = v.results.filter((r) => r.trailsUsed > 1).length
    sec.append(h('p', { class: 'small' }, `${v.results.length} mete raggiungibili${combined ? `, ${combined} con percorso combinato` : ''}${v.results.length > MAX_SHOWN ? ` · le ${MAX_SHOWN} più vicine al parcheggio` : ''}.`))
    const list = h('ul', { class: 'cards' })
    for (const r of v.results.slice(0, MAX_SHOWN)) list.append(card(r, pois, trails, a))
    sec.append(list)
  }
  return sec
}

export interface ReachView {
  state: 'running' | 'done' | 'error'
  results: FoundRoute[]
  message: string | null
  summary: string
  radiusKm: number
}

/** "Come arrivarci" (scheda di un punto): intestazione, filtri (nodo fisso, non ridisegnato mentre
 *  si trascinano i cursori) e risultati. Chi chiama tiene i tre pezzi e ridisegna solo quelli che cambiano. */
export function reachHead(v: ReachView): HTMLElement {
  const n = v.results.length
  return h(
    'div',
    {},
    h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, v.state === 'done' ? `Come arrivarci · ${n} ${n === 1 ? 'percorso' : 'percorsi'}` : 'Come arrivarci')),
    h('p', { class: 'hint' }, `Da ogni parcheggio entro ${v.radiusKm.toLocaleString('it-IT')} km di cammino: il percorso più breve che arriva a meno di ${SPUR_TXT} dal punto, anche unendo sentieri diversi. Lunghezza = solo andata. Sulla mappa sono evidenziati tutti.`),
    h('p', { class: 'small mono finder-sum' }, v.summary),
  )
}

export function reachFilters(form: () => HTMLElement, open: boolean, onToggle: (open: boolean) => void): HTMLElement {
  const det = h('details', { class: 'wxacc reachfilters' }) as HTMLDetailsElement
  det.open = open
  let built = false
  const build = () => {
    if (built || !det.open) return
    built = true
    det.append(form())
  }
  det.addEventListener('toggle', () => {
    onToggle(det.open)
    build()
  })
  det.append(h('summary', { class: 'wxsum' }, h('span', { class: 'section-label' }, 'Filtri'), h('span', { class: 'small muted reachf-hint' }, 'lunghezza, pendenza, quota, difficoltà…'), icon('chevronRight', 18)))
  build()
  return det
}

export function reachList(v: ReachView, pois: Map<string, PoiProps>, trails: Map<string, Trail>, a: FinderActions): HTMLElement {
  const sec = h('div', { class: 'reachlist' })
  const n = v.results.length
  if (v.state === 'running') sec.append(h('p', { class: 'muted small' }, 'Cerco i percorsi…'))
  else if (v.state === 'error') sec.append(h('p', { class: 'warn small' }, v.message ?? 'Ricerca non riuscita.'))
  else if (!n) sec.append(h('p', { class: 'muted small' }, 'Nessun percorso da un parcheggio con questi filtri. Prova ad allargare lunghezza o pendenza.'))
  else {
    const list = h('ul', { class: 'cards' })
    for (const r of v.results.slice(0, MAX_SHOWN)) list.append(card(r, pois, trails, a, true))
    sec.append(list)
    if (n > MAX_SHOWN) sec.append(h('p', { class: 'small muted' }, `Mostrati i ${MAX_SHOWN} più corti; sulla mappa ci sono tutti.`))
  }
  return sec
}

const SPUR_TXT = '500 m'

function card(r: FoundRoute, pois: Map<string, PoiProps>, trails: Map<string, Trail>, a: FinderActions, fromPark = false): HTMLElement {
  const p = pois.get(r.poi)
  const cat = p ? CATEGORIES[p.categoria] : null
  const shown = r.pieces.filter((x) => Math.abs(x.to - x.from) >= 50)
  const path = (shown.length ? shown : r.pieces).map((x) => `${trails.get(x.trail)?.numero ?? x.trail} ${km(Math.abs(x.to - x.from))} km`).join(' → ')
  const park = `${r.park.nome || 'Parcheggio'}${r.park.tariffa ? ` (${r.park.tariffa})` : ''}`
  const btn = h(
    'button',
    { type: 'button', class: 'card-main' },
    h(
      'span',
      { class: 'card-top' },
      fromPark ? h('span', { class: 'mono muted' }, r.trailsUsed > 1 ? `${r.trailsUsed} sentieri` : (trails.get(r.pieces[0].trail)?.numero ?? '')) : cat ? h('span', { class: 'mono muted' }, h('i', { class: 'dot', style: `background:${cat.color}` }), ` ${cat.label}`) : null,
      r.trailsUsed > 1 ? h('span', { class: 'pill tiny combo' }, 'COMBINATO') : null,
      h('span', { class: 'mono card-km' }, `${km(r.totalM)} km`),
    ),
    h('span', { class: 'card-title' }, fromPark ? (r.park.nome ? `Da ${r.park.nome}` : 'Da un parcheggio') : (p?.nome ?? 'Meta')),
    h('span', { class: 'small mono muted' }, `D+ ${it(r.dplus)} m · quota max ${it(r.qmax)} m · pendenza max ${r.slope} %`),
    fromPark
      ? [r.park.tariffa, r.park.dist > 30 ? `${it(r.park.dist)} m dal parcheggio al sentiero` : null].some(Boolean)
        ? h('span', { class: 'small' }, [r.park.tariffa ? `parcheggio ${r.park.tariffa}` : null, r.park.dist > 30 ? `${it(r.park.dist)} m dal parcheggio al sentiero` : null].filter(Boolean).join(' · '))
        : null
      : h('span', { class: 'small' }, `da ${park}${r.park.dist > 30 ? ` · ${it(r.park.dist)} m al sentiero` : ''}`),
    h('span', { class: 'small muted' }, path + (r.spur > 30 ? ` → ${it(r.spur)} m alla meta` : '')),
  )
  btn.addEventListener('click', () => a.open(r))
  btn.addEventListener('pointerenter', () => a.hover(r))
  btn.addEventListener('pointerleave', () => a.hover(null))
  return h('li', { class: 'card' }, btn)
}
