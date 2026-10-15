// Contenuto del pannello informativo (tratto di sentiero o zone D-Flight).
// Tutto il testo passa da textContent: nessun HTML dei dati viene interpretato.

import { split, type Effective } from './flight'
import { CATEGORIES, iconDataUrl } from './icons'
import type { PoiCategory, PoiProps, Restriction, SegmentProps, Trail, ZoneProps } from './types'

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

const km = (m: number | null | undefined) => (m == null ? '–' : `${(m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`)
/** Numero di km formattato ("2,9"); kmVal aggiunge l'unità ("2,9 km"). */
export const kmNum = (v: number) => v.toLocaleString('it-IT', { maximumFractionDigits: 1 })
export const kmVal = (v: number) => `${kmNum(v)} km`

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
export const formatDate = (iso: string) => dateFmt.format(new Date(iso))

/** Testo breve della restrizione, es. "Libero fino a 45 m". */
export function restrictionLabel(r: Restriction): string {
  if (r.colore === 'verde') return 'Volo libero (categoria Open, max 120 m)'
  if (r.colore === 'giallo') return `Libero fino a ${r.quota_max_m} m dal suolo`
  return r.tipo_rosso === 'vietato' ? 'Volo vietato' : 'Serve autorizzazione'
}

function badge(r: Restriction): HTMLElement {
  return h('span', { class: `badge ${r.colore}` }, restrictionLabel(r))
}

function row(label: string, value: Child): HTMLElement | null {
  return value ? h('div', { class: 'row' }, h('dt', {}, label), h('dd', {}, value)) : null
}

function kmBar(k: { verde: number; giallo: number; rosso: number }): HTMLElement {
  const tot = k.verde + k.giallo + k.rosso || 1
  const bar = h('div', { class: 'kmbar', role: 'img', 'aria-label': 'ripartizione km per colore' })
  for (const c of ['verde', 'giallo', 'rosso'] as const) {
    if (k[c] > 0) bar.append(h('i', { class: c, style: `flex-grow:${k[c] / tot}` }))
  }
  const legend = h('div', { class: 'kmlegend' })
  for (const c of ['verde', 'giallo', 'rosso'] as const) {
    legend.append(h('span', {}, h('i', { class: `sw ${c}` }), kmVal(k[c])))
  }
  return h('div', {}, bar, legend)
}

export interface TrailView {
  trail: Trail
  /** Il tratto toccato sulla mappa (assente se il sentiero arriva da filtri o ricerca). */
  segment?: { seg: SegmentProps; eff: Effective }
  trailKm: { verde: number; giallo: number; rosso: number }
  zones: Map<string, ZoneProps>
  pois: Map<string, PoiProps>
  profile: HTMLElement // contenitore del profilo, riempito da chi chiama
  photos: HTMLElement // contenitore delle foto, riempito da chi chiama
  onZone: (ids: string[]) => void
  onPoi: (id: string) => void
  onFit: () => void
}

/** Icona di categoria come <img> (stessa grafica della mappa). */
export function catIcon(cat: PoiCategory, size = 16): HTMLElement {
  return h('img', { src: iconDataUrl(`poi-${cat}`, size), width: String(size), height: String(size), alt: '', class: 'caticon' })
}

function segmentSection(v: TrailView): HTMLElement | null {
  if (!v.segment) return null
  const { seg, eff } = v.segment
  const zoneIds = [...split(seg.zone), ...eff.notam]
  const zoneNames = [...new Set(zoneIds.map((id) => v.zones.get(id)?.nome ?? id))]
  const section = h(
    'section',
    { class: 'tratto' },
    h('h3', {}, 'Questo tratto'),
    badge(eff),
    eff.notam.length ? h('p', { class: 'warn' }, 'Restrizione temporanea (NOTAM) attiva nel giorno scelto.') : null,
    h(
      'dl',
      {},
      row('Lunghezza', km(seg.lunghezza_m)),
      row('Quota max', eff.colore === 'giallo' ? `${eff.quota_max_m} m dal suolo (AGL)` : null),
      row('Tipo', eff.colore === 'rosso' ? (eff.tipo_rosso === 'vietato' ? 'Divieto (no-fly zone)' : 'Autorizzazione richiesta (ATM-09)') : null),
    ),
  )
  if (zoneIds.length) {
    const btn = h('button', { type: 'button', class: 'link' }, zoneNames.length > 1 ? `Dettagli delle ${zoneNames.length} zone` : `Dettagli zona: ${zoneNames[0]}`)
    btn.addEventListener('click', () => v.onZone(zoneIds))
    section.append(btn)
  }
  return section
}

/** Badge riassuntivi: una icona per categoria presente lungo il sentiero. */
export function badgeRow(cats: PoiCategory[]): HTMLElement {
  const wrap = h('div', { class: 'badges' })
  for (const c of cats) wrap.append(h('span', { class: 'chip' }, catIcon(c, 14), CATEGORIES[c].label))
  return wrap
}

function poiList(v: TrailView): HTMLElement | null {
  const items = v.trail.poi.map((p) => ({ ...p, info: v.pois.get(p.id) })).filter((p) => p.info)
  if (!items.length) return null
  const list = h('ul', { class: 'poilist' })
  for (const p of items) {
    const btn = h(
      'button',
      { type: 'button' },
      catIcon(p.info!.categoria),
      h('span', { class: 'poiname' }, p.info!.nome + (p.info!.ele ? ` (${p.info!.ele} m)` : '')),
      h('span', { class: 'poimeta' }, `al km ${kmNum(p.km)} · a ${p.d} m`),
    )
    btn.addEventListener('click', () => v.onPoi(p.id))
    list.append(h('li', {}, btn))
  }
  return h('div', {}, h('h3', {}, `Lungo il percorso (${items.length})`), list)
}

export function renderTrail(v: TrailView): HTMLElement {
  const { trail } = v
  const diff = trail.difficolta
  const tempi = [trail.tempo_andata && `andata ${trail.tempo_andata}`, trail.tempo_ritorno && `ritorno ${trail.tempo_ritorno}`]
    .filter(Boolean)
    .join(' · ')
  const quote = trail.quota_min != null ? `${trail.quota_min} – ${trail.quota_max} m` : null
  const disl =
    trail.dislivello_pos != null ? `+${trail.dislivello_pos} m / −${trail.dislivello_neg} m` : null

  const fit = h('button', { type: 'button', class: 'link' }, 'Centra il sentiero')
  fit.addEventListener('click', v.onFit)

  return h(
    'div',
    {},
    h('p', { class: 'kicker' }, `Sentiero ${trail.numero}`),
    h('h2', {}, trail.titolo),
    trail.nome ? h('p', { class: 'sub' }, `${trail.loc_inizio} → ${trail.loc_fine}`) : null,
    trail.badge.length ? badgeRow(trail.badge) : null,
    segmentSection(v),
    h(
      'dl',
      {},
      row('Difficoltà', diff ? `${diff} · ${DIFFICOLTA[diff] ?? ''}` : null),
      row('Lunghezza', km(trail.lunghezza_m)),
      row('Dislivello', disl),
      row('Tempi', tempi),
      row('Quote', quote),
      row('Gruppo', trail.gruppo_montuoso),
    ),
    h('h3', {}, 'Volo lungo il sentiero'),
    kmBar(v.trailKm),
    h('h3', {}, 'Profilo altimetrico'),
    v.profile,
    fit,
    poiList(v),
    v.photos,
  )
}

export interface PoiView {
  poi: PoiProps
  near: { trail: Trail; d: number; km: number }[]
  photos: HTMLElement
  onTrail: (id: string) => void
  onBack?: () => void
}

export function renderPoi(v: PoiView): HTMLElement {
  const { poi } = v
  const root = h('div', {})
  if (v.onBack) {
    const back = h('button', { type: 'button', class: 'link back' }, '← Torna al sentiero')
    back.addEventListener('click', v.onBack)
    root.append(back)
  }
  root.append(
    h('p', { class: 'kicker' }, catIcon(poi.categoria, 14), ` ${CATEGORIES[poi.categoria].label}`),
    h('h2', {}, poi.nome),
  )
  if (poi.ele) root.append(h('p', { class: 'sub' }, `${poi.ele} m`))
  if (v.near.length) {
    const list = h('ul', { class: 'poilist' })
    for (const n of v.near) {
      const btn = h(
        'button',
        { type: 'button' },
        h('span', { class: 'poiname' }, `${n.trail.numero} · ${n.trail.titolo}`),
        h('span', { class: 'poimeta' }, `a ${n.d} m, al km ${kmNum(n.km)}`),
      )
      btn.addEventListener('click', () => v.onTrail(n.trail.id))
      list.append(h('li', {}, btn))
    }
    root.append(h('h3', {}, `Sentieri vicini (${v.near.length})`), list)
  } else {
    root.append(h('p', { class: 'muted' }, 'Nessun sentiero SAT entro la distanza dei badge.'))
  }
  const osmUrl = `https://www.openstreetmap.org/${({ n: 'node', w: 'way', r: 'relation' } as Record<string, string>)[poi.osm[0]]}/${poi.osm.slice(1)}`
  root.append(h('p', { class: 'small' }, h('a', { href: osmUrl, target: '_blank', rel: 'noopener' }, 'Vedi su OpenStreetMap')), v.photos)
  return root
}

function validity(z: ZoneProps): string {
  if (z.permanente || !z.fine) return 'Permanente'
  const fine = z.fine.startsWith('2099') ? 'a tempo indeterminato' : `al ${formatDate(z.fine)}`
  return z.inizio ? `Dal ${formatDate(z.inizio)} ${fine}` : `Fino ${fine}`
}

function verticalLimits(z: ZoneProps): string {
  const sup = z.quota_sup_m == null ? 'senza limite' : `${z.quota_sup_m} m`
  return `da ${z.quota_min_m} m a ${sup} dal suolo (${z.riferimento})`
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
  if (z.tipo_rosso === 'vietato') return 'Le operazioni UAS sono vietate nell\'area, salvo esenzioni previste dal provvedimento.'
  return 'Serve un\'autorizzazione già da terra (0 m): senza, non si vola.'
}

/** Testo semplice dal messaggio HTML di D-Flight (DOMParser non esegue script). */
function messageText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

function contacts(z: ZoneProps): HTMLElement {
  const items = [z.ente, z.ente_servizio, z.ente_contatto, z.ente_email, z.ente_telefono, z.ente_sito].filter(Boolean) as string[]
  if (!items.length) return h('p', { class: 'muted' }, 'Contatti dell\'ente non forniti da D-Flight (da compilare in authorities.yaml).')
  return h('p', {}, items.join(' · '))
}

export function renderZones(list: ZoneProps[], onBack?: () => void): HTMLElement {
  const root = h('div', {})
  if (onBack) {
    const back = h('button', { type: 'button', class: 'link back' }, '← Torna al tratto')
    back.addEventListener('click', onBack)
    root.append(back)
  }
  root.append(h('p', { class: 'kicker' }, list.length > 1 ? `${list.length} zone D-Flight in questo punto` : 'Zona D-Flight'))
  for (const z of list) {
    const motivi = split(z.motivi).map((m) => MOTIVI[m] ?? m).join(', ')
    root.append(
      h(
        'section',
        { class: 'zona' },
        h('h2', {}, z.nome),
        badge(z),
        h(
          'dl',
          {},
          row('Tipo', zoneType(z)),
          row('Quote', verticalLimits(z)),
          row('Validità', validity(z)),
          row('Motivi', motivi),
        ),
        h('h3', {}, 'Regole'),
        h('p', {}, rules(z)),
        z.messaggio ? h('p', { class: 'message' }, messageText(z.messaggio)) : null,
        h('h3', {}, 'Ente per i permessi'),
        contacts(z),
      ),
    )
  }
  root.append(h('p', { class: 'muted small' }, 'Ausilio alla pianificazione: il riferimento ufficiale resta la mappa D-Flight.'))
  return root
}
