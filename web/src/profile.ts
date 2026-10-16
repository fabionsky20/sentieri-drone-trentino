// Profilo altimetrico su canvas, colorato come i tratti (verde/giallo/rosso nella data scelta),
// con i POI lungo il percorso e lettura al passaggio del dito o del mouse.

import { CATEGORIES } from './icons'
import { kmNum } from './panel'
import type { PoiCategory, Profile } from './types'

export interface ProfileInput {
  profile: Profile
  ranges: { from: number; to: number; color: string }[] // in metri dall'inizio
  pois: { km: number; cat: PoiCategory }[]
  onHover: (m: number | null) => void
}

const PAD = { left: 40, right: 8, top: 14, bottom: 20 }
const HEIGHT = 150

export function renderProfile(input: ProfileInput): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'profile'
  const canvas = document.createElement('canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Profilo altimetrico del sentiero')
  const cursor = document.createElement('div')
  cursor.className = 'profile-cursor'
  cursor.hidden = true
  const readout = document.createElement('div')
  readout.className = 'profile-readout'
  readout.textContent = 'Tocca il profilo per vedere il punto sulla mappa'
  wrap.append(canvas, cursor, readout)

  const { profile } = input
  const xs = profile.q.map((_, i) => Math.min(i * profile.passo, profile.lung))
  const qMin = Math.min(...profile.q)
  const qMax = Math.max(...profile.q)
  const span = Math.max(qMax - qMin, 50)
  const yLo = Math.floor((qMin - span * 0.08) / 10) * 10
  const yHi = Math.ceil((qMax + span * 0.08) / 10) * 10

  let width = 0
  const sx = (m: number) => PAD.left + (m / profile.lung) * (width - PAD.left - PAD.right)
  const sy = (q: number) => PAD.top + (1 - (q - yLo) / (yHi - yLo)) * (HEIGHT - PAD.top - PAD.bottom)

  function draw(): void {
    width = wrap.clientWidth
    if (!width) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = HEIGHT * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${HEIGHT}px`
    const c = canvas.getContext('2d')!
    c.scale(dpr, dpr)
    c.clearRect(0, 0, width, HEIGHT)

    // Griglia e quote sull'asse verticale.
    c.font = "500 11px 'IBM Plex Mono', ui-monospace, monospace"
    c.fillStyle = '#4F5C59'
    c.strokeStyle = '#D3D9D3'
    c.lineWidth = 1
    c.textAlign = 'right'
    c.textBaseline = 'middle'
    for (const q of niceTicks(yLo, yHi, 4)) {
      const y = sy(q)
      c.beginPath()
      c.moveTo(PAD.left, y)
      c.lineTo(width - PAD.right, y)
      c.stroke()
      c.fillText(`${q}`, PAD.left - 4, y)
    }
    // Km sull'asse orizzontale.
    c.textAlign = 'center'
    c.textBaseline = 'top'
    for (const k of niceTicks(0, profile.lung / 1000, 5)) c.fillText(kmNum(k), sx(k * 1000), HEIGHT - PAD.bottom + 4)

    // Area e linea, ritagliate tratto per tratto con il colore del tratto.
    const path = new Path2D()
    xs.forEach((x, i) => (i ? path.lineTo(sx(x), sy(profile.q[i])) : path.moveTo(sx(x), sy(profile.q[i]))))
    const area = new Path2D(path)
    area.lineTo(sx(profile.lung), HEIGHT - PAD.bottom)
    area.lineTo(sx(0), HEIGHT - PAD.bottom)
    area.closePath()
    for (const r of input.ranges) {
      c.save()
      c.beginPath()
      c.rect(sx(r.from), 0, Math.max(1, sx(r.to) - sx(r.from)), HEIGHT)
      c.clip()
      c.globalAlpha = 0.3
      c.fillStyle = r.color
      c.fill(area)
      c.globalAlpha = 1
      c.strokeStyle = r.color
      c.lineWidth = 2.2
      c.lineJoin = 'round'
      c.stroke(path)
      c.restore()
    }

    // POI lungo il percorso: pallini colorati in alto.
    for (const p of input.pois) {
      const x = sx(p.km * 1000)
      c.fillStyle = CATEGORIES[p.cat].color
      c.strokeStyle = '#fff'
      c.lineWidth = 1.5
      c.beginPath()
      c.arc(x, PAD.top - 6, 4.5, 0, Math.PI * 2)
      c.fill()
      c.stroke()
    }
  }

  function hover(clientX: number): void {
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const m = Math.max(0, Math.min(profile.lung, ((x - PAD.left) / (width - PAD.left - PAD.right)) * profile.lung))
    const i = Math.min(profile.q.length - 1, Math.round(m / profile.passo))
    cursor.hidden = false
    cursor.style.left = `${sx(m)}px`
    readout.textContent = `km ${kmNum(m / 1000)} · ${profile.q[i]} m`
    input.onHover(m)
  }
  canvas.addEventListener('pointermove', (e) => hover(e.clientX))
  canvas.addEventListener('pointerdown', (e) => hover(e.clientX))
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') {
      cursor.hidden = true
      input.onHover(null)
    }
  })

  new ResizeObserver(draw).observe(wrap)
  return wrap
}

/** Valori "tondi" per gli assi (1, 2, 5 × 10^n). */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100)
  return out
}
