// Filtri combinabili sui sentieri (tutti in AND) e modulo per impostarli.

import { CATEGORIES, CATEGORY_ORDER } from './icons'
import { h } from './panel'
import type { PoiCategory, Trail } from './types'

export type Volo = 'qualsiasi' | 'verde' | 'tutto'
export type Salvati = '' | 'miei' | 'condivisi' | 'entrambi'
// '' = tutti, 'no' = mai fatti, 'iniziati' = iniziati ma non finiti, 'si' = completati
export type Fatti = '' | 'no' | 'iniziati' | 'si'
export type KmByColor = { verde: number; giallo: number; rosso: number }

export interface FilterState {
  soloAperti: boolean // esclude i sentieri chiusi nella data scelta
  salvati: Salvati // '' = tutti i sentieri
  volo: Volo
  verdeKm: number // per volo = 'verde': almeno questi km di tratti verdi
  vicino: Set<PoiCategory> // deve avere TUTTE le categorie scelte
  difficolta: Set<string> // T, E, EE, EEA (vuoto = tutte)
  lungMin: number | null // km
  lungMax: number | null
  dislMax: number | null // m di dislivello positivo
  quotaMin: number | null // quota massima raggiunta, almeno (m)
  gruppo: string // '' = tutti
  fatti: Fatti
  segnaFatti: boolean // segno sulla mappa per i sentieri già fatti (non è un filtro)
  volMin: number | null // volabilità minima del giorno (0–100)
  ordina: 'aria' | 'volabilita' // ordine dei risultati
  coloraVol: boolean // sulla mappa: colori per volabilità invece che per spazio aereo
}

export const defaultFilters = (): FilterState => ({
  soloAperti: false,
  salvati: '',
  volo: 'qualsiasi',
  verdeKm: 1,
  vicino: new Set(),
  difficolta: new Set(),
  lungMin: null,
  lungMax: null,
  dislMax: null,
  quotaMin: null,
  gruppo: '',
  fatti: '',
  segnaFatti: true,
  volMin: null,
  ordina: 'aria',
  coloraVol: false,
})

/** Quanti filtri sono attivi (per il numerino sul pulsante). */
export function activeCount(f: FilterState): number {
  return (
    Number(f.volo !== 'qualsiasi') +
    f.vicino.size +
    Number(f.difficolta.size > 0) +
    Number(f.lungMin != null || f.lungMax != null) +
    Number(f.dislMax != null) +
    Number(f.quotaMin != null) +
    Number(!!f.gruppo) +
    Number(f.soloAperti) +
    Number(!!f.salvati) +
    Number(!!f.fatti) +
    Number(f.volMin != null)
  )
}

const diffGroup = (d: string | null) => (d?.startsWith('EEA') ? 'EEA' : (d ?? ''))

/** Dati del sentiero che dipendono dalla data scelta o dall'utente. */
export interface TrailContext {
  km: KmByColor
  closed: boolean
  mine: boolean // nei miei salvati
  shared: boolean // nella lista condivisa
  done: boolean // completato (le uscite coprono tutto il sentiero)
  started: boolean // iniziato ma non finito
  vol: number | null // indice di volabilità del giorno (null = non calcolato)
}

export function matches(t: Trail, ctx: TrailContext, f: FilterState): boolean {
  const { km } = ctx
  if (f.soloAperti && ctx.closed) return false
  if (f.salvati === 'miei' && !ctx.mine) return false
  if (f.salvati === 'condivisi' && !ctx.shared) return false
  if (f.salvati === 'entrambi' && !ctx.mine && !ctx.shared) return false
  if (f.fatti === 'no' && (ctx.done || ctx.started)) return false
  if (f.fatti === 'iniziati' && !ctx.started) return false
  if (f.fatti === 'si' && !ctx.done) return false
  if (f.volo === 'verde' && km.verde < f.verdeKm) return false
  if (f.volo === 'tutto' && km.rosso > 0.005) return false
  for (const c of f.vicino) if (!t.badge.includes(c)) return false
  if (f.difficolta.size && !f.difficolta.has(diffGroup(t.difficolta))) return false
  const lung = (t.lunghezza_m ?? 0) / 1000
  if (f.lungMin != null && lung < f.lungMin) return false
  if (f.lungMax != null && lung > f.lungMax) return false
  if (f.dislMax != null && (t.dislivello_pos ?? 0) > f.dislMax) return false
  if (f.quotaMin != null && (t.quota_max ?? 0) < f.quotaMin) return false
  if (f.gruppo && t.gruppo_montuoso !== f.gruppo) return false
  if (f.volMin != null && (ctx.vol == null || ctx.vol < f.volMin)) return false
  return true
}

// ---------------------------------------------------------------- modulo

const label = (text: string) => h('p', { class: 'section-label' }, text)

/** Controllo a segmenti: una sola opzione attiva. */
export function segmented<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void, cls = ''): HTMLElement {
  const wrap = h('div', { class: `segmented ${cls}`, role: 'radiogroup' })
  const buttons = options.map(([v, text]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value) }, text)
    b.addEventListener('click', () => {
      for (const x of buttons) x.setAttribute('aria-checked', String(x === b))
      onPick(v)
    })
    return b
  })
  wrap.append(...buttons)
  return wrap
}

/** Pulsante on/off (chip, difficoltà). */
function toggle(content: (Node | string)[], on: boolean, onChange: (v: boolean) => void, cls: string): HTMLElement {
  const b = h('button', { type: 'button', class: cls, 'aria-pressed': String(on) }, ...content)
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true'
    b.setAttribute('aria-pressed', String(next))
    onChange(next)
  })
  return b
}

/** Interruttore stile switch (checkbox nativa, accessibile). */
export function switchRow(text: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement
  input.checked = on
  input.addEventListener('change', () => onChange(input.checked))
  return h('label', { class: 'switchrow' }, h('span', {}, text), input)
}

/** Riquadro con cursore. `off` è il valore che significa "qualsiasi" (filtro spento). */
function sliderTile(
  title: string,
  value: number | null,
  o: { min: number; max: number; step: number; off: number; fmt: (v: number) => string },
  onInput: (v: number | null) => void,
): HTMLElement {
  const input = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step), 'aria-label': title }) as HTMLInputElement
  input.value = String(value ?? o.off)
  const out = h('span', { class: 'tile-v' })
  const show = () => {
    const v = Number(input.value)
    out.textContent = v === o.off ? 'qualsiasi' : o.fmt(v)
    out.classList.toggle('off', v === o.off)
  }
  show()
  input.addEventListener('input', () => {
    show()
    const v = Number(input.value)
    onInput(v === o.off ? null : v)
  })
  return h('label', { class: 'tile slider' }, h('span', { class: 'tile-k' }, title), out, input)
}

/** Disegna il modulo; ogni modifica chiama onChange (lo stato è modificato sul posto). */
export function renderForm(f: FilterState, gruppi: string[], onChange: () => void): HTMLElement {
  const form = h('form', { class: 'filters-form' })
  form.addEventListener('submit', (e) => e.preventDefault())

  // VOLO: segmented + cursore dei km verdi (solo per "Tratto libero")
  const verdeTile = sliderTile('Tratto verde minimo', f.verdeKm, { min: 0.5, max: 10, step: 0.5, off: -1, fmt: (v) => `≥ ${v.toLocaleString('it-IT')} km` }, (v) => {
    f.verdeKm = v ?? 1
    onChange()
  })
  verdeTile.classList.add('wide')
  verdeTile.hidden = f.volo !== 'verde'
  const volo = segmented<Volo>(
    [
      ['tutto', 'Tutto libero'],
      ['verde', 'Tratto libero'],
      ['qualsiasi', 'Qualsiasi'],
    ],
    f.volo,
    (v) => {
      f.volo = v
      verdeTile.hidden = v !== 'verde'
      onChange()
    },
  )
  const voloHelp = h('p', { class: 'hint' }, '"Tutto libero" = nessun tratto rosso nella data scelta.')

  // PASSA VICINO A
  const near = h('div', { class: 'chipgrid' })
  for (const c of CATEGORY_ORDER) {
    near.append(
      toggle([h('i', { class: 'dot', style: `background:${CATEGORIES[c].color}` }), CATEGORIES[c].label], f.vicino.has(c), (on) => {
        if (on) f.vicino.add(c)
        else f.vicino.delete(c)
        onChange()
      }, 'chiptoggle'),
    )
  }

  // DIFFICOLTÀ
  const diff = h('div', { class: 'diffrow' })
  for (const [d, title] of [['T', 'turistico'], ['E', 'escursionistico'], ['EE', 'esperti'], ['EEA', 'attrezzato']]) {
    const b = toggle([h('span', { class: 'mono' }, d), h('small', {}, title)], f.difficolta.has(d), (on) => {
      if (on) f.difficolta.add(d)
      else f.difficolta.delete(d)
      onChange()
    }, 'difftoggle')
    diff.append(b)
  }

  // Griglia 2×2: lunghezza, dislivello, quota, gruppo
  const fmtM = (v: number) => `${v.toLocaleString('it-IT')} m`
  const select = h('select', { 'aria-label': 'Gruppo montuoso' }) as HTMLSelectElement
  select.append(h('option', { value: '' }, 'qualsiasi'))
  for (const g of gruppi) select.append(h('option', { value: g }, g))
  select.value = f.gruppo
  select.addEventListener('change', () => {
    f.gruppo = select.value
    onChange()
  })
  const grid = h(
    'div',
    { class: 'tilegrid' },
    sliderTile('Lunghezza max', f.lungMax, { min: 1, max: 40, step: 1, off: 40, fmt: (v) => `≤ ${v} km` }, (v) => {
      f.lungMax = v
      onChange()
    }),
    sliderTile('Dislivello max', f.dislMax, { min: 100, max: 2500, step: 50, off: 2500, fmt: (v) => `≤ ${fmtM(v)}` }, (v) => {
      f.dislMax = v
      onChange()
    }),
    sliderTile('Quota min raggiunta', f.quotaMin, { min: 0, max: 3200, step: 100, off: 0, fmt: (v) => `≥ ${fmtM(v)}` }, (v) => {
      f.quotaMin = v
      onChange()
    }),
    h('label', { class: 'tile' }, h('span', { class: 'tile-k' }, 'Gruppo montuoso'), select),
  )

  // Interruttori
  const savedSeg = segmented<Exclude<Salvati, ''>>(
    [
      ['entrambi', 'Tutti'],
      ['miei', 'Miei'],
      ['condivisi', 'Bacheche'],
    ],
    f.salvati || 'entrambi',
    (v) => {
      f.salvati = v
      onChange()
    },
    'small',
  )
  savedSeg.hidden = !f.salvati
  const switches = h(
    'div',
    { class: 'switches' },
    switchRow('Solo sentieri aperti', f.soloAperti, (on) => {
      f.soloAperti = on
      onChange()
    }),
    switchRow('Solo salvati', !!f.salvati, (on) => {
      f.salvati = on ? 'entrambi' : ''
      savedSeg.hidden = !on
      for (const b of savedSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.textContent === 'Tutti'))
      onChange()
    }),
    savedSeg,
  )

  // SENTIERI FATTI (le mie uscite)
  const fatti = segmented<Fatti>(
    [
      ['', 'Tutti'],
      ['no', 'Non ancora fatti'],
      ['iniziati', 'Iniziati ma non finiti'],
      ['si', 'Solo fatti'],
    ],
    f.fatti,
    (v) => {
      f.fatti = v
      onChange()
    },
    'small',
  )
  const segna = switchRow('Segna sulla mappa i sentieri fatti', f.segnaFatti, (on) => {
    f.segnaFatti = on
    onChange()
  })

  // VOLABILITÀ (meteo del giorno scelto)
  const volTile = sliderTile('Volabilità minima', f.volMin, { min: 0, max: 90, step: 10, off: 0, fmt: (v) => `≥ ${v}` }, (v) => {
    f.volMin = v
    onChange()
  })
  volTile.classList.add('wide')
  const ordina = segmented<FilterState['ordina']>(
    [
      ['aria', 'Ordina per spazio aereo'],
      ['volabilita', 'Ordina per volabilità'],
    ],
    f.ordina,
    (v) => {
      f.ordina = v
      onChange()
    },
    'small',
  )
  const colora = switchRow('Colora i sentieri per volabilità', f.coloraVol, (on) => {
    f.coloraVol = on
    onChange()
  })
  const volHelp = h('p', { class: 'hint' }, 'Indice 0–100 dal meteo del giorno scelto (vento, pioggia, nuvole, luce, Kp) e dallo spazio aereo. Calcolato per i sentieri nella zona della mappa.')

  form.append(
    h('section', {}, label('Volo'), volo, verdeTile, voloHelp),
    h('section', {}, label('Volabilità del giorno'), volTile, ordina, h('div', { class: 'switches' }, colora), volHelp),
    h('section', {}, label('Passa vicino a'), near),
    h('section', {}, label('Difficoltà'), diff),
    h('section', {}, grid),
    h('section', {}, switches),
    h('section', {}, label('Sentieri fatti'), fatti, h('div', { class: 'switches' }, segna)),
  )
  return form
}
