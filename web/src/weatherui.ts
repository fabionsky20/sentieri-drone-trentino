// Meteo e indice di volabilità nella scheda del sentiero, e il bollino nelle liste.

import { PROFILE_LABEL, type DroneProfile } from './flyconfig'
import { sentence, type DaySummary } from './flyindex'
import { h } from './panel'
import { icon } from './ui'
import type { PointWx } from './weather'

export type WxStatus = 'ok' | 'passato' | 'lontano' | 'caricamento' | 'errore' | 'pausa'

/** Fascia di colore dell'indice (gli stessi tre stati del volo). */
export const volClass = (i: number) => (i >= 60 ? 'v-good' : i >= 30 ? 'v-mid' : 'v-bad')

/** Bollino "VOL 72" per card e liste (testo scuro, colore solo nel pallino). */
export function volChip(i: number | null | undefined): HTMLElement | null {
  if (i == null) return null
  return h('span', { class: `volchip ${volClass(i)}`, title: `Indice di volabilità del giorno: ${i}/100` }, h('i', { class: 'dot' }), h('span', { class: 'mono' }, `VOL ${i}`))
}

export interface WxPointView {
  label: string // "Punto più alto", "Centro del sentiero"
  ele: number
  wx: PointWx
}

export interface WeatherCtx {
  day: string
  status: WxStatus
  summary: DaySummary | null
  points: WxPointView[]
  hour: number | null // ora scelta (null = la migliore)
  onHour: (h: number) => void
  drones: { id: string; label: string }[] // dall'hangar; id '' = generico
  droneId: string
  onDrone: (id: string) => void
  profile: DroneProfile
}

const fmt = (v: number | null, unit: string, d = 0) => (v == null ? '–' : `${v.toLocaleString('it-IT', { maximumFractionDigits: d })}${unit}`)

function strip(s: DaySummary, sel: number, onHour: (h: number) => void): HTMLElement {
  const wrap = h('div', { class: 'wxstrip', role: 'group', 'aria-label': 'Indice di volabilità ora per ora' })
  for (const x of s.hours) {
    const cls = x.night ? 'night' : volClass(x.index)
    const b = h(
      'button',
      {
        type: 'button',
        class: `wxcell ${cls}${x.h === sel ? ' sel' : ''}`,
        'aria-pressed': String(x.h === sel),
        title: `${x.h}:00 · indice ${x.index}${x.worst ? ` · ${x.worst.why}` : ''}`,
        'aria-label': `Ore ${x.h}: indice ${x.index}`,
      },
      h('span', { class: 'bar', style: `height:${Math.max(x.night ? 8 : 10, x.index)}%` }),
    )
    b.addEventListener('click', () => onHour(x.h))
    wrap.append(b)
  }
  const ticks = h('div', { class: 'wxticks mono', 'aria-hidden': 'true' }, ...[0, 3, 6, 9, 12, 15, 18, 21].map((t) => h('span', { style: `left:${((t + 0.5) / 24) * 100}%` }, String(t))))
  return h('div', { class: 'wxstripbox' }, wrap, ticks)
}

function detailTable(points: WxPointView[], hr: number, kp: number | null): HTMLElement {
  const rows: [string, (w: PointWx) => string][] = [
    ['Temperatura', (p) => fmt(p.hours[hr].temp, ' °C')],
    ['Pioggia', (p) => `${fmt(p.hours[hr].pp, '%')} · ${fmt(p.hours[hr].mm, ' mm', 1)}`],
    ['Vento a 10 m', (p) => fmt(p.hours[hr].w10, ' km/h')],
    ['Vento a 80 m', (p) => fmt(p.hours[hr].w80, ' km/h')],
    ['Vento a 120 m', (p) => fmt(p.hours[hr].w120, ' km/h')],
    ['Raffiche', (p) => fmt(p.hours[hr].g10, ' km/h')],
    ['Nuvole basse', (p) => fmt(p.hours[hr].cl, '%')],
    ['Visibilità', (p) => (p.hours[hr].vis == null ? '–' : `${fmt(p.hours[hr].vis! / 1000, ' km', 1)}`)],
  ]
  const head = h('tr', {}, h('th', { scope: 'col' }, `Ore ${hr}:00`), ...points.map((p) => h('th', { scope: 'col' }, h('span', {}, p.label), h('span', { class: 'mono' }, `${p.ele.toLocaleString('it-IT')} m`))))
  const body = rows.map(([k, f]) => h('tr', {}, h('th', { scope: 'row' }, k), ...points.map((p) => h('td', { class: 'mono' }, f(p.wx)))))
  const kpRow = h('tr', {}, h('th', { scope: 'row' }, 'Kp (NOAA)'), h('td', { class: 'mono', colspan: String(points.length) }, kp == null ? 'non disponibile' : kp.toLocaleString('it-IT', { maximumFractionDigits: 1 })))
  return h('table', { class: 'wxtable' }, h('thead', {}, head), h('tbody', {}, ...body, kpRow))
}

export function renderWeather(c: WeatherCtx): HTMLElement {
  const sec = h('div', { class: 'wx' })
  const dateLbl = c.day.split('-').reverse().join('.')
  sec.append(h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, 'Meteo e volabilità'), h('span', { class: 'mono' }, dateLbl)))
  const msg = (t: string) => sec.append(h('p', { class: 'muted small' }, t))
  if (c.status === 'passato') {
    msg('Nessuna previsione per una data passata.')
    return sec
  }
  if (c.status === 'lontano') {
    msg('Nessuna previsione: Open-Meteo arriva a circa 15 giorni da oggi.')
    return sec
  }
  if (c.status === 'pausa') {
    msg('Open-Meteo chiede di rallentare (troppe richieste): riprovo da solo tra un minuto.')
    return sec
  }
  if (c.status === 'caricamento' || (!c.summary && c.status === 'ok')) {
    msg('Carico la previsione…')
    return sec
  }
  if (c.status === 'errore' || !c.summary || !c.points.length) {
    msg('Previsione non disponibile in questo momento (connessione?).')
    return sec
  }
  const s = c.summary
  const hr = c.hour ?? s.best
  const sel = s.hours.find((x) => x.h === hr) ?? s.hours[s.best]
  sec.append(
    h(
      'div',
      { class: `wxhead ${volClass(s.index)}` },
      h('span', { class: 'wxindex mono' }, String(s.index)),
      h('div', {}, h('p', { class: 'wxlevel' }, sentence(s)), h('p', { class: 'small muted' }, `Indice di volabilità 0–100 · soglie per ${PROFILE_LABEL[c.profile]}`)),
    ),
    strip(s, hr, c.onHour),
  )
  if (sel && !sel.night && sel.index < 60 && sel.worst) sec.append(h('p', { class: 'small wxwhy' }, icon('shield', 14), `Alle ${hr}:00 pesa: ${sel.worst.why}`))
  if (sel?.night) sec.append(h('p', { class: 'small muted' }, `Alle ${hr}:00 è buio: non si vola.`))
  sec.append(detailTable(c.points, hr, sel?.kp ?? null))
  const p0 = c.points[0].wx
  sec.append(h('p', { class: 'small mono wxsun' }, `Alba ${p0.sunrise ?? '–'} · Tramonto ${p0.sunset ?? '–'}`))
  if (c.drones.length > 1) {
    const select = h('select', { 'aria-label': 'Drone per le soglie del vento' }, ...c.drones.map((d) => h('option', { value: d.id }, d.label))) as HTMLSelectElement
    select.value = c.droneId
    select.addEventListener('change', () => c.onDrone(select.value))
    sec.append(h('label', { class: 'field wxdrone' }, h('span', { class: 'field-k' }, 'Drone'), select))
  }
  sec.append(h('p', { class: 'hint' }, 'Previsione Open-Meteo alla quota dei punti del sentiero; Kp da NOAA SWPC. È un aiuto alla pianificazione: sul posto decide il pilota.'))
  return sec
}
