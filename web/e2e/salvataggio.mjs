// Prova del salvataggio dei percorsi personalizzati: creo un percorso su un "dispositivo", lo salvo
// nei miei e in una bacheca, poi lo riapro da un secondo dispositivo con lo stesso account.
// Usa gli emulatori Firebase (progetto demo, nessun dato vero):
//   cd firebase-test && npm run emulatori        (in un altro terminale, serve Java 21)
//   cd web && npm run build && npx vite preview --port 4173
//   node e2e/salvataggio.mjs [url]
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { mockWeather } from './mock.mjs'

const BASE = process.argv[2] ?? 'http://localhost:4173/'
const OUT = process.argv[3] ?? 'e2e/screenshot'
const URL_EMU = `${BASE}?emulatori`
mkdirSync(OUT, { recursive: true })
const ok = []
const fail = []
const errors = []
const check = (c, m) => (c ? ok : fail).push(m)

// Emulatori puliti a ogni giro.
await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-quota120/databases/(default)/documents', { method: 'DELETE' })
await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-quota120/accounts', { method: 'DELETE' })

const segments = await (await fetch(new URL('data/segments.geojson', BASE))).json()
const coordsOf = (id) =>
  segments.features
    .filter((f) => f.properties.sentiero_id === id && f.geometry?.type === 'LineString')
    .sort((a, b) => Number(a.properties.id.split('#')[1]) - Number(b.properties.id.split('#')[1]))
    .flatMap((f) => f.geometry.coordinates)
const at = (id, frac) => {
  const c = coordsOf(id)
  return c[Math.round((c.length - 1) * frac)]
}

const browser = await chromium.launch({ channel: 'msedge' })
async function open(kind) {
  const ctx = await browser.newContext(kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } })
  await mockWeather(ctx)
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && !/Cross-Origin-Opener-Policy/.test(m.text()) && errors.push(`${kind}: ${m.text()}`))
  await p.goto(URL_EMU)
  await p.waitForFunction(() => document.querySelector('#day-label')?.textContent)
  await p.waitForTimeout(1000)
  return p
}

/** Login Google sull'emulatore: la finestra dell'emulatore crea (o sceglie) l'account. */
async function login(p, first) {
  const btn = p.getByRole('button', { name: /ACCEDI CON GOOGLE/i }).first()
  if (!(await btn.isVisible().catch(() => false))) {
    await p.locator(p.viewportSize().width < 768 ? '.tabbar [data-tab="saved"]' : '#open-saved').first().click()
  }
  const [pop] = await Promise.all([p.waitForEvent('popup'), btn.click()])
  await pop.waitForLoadState()
  if (first) {
    await pop.getByText(/Add new account/i).click()
    await pop.locator('#email-input').fill('pilota@example.com')
    await pop.locator('#display-name-input').fill('Pilota Prova')
    await pop.getByRole('button', { name: /Sign in with Google/i }).click()
  } else {
    await pop.getByText('pilota@example.com').click()
  }
  await p.waitForFunction(() => !document.querySelector('#saved-body')?.textContent?.match(/ACCEDI CON GOOGLE/i), null, { timeout: 15000 })
  // onboarding: "SALTA TUTTO"
  if (first) {
    await p.waitForSelector('#onboarding:not([hidden])', { timeout: 15000 })
    await p.locator('#onboarding').getByRole('button', { name: /SALTA TUTTO/i }).click()
    await p.waitForSelector('#onboarding', { state: 'hidden' })
  }
}

async function frame(p, pts) {
  await p.evaluate((pts) => {
    const m = window.__q120map
    const lon = pts.map((x) => x[0])
    const lat = pts.map((x) => x[1])
    m.fitBounds([Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)], { padding: 140, maxZoom: 15, duration: 0 })
  }, pts)
  await p.evaluate(() => new Promise((r) => window.__q120map.once('idle', r)))
  await p.waitForTimeout(300)
}
async function tap(p, c) {
  const xy = await p.evaluate((c) => {
    const m = window.__q120map
    const px = m.project(c)
    const r = m.getCanvas().getBoundingClientRect()
    return { x: px.x + r.left, y: px.y + r.top }
  }, c)
  await p.mouse.click(xy.x, xy.y)
  await p.waitForTimeout(500)
}
const txt = async (p, sel) => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ')

// ---- dispositivo 1 (PC): creo, rinomino, salvo, aggiungo a una bacheca
const NAME = 'Giro del Manghen'
let pieces1 = ''
{
  const p = await open('desktop')
  await login(p, true)
  await p.locator('#saved-close').click().catch(() => {})
  const a = at('E310', 0.3)
  const b = at('E322', 0.3)
  await frame(p, [a, b])
  await p.click('#route-btn')
  await tap(p, a)
  await p.waitForFunction(() => /ARRIVO/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 10000 })
  await tap(p, b)
  await p.waitForFunction(() => /Percorso pronto/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 15000 })
  pieces1 = await txt(p, '.routepieces')
  const name = p.locator('.route-name')
  check(await name.isVisible(), 'campo per il nome del percorso')
  await name.fill(NAME)
  await name.press('Enter')
  await p.waitForTimeout(300)
  check((await txt(p, '#panel-body h2, #panel-body .title')).includes(NAME), 'il titolo della scheda prende il nome scelto')
  const save = p.locator('#panel-foot .btn-primary').first()
  await save.click()
  await p.waitForFunction(() => /NEI MIEI/.test([...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent).join(' ')), null, { timeout: 10000 })
  check(true, 'SALVA NEI MIEI → "NEI MIEI"')
  await p.getByRole('button', { name: /AGGIUNGI A BACHECA/i }).click()
  await p.locator('.picker input[type="text"]').fill('Uscita di prova')
  await p.getByRole('button', { name: /CREA E AGGIUNGI/i }).click()
  await p.waitForSelector('#modal', { state: 'hidden', timeout: 10000 })
  check(true, 'bacheca creata con il percorso')
  // rinomino dopo il salvataggio: il nome cambia anche nei miei
  await name.fill(`${NAME} (2)`)
  await name.press('Enter')
  await p.waitForTimeout(1500)
  await p.screenshot({ path: `${OUT}/salvataggio_1_pc.png` })
  await p.context().close()
}

// ---- dispositivo 2 (telefono, nessun dato locale): lo ritrovo nei miei e nella bacheca
{
  const p = await open('mobile')
  await login(p, false)
  await p.waitForSelector('#saved-body .route-tag', { timeout: 15000 })
  const card = await txt(p, '#saved-body .cards')
  check(card.includes(`${NAME} (2)`), `il percorso c'è nei miei, rinominato: ${card.slice(0, 80)}`)
  await p.locator('#saved-body .card-main', { hasText: NAME }).first().click()
  await p.waitForSelector('#sheet .routepieces', { timeout: 15000 })
  const pieces2 = await txt(p, '#sheet .routepieces')
  check(pieces2 === pieces1, `stessi tratti dopo la riapertura: ${pieces2}`)
  check(await p.locator('#sheet .profile canvas').isVisible(), 'profilo altimetrico ricostruito')
  check(/NEI MIEI/.test(await txt(p, '#panel-foot')), 'risulta già salvato')
  await p.screenshot({ path: `${OUT}/salvataggio_2_telefono.png` })
  // bacheca
  await p.locator('#panel-close').click()
  await p.locator('.tabbar [data-tab="saved"]').first().click()
  await p.locator('#saved-body').getByText(/Bacheche ·/).first().click()
  await p.getByText('Uscita di prova').first().click()
  await p.waitForSelector('#board-body .route-tag', { timeout: 10000 })
  check((await txt(p, '#board-body')).includes(NAME), 'il percorso è nella bacheca')
  await p.locator('#board-body .card-main', { hasText: NAME }).first().click()
  await p.waitForSelector('#sheet .routepieces', { timeout: 15000 })
  check((await txt(p, '#sheet .routepieces')) === pieces1, 'si apre anche dalla bacheca')
  await p.screenshot({ path: `${OUT}/salvataggio_3_bacheca.png` })
  await p.context().close()
}

console.log(`OK (${ok.length})`)
for (const m of ok) console.log('  ' + m)
console.log(`\nFALLITI (${fail.length}):`)
for (const m of fail) console.log('  ' + m)
console.log('\nERRORI', errors)
await browser.close()
process.exit(fail.length || errors.length ? 1 : 0)
