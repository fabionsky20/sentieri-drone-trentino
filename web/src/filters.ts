// Filtri combinabili sui sentieri (tutti in AND) e modulo per impostarli.

import { CATEGORIES, CATEGORY_ORDER } from './icons'
import { catIcon, h } from './panel'
import type { PoiCategory, Trail } from './types'

export type Volo = 'qualsiasi' | 'verde' | 'tutto'
export type KmByColor = { verde: number; giallo: number; rosso: number }

export interface FilterState {
  volo: Volo
  verdeKm: number // per volo = 'verde': almeno questi km di tratti verdi
  vicino: Set<PoiCategory> // deve avere TUTTE le categorie scelte
  difficolta: Set<string> // T, E, EE, EEA (vuoto = tutte)
  lungMin: number | null // km
  lungMax: number | null
  dislMax: number | null // m di dislivello positivo
  quotaMin: number | null // quota massima raggiunta, almeno (m)
  gruppo: string // '' = tutti
}

export const defaultFilters = (): FilterState => ({
  volo: 'qualsiasi',
  verdeKm: 1,
  vicino: new Set(),
  difficolta: new Set(),
  lungMin: null,
  lungMax: null,
  dislMax: null,
  quotaMin: null,
  gruppo: '',
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
    Number(!!f.gruppo)
  )
}

const diffGroup = (d: string | null) => (d?.startsWith('EEA') ? 'EEA' : (d ?? ''))

export function matches(t: Trail, km: KmByColor, f: FilterState): boolean {
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
  return true
}

// ---------------------------------------------------------------- modulo

function numberInput(value: number | null, placeholder: string, onInput: (v: number | null) => void): HTMLInputElement {
  const el = h('input', { type: 'number', inputmode: 'decimal', min: '0', placeholder }) as HTMLInputElement
  if (value != null) el.value = String(value)
  el.addEventListener('input', () => onInput(el.value === '' ? null : Number(el.value)))
  return el
}

function checkbox(label: Node | string, checked: boolean, onChange: (v: boolean) => void, icon?: Node): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  return h('label', { class: 'check' }, input, icon ?? null, label)
}

/** Disegna il modulo; ogni modifica chiama onChange (lo stato è modificato sul posto). */
export function renderForm(f: FilterState, gruppi: string[], onChange: () => void): HTMLElement {
  const form = h('form', { class: 'filters-form' })
  form.addEventListener('submit', (e) => e.preventDefault())

  // Volo
  const voloBox = h('fieldset', {}, h('legend', {}, 'Volo (nella data scelta)'))
  const kmInput = numberInput(f.verdeKm, 'km', (v) => {
    f.verdeKm = v ?? 0
    onChange()
  })
  kmInput.classList.add('short')
  const options: [Volo, Node | string][] = [
    ['qualsiasi', 'Qualsiasi'],
    ['verde', h('span', {}, 'Almeno ', kmInput, ' km di tratti verdi')],
    ['tutto', 'Tutto volabile (nessun tratto rosso)'],
  ]
  for (const [value, label] of options) {
    const r = h('input', { type: 'radio', name: 'volo', value }) as HTMLInputElement
    r.checked = f.volo === value
    r.addEventListener('change', () => {
      f.volo = value
      onChange()
    })
    voloBox.append(h('label', { class: 'check' }, r, label))
  }

  // Vicino a
  const vicinoBox = h('fieldset', {}, h('legend', {}, 'Passa vicino a (tutti quelli scelti)'))
  const grid = h('div', { class: 'checkgrid' })
  for (const c of CATEGORY_ORDER) {
    grid.append(
      checkbox(CATEGORIES[c].label, f.vicino.has(c), (on) => {
        if (on) f.vicino.add(c)
        else f.vicino.delete(c)
        onChange()
      }, catIcon(c, 16)),
    )
  }
  vicinoBox.append(grid)

  // Difficoltà
  const diffBox = h('fieldset', {}, h('legend', {}, 'Difficoltà'))
  const dgrid = h('div', { class: 'checkgrid' })
  for (const [d, label] of [['T', 'T turistico'], ['E', 'E escursionistico'], ['EE', 'EE esperti'], ['EEA', 'EEA attrezzato']]) {
    dgrid.append(
      checkbox(label, f.difficolta.has(d), (on) => {
        if (on) f.difficolta.add(d)
        else f.difficolta.delete(d)
        onChange()
      }),
    )
  }
  diffBox.append(dgrid)

  // Numeri
  const numBox = h(
    'fieldset',
    {},
    h('legend', {}, 'Percorso'),
    h(
      'div',
      { class: 'numgrid' },
      h('label', {}, 'Lunghezza da (km)', numberInput(f.lungMin, 'min', (v) => ((f.lungMin = v), onChange()))),
      h('label', {}, 'a (km)', numberInput(f.lungMax, 'max', (v) => ((f.lungMax = v), onChange()))),
      h('label', {}, 'Dislivello + max (m)', numberInput(f.dislMax, 'es. 800', (v) => ((f.dislMax = v), onChange()))),
      h('label', {}, 'Arriva almeno a (m)', numberInput(f.quotaMin, 'es. 2000', (v) => ((f.quotaMin = v), onChange()))),
    ),
  )

  // Gruppo montuoso
  const select = h('select', {}) as HTMLSelectElement
  select.append(h('option', { value: '' }, 'Tutti'))
  for (const g of gruppi) select.append(h('option', { value: g }, g))
  select.value = f.gruppo
  select.addEventListener('change', () => {
    f.gruppo = select.value
    onChange()
  })
  const gruppoBox = h('fieldset', {}, h('legend', {}, 'Gruppo montuoso'), select)

  form.append(voloBox, vicinoBox, diffBox, numBox, gruppoBox)
  return form
}
