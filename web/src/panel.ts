// Contenuto della scheda (sentiero, POI, zone D-Flight) e componenti condivisi (card, barre).
// Tutto il testo passa da textContent: nessun HTML dei dati viene interpretato.

import { periodLabel, type Closure } from './closures'
import { split, type Effective } from './flight'
import { CATEGORIES, iconDataUrl } from './icons'
import type { Colore, PoiCategory, PoiProps, Restriction, SegmentProps, Trail, ZoneProps } from './types'
import { icon } from './ui'

type Child = Node | string | null | undefined | false

export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  for (const c of children) if (c) el.append(c)
  return el
}

const DIFFICOLTA: Record<string, string> = {
  T: 'turistico',
  E: 'escursionistico',
  EE: 'per escursionisti esperti',
  'EEA-F': 'attrezzato, facile',
  'EEA-PD': 'attrezzato, poco difficile',
  'EEA-D': 'attrezzato, difficile',
  'EEA-MD': 'attrezzato, molto difficile',
}

const MOTIVI: Record<string, string> = {
  EMERGENCY: 'emergenza / soccorso',
  AIR_TRAFFIC: 'traffico aereo',
  SENSITIVE: 'sito sensibile',
  PRIVACY: 'privacy',
  POPULATION: 'aree popolate',
  NOISE: 'rumore',
  NATURE: 'tutela ambientale',
  OTHER: 'altro',
}

/** Numero di km formattato ("2,9"); kmVal aggiunge l'unità ("2,9 km"). */
export const kmNum = (v: number) => v.toLocaleString('it-IT', { maximumFractionDigits: 1 })
export const kmVal = (v: number) => `${kmNum(v)} km`
const intIt = (v: number) => v.toLocaleString('it-IT')

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
export const formatDate = (iso: string) => dateFmt.format(new Date(iso))
/** "2026-10-16" → "16.10.2026" */
export const dotDate = (day: string) => day.split('-').reverse().join('.')

const mono = (text: string) => h('span', { class: 'mono' }, text)
const label = (text: string) => h('p', { class: 'section-label' }, text)

/** Testo breve della restrizione, es. "Libero fino a 45 m". */
export function restrictionLabel(r: Restriction): string {
  if (r.colore === 'verde') return 'Volo libero (categoria Open, max 120 m)'
  if (r.colore === 'giallo') return `Libero fino a ${r.quota_max_m} m dal suolo`
  return r.tipo_rosso === 'vietato' ? 'Volo vietato' : 'Serve autorizzazione'
}

/** Stato di volo come pillola: pallino colorato + testo scuro (contrasto sempre ≥ 4,5:1). */
function statePill(r: Restriction): HTMLElement {
  return h('span', { class: `pill state ${r.colore}` }, h('i', { class: `dot ${r.colore}` }), restrictionLabel(r))
}

/** Barra proporzionale verde/giallo/rossa dei km. */
export function flightBar(k: Record<Colore, number>, thin = false): HTMLElement {
  const tot = k.verde + k.giallo + k.rosso || 1
  const bar = h('div', { class: `flightbar${thin ? ' thin' : ''}`, role: 'img', 'aria-label': `verde ${kmVal(k.verde)}, giallo ${kmVal(k.giallo)}, rosso ${kmVal(k.rosso)}` })
  for (const c of ['verde', 'giallo', 'rosso'] as const) if (k[c] > 0) bar.append(h('i', { class: c, style: `flex-grow:${k[c] / tot}` }))
  return bar
}

function kmLegend(k: Record<Colore, number>): HTMLElement {
  const row = h('div', { class: 'kmlegend' })
  const names: Record<Colore, string> = { verde: 'libero', giallo: 'quota lim.', rosso: 'no / aut.' }
  for (const c of ['verde', 'giallo', 'rosso'] as const) {
    row.append(h('span', {}, h('i', { class: `dot ${c}` }), mono(kmVal(k[c])), h('span', { class: 'muted' }, ` ${names[c]}`)))
  }
  return row
}

function tile(k: string, value: string, sub?: string | null): HTMLElement {
  return h('div', { class: 'tile' }, h('span', { class: 'tile-k' }, k), h('span', { class: 'tile-v' }, value), sub ? h('span', { class: 'tile-s' }, sub) : null)
}

function chip(text: string, cls = '', title?: string): HTMLElement {
  return h('span', { class: `pill ${cls}`, ...(title ? { title } : {}) }, text)
}

/** Icona di categoria come <img> (stessa grafica della mappa). */
export function catIcon(cat: PoiCategory, size = 16): HTMLElement {
  return h('img', { src: iconDataUrl(`poi-${cat}`, size), width: String(size), height: String(size), alt: '', class: 'caticon' })
}

const catDot = (cat: PoiCategory) => h('i', { class: 'dot', style: `background:${CATEGORIES[cat].color}` })

/** Etichette POI compatte (pallino colore + nome categoria). */
export function badgeRow(cats: PoiCategory[]): HTMLElement {
  const wrap = h('div', { class: 'tags' })
  for (const c of cats) wrap.append(h('span', { class: 'tag' }, catDot(c), CATEGORIES[c].label))
  return wrap
}

function sectionHead(title: string, right?: Node | null): HTMLElement {
  return h('div', { class: 'section-head' }, label(title), right ?? null)
}

// ---------------------------------------------------------------- card sentiero (liste)

export interface CardOptions {
  km: Record<Colore, number>
  closed: boolean
  saved: boolean
  done?: boolean // l'ho già fatto tutto
  started?: boolean // iniziato ma non finito
  vol?: HTMLElement | null // bollino della volabilità del giorno
  who?: string | null // "aggiunto da …" nella lista condivisa
  onOpen: () => void
  onRemove?: () => void
}

export function trailCard(t: Trail, o: CardOptions): HTMLElement {
  const open = h(
    'button',
    { type: 'button', class: 'card-main' },
    h(
      'span',
      { class: 'card-top' },
      h('span', { class: 'mono muted' }, [t.numero, t.difficolta].filter(Boolean).join(' · ')),
      o.closed ? h('span', { class: 'pill tiny closed' }, h('i', { class: 'dot rosso' }), 'CHIUSO') : null,
      o.done ? h('span', { class: 'done-mark', title: 'Già fatto' }, icon('check', 14)) : o.started ? h('span', { class: 'done-mark', title: 'Iniziato, non finito' }, icon('half', 14)) : null,
      o.saved ? h('span', { class: 'saved-mark', title: 'Salvato' }, icon('bookmarkFilled', 14)) : null,
      o.vol ?? null,
      h('span', { class: 'mono card-km' }, kmVal((t.lunghezza_m ?? 0) / 1000)),
    ),
    h('span', { class: 'card-title' }, t.titolo),
    flightBar(o.km, true),
    t.badge.length ? badgeRow(t.badge) : null,
    o.who ? h('span', { class: 'card-who' }, o.who) : null,
  )
  open.addEventListener('click', o.onOpen)
  const li = h('li', { class: 'card' }, open)
  if (o.onRemove) {
    const del = h('button', { type: 'button', class: 'iconbtn card-remove', 'aria-label': `Togli ${t.numero} dalla lista`, title: 'Togli dalla lista' }, icon('close', 18))
    del.addEventListener('click', o.onRemove)
    li.append(del)
  }
  return li
}

// ---------------------------------------------------------------- scheda sentiero

export interface TrailView {
  trail: Trail
  day: string
  /** Il tratto toccato sulla mappa (assente se il sentiero arriva da filtri o ricerca). */
  segment?: { seg: SegmentProps; eff: Effective }
  trailKm: Record<Colore, number>
  closures: { all: Closure[]; active: Closure[] } // tutte / in vigore nella data scelta
  zones: Map<string, ZoneProps>
  pois: Map<string, PoiProps>
  profile: HTMLElement // contenitore del profilo, riempito da chi chiama
  photos: HTMLElement // contenitore delle foto, riempito da chi chiama
  mine?: HTMLElement // le mie uscite e la nota personale, riempito da chi chiama
  weather?: HTMLElement // meteo e volabilità, riempito da chi chiama
  onZone: (ids: string[]) => void
  onPoi: (id: string) => void
  onFit: () => void
}

function closureSection(c: { all: Closure[]; active: Closure[] }): HTMLElement | null {
  if (!c.all.length) return null
  const item = (x: Closure) =>
    h(
      'li',
      {},
      `${x.motivo ?? 'Chiuso'} `,
      h('span', { class: 'mono muted' }, `(${periodLabel(x)})`),
      x.fonte ? h('span', {}, ' · ', h('a', { href: x.fonte, target: '_blank', rel: 'noopener' }, 'fonte')) : null,
    )
  if (c.active.length) {
    return h('section', { class: 'notice danger' }, label('Chiuso nella data scelta'), h('ul', {}, ...c.active.map(item)))
  }
  return h('section', { class: 'notice' }, label('Aperto · chiusure previste'), h('ul', {}, ...c.all.map(item)))
}

function segmentSection(v: TrailView): HTMLElement | null {
  if (!v.segment) return null
  const { seg, eff } = v.segment
  const zoneIds = [...split(seg.zone), ...eff.notam]
  const zoneNames = [...new Set(zoneIds.map((id) => v.zones.get(id)?.nome ?? id))]
  const details = [
    `tratto di ${kmVal(seg.lunghezza_m / 1000)}`,
    eff.colore === 'giallo' ? `max ${eff.quota_max_m} m AGL` : null,
    eff.colore === 'rosso' ? (eff.tipo_rosso === 'vietato' ? 'divieto (no-fly zone)' : 'autorizzazione (ATM-09)') : null,
  ].filter(Boolean)
  const box = h(
    'div',
    { class: 'subcard' },
    h('div', { class: 'subcard-head' }, label('Questo tratto'), mono(details.join(' · '))),
    statePill(eff),
    eff.notam.length ? h('p', { class: 'warn' }, h('i', { class: 'dot rosso' }), 'NOTAM temporaneo attivo nel giorno scelto') : null,
  )
  if (zoneIds.length) {
    const btn = h('button', { type: 'button', class: 'btn-link' }, zoneNames.length > 1 ? `Dettagli delle ${zoneNames.length} zone` : `Zona: ${zoneNames[0]}`)
    btn.addEventListener('click', () => v.onZone(zoneIds))
    box.append(btn)
  }
  return box
}

function poiChips(v: TrailView): HTMLElement | null {
  const items = v.trail.poi.map((p) => ({ ...p, info: v.pois.get(p.id) })).filter((p) => p.info)
  if (!items.length) return null
  const wrap = h('div', { class: 'poichips' })
  for (const p of items) {
    const b = h(
      'button',
      { type: 'button', class: 'poichip', title: `al km ${kmNum(p.km)}, a ${p.d} m dal sentiero` },
      catDot(p.info!.categoria),
      h('span', {}, p.info!.nome + (p.info!.ele ? ` ${p.info!.ele} m` : '')),
      h('span', { class: 'mono muted' }, `${p.d} m`),
    )
    b.addEventListener('click', () => v.onPoi(p.id))
    wrap.append(b)
  }
  return h('section', {}, sectionHead(`Lungo il percorso · ${items.length}`), wrap)
}

export function renderTrail(v: TrailView): HTMLElement {
  const { trail } = v
  const open = v.closures.active.length === 0
  const diff = trail.difficolta
  const route = trail.nome ? `${trail.loc_inizio} → ${trail.loc_fine}` : null
  const sub = [route, trail.gruppo_montuoso].filter(Boolean).join(' · ')

  const fit = h('button', { type: 'button', class: 'btn-link icon-left', title: 'Centra il sentiero sulla mappa' }, icon('focus', 16), 'CENTRA')
  fit.addEventListener('click', v.onFit)

  const hm = (t: string | null) => (t ? t.replace(/^0/, '') : '–')
  return h(
    'div',
    { class: 'trail' },
    h(
      'div',
      { class: 'chiprow' },
      chip(trail.numero, 'code mono'),
      diff ? chip(diff, 'mono', `${diff} · ${DIFFICOLTA[diff] ?? ''}`) : null,
      h('span', { class: `pill ${open ? 'open' : 'closed'}` }, h('i', { class: `dot ${open ? 'verde' : 'rosso'}` }), open ? 'APERTO' : 'CHIUSO'),
    ),
    h('h2', { class: 'title' }, trail.titolo),
    sub ? h('p', { class: 'subtitle' }, sub) : null,
    h(
      'div',
      { class: 'tiles' },
      tile('DIST', kmVal((trail.lunghezza_m ?? 0) / 1000), trail.lunghezza_inclinata_m ? `reale ${kmVal(trail.lunghezza_inclinata_m / 1000)}` : null),
      tile('D+', trail.dislivello_pos != null ? `${intIt(trail.dislivello_pos)} m` : '–', trail.dislivello_neg != null ? `D− ${intIt(trail.dislivello_neg)} m` : null),
      tile('Q.MAX', trail.quota_max != null ? `${intIt(trail.quota_max)} m` : '–', trail.quota_min != null ? `min ${intIt(trail.quota_min)} m` : null),
      tile('TEMPO', hm(trail.tempo_andata), trail.tempo_ritorno ? `ritorno ${hm(trail.tempo_ritorno)}` : null),
    ),
    closureSection(v.closures),
    h(
      'section',
      {},
      sectionHead('Spazio aereo', mono(dotDate(v.day))),
      flightBar(v.trailKm),
      kmLegend(v.trailKm),
      segmentSection(v),
    ),
    v.weather ?? null,
    v.mine ?? null,
    h('section', {}, sectionHead('Profilo', fit), v.profile),
    poiChips(v),
    v.photos,
  )
}

// ---------------------------------------------------------------- scheda POI

export interface PoiView {
  poi: PoiProps
  near: { trail: Trail; d: number; km: number }[]
  photos: HTMLElement
  onTrail: (id: string) => void
  onBack?: () => void
}

function backButton(text: string, onBack: () => void): HTMLElement {
  const b = h('button', { type: 'button', class: 'btn-link icon-left back' }, icon('back', 16), text)
  b.addEventListener('click', onBack)
  return b
}

export function renderPoi(v: PoiView): HTMLElement {
  const { poi } = v
  const root = h('div', { class: 'trail' })
  if (v.onBack) root.append(backButton('SENTIERO', v.onBack))
  root.append(
    h('div', { class: 'chiprow' }, h('span', { class: 'pill' }, catDot(poi.categoria), CATEGORIES[poi.categoria].label.toUpperCase())),
    h('h2', { class: 'title' }, poi.nome),
  )
  if (poi.ele) root.append(h('div', { class: 'tiles two' }, tile('QUOTA', `${intIt(poi.ele)} m`)))
  if (v.near.length) {
    const list = h('ul', { class: 'linklist' })
    for (const n of v.near) {
      const b = h(
        'button',
        { type: 'button' },
        h('span', { class: 'mono muted' }, n.trail.numero),
        h('span', { class: 'll-title' }, n.trail.titolo),
        h('span', { class: 'mono muted' }, `${n.d} m · km ${kmNum(n.km)}`),
      )
      b.addEventListener('click', () => v.onTrail(n.trail.id))
      list.append(h('li', {}, b))
    }
    root.append(h('section', {}, sectionHead(`Sentieri vicini · ${v.near.length}`), list))
  } else {
    root.append(h('p', { class: 'muted' }, 'Nessun sentiero SAT entro la distanza dei badge.'))
  }
  const osmUrl = `https://www.openstreetmap.org/${({ n: 'node', w: 'way', r: 'relation' } as Record<string, string>)[poi.osm[0]]}/${poi.osm.slice(1)}`
  root.append(h('p', { class: 'small' }, h('a', { href: osmUrl, target: '_blank', rel: 'noopener' }, 'Vedi su OpenStreetMap')), v.photos)
  return root
}

// ---------------------------------------------------------------- scheda zone D-Flight

function validity(z: ZoneProps): string {
  if (z.permanente || !z.fine) return 'Permanente'
  const fine = z.fine.startsWith('2099') ? 'a tempo indeterminato' : `al ${formatDate(z.fine)}`
  return z.inizio ? `Dal ${formatDate(z.inizio)} ${fine}` : `Fino ${fine}`
}

function verticalLimits(z: ZoneProps): string {
  const sup = z.quota_sup_m == null ? '∞' : `${z.quota_sup_m} m`
  return `${z.quota_min_m}–${sup} ${z.riferimento}`
}

function zoneType(z: ZoneProps): string {
  if (z.nome.startsWith('NOTAM')) return 'NOTAM temporaneo (divieto)'
  if (z.categoria === 'NFZ') return 'No-fly zone (divieto)'
  if (z.categoria === 'ATM09') return 'Zona ATM-09 (autorizzazione sopra la quota libera)'
  return z.categoria
}

function rules(z: ZoneProps): string {
  if (z.colore === 'giallo') {
    return `Si può volare senza autorizzazione fino a ${z.quota_max_m} m dal suolo. Più in alto serve l'autorizzazione dell'ente.`
  }
  if (z.tipo_rosso === 'vietato') return "Le operazioni UAS sono vietate nell'area, salvo esenzioni previste dal provvedimento."
  return "Serve un'autorizzazione già da terra (0 m): senza, non si vola."
}

/** Testo semplice dal messaggio HTML di D-Flight (DOMParser non esegue script). */
function messageText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

function contacts(z: ZoneProps): HTMLElement {
  const items = [z.ente, z.ente_servizio, z.ente_contatto, z.ente_email, z.ente_telefono, z.ente_sito].filter(Boolean) as string[]
  if (!items.length) return h('p', { class: 'muted' }, "Contatti dell'ente non forniti da D-Flight (da compilare in authorities.yaml).")
  return h('p', {}, items.join(' · '))
}

export function renderZones(list: ZoneProps[], onBack?: () => void): HTMLElement {
  const root = h('div', { class: 'trail' })
  if (onBack) root.append(backButton('SENTIERO', onBack))
  root.append(label(list.length > 1 ? `${list.length} zone D-Flight in questo punto` : 'Zona D-Flight'))
  for (const z of list) {
    const motivi = split(z.motivi).map((m) => MOTIVI[m] ?? m).join(', ')
    root.append(
      h(
        'section',
        { class: 'zonecard' },
        h('h2', { class: 'title small' }, z.nome),
        statePill(z),
        h('div', { class: 'tiles two' }, tile('QUOTE', verticalLimits(z)), tile('VALIDITÀ', z.permanente || !z.fine ? 'PERMANENTE' : 'TEMPORANEA')),
        h(
          'dl',
          { class: 'facts' },
          h('dt', {}, 'Tipo'),
          h('dd', {}, zoneType(z)),
          h('dt', {}, 'Validità'),
          h('dd', { class: 'mono' }, validity(z)),
          motivi ? h('dt', {}, 'Motivi') : null,
          motivi ? h('dd', {}, motivi) : null,
        ),
        label('Regole'),
        h('p', {}, rules(z)),
        z.messaggio ? h('p', { class: 'message' }, messageText(z.messaggio)) : null,
        label('Ente per i permessi'),
        contacts(z),
      ),
    )
  }
  root.append(h('p', { class: 'muted small' }, 'Ausilio alla pianificazione: il riferimento ufficiale resta la mappa D-Flight.'))
  return root
}
