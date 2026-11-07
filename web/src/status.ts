// Stato del sentiero (aperto / chiuso / da verificare) dall'incrocio di più fonti:
// - chiusure inserite a mano nell'app (data/closures.yaml);
// - segnalazioni degli utenti dell'app, viste sul posto (Firestore, condivise);
// - comunicati della Provincia di Trento e notizie (avvisi.json, aggiornato ogni giorno dalla
//   GitHub Action con pipeline/avvisi.py);
// - OpenStreetMap, interrogato dal browser (Overpass) sui tratti di sentiero sotto la linea:
//   divieti di accesso, sentieri dismessi o in costruzione, chiusure stagionali, pericoli, note.
// Nessuna fonte è completa: la scheda mostra cosa dice ognuna, con i link per controllare.

import { isClosedOn, periodLabel, type Closure } from './closures'
import { h } from './panel'
import { projectOnLine, type TrailLine } from './trailgeom'
import type { Trail } from './types'
import { icon } from './ui'

// ---------------------------------------------------------------- tipi

export interface Avviso {
  fonte: 'provincia' | 'notizie'
  testata?: string | null
  data: string | null
  titolo: string
  url: string
  stato: 'chiuso' | 'riaperto' | 'info'
  forte: string[] // sentieri citati per numero
  debole: string[] // sentieri citati per luogo
}

export interface AvvisiFile {
  aggiornato: string
  fonti: Record<string, { ok: boolean; nuovi: number; url: string }>
  avvisi: Avviso[]
}

export interface ReportView {
  id: string
  sentiero: string
  stato: 'chiuso' | 'pericolo' | 'aperto'
  nota: string | null
  data: string
  nome: string
  mine: boolean
}

export interface OsmFinding {
  livello: 'chiuso' | 'attenzione' | 'info'
  testo: string
  url: string // pagina dell'elemento su openstreetmap.org
}

export type OsmState = { stato: 'caricamento' } | { stato: 'errore'; messaggio: string } | { stato: 'ok'; trovati: OsmFinding[]; quando: number }

export type Verdetto = 'aperto' | 'chiuso' | 'verificare'

export interface StatusInput {
  trails: Trail[] // il sentiero, o i sentieri usati da un percorso
  isRoute: boolean
  day: string // data scelta (AAAA-MM-GG)
  today: string
  closures: Closure[] // dall'elenco dell'app (tutte, anche non attive)
  reports: ReportView[]
  avvisi: Avviso[] // già filtrati per i sentieri
  avvisiFile: AvvisiFile | null | undefined // undefined = in caricamento, null = non disponibile
  osm: OsmState
}

export interface StatusResult {
  verdetto: Verdetto
  titolo: string // "APERTO" / "CHIUSO" / "DA VERIFICARE"
  motivo: string // frase breve
}

// ---------------------------------------------------------------- verdetto

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const fmt = (iso: string | null) => (iso ? iso.split('-').reverse().join('.') : 'data ?')
const REPORT_DAYS = 120 // una segnalazione più vecchia vale solo come informazione
const AVVISO_DAYS = 365

export function verdict(s: StatusInput): StatusResult {
  const active = s.closures.filter((c) => isClosedOn(c, s.day))
  if (active.length) return { verdetto: 'chiuso', titolo: 'CHIUSO', motivo: `Chiusura inserita nell’app: ${active[0].motivo ?? periodLabel(active[0])}` }

  const recentReports = s.reports.filter((r) => daysBetween(r.data, s.today) <= REPORT_DAYS)
  const lastReport = recentReports[0] // dalla più recente
  const strong = s.avvisi.filter((a) => a.data && daysBetween(a.data, s.today) <= AVVISO_DAYS && s.trails.some((t) => a.forte.includes(t.id)))
  const lastStrong = strong.find((a) => a.stato !== 'info')
  const positives = [lastReport?.stato === 'aperto' ? lastReport.data : null, lastStrong?.stato === 'riaperto' ? lastStrong.data : null].filter((x): x is string => !!x).sort()
  const lastPositive = positives[positives.length - 1] ?? null
  const newer = (d: string | null) => !!d && (!lastPositive || d > lastPositive)

  if (lastReport?.stato === 'chiuso' && newer(lastReport.data)) return { verdetto: 'chiuso', titolo: 'CHIUSO', motivo: `Segnalato chiuso da ${lastReport.nome} il ${fmt(lastReport.data)}` }
  if (lastStrong?.stato === 'chiuso' && newer(lastStrong.data)) return { verdetto: 'chiuso', titolo: 'CHIUSO', motivo: `${lastStrong.fonte === 'provincia' ? 'Comunicato della Provincia' : 'Notizia'} del ${fmt(lastStrong.data)}` }

  const osmClosed = s.osm.stato === 'ok' ? s.osm.trovati.filter((f) => f.livello === 'chiuso') : []
  const verifiedOpen = lastPositive && daysBetween(lastPositive, s.today) <= 60
  if (osmClosed.length && !verifiedOpen) return { verdetto: 'chiuso', titolo: 'CHIUSO', motivo: `Secondo OpenStreetMap: ${osmClosed[0].testo}` }

  const warn: string[] = []
  if (lastReport?.stato === 'pericolo') warn.push(`pericolo segnalato da ${lastReport.nome} il ${fmt(lastReport.data)}`)
  const weak = s.avvisi.filter((a) => a.stato === 'chiuso' && a.data && daysBetween(a.data, s.today) <= 180 && !s.trails.some((t) => a.forte.includes(t.id)) && newer(a.data))
  if (weak.length) warn.push(`${weak.length === 1 ? 'una notizia recente' : `${weak.length} notizie recenti`} su chiusure in zona`)
  const osmWarn = s.osm.stato === 'ok' ? s.osm.trovati.filter((f) => f.livello === 'attenzione') : []
  if (osmWarn.length) warn.push(`OpenStreetMap: ${osmWarn[0].testo}`)
  const upcoming = s.closures.filter((c) => !active.includes(c))
  if (warn.length) return { verdetto: 'verificare', titolo: 'DA VERIFICARE', motivo: warn[0][0].toUpperCase() + warn[0].slice(1) }

  if (verifiedOpen) return { verdetto: 'aperto', titolo: 'APERTO', motivo: lastReport?.stato === 'aperto' && lastReport.data === lastPositive ? `Verificato aperto da ${lastReport.nome} il ${fmt(lastReport.data)}` : `Riaperto (comunicato del ${fmt(lastPositive)})` }
  const pending = s.osm.stato === 'caricamento' ? ' · controllo OpenStreetMap…' : ''
  return { verdetto: 'aperto', titolo: 'APERTO', motivo: (upcoming.length ? `Nessuna chiusura nella data scelta (prevista: ${periodLabel(upcoming[0])})` : 'Nessuna chiusura segnalata dalle fonti') + pending }
}

// ---------------------------------------------------------------- OpenStreetMap (Overpass, dal browser)

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
const OSM_CACHE_H = 24
const OSM_NEAR_M = 25 // un vertice dell'elemento OSM conta come "sul sentiero" entro questa distanza
const PATHS = '^(path|footway|track|steps|bridleway|cycleway|via_ferrata|unclassified|service)$'
const MESI_EN: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const MESI_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']
const CLOSE_WORDS = /chius|interrott|franat|frana|inagibil|impraticabil|non percorribil|closed|impassable|landslide/i

function overpassQuery(b: [number, number, number, number]): string {
  const pad = 0.002
  const bb = `${b[1] - pad},${b[0] - pad},${b[3] + pad},${b[2] + pad}`
  const w = `way[highway~"${PATHS}"](${bb})`
  return `[out:json][timeout:25];(
${w}[~"^(access|foot)$"~"^(no|private)$"];
${w}[~"^(access|foot)(:conditional)$"~"."];
${w}[~"^(seasonal|opening_hours)$"~"."];
${w}[hazard];
${w}[~"^(note|description|fixme|FIXME)$"~"chius|interrott|fran|inagibil|impraticabil|percorribil|closed|impassable",i];
way["disused:highway"](${bb});
way["abandoned:highway"](${bb});
way[highway=construction](${bb});
way[~"^(trail_visibility)$"~"^(bad|horrible|no)$"](${bb});
);out tags geom;`
}

interface OsmEl {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

/** Il mese (1–12) è nell'intervallo "Nov-Mar" (anche a cavallo dell'anno)? */
const inMonths = (m: number, a: number, b: number) => (a <= b ? m >= a && m <= b : m >= a || m <= b)

/** Intervalli di mesi da testi OSM tipo "no @ (Nov-Mar)", "Apr-Oct", "Nov 01-Mar 31". */
function monthRanges(v: string): [number, number][] {
  const out: [number, number][] = []
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s*\d{1,2})?\s*-\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi
  for (const m of v.matchAll(re)) out.push([MESI_EN[m[1].toLowerCase()], MESI_EN[m[2].toLowerCase()]])
  return out
}

const monthsIt = (r: [number, number]) => `${MESI_IT[r[0] - 1]}–${MESI_IT[r[1] - 1]}`

function interpret(el: OsmEl, month: number): OsmFinding[] {
  const t = el.tags ?? {}
  const url = `https://www.openstreetmap.org/${el.type}/${el.id}`
  const name = t.name ? `“${t.name}”: ` : ''
  const out: OsmFinding[] = []
  const short = (s: string) => (s.length > 140 ? `${s.slice(0, 137)}…` : s)
  for (const k of ['access', 'foot']) if (t[k] === 'no' || t[k] === 'private') out.push({ livello: 'chiuso', testo: `${name}transito ${t[k] === 'private' ? 'privato' : 'vietato'} (${k}=${t[k]})`, url })
  if (t['disused:highway'] || t['abandoned:highway']) out.push({ livello: 'chiuso', testo: `${name}sentiero ${t['disused:highway'] ? 'dismesso' : 'abbandonato'}`, url })
  if (t.highway === 'construction') out.push({ livello: 'chiuso', testo: `${name}in lavori`, url })
  for (const k of ['access:conditional', 'foot:conditional']) {
    const v = t[k]
    if (!v) continue
    const rs = /^\s*(no|private)\b/i.test(v) ? monthRanges(v) : []
    if (rs.length && rs.some((r) => inMonths(month, r[0], r[1]))) out.push({ livello: 'chiuso', testo: `${name}chiuso nel periodo ${rs.map(monthsIt).join(', ')} (${k})`, url })
    else out.push({ livello: 'info', testo: `${name}limitazione a periodi: ${short(v)}`, url })
  }
  if (t.seasonal && t.seasonal !== 'no') out.push({ livello: 'info', testo: `${name}percorribile solo in certe stagioni (seasonal=${t.seasonal})`, url })
  if (t.opening_hours) {
    const rs = monthRanges(t.opening_hours)
    if (rs.length && !rs.some((r) => inMonths(month, r[0], r[1])) && !/\boff\b/i.test(t.opening_hours)) out.push({ livello: 'chiuso', testo: `${name}aperto solo ${rs.map(monthsIt).join(', ')}`, url })
    else if (/\boff\b|closed/i.test(t.opening_hours)) out.push({ livello: 'attenzione', testo: `${name}orari/chiusure: ${short(t.opening_hours)}`, url })
    else out.push({ livello: 'info', testo: `${name}orari: ${short(t.opening_hours)}`, url })
  }
  if (t.hazard) out.push({ livello: 'attenzione', testo: `${name}pericolo segnalato (${t.hazard.replace(/_/g, ' ')})`, url })
  if (['bad', 'horrible', 'no'].includes(t.trail_visibility ?? '')) out.push({ livello: 'info', testo: `${name}traccia poco visibile`, url })
  for (const k of ['note', 'description', 'fixme', 'FIXME']) {
    const v = t[k]
    if (v && CLOSE_WORDS.test(v)) out.push({ livello: 'attenzione', testo: `${name}nota: ${short(v)}`, url })
  }
  return out
}

const memo = new Map<string, Promise<OsmState>>()

/** Elementi OSM con divieti, chiusure, pericoli o note che stanno SULLA linea del sentiero. */
export function checkOsm(key: string, line: TrailLine, bbox: [number, number, number, number], day: string): Promise<OsmState> {
  const ck = `osm-stato:${key}:${day.slice(0, 7)}`
  try {
    const c = JSON.parse(localStorage.getItem(ck) ?? 'null') as Extract<OsmState, { stato: 'ok' }> | null
    if (c && Date.now() - c.quando < OSM_CACHE_H * 3_600_000) return Promise.resolve(c)
  } catch {
    // niente cache: si interroga
  }
  const hit = memo.get(ck)
  if (hit) return hit
  const month = Number(day.slice(5, 7))
  const p = (async (): Promise<OsmState> => {
    let lastErr = ''
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(bbox) }) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { elements: OsmEl[] }
        const trovati: OsmFinding[] = []
        for (const el of j.elements) {
          const g = el.geometry ?? []
          if (!g.length) continue
          const near = g.filter((p) => projectOnLine(line, [p.lon, p.lat]).d <= OSM_NEAR_M).length
          // sul sentiero: almeno 2 punti vicini e metà dei punti (o tutti, se l'elemento è corto)
          if (near < Math.min(2, g.length) || near < g.length * 0.5) continue
          trovati.push(...interpret(el, month))
        }
        const order = { chiuso: 0, attenzione: 1, info: 2 }
        trovati.sort((a, b) => order[a.livello] - order[b.livello])
        const st: OsmState = { stato: 'ok', trovati, quando: Date.now() }
        try {
          localStorage.setItem(ck, JSON.stringify(st))
        } catch {
          // memoria piena o non disponibile: va bene lo stesso
        }
        return st
      } catch (e) {
        lastErr = (e as Error).message
      }
    }
    memo.delete(ck)
    return { stato: 'errore', messaggio: lastErr || 'nessuna risposta' }
  })()
  memo.set(ck, p)
  return p
}

// ---------------------------------------------------------------- interfaccia

export interface StatusActions {
  logged: boolean
  login: () => void
  report: (r: { sentiero: string; stato: ReportView['stato']; nota: string | null; data: string }) => Promise<void>
  deleteReport: (id: string) => Promise<void>
  retryOsm: () => void
  toast: (m: string) => void
}

export function statusPill(r: StatusResult, onClick?: () => void): HTMLElement {
  const cls = r.verdetto === 'aperto' ? 'open' : r.verdetto === 'chiuso' ? 'closed' : 'check'
  const dot = r.verdetto === 'aperto' ? 'verde' : r.verdetto === 'chiuso' ? 'rosso' : 'giallo'
  const el = h('button', { type: 'button', class: `pill statuspill ${cls}`, title: `${r.motivo} — tocca per le fonti` }, h('i', { class: `dot ${dot}` }), r.titolo)
  if (onClick) el.addEventListener('click', onClick)
  return el
}

const stateChip = (text: string, kind: 'chiuso' | 'attenzione' | 'aperto' | 'info') =>
  h('span', { class: `srcstate ${kind}` }, h('i', { class: `dot ${kind === 'chiuso' ? 'rosso' : kind === 'attenzione' ? 'giallo' : kind === 'aperto' ? 'verde' : 'muted'}` }), text)

const ext = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text, ' ', icon('link', 12))

function block(title: string, chip: HTMLElement | null, ...body: (Node | null)[]): HTMLElement {
  return h('div', { class: 'srcblock' }, h('div', { class: 'srchead' }, h('span', { class: 'srcname' }, title), chip), ...body.filter((x): x is Node => !!x))
}

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function renderStatus(s: StatusInput, r: StatusResult, open: boolean, onToggle: (open: boolean) => void, a: StatusActions): HTMLElement {
  const det = h('details', { class: 'wxacc statusacc' }) as HTMLDetailsElement
  det.open = open
  det.addEventListener('toggle', () => onToggle(det.open))
  const kind = r.verdetto === 'aperto' ? 'aperto' : r.verdetto === 'chiuso' ? 'chiuso' : 'attenzione'
  det.append(
    h('summary', { class: 'wxsum' }, h('span', { class: 'section-label' }, 'Aperto o chiuso?'), stateChip(r.titolo, kind), icon('chevronRight', 18)),
    body(s, r, a),
  )
  return det
}

function body(s: StatusInput, r: StatusResult, a: StatusActions): HTMLElement {
  const box = h('div', { class: 'wx statusbody' })
  const t0 = s.trails[0]
  const nums = s.trails.map((t) => t.numero).join(', ')
  box.append(h('p', { class: 'statusmotivo' }, r.motivo))

  // 1. Chiusure inserite nell'app
  const active = s.closures.filter((c) => isClosedOn(c, s.day))
  box.append(
    block(
      'Chiusure nell’app',
      s.closures.length ? stateChip(active.length ? 'chiuso nella data' : 'previste', active.length ? 'chiuso' : 'info') : stateChip('nessuna', 'aperto'),
      s.closures.length
        ? h('ul', { class: 'srclist' }, ...s.closures.map((c) => h('li', {}, `${c.motivo ?? 'Chiuso'} `, h('span', { class: 'mono muted' }, `(${periodLabel(c)})`), c.fonte ? h('span', {}, ' · ', ext(c.fonte, 'fonte')) : null)))
        : h('p', { class: 'small muted' }, 'Elenco tenuto a mano nel progetto (data/closures.yaml).'),
    ),
  )

  // 2. Segnalazioni degli utenti
  const reps = s.reports.slice(0, 8)
  const last = s.reports[0]
  const repChip = last ? stateChip(`${last.stato} · ${fmt(last.data)}`, last.stato === 'pericolo' ? 'attenzione' : last.stato) : stateChip('nessuna', 'info')
  const repList = reps.length
    ? h(
        'ul',
        { class: 'srclist' },
        ...reps.map((x) => {
          const del = x.mine ? h('button', { type: 'button', class: 'iconbtn small', 'aria-label': 'Togli la mia segnalazione' }, icon('trash', 14)) : null
          del?.addEventListener('click', () => {
            if (confirm('Togliere la tua segnalazione?')) void a.deleteReport(x.id).catch((e) => a.toast(`Non riuscito: ${(e as Error).message}`))
          })
          return h('li', {}, h('span', { class: 'mono' }, fmt(x.data)), ` ${x.nome}: `, h('strong', {}, x.stato), x.nota ? ` — ${x.nota}` : '', s.isRoute ? h('span', { class: 'mono muted' }, ` (${s.trails.find((t) => t.id === x.sentiero)?.numero ?? x.sentiero})`) : null, del)
        }),
      )
    : h('p', { class: 'small muted' }, 'Nessuna segnalazione recente da chi usa l’app.')
  box.append(block('Segnalazioni sul posto (app)', repChip, repList, reportForm(s, a)))

  // 3–4. Provincia e notizie
  for (const fonte of ['provincia', 'notizie'] as const) {
    const list = s.avvisi.filter((x) => x.fonte === fonte)
    const info = s.avvisiFile?.fonti?.[fonte]
    const title = fonte === 'provincia' ? 'Provincia di Trento · comunicati' : 'Notizie (Google News)'
    let chip: HTMLElement
    if (s.avvisiFile === undefined) chip = stateChip('carico…', 'info')
    else if (!s.avvisiFile) chip = stateChip('non disponibile', 'info')
    else if (!list.length) chip = stateChip(info && !info.ok ? 'fonte non raggiunta' : 'nessun avviso', info && !info.ok ? 'info' : 'aperto')
    else chip = stateChip(list[0].stato === 'info' ? 'citato' : `${list[0].stato} · ${fmt(list[0].data)}`, list[0].stato === 'chiuso' ? 'chiuso' : list[0].stato === 'riaperto' ? 'aperto' : 'info')
    const items = list.slice(0, 6).map((x) => {
      const byNum = s.trails.some((t) => x.forte.includes(t.id))
      return h(
        'li',
        {},
        h('span', { class: 'mono' }, fmt(x.data)),
        ' ',
        h('span', { class: `srcstate inline ${x.stato === 'chiuso' ? 'chiuso' : x.stato === 'riaperto' ? 'aperto' : 'info'}` }, x.stato),
        ' ',
        ext(x.url, x.titolo),
        h('span', { class: 'small muted' }, byNum ? ' · cita il numero del sentiero' : ' · cita un luogo del sentiero (da verificare)', x.testata ? ` · ${x.testata}` : ''),
      )
    })
    const q = encodeURIComponent(`sentiero ${nums} ${t0?.loc_inizio ?? ''} chiuso`.trim())
    const search = fonte === 'provincia' ? ext(`https://www.google.com/search?q=${encodeURIComponent(`site:ufficiostampa.provincia.tn.it sentiero ${nums}`)}`, 'Cerca nei comunicati') : ext(`https://news.google.com/search?q=${q}&hl=it&gl=IT&ceid=IT:it`, 'Cerca nelle notizie')
    const upd = s.avvisiFile?.aggiornato ? h('span', { class: 'small muted' }, ` · letto il ${fmt(s.avvisiFile.aggiornato.slice(0, 10))}`) : null
    box.append(block(title, chip, items.length ? h('ul', { class: 'srclist' }, ...items) : null, h('p', { class: 'small' }, search, upd)))
  }

  // 5. OpenStreetMap
  let osmChip: HTMLElement
  let osmBody: HTMLElement
  if (s.osm.stato === 'caricamento') {
    osmChip = stateChip('controllo…', 'info')
    osmBody = h('p', { class: 'small muted' }, 'Cerco divieti, chiusure stagionali, pericoli e note sui tratti del sentiero…')
  } else if (s.osm.stato === 'errore') {
    osmChip = stateChip('non raggiunto', 'info')
    const retry = h('button', { type: 'button', class: 'btn-link' }, 'RIPROVA')
    retry.addEventListener('click', a.retryOsm)
    osmBody = h('p', { class: 'small muted' }, `Overpass non risponde (${s.osm.messaggio}). `, retry)
  } else if (!s.osm.trovati.length) {
    osmChip = stateChip('nessun divieto', 'aperto')
    osmBody = h('p', { class: 'small muted' }, 'Nessun divieto, chiusura stagionale, pericolo o nota di chiusura sui tratti mappati.')
  } else {
    const f0 = s.osm.trovati[0]
    osmChip = stateChip(f0.livello === 'chiuso' ? 'chiuso' : f0.livello === 'attenzione' ? 'attenzione' : 'info', f0.livello === 'chiuso' ? 'chiuso' : f0.livello === 'attenzione' ? 'attenzione' : 'info')
    osmBody = h('ul', { class: 'srclist' }, ...s.osm.trovati.slice(0, 8).map((f) => h('li', {}, h('span', { class: `srcstate inline ${f.livello}` }, f.livello), ' ', f.testo, ' · ', ext(f.url, 'vedi'))))
  }
  const c = t0 ? [(t0.bbox[1] + t0.bbox[3]) / 2, (t0.bbox[0] + t0.bbox[2]) / 2] : null
  box.append(block('OpenStreetMap', osmChip, osmBody, c ? h('p', { class: 'small' }, ext(`https://www.openstreetmap.org/#map=15/${c[0].toFixed(5)}/${c[1].toFixed(5)}`, 'Apri la mappa OSM qui')) : null))

  // 6. Controllo manuale
  const month = Number(s.day.slice(5, 7))
  const high = s.trails.some((t) => (t.quota_max ?? 0) >= 1500)
  const links: HTMLElement[] = [
    ext(`https://www.google.com/search?q=${encodeURIComponent(`SAT sentiero ${nums} percorribilità`)}`, 'SAT: cerca il sentiero'),
    ext('https://www.sat.tn.it/', 'Sito SAT'),
    ext('https://www.ufficiostampa.provincia.tn.it/Comunicati', 'Comunicati della Provincia'),
  ]
  if (high && (month >= 11 || month <= 5)) links.push(ext('https://avalanche.report/bulletin/latest', 'Bollettino valanghe'))
  box.append(block('Controllo manuale', null, h('p', { class: 'small srclinks' }, ...links.flatMap((l, i) => (i ? [' · ', l] : [l])))))
  box.append(h('p', { class: 'hint' }, 'Stima da fonti pubbliche, nessuna è completa: prima di partire controlla i link qui sopra e, sul posto, la segnaletica SAT.'))
  return box
}

function reportForm(s: StatusInput, a: StatusActions): HTMLElement {
  if (!a.logged) {
    const b = h('button', { type: 'button', class: 'btn-link' }, 'ACCEDI')
    b.addEventListener('click', a.login)
    return h('p', { class: 'small muted' }, 'Sei passato di lì? ', b, ' per segnalare com’era.')
  }
  const wrap = h('div', { class: 'reportform' })
  const choose = h('select', { 'aria-label': 'Sentiero' }) as HTMLSelectElement
  for (const t of s.trails) choose.append(h('option', { value: t.id }, `${t.numero}${s.isRoute ? ` · ${t.titolo}` : ''}`))
  const date = h('input', { type: 'date', max: todayIso(), 'aria-label': 'Quando l’hai visto' }) as HTMLInputElement
  date.value = todayIso()
  const nota = h('input', { type: 'text', maxlength: '300', placeholder: 'Cosa hai visto? (facoltativo: frana al km 2, cartello SAT…)', 'aria-label': 'Nota' }) as HTMLInputElement
  const send = (stato: ReportView['stato']) => async (ev: Event) => {
    const b = ev.currentTarget as HTMLButtonElement
    if (!date.value || date.value > todayIso()) return a.toast('Scegli una data valida (non nel futuro).')
    b.disabled = true
    try {
      await a.report({ sentiero: choose.value, stato, nota: nota.value.trim() || null, data: date.value })
      a.toast('Segnalazione inviata: la vedono tutti gli utenti dell’app.')
    } catch (e) {
      a.toast(`Non inviata: ${(e as Error).message}`)
    } finally {
      b.disabled = false
    }
  }
  const btns = h('div', { class: 'reportbtns' })
  for (const [stato, text] of [['chiuso', 'È CHIUSO'], ['pericolo', 'PERICOLO'], ['aperto', 'È APERTO']] as const) {
    const b = h('button', { type: 'button', class: `btn-outline small rep-${stato}` }, text)
    b.addEventListener('click', send(stato))
    btns.append(b)
  }
  wrap.append(h('p', { class: 'small' }, 'Sei passato di lì? Segnala com’era:'))
  if (s.trails.length > 1) wrap.append(choose)
  wrap.append(h('div', { class: 'reportrow' }, date, nota), btns)
  if (s.trails.length <= 1) choose.value = s.trails[0]?.id ?? ''
  return wrap
}
