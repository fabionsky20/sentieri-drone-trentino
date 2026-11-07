// Prova delle novità di novembre 2026: "Trova percorsi" (percorsi combinati), filtri di
// lunghezza min/pendenza/parcheggio, stato aperto/chiuso con le fonti, "segna come fatto" sui percorsi.
// Uso: npm run build && npx vite preview --port 4173   poi   node e2e/nuove.mjs [url] [cartella] [canale]
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { mockWeather } from './mock.mjs'

const BASE = process.argv[2] ?? 'http://localhost:4173/'
const OUT = process.argv[3] ?? 'e2e/screenshot'
const CHANNEL = process.argv[4] ?? 'msedge'
mkdirSync(OUT, { recursive: true })
const ok = []
const fail = []
const errors = []
const check = (c, m) => (c ? ok : fail).push(m)
const browser = await chromium.launch({ channel: CHANNEL })

// Overpass finto: un tratto con divieto sotto la linea di E310 (le coordinate arrivano dalla pagina).
let fakeWay = null
async function open(kind) {
  const ctx = await browser.newContext(kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } })
  await mockWeather(ctx)
  await ctx.route(/overpass/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: fakeWay ? [fakeWay] : [] }) }))
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && !/Cross-Origin-Opener-Policy|Failed to load resource|ERR_|AJAXError|avvisi\.json/.test(m.text()) && errors.push(`${kind}: ${m.text()}`))
  await p.goto(BASE)
  await p.waitForFunction(() => document.querySelector('#day-label')?.textContent, null, { timeout: 60000 })
  await p.waitForTimeout(1500)
  return p
}
async function openTrail(p, q) {
  await p.fill('#search-input', q)
  await p.locator('#search-results button').first().click()
  await p.waitForTimeout(1200)
}

// ---------------- stato aperto/chiuso: tendina con le fonti
{
  const p = await open('desktop')
  await openTrail(p, 'e310')
  const pill = p.locator('.statuspill')
  check((await pill.count()) === 1, 'stato: bollino in cima alla scheda')
  const acc = p.locator('.statusacc')
  check((await acc.count()) === 1 && !(await acc.evaluate((d) => d.open)), 'stato: tendina chiusa di default')
  await pill.click()
  await p.waitForTimeout(300)
  check(await acc.evaluate((d) => d.open), 'stato: il bollino apre la tendina')
  const names = await p.locator('.srcname').allInnerTexts()
  check(names.length >= 5, `stato: ${names.length} fonti elencate (${names.join(' | ')})`)
  check((await p.locator('.srcblock a[href*="openstreetmap.org"]').count()) >= 1, 'stato: link a OSM per il controllo manuale')
  check((await p.locator('.srcblock a[href*="ufficiostampa"]').count()) >= 1, 'stato: link ai comunicati della Provincia')
  await p.screenshot({ path: `${OUT}/stato-pc.png` })

  // un tratto OSM con divieto, sopra la linea del sentiero → CHIUSO (secondo OSM)
  const coords = await p.evaluate(() => {
    const m = window.__q120map
    const f = m.querySourceFeatures('segments', { filter: ['==', ['get', 'sentiero_id'], 'E310'] })[0]
    return f?.geometry?.coordinates?.slice(0, 6) ?? null
  })
  check(!!coords, 'stato: coordinate di E310 lette dalla mappa')
  if (coords) {
    fakeWay = { type: 'way', id: 123, tags: { highway: 'path', access: 'no', name: 'Prova' }, geometry: coords.map(([lon, lat]) => ({ lon, lat })) }
    const p2 = await open('desktop')
    await p2.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('osm-stato')).forEach((k) => localStorage.removeItem(k)))
    await openTrail(p2, 'e310')
    await p2.waitForTimeout(800)
    const t = await p2.locator('.statuspill').innerText()
    check(/CHIUSO/.test(t), `stato: divieto OSM sotto la linea → ${t.trim()}`)
    await p2.locator('.statuspill').click()
    await p2.waitForTimeout(300)
    await p2.screenshot({ path: `${OUT}/stato-osm-chiuso.png` })
    fakeWay = null
  }
}

// ---------------- filtri nuovi + Trova percorsi (PC)
{
  const p = await open('desktop')
  const tiles = await p.locator('.tile-k').allInnerTexts()
  const low = tiles.map((t) => t.toLowerCase())
  check(low.includes('lunghezza min') && low.includes('pendenza max') && low.includes('quota max raggiunta'), `filtri: nuovi cursori (${tiles.join(', ')})`)
  // lago come meta, max 5 km, pendenza max 30 %
  await p.locator('.chiptoggle', { hasText: 'Lago' }).first().click()
  const setRange = async (title, v) => {
    const r = p.locator(`input[aria-label="${title}"]`)
    await r.evaluate((el, val) => {
      el.value = String(val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, v)
  }
  await setRange('Lunghezza min', 1)
  await setRange('Lunghezza max', 5)
  await setRange('Pendenza max', 30)
  await p.waitForTimeout(800)
  // tutta la provincia, non solo la zona visibile
  const only = p.locator('.finder input[role="switch"]')
  if (await only.isChecked()) await only.click()
  await p.locator('.finder .btn-primary').click()
  await p.waitForFunction(() => !/CERCO/.test(document.querySelector('.finder .btn-primary')?.textContent ?? ''), null, { timeout: 30000 })
  await p.waitForTimeout(300)
  const n = await p.locator('.finder .cards .card').count()
  check(n > 0, `trova percorsi: ${n} risultati per laghi 1–5 km, pendenza ≤ 30 %`)
  const kms = await p.locator('.finder .card-km').allInnerTexts()
  const vals = kms.map((k) => Number(k.replace(' km', '').replace(',', '.')))
  check(vals.every((v) => v >= 1 && v <= 5), `trova percorsi: lunghezze nei limiti (${vals.slice(0, 5).join(', ')}…)`)
  const slopes = (await p.locator('.finder .card-main').allInnerTexts()).map((t) => Number(/pendenza max (\d+)/.exec(t)?.[1] ?? 999))
  check(slopes.every((v) => v <= 30), 'trova percorsi: pendenza nei limiti')
  check((await p.locator('.finder .pill.combo').count()) > 0, 'trova percorsi: almeno un percorso COMBINATO')
  await p.locator('.finder').screenshot({ path: `${OUT}/trova-risultati.png` })
  // apre il primo combinato come percorso personalizzato
  await p.locator('.finder .card', { has: p.locator('.pill.combo') }).first().locator('.card-main').click()
  await p.waitForTimeout(1500)
  const title = await p.locator('.trail .title').innerText()
  check(/ da /.test(title), `trova percorsi: aperto come percorso ("${title}")`)
  check((await p.locator('.routebox').count()) >= 1, 'trova percorsi: scheda del percorso con i pezzi')
  check((await p.locator('.mybox .mytrail').count()) === 1, 'percorso: sezione "Le mie uscite" presente')
  check((await p.locator('.mybox button', { hasText: 'ACCEDI CON GOOGLE' }).count()) === 1, 'percorso: senza login invita ad accedere per segnarlo come fatto')
  check((await p.locator('.statusacc').count()) === 1, 'percorso: stato aperto/chiuso dei sentieri usati')
  await p.screenshot({ path: `${OUT}/trova-percorso.png` })
  // cambiare un filtro invalida i risultati
  await setRange('Pendenza max', 40)
  await p.waitForTimeout(400)
  check(/Filtri cambiati/.test(await p.locator('.finder').innerText()), 'trova percorsi: filtri cambiati → risultati da rifare')
}

// ---------------- telefono
{
  const p = await open('mobile')
  await openTrail(p, 'e310')
  await p.locator('.statuspill').click()
  await p.waitForTimeout(400)
  const w = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  check(w, 'telefono: niente scorrimento orizzontale con la tendina aperta')
  await p.screenshot({ path: `${OUT}/stato-telefono.png` })
}

await browser.close()
console.log(ok.map((m) => `ok   ${m}`).join('\n'))
console.log(fail.map((m) => `FAIL ${m}`).join('\n'))
if (errors.length) console.log('errori in pagina:\n' + [...new Set(errors)].join('\n'))
process.exit(fail.length || errors.length ? 1 : 0)
