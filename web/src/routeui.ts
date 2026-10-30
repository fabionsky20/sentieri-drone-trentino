// Interfaccia dei percorsi personalizzati: barra della modalità "Crea percorso" e sezione
// "Percorso" nella scheda (tratti usati, buco, ultimo pezzo fino alla meta).

import { h } from './panel'
import type { RoutePlan } from './routes'
import { icon } from './ui'

export type RouteStep = 'start' | 'end' | 'calc' | 'done'

export interface RouteBarCtx {
  step: RouteStep
  startLabel: string | null
  onCancel: () => void
  onNew: () => void
}

/** Barra in alto sulla mappa: cosa toccare adesso. */
export function renderRouteBar(c: RouteBarCtx): HTMLElement {
  const text: Record<RouteStep, string> = {
    start: 'Tocca un sentiero per la PARTENZA (anche a metà)',
    end: `Partenza: ${c.startLabel ?? '—'}. Ora tocca l'ARRIVO: un sentiero o una meta (lago, malga, vetta, rifugio…)`,
    calc: 'Calcolo il percorso…',
    done: 'Percorso pronto',
  }
  const cancel = h('button', { type: 'button', class: 'btn-text' }, c.step === 'done' ? 'CHIUDI' : 'ANNULLA')
  cancel.addEventListener('click', c.onCancel)
  const parts: HTMLElement[] = [h('span', { class: 'route-step' }, icon('route', 18), h('span', {}, text[c.step])), cancel]
  if (c.step === 'done') {
    const again = h('button', { type: 'button', class: 'btn-text' }, 'NUOVO')
    again.addEventListener('click', c.onNew)
    parts.splice(1, 0, again)
  }
  return h('div', { class: 'route-bar', role: 'status', 'aria-live': 'polite' }, ...parts)
}

const km = (m: number) => (m / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Sezione della scheda: "Percorso personalizzato" con i tratti SAT usati. */
export function renderRouteInfo(plan: RoutePlan, piecesText: string, extra?: HTMLElement | null): HTMLElement {
  const sec = h('div', { class: 'routeinfo' })
  sec.append(h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, 'Percorso personalizzato')))
  sec.append(h('p', { class: 'small routepieces' }, piecesText || '—'))
  if (plan.gap) {
    sec.append(h('p', { class: 'small routegap' }, h('i', { class: 'gapmark', 'aria-hidden': 'true' }), `Non collegato da sentieri SAT: un buco di ${km(plan.gap.meters)} km in linea d'aria (su strade o fuori sentiero). Km e dislivello contano solo i tratti su sentiero.`))
  }
  if (plan.tail && plan.end.poi) {
    sec.append(h('p', { class: 'small' }, h('i', { class: 'tailmark', 'aria-hidden': 'true' }), `Ultimo pezzo fuori sentiero fino a ${plan.end.poi.nome}: ${Math.round(plan.tail.meters).toLocaleString('it-IT')} m in linea d'aria.`))
  }
  sec.append(h('p', { class: 'hint' }, 'Il più breve sui sentieri SAT (non tiene conto di difficoltà e dislivello). Tempi stimati: 4 km/h in piano, 400 m/h in salita.'))
  if (extra) sec.append(extra)
  return sec
}
