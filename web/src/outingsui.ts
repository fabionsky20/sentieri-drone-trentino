// Interfaccia di "segna come fatto", note personali e statistiche private.
// REGOLA FISSA: nessuna quota di volo. Si chiede solo "avevo il drone?"; la quota più alta
// delle statistiche è quella del sentiero, raggiunta a piedi.

import { segmented, switchRow } from './filters'
import { CATEGORIES } from './icons'
import { COLLECT, computeStats, coverage, matchTrail, outingDplus, outingKm, parseGpx, proposeFromGpx, yearsOf, type GpxTrack, type Outing, type OutingInput, type RouteChoice, type Stats } from './outings'
import { h } from './panel'
import { sliceLine, type TrailLine } from './trailgeom'
import type { PoiProps, Profile, Trail } from './types'
import { icon } from './ui'

export interface Person {
  uid: string
  nome: string
}

export interface OutingActions {
  login: () => void
  saveOuting: (o: OutingInput, id?: string) => Promise<void>
  deleteOuting: (id: string) => Promise<void>
  saveNote: (trail: string, testo: string) => Promise<void>
  toast: (msg: string) => void
}

const it = (n: number, d = 0) => n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d })
const dot = (iso: string) => iso.split('-').reverse().join('.')
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const MESI = ['G', 'F', 'M', 'A', 'M', 'G', 'L', 'A', 'S', 'O', 'N', 'D']
const MESI_LUNGHI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']

function btn(cls: string, content: (Node | string)[], onClick: (b: HTMLButtonElement) => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, ...attrs }, ...content) as HTMLButtonElement
  b.addEventListener('click', () => onClick(b))
  return b
}

async function busy(b: HTMLButtonElement, fn: () => Promise<void>, a: { toast: (m: string) => void }): Promise<void> {
  b.disabled = true
  try {
    await fn()
  } catch (e) {
    a.toast(`Non riuscito: ${(e as Error).message}`)
  } finally {
    b.disabled = false
  }
}

// ---------------------------------------------------------------- modulo "segna come fatto"

/** Stato di un modulo aperto: resta tra un ridisegno e l'altro della scheda. */
export interface OutingDraft {
  id: string | null // null = nuova uscita
  data: string
  con: Person[] // uid vuoto = nome scritto a mano
  commento: string
  drone: boolean
  gpx: { km: number; dplus: number | null; share: number | null } | null
  parziale: boolean // "fin dove sono arrivato"
  partenza: 'inizio' | 'fine'
  finoM: number | null // metri fatti dal capo di partenza
  ar: boolean // andata e ritorno
}

export function newDraft(prefill?: Partial<OutingDraft>): OutingDraft {
  return { id: null, data: todayIso(), con: [], commento: '', drone: false, gpx: null, parziale: false, partenza: 'inizio', finoM: null, ar: false, ...prefill }
}

/** Applica al modulo la parte di sentiero proposta da una traccia GPX. */
export function applyRoute(d: OutingDraft, r: RouteChoice): void {
  d.parziale = r.parziale
  d.partenza = r.partenza
  d.finoM = r.parziale ? r.finoM : null
  d.ar = r.ar
}

export function draftFrom(o: Outing): OutingDraft {
  return {
    id: o.id,
    data: o.data,
    con: o.con.map((nome, i) => ({ uid: o.conUid[i] ?? '', nome })),
    commento: o.commento ?? '',
    drone: o.drone,
    gpx: o.gpxKm != null ? { km: o.gpxKm, dplus: o.gpxDplus, share: null } : null,
    parziale: o.parziale,
    partenza: o.partenza,
    finoM: o.finoM,
    ar: o.ar,
  }
}

/** Cosa serve al modulo per la parte fatta: quote dal profilo e anteprima su mappa e profilo. */
export interface RouteHelpers {
  pois: Map<string, PoiProps>
  profile: () => Profile | null // null finché il profilo non è caricato
  /** Parte fatta (m dall'inizio del sentiero) e punto di arrivo; null = niente anteprima. */
  preview: (p: { from: number; to: number; at: number } | null) => void
}

const endName = (t: Trail, which: 'inizio' | 'fine') => {
  const n = which === 'inizio' ? t.loc_inizio : t.loc_fine
  return n ? `da ${n}` : which === 'inizio' ? 'dall’inizio' : 'dalla fine'
}

/** Percorso completo oppure "fin dove sono arrivato" (capo di partenza + punto di arrivo). */
function routeSection(trail: Trail, L: number, draft: OutingDraft, rh: RouteHelpers): HTMLElement {
  const box = h('div', { class: 'routebox' })
  const draw = () => {
    if (!draft.parziale) {
      rh.preview(null)
      box.replaceChildren(mode)
      return
    }
    draft.finoM ??= Math.round(L / 2)
    const start = segmented<'inizio' | 'fine'>(
      [
        ['inizio', endName(trail, 'inizio')],
        ['fine', endName(trail, 'fine')],
      ],
      draft.partenza,
      (v) => {
        draft.partenza = v
        draw()
      },
      'small',
    )
    const slider = h('input', { type: 'range', min: '0', max: String(Math.round(L)), step: '10', 'aria-label': 'Punto di arrivo lungo il sentiero', class: 'routeslider' }) as HTMLInputElement
    const kmIn = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Km percorsi' }) as HTMLInputElement
    const readout = h('p', { class: 'mono small routeread' })
    const update = (from?: 'slider' | 'km') => {
      const f = Math.max(0, Math.min(L, draft.finoM ?? 0))
      if (from !== 'slider') slider.value = String(Math.round(f))
      if (from !== 'km') kmIn.value = it(f / 1000, 1)
      const at = draft.partenza === 'inizio' ? f : L - f
      const p = rh.profile()
      const q = p ? p.q[Math.max(0, Math.min(p.q.length - 1, Math.round(((at / (L || 1)) * p.lung) / p.passo)))] : null
      readout.textContent = `${it(f / 1000, 1)} km di ${it(L / 1000, 1)}${q != null ? ` · arrivo a ${it(q)} m` : ''}`
      rh.preview({ from: Math.min(at, draft.partenza === 'inizio' ? 0 : L), to: Math.max(at, draft.partenza === 'inizio' ? 0 : L), at })
      for (const c of shortcuts.querySelectorAll<HTMLElement>('button')) c.setAttribute('aria-pressed', String(Math.abs(Number(c.dataset.m) - f) < 15))
    }
    slider.addEventListener('input', () => {
      draft.finoM = Number(slider.value)
      update('slider')
    })
    kmIn.addEventListener('input', () => {
      const v = Number(kmIn.value.trim().replace(',', '.'))
      if (!kmIn.value.trim() || !Number.isFinite(v)) return
      draft.finoM = Math.max(0, Math.min(L, v * 1000))
      update('km')
    })
    kmIn.addEventListener('change', () => update())
    // Scorciatoie: i POI lungo il percorso, in ordine dal capo di partenza.
    const shortcuts = h('div', { class: 'chipgrid' })
    const stops = trail.poi
      .map((x) => ({ info: rh.pois.get(x.id), m: draft.partenza === 'inizio' ? x.km * 1000 : L - x.km * 1000 }))
      .filter((x) => x.info && x.m > 50 && x.m < L - 20)
      .sort((x, y) => x.m - y.m)
    for (const s of stops) {
      const b = btn('chiptoggle', [h('i', { class: 'dot', style: `background:${CATEGORIES[s.info!.categoria].color}` }), `fino a ${s.info!.nome}`], () => {
        draft.finoM = Math.round(s.m)
        update()
      }, { 'aria-pressed': 'false', 'data-m': String(Math.round(s.m)) })
      shortcuts.append(b)
    }
    box.replaceChildren(
      mode,
      h('div', { class: 'field', role: 'group', 'aria-label': 'Capo di partenza' }, h('span', { class: 'field-k' }, 'Partito'), start),
      h(
        'div',
        { class: 'field', role: 'group', 'aria-label': 'Fin dove sono arrivato' },
        h('span', { class: 'field-k' }, 'Arrivato fino a'),
        h('div', { class: 'routeslide' }, icon('user', 18), slider),
        h('div', { class: 'routekm' }, readout, h('label', { class: 'kmfield' }, kmIn, h('span', { class: 'mono small' }, 'km'))),
        stops.length ? shortcuts : null,
      ),
    )
    update()
  }
  const mode = segmented<'completo' | 'parziale'>(
    [
      ['completo', 'Percorso completo'],
      ['parziale', 'Fin dove sono arrivato'],
    ],
    draft.parziale ? 'parziale' : 'completo',
    (v) => {
      draft.parziale = v === 'parziale'
      draw()
    },
  )
  draw()
  return box
}

/** Riassunto della traccia GPX letta. */
export function gpxDraft(track: GpxTrack, share: number | null): OutingDraft['gpx'] {
  return { km: track.km, dplus: track.dplus, share }
}

function outingForm(trail: Trail, line: TrailLine | undefined, draft: OutingDraft, friends: Person[], a: OutingActions, rh: RouteHelpers, done: () => void): HTMLElement {
  const L = line?.length ?? trail.lunghezza_m ?? 0
  const form = h('form', { class: 'outingform', 'aria-label': 'Segna come fatto' }) as HTMLFormElement
  form.addEventListener('submit', (e) => e.preventDefault())

  const date = h('input', { type: 'date', required: '', max: todayIso(), min: '1980-01-01', 'aria-label': 'Data dell’uscita' }) as HTMLInputElement
  date.value = draft.data
  date.addEventListener('change', () => (draft.data = date.value))

  // Con chi: amici dell'app (pulsanti) + nomi scritti a mano.
  const chosen = h('div', { class: 'chipgrid' })
  const drawChosen = () => {
    chosen.replaceChildren(
      ...draft.con
        .filter((p) => !p.uid)
        .map((p) =>
          btn('chiptoggle', [p.nome, icon('close', 14)], () => {
            draft.con = draft.con.filter((x) => x !== p)
            drawChosen()
          }, { 'aria-pressed': 'true', 'aria-label': `Togli ${p.nome}` }),
        ),
    )
  }
  const friendRow = h('div', { class: 'chipgrid' })
  for (const f of friends) {
    const on = draft.con.some((p) => p.uid === f.uid)
    const b = btn('chiptoggle', [f.nome], () => {
      const now = b.getAttribute('aria-pressed') !== 'true'
      b.setAttribute('aria-pressed', String(now))
      draft.con = now ? [...draft.con, { ...f }] : draft.con.filter((p) => p.uid !== f.uid)
    }, { 'aria-pressed': String(on) })
    friendRow.append(b)
  }
  const nameIn = h('input', { type: 'text', maxlength: '60', placeholder: 'Scrivi un nome', 'aria-label': 'Aggiungi un nome', autocomplete: 'off' }) as HTMLInputElement
  const addName = () => {
    const n = nameIn.value.trim()
    if (!n || draft.con.length >= 20) return
    draft.con = [...draft.con, { uid: '', nome: n }]
    nameIn.value = ''
    drawChosen()
  }
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addName()
    }
  })
  drawChosen()

  const comment = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Com’è andata? (facoltativo)', 'aria-label': 'Commento' }) as HTMLTextAreaElement
  comment.value = draft.commento
  comment.addEventListener('input', () => (draft.commento = comment.value))

  const drone = switchRow('Avevo il drone', draft.drone, (on) => (draft.drone = on))
  const route = h('div', {}, routeSection(trail, L, draft, rh))
  const redrawRoute = () => route.replaceChildren(routeSection(trail, L, draft, rh))
  const ar = h('div', {}, switchRow('Andata e ritorno', draft.ar, (on) => (draft.ar = on)))
  const redrawAr = () => ar.replaceChildren(switchRow('Andata e ritorno', draft.ar, (on) => (draft.ar = on)))

  // GPX facoltativo: solo km e dislivello reali dell'uscita.
  const gpxBox = h('div', { class: 'gpxbox' })
  const file = h('input', { type: 'file', accept: '.gpx,application/gpx+xml', class: 'visually-hidden', 'aria-label': 'Traccia GPX' }) as HTMLInputElement
  const drawGpx = () => {
    if (!draft.gpx) {
      gpxBox.replaceChildren(btn('btn-text icon-left', [icon('plus', 16), 'TRACCIA GPX (FACOLTATIVA)'], () => file.click()), h('p', { class: 'hint' }, 'Da Strava o Garmin: si usano solo km e dislivello reali dell’uscita.'))
      return
    }
    const g = draft.gpx
    const far = g.share != null && g.share < 0.3
    gpxBox.replaceChildren(
      h(
        'div',
        { class: 'gpxsum' },
        h('span', { class: 'mono' }, `GPX · ${it(g.km, 1)} km${g.dplus != null ? ` · D+ ${it(g.dplus)} m` : ''}`),
        btn('iconbtn small', [icon('close', 16)], () => {
          draft.gpx = null
          drawGpx()
        }, { 'aria-label': 'Togli la traccia GPX' }),
      ),
      ...(g.share != null ? [h('p', { class: far ? 'warn small' : 'hint' }, far ? `La traccia segue questo sentiero solo per il ${Math.round(g.share * 100)}%: è il file giusto?` : `Segue il sentiero per il ${Math.round(g.share * 100)}%.`)] : []),
    )
  }
  file.addEventListener('change', async () => {
    const f = file.files?.[0]
    file.value = ''
    if (!f) return
    try {
      const track = parseGpx(await f.text())
      const m = line ? matchTrail(track, trail, line) : null
      draft.gpx = gpxDraft(track, m?.share ?? null)
      // La traccia dice anche quale parte del sentiero si è fatta: la proponiamo.
      if (m && m.share >= 0.15) {
        applyRoute(draft, proposeFromGpx(m, track, L))
        redrawRoute()
        redrawAr()
      }
      if (track.date && !draft.id) {
        draft.data = track.date
        date.value = track.date
      }
      drawGpx()
    } catch (e) {
      a.toast((e as Error).message)
    }
  })
  drawGpx()

  const err = h('p', { class: 'warn small' })
  const save = btn('btn-primary', [draft.id ? 'SALVA' : 'SEGNA COME FATTO'], (b) => {
    if (!date.value || date.value > todayIso()) {
      err.textContent = 'Scegli una data valida (non nel futuro).'
      return
    }
    addName()
    void busy(b, async () => {
      await a.saveOuting(
        {
          sentiero: trail.id,
          data: date.value,
          con: draft.con.map((p) => p.nome),
          conUid: draft.con.map((p) => p.uid),
          commento: draft.commento.trim() || null,
          drone: draft.drone,
          gpxKm: draft.gpx?.km ?? null,
          gpxDplus: draft.gpx?.dplus ?? null,
          parziale: draft.parziale,
          partenza: draft.partenza,
          finoM: draft.parziale ? Math.round(draft.finoM ?? 0) : null,
          ar: draft.ar,
        },
        draft.id ?? undefined,
      )
      a.toast(draft.id ? 'Uscita aggiornata.' : draft.parziale ? `${trail.numero}: fatti ${it((draft.finoM ?? 0) / 1000, 1)} km.` : `${trail.numero} segnato come fatto.`)
      done()
    }, a)
  })
  const cancel = btn('btn-text', ['ANNULLA'], done)

  form.append(
    h('label', { class: 'field' }, h('span', { class: 'field-k' }, 'Data'), date),
    route,
    ar,
    h(
      'div',
      { class: 'field', role: 'group', 'aria-label': 'Con chi' },
      h('span', { class: 'field-k' }, 'Con chi'),
      friends.length ? friendRow : h('p', { class: 'hint' }, 'Gli amici delle tue bacheche e quelli invitati compaiono qui.'),
      h('div', { class: 'addname' }, nameIn, btn('btn-outline', ['AGGIUNGI'], addName)),
      chosen,
    ),
    h('label', { class: 'field' }, h('span', { class: 'field-k' }, 'Commento'), comment),
    drone,
    gpxBox,
    file,
    err,
    h('div', { class: 'form-actions' }, cancel, save),
  )
  return form
}

// ---------------------------------------------------------------- sezione nella scheda del sentiero

export interface MyTrailCtx {
  trail: Trail
  line: TrailLine | undefined
  logged: boolean
  outings: Outing[] // di questo sentiero
  note: string | null
  friends: Person[]
  draft: OutingDraft | null // modulo aperto
  setDraft: (d: OutingDraft | null) => void
  a: OutingActions
  route: RouteHelpers
}

export function renderMyTrail(c: MyTrailCtx): HTMLElement {
  const sec = h('div', { class: 'mytrail' })
  const n = c.outings.length
  const L = c.line?.length ?? c.trail.lunghezza_m ?? 0
  const cov = coverage(c.outings, L)
  const head = h(
    'div',
    { class: 'section-head' },
    h('p', { class: 'section-label' }, n ? `Le mie uscite · ${n}` : 'Le mie uscite'),
    n ? (cov.complete ? h('span', { class: 'pill tiny done' }, icon('check', 14), 'FATTO') : h('span', { class: 'pill tiny part' }, icon('half', 14), 'INIZIATO')) : null,
  )
  sec.append(head)
  if (n && !cov.complete) sec.append(h('p', { class: 'small doneline' }, coverageText(cov.ranges, L)))
  if (!c.logged) {
    sec.append(h('p', { class: 'muted small' }, 'Accedi per segnare i sentieri fatti e scrivere note personali (visibili solo a te).'), btn('btn-outline', ['ACCEDI CON GOOGLE'], c.a.login))
    return sec
  }
  if (n) {
    const list = h('ul', { class: 'outings' })
    for (const o of c.outings) {
      const part = o.parziale && o.finoM != null ? `${endName(c.trail, o.partenza)}, ${it(o.finoM / 1000, 1)} km` : 'percorso completo'
      const meta = [part + (o.ar ? ' · andata e ritorno' : ''), o.con.length ? `con ${o.con.join(', ')}` : null, o.gpxKm != null ? `${it(o.gpxKm, 1)} km${o.gpxDplus != null ? ` · D+ ${it(o.gpxDplus)} m` : ''} (GPX)` : null].filter(Boolean).join(' · ')
      list.append(
        h(
          'li',
          {},
          h(
            'div',
            { class: 'outing-top' },
            h('span', { class: 'mono' }, dot(o.data)),
            o.drone ? h('span', { class: 'pill tiny', title: 'Avevo il drone' }, icon('drone', 14), 'DRONE') : null,
            btn('iconbtn small', [icon('edit', 16)], () => c.setDraft(draftFrom(o)), { 'aria-label': `Modifica l’uscita del ${dot(o.data)}` }),
            btn('iconbtn small', [icon('trash', 16)], (b) => {
              if (!confirm(`Togliere l’uscita del ${dot(o.data)}?`)) return
              void busy(b, () => c.a.deleteOuting(o.id), c.a)
            }, { 'aria-label': `Togli l’uscita del ${dot(o.data)}` }),
          ),
          meta ? h('p', { class: 'small muted' }, meta) : null,
          o.commento ? h('p', { class: 'small' }, o.commento) : null,
        ),
      )
    }
    sec.append(list)
  }
  if (c.draft) sec.append(outingForm(c.trail, c.line, c.draft, c.friends, c.a, c.route, () => c.setDraft(null)))
  else sec.append(btn('btn-outline wide', [icon('check', 18), n ? 'SEGNA UN’ALTRA USCITA' : 'SEGNA COME FATTO'], () => c.setDraft(newDraft())))

  // Nota personale: si salva quando si esce dal campo.
  const note = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'Parcheggio, punti per il decollo, cosa rifare…', 'aria-label': 'Nota personale' }) as HTMLTextAreaElement
  note.value = c.note ?? ''
  const status = h('span', { class: 'mono small muted' }, c.note ? 'salvata' : '')
  let last = note.value
  const saveNote = async () => {
    if (note.value === last) return
    const v = note.value
    status.textContent = 'salvo…'
    try {
      await c.a.saveNote(c.trail.id, v)
      last = v
      status.textContent = v.trim() ? 'salvata' : 'cancellata'
    } catch (e) {
      status.textContent = ''
      c.a.toast(`Nota non salvata: ${(e as Error).message}`)
    }
  }
  note.addEventListener('blur', () => void saveNote())
  sec.append(
    h('div', { class: 'section-head note-head' }, h('p', { class: 'section-label' }, 'Nota personale · solo tu'), status),
    note,
  )
  return sec
}

/** "Fatto fino al km 4,2 di 7,8" (o dalla fine, o in più pezzi). */
export function coverageText(ranges: [number, number][], L: number): string {
  const km = (m: number) => it(m / 1000, 1)
  if (ranges.length === 1) {
    const [a, b] = ranges[0]
    if (a <= 1) return `Fatto fino al km ${km(b)} di ${km(L)}`
    if (b >= L - 1) return `Fatto dal km ${km(a)} alla fine (${km(L)} km)`
    return `Fatto dal km ${km(a)} al km ${km(b)} di ${km(L)}`
  }
  const done = ranges.reduce((s, [a, b]) => s + b - a, 0)
  return `Fatti ${km(done)} km di ${km(L)}, in ${ranges.length} parti`
}

// ---------------------------------------------------------------- statistiche

export interface StatsCtx {
  outings: Outing[]
  trails: Map<string, Trail>
  pois: Map<string, PoiProps>
  lines: Map<string, TrailLine>
  profiles: Record<string, Profile> | null // per il dislivello delle parti fatte (null finché si carica)
  nome: string
  onShowMap: (ids: string[]) => void
  onImportGpx: (file: File) => void
  toast: (m: string) => void
}

let statsYear: number | null = new Date().getFullYear()

const COLLECT_LABEL: Record<string, string> = { lago: 'Laghi', vetta: 'Vette', rifugio: 'Rifugi', malga: 'Malghe' }
const COLLECT_ONE: Record<string, string> = { lago: 'lago', vetta: 'vetta', rifugio: 'rifugio', malga: 'malga' }
const countOf = (cat: string, n: number) => `${n} ${n === 1 ? COLLECT_ONE[cat] : COLLECT_LABEL[cat].toLowerCase()}`

function monthChart(s: Stats): HTMLElement {
  const max = Math.max(1, ...s.mesi.map((m) => m.km))
  const W = 300
  const H = 120
  const bw = W / 12
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`)
  svg.setAttribute('class', 'monthchart')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Km per mese: ${s.mesi.map((m, i) => `${MESI_LUNGHI[i]} ${it(m.km, 1)}`).join(', ')}`)
  s.mesi.forEach((m, i) => {
    const hgt = (m.km / max) * (H - 14)
    const r = document.createElementNS(ns, 'rect')
    r.setAttribute('x', String(i * bw + 3))
    r.setAttribute('y', String(H - hgt))
    r.setAttribute('width', String(bw - 6))
    r.setAttribute('height', String(Math.max(hgt, m.km ? 2 : 0)))
    r.setAttribute('rx', '2')
    r.setAttribute('class', 'bar')
    const title = document.createElementNS(ns, 'title')
    title.textContent = `${MESI_LUNGHI[i]}: ${it(m.km, 1)} km · D+ ${it(m.dplus)} m · ${m.uscite} uscite`
    r.append(title)
    svg.append(r)
    if (m.km) {
      const v = document.createElementNS(ns, 'text')
      v.setAttribute('x', String(i * bw + bw / 2))
      v.setAttribute('y', String(H - hgt - 3))
      v.setAttribute('class', 'val')
      v.textContent = it(m.km)
      svg.append(v)
    }
    const t = document.createElementNS(ns, 'text')
    t.setAttribute('x', String(i * bw + bw / 2))
    t.setAttribute('y', String(H + 14))
    t.setAttribute('class', 'lbl')
    t.textContent = MESI[i]
    svg.append(t)
  })
  const line = document.createElementNS(ns, 'line')
  line.setAttribute('x1', '0')
  line.setAttribute('x2', String(W))
  line.setAttribute('y1', String(H))
  line.setAttribute('y2', String(H))
  line.setAttribute('class', 'axis')
  svg.append(line)
  return svg as unknown as HTMLElement
}

// Mappa personale: tutti i sentieri in grigio, quelli fatti in evidenza (SVG, nessun servizio esterno).
const MAP_BOX = [10.45, 45.67, 11.97, 46.55] as const
const KX = Math.cos((46.1 * Math.PI) / 180)
let basePath: string | null = null

function project(c: [number, number], w: number): [number, number] {
  const s = w / ((MAP_BOX[2] - MAP_BOX[0]) * KX)
  return [(c[0] - MAP_BOX[0]) * KX * s, (MAP_BOX[3] - c[1]) * s]
}
export const mapSize = (w: number): [number, number] => [w, Math.round(((MAP_BOX[3] - MAP_BOX[1]) / ((MAP_BOX[2] - MAP_BOX[0]) * KX)) * w)]

function pathOf(coords: [number, number][], w: number, step: number): string {
  const pts = coords.filter((_, i) => i % step === 0 || i === coords.length - 1)
  return pts.map((c, i) => `${i ? 'L' : 'M'}${project(c, w).map((v) => v.toFixed(1)).join(' ')}`).join('')
}

/** Solo le parti fatte dei sentieri (uscite parziali comprese). */
function doneParts(s: Stats, lines: Map<string, TrailLine>): [number, number][][] {
  const out: [number, number][][] = []
  for (const [id, ranges] of s.parti) {
    const l = lines.get(id)
    if (l) for (const [a, b] of ranges) out.push(sliceLine(l, a, b))
  }
  return out.filter((c) => c.length > 1)
}

function personalMap(s: Stats, lines: Map<string, TrailLine>): HTMLElement {
  const W = 600
  const [, H] = mapSize(W)
  basePath ??= [...lines.values()].map((l) => pathOf(l.coords, W, 6)).join('')
  const done = doneParts(s, lines).map((c) => pathOf(c, W, 1)).join('')
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'personalmap')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Mappa personale: ${s.sentieri} sentieri fatti`)
  const base = document.createElementNS(ns, 'path')
  base.setAttribute('d', basePath)
  base.setAttribute('class', 'base')
  const mine = document.createElementNS(ns, 'path')
  mine.setAttribute('d', done)
  mine.setAttribute('class', 'mine')
  svg.append(base, mine)
  return svg as unknown as HTMLElement
}

export function renderStats(c: StatsCtx, rerender: () => void): HTMLElement {
  const years = yearsOf(c.outings)
  if (statsYear != null && !years.includes(statsYear)) statsYear = years[0]
  const s = computeStats(c.outings, statsYear, c.trails, c.pois, c.lines, c.profiles)
  const sec = h('section', { class: 'stats' })
  const sel = h('select', { 'aria-label': 'Anno delle statistiche' }, ...years.map((y) => h('option', { value: String(y) }, String(y))), h('option', { value: '' }, 'Tutti gli anni')) as HTMLSelectElement
  sel.value = statsYear == null ? '' : String(statsYear)
  sel.addEventListener('change', () => {
    statsYear = sel.value ? Number(sel.value) : null
    rerender()
  })
  sec.append(h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, 'Statistiche · solo tu'), sel))

  const file = h('input', { type: 'file', accept: '.gpx,application/gpx+xml', class: 'visually-hidden', 'aria-label': 'Importa una traccia GPX' }) as HTMLInputElement
  file.addEventListener('change', () => {
    const f = file.files?.[0]
    file.value = ''
    if (f) c.onImportGpx(f)
  })
  const importBtn = btn('btn-outline', [icon('plus', 16), 'IMPORTA GPX'], () => file.click())

  if (!s.uscite) {
    sec.append(
      h('p', { class: 'muted small' }, statsYear == null ? 'Nessuna uscita segnata.' : `Nessuna uscita nel ${statsYear}.`, ' Usa “Segna come fatto” nella scheda di un sentiero, oppure importa una traccia GPX: viene associata al sentiero più vicino.'),
      h('div', { class: 'form-actions' }, importBtn),
      file,
    )
    return sec
  }
  const tile = (k: string, v: string, sub?: string) => h('div', { class: 'tile' }, h('span', { class: 'tile-k' }, k), h('span', { class: 'tile-v' }, v), sub ? h('span', { class: 'tile-s' }, sub) : null)
  sec.append(
    h(
      'div',
      { class: 'tiles statstiles' },
      tile('KM', it(s.km, 1)),
      tile('D+', `${it(s.dplus)} m`),
      tile('USCITE', String(s.uscite), `${s.sentieri} ${s.sentieri === 1 ? 'sentiero' : 'sentieri diversi'}`),
      tile('COMPLETATI', String(s.completati), 'sentieri fatti tutti'),
      tile('INIZIATI', String(s.iniziati), 'non ancora finiti'),
      tile('COL DRONE', String(s.conDrone), s.uscite ? `${Math.round((s.conDrone / s.uscite) * 100)}% delle uscite` : undefined),
    ),
  )
  if (statsYear != null) sec.append(h('p', { class: 'section-label sub' }, `Km per mese · ${statsYear}`), monthChart(s))

  // Collezione: POI vicini ai sentieri fatti.
  const coll = h('div', { class: 'collect' })
  for (const cat of COLLECT) {
    const items = s.raccolti[cat]
    const d = h('details', {}, h('summary', {}, h('i', { class: 'dot', style: `background:${CATEGORIES[cat].color}` }), h('span', {}, COLLECT_LABEL[cat]), h('span', { class: 'mono' }, String(items.length))))
    if (items.length) d.append(h('p', { class: 'small muted' }, items.map((x) => x.nome).join(', ')))
    else d.append(h('p', { class: 'small muted' }, 'Ancora nessuno.'))
    coll.append(d)
  }
  sec.append(h('p', { class: 'section-label sub' }, 'Collezionati lungo i sentieri fatti'), coll)

  // Record
  const rec = h('ul', { class: 'records' })
  if (s.piuLunga) rec.append(h('li', {}, h('span', { class: 'small muted' }, 'Uscita più lunga'), h('span', { class: 'mono' }, `${it(s.piuLunga.km, 1)} km`), h('span', { class: 'small' }, `${s.piuLunga.trail.numero} · ${dot(s.piuLunga.data)}`)))
  if (s.piuAlta) rec.append(h('li', {}, h('span', { class: 'small muted' }, 'Quota più alta raggiunta a piedi'), h('span', { class: 'mono' }, `${it(s.piuAlta.quota)} m`), h('span', { class: 'small' }, s.piuAlta.trail.numero)))
  sec.append(h('p', { class: 'section-label sub' }, 'Record'), rec)

  sec.append(h('p', { class: 'section-label sub' }, 'La mia mappa'), personalMap(s, c.lines))
  const show = btn('btn-outline', [icon('map', 16), 'MOSTRA SULLA MAPPA'], () => c.onShowMap([...s.fatti]))
  const exp = btn('btn-primary', [icon('share', 16), 'ESPORTA IMMAGINE'], (b) => void busy(b, () => exportStats(s, c), c))
  sec.append(h('div', { class: 'form-actions wrap' }, show, importBtn, exp), file)
  sec.append(h('p', { class: 'hint' }, 'Le statistiche sono private: le vedi solo tu. Con “Esporta immagine” decidi tu se e con chi condividerle.'))
  return sec
}

// ---------------------------------------------------------------- esporta come immagine

async function exportStats(s: Stats, c: StatsCtx): Promise<void> {
  await document.fonts?.ready
  const W = 1080
  const H = 1350
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  const css = getComputedStyle(document.documentElement)
  const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f
  const accent = v('--accent', '#0B6E84')
  const ink = v('--ink', '#142024')
  const muted = v('--muted', '#4F5C59')
  g.fillStyle = v('--bg', '#EEF0EC')
  g.fillRect(0, 0, W, H)
  const cond = '"IBM Plex Sans Condensed", sans-serif'
  const mono = '"IBM Plex Mono", monospace'
  const sans = '"IBM Plex Sans", sans-serif'
  // Testata
  g.fillStyle = accent
  g.fillRect(0, 0, W, 150)
  g.fillStyle = '#fff'
  g.font = `700 64px ${cond}`
  g.fillText('QUOTA 120', 60, 95)
  g.font = `600 30px ${mono}`
  g.textAlign = 'right'
  g.fillText(s.anno == null ? 'TUTTI GLI ANNI' : String(s.anno), W - 60, 95)
  g.textAlign = 'left'
  g.fillStyle = ink
  g.font = `700 48px ${cond}`
  g.fillText(`Le uscite di ${c.nome}`.toUpperCase(), 60, 230)
  // Riquadri
  const tiles: [string, string][] = [
    ['KM', it(s.km, 1)],
    ['D+ (m)', it(s.dplus)],
    ['USCITE', String(s.uscite)],
    ['COL DRONE', String(s.conDrone)],
  ]
  tiles.forEach(([k, val], i) => {
    const x = 60 + i * 245
    g.fillStyle = '#fff'
    g.beginPath()
    g.roundRect(x, 270, 225, 150, 18)
    g.fill()
    g.fillStyle = muted
    g.font = `600 22px ${mono}`
    g.fillText(k, x + 22, 312)
    g.fillStyle = ink
    g.font = `600 52px ${mono}`
    g.fillText(val, x + 22, 385)
  })
  // Mesi
  let y = 470
  if (s.anno != null) {
    g.fillStyle = muted
    g.font = `600 22px ${mono}`
    g.fillText('KM PER MESE', 60, y)
    const max = Math.max(1, ...s.mesi.map((m) => m.km))
    const bw = (W - 120) / 12
    s.mesi.forEach((m, i) => {
      const hh = (m.km / max) * 170
      g.fillStyle = accent
      g.beginPath()
      g.roundRect(60 + i * bw + 8, y + 210 - hh, bw - 16, Math.max(hh, m.km ? 3 : 0), 4)
      g.fill()
      g.fillStyle = muted
      g.font = `500 20px ${mono}`
      g.textAlign = 'center'
      g.fillText(MESI[i], 60 + i * bw + bw / 2, y + 240)
      g.textAlign = 'left'
    })
    y += 280
  }
  // Collezione e record
  g.fillStyle = ink
  g.font = `500 28px ${sans}`
  const coll = COLLECT.map((cat) => countOf(cat, s.raccolti[cat].length)).join(' · ')
  g.fillText(coll, 60, y)
  y += 44
  g.fillStyle = muted
  g.font = `500 24px ${sans}`
  const recs = [s.sentieri ? `${s.sentieri} ${s.sentieri === 1 ? 'sentiero' : 'sentieri diversi'}` : null, s.piuLunga ? `uscita più lunga ${it(s.piuLunga.km, 1)} km` : null, s.piuAlta ? `quota più alta a piedi ${it(s.piuAlta.quota)} m` : null].filter(Boolean).join(' · ')
  g.fillText(recs, 60, y)
  y += 40
  // Mappa personale: la più grande che sta nello spazio rimasto, centrata.
  const ratio = mapSize(1000)[1] / 1000
  const room = H - 80 - y
  const mw = Math.min(W - 120, room / ratio)
  const mh = mw * ratio
  g.fillStyle = '#fff'
  g.beginPath()
  g.roundRect((W - mw) / 2 - 16, y - 16, mw + 32, mh + 32, 18)
  g.fill()
  g.save()
  g.translate((W - mw) / 2, y)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const drawLine = (coords: [number, number][], step: number) => {
    g.beginPath()
    coords.forEach((pt, i) => {
      if (i % step && i !== coords.length - 1) return
      const [px, py] = project(pt, mw)
      if (i) g.lineTo(px, py)
      else g.moveTo(px, py)
    })
    g.stroke()
  }
  g.strokeStyle = 'rgba(20,32,36,0.16)'
  g.lineWidth = 1.2
  for (const l of c.lines.values()) drawLine(l.coords, 4)
  g.strokeStyle = accent
  g.lineWidth = 4
  for (const part of doneParts(s, c.lines)) drawLine(part, 1)
  g.restore()
  g.fillStyle = muted
  g.font = `500 20px ${mono}`
  g.fillText('Sentieri SAT · zone D-Flight · quota120', 60, H - 30)

  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'))
  if (!blob) throw new Error('immagine non creata')
  const name = `quota120-${s.anno ?? 'tutto'}.png`
  const fileObj = new File([blob], name, { type: 'image/png' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (matchMedia('(pointer: coarse)').matches && nav.canShare?.({ files: [fileObj] })) {
    try {
      await navigator.share({ files: [fileObj], title: 'Le mie uscite su Quota 120' })
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
  }
  const url = URL.createObjectURL(blob)
  const link = h('a', { href: url, download: name }) as HTMLAnchorElement
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  c.toast('Immagine scaricata.')
}

export { outingDplus, outingKm }
