// Interfaccia dei percorsi personalizzati: barra della modalità "Crea percorso" e sezione
// "Percorso" nella scheda (tappe, tratti usati, buchi, pezzi fino alle mete fuori sentiero).

import { h } from './panel'
import type { RoutePlan } from './routes'
import { icon } from './ui'

export type RouteStep = 'start' | 'end' | 'via' | 'calc' | 'done'

export interface RouteBarCtx {
  step: RouteStep
  startLabel: string | null
  viaLabel?: string // "tra Partenza e Lago X"
  onCancel: () => void
  onNew: () => void
  onAddVia?: () => void // solo a percorso pronto
}

/** Barra in alto sulla mappa: cosa toccare adesso. */
export function renderRouteBar(c: RouteBarCtx): HTMLElement {
  const text: Record<RouteStep, string> = {
    start: 'Tocca un sentiero per la PARTENZA (anche a metà)',
    end: `Partenza: ${c.startLabel ?? '—'}. Ora tocca l'ARRIVO: un sentiero o una meta (lago, malga, vetta, rifugio…)`,
    via: `Tocca un sentiero o una meta per il PUNTO INTERMEDIO${c.viaLabel ? ` (${c.viaLabel})` : ''}`,
    calc: 'Calcolo il percorso…',
    done: 'Percorso pronto · trascina A, B e i punti per spostarli',
  }
  const cancel = h('button', { type: 'button', class: 'btn-text' }, c.step === 'done' ? 'CHIUDI' : c.step === 'via' ? 'FATTO' : 'ANNULLA')
  cancel.addEventListener('click', c.onCancel)
  const parts: HTMLElement[] = [h('span', { class: 'route-step' }, icon('route', 18), h('span', {}, text[c.step])), cancel]
  if (c.step === 'done') {
    const again = h('button', { type: 'button', class: 'btn-text' }, 'NUOVO')
    again.addEventListener('click', c.onNew)
    parts.splice(1, 0, again)
    if (c.onAddVia) {
      const via = h('button', { type: 'button', class: 'btn-text route-addvia' }, icon('plus', 16), 'PUNTO')
      via.setAttribute('aria-label', 'Aggiungi un punto intermedio')
      via.addEventListener('click', c.onAddVia)
      parts.splice(1, 0, via)
    }
  }
  return h('div', { class: 'route-bar', role: 'status', 'aria-live': 'polite' }, ...parts)
}

const km = (m: number) => (m / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const meters = (m: number) => Math.round(m).toLocaleString('it-IT')

/** Comandi sulle tappe (riordino, inserimento, eliminazione): ognuno ricalcola subito. */
export interface StopsCtl {
  labels: string[] // nome di ogni tappa, in ordine
  inserting: number | null // indice dove sta per entrare un nuovo punto (modalità "via")
  onMove: (i: number, dir: -1 | 1) => void
  onRemove: (i: number) => void
  onInsert: (i: number) => void // nuovo punto in posizione i (tra i-1 e i)
}

function stopsList(c: StopsCtl): HTMLElement {
  const n = c.labels.length
  const ol = h('ol', { class: 'routestops' })
  const btn = (ic: Parameters<typeof icon>[0], label: string, on: () => void, disabled = false) => {
    const b = h('button', { type: 'button', class: 'iconbtn small', 'aria-label': label, title: label }, icon(ic, 18)) as HTMLButtonElement
    b.disabled = disabled
    b.addEventListener('click', on)
    return b
  }
  c.labels.forEach((name, i) => {
    if (i > 0) {
      const ins = h('button', { type: 'button', class: 'btn-text route-insert', 'aria-pressed': String(c.inserting === i) }, icon('plus', 14), c.inserting === i ? 'TOCCA LA MAPPA…' : 'INSERISCI QUI')
      ins.setAttribute('aria-label', `Inserisci un punto tra ${c.labels[i - 1]} e ${name}`)
      ins.addEventListener('click', () => c.onInsert(i))
      ol.append(h('li', { class: 'route-insert-row' }, ins))
    }
    const tag = i === 0 ? 'A' : i === n - 1 ? 'B' : String(i)
    ol.append(
      h(
        'li',
        { class: 'routestop' },
        h('span', { class: `route-pin inline ${i === 0 ? 'a' : i === n - 1 ? 'b' : 'v'}`, 'aria-hidden': 'true' }, tag),
        h('span', { class: 'routestop-name' }, h('span', { class: 'field-k' }, i === 0 ? 'Partenza' : i === n - 1 ? 'Arrivo' : `Punto ${i}`), name),
        btn('chevronUp', `Sposta ${name} prima`, () => c.onMove(i, -1), i === 0),
        btn('chevronDown', `Sposta ${name} dopo`, () => c.onMove(i, 1), i === n - 1),
        btn('trash', `Elimina ${name}`, () => c.onRemove(i), n <= 2),
      ),
    )
  })
  return ol
}

/** Sezione della scheda: "Percorso personalizzato" con tappe e tratti SAT usati. */
export function renderRouteInfo(plan: RoutePlan, piecesText: string, extra?: HTMLElement | null, stops?: StopsCtl): HTMLElement {
  const sec = h('div', { class: 'routeinfo' })
  sec.append(h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, 'Percorso personalizzato')))
  if (stops) {
    sec.append(h('p', { class: 'small routestops-line' }, stops.labels.join(' → ')))
    sec.append(stopsList(stops))
  }
  sec.append(h('p', { class: 'small routepieces' }, piecesText || '—'))
  const gaps = plan.stages.flatMap((s) => (s.gap ? [s.gap.meters] : []))
  if (gaps.length) {
    const tot = gaps.reduce((a, b) => a + b, 0)
    const what = gaps.length === 1 ? `un buco di ${km(tot)} km` : `${gaps.length} buchi, in tutto ${km(tot)} km`
    sec.append(h('p', { class: 'small routegap' }, h('i', { class: 'gapmark', 'aria-hidden': 'true' }), `Non collegato da sentieri SAT: ${what} in linea d'aria (su strade o fuori sentiero). Km e dislivello contano solo i tratti su sentiero.`))
  }
  plan.stages.forEach((s, i) => {
    const stop = plan.stops[i + 1]
    if (!s.spur || !stop.poi) return
    const last = i === plan.stages.length - 1
    const text = last
      ? `Ultimo pezzo fuori sentiero fino a ${stop.poi.nome}: ${meters(s.spur.meters)} m in linea d'aria.`
      : `Deviazione fuori sentiero fino a ${stop.poi.nome}: ${meters(s.spur.meters)} m in linea d'aria (andata e ritorno, non contati nei km).`
    sec.append(h('p', { class: 'small' }, h('i', { class: 'tailmark', 'aria-hidden': 'true' }), text))
  })
  sec.append(h('p', { class: 'hint' }, 'Il più breve sui sentieri SAT tra una tappa e la successiva (non tiene conto di difficoltà e dislivello). Tempi stimati: 4 km/h in piano, 400 m/h in salita.'))
  if (extra) sec.append(extra)
  return sec
}
