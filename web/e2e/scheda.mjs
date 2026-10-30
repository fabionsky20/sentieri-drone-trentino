// Prova della scheda del sentiero: meteo a tendina e "Come arrivare".
// Uso: npm run build && npx vite preview --port 4173   poi   npm run e2e [-- <url>]
// Usa Microsoft Edge già installato (playwright-core, nessun browser scaricato).
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { mockWeather } from './mock.mjs'

const BASE = process.argv[2] ?? 'http://localhost:4173/'
const OUT = process.argv[3] ?? 'e2e/screenshot'
mkdirSync(OUT, { recursive: true })
const ok = []
const fail = []
const errors = []
const check = (c, m) => (c ? ok : fail).push(m)
const browser = await chromium.launch({ channel: 'msedge' })

async function open(kind) {
  const ctx = await browser.newContext(kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } })
  await mockWeather(ctx)
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && !/Cross-Origin-Opener-Policy/.test(m.text()) && errors.push(`${kind}: ${m.text()}`))
  await p.goto(BASE)
  await p.waitForFunction(() => document.querySelector('#day-label')?.textContent)
  await p.waitForTimeout(1500)
  return p
}
async function openTrail(p, q) {
  await p.fill('#search-input', q)
  await p.locator('#search-results button').first().click()
  await p.waitForTimeout(1500)
}
const txt = async (p, sel) => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ')

// ---------------- meteo a tendina (PC)
{
  const p = await open('desktop')
  await openTrail(p, 'e310')
  const acc = p.locator('.wxacc')
  check((await acc.count()) === 1 && !(await acc.evaluate((d) => d.open)), 'meteo: tendina chiusa di default')
  check(!(await p.locator('.wxacc .wxtable').isVisible()), 'meteo: dettagli nascosti')
  await p.waitForFunction(() => /\d/.test(document.querySelector('.wxbadge')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {})
  const sum = await txt(p, '.wxsum')
  check(/Meteo · volabilità/i.test(sum) && /\d+ (Ottimo|Buono|Discreto|Scarso|Non volabile)/.test(sum), `meteo: intestazione con esito (${sum})`)
  await p.screenshot({ path: `${OUT}/meteo_chiuso.png` })
  await p.locator('.wxsum').click()
  await p.waitForTimeout(300)
  check(await p.locator('.wxacc .wxtable').isVisible(), 'meteo: tocco → dettagli aperti')
  // resta aperta se la scheda si ridisegna (nuovo giorno), si richiude cambiando sentiero
  await p.locator('.wxcell').nth(10).click()
  await p.waitForTimeout(300)
  check(await acc.evaluate((d) => d.open), 'meteo: resta aperta mentre la uso')
  await openTrail(p, 'e101')
  check(!(await p.locator('.wxacc').evaluate((d) => d.open)), 'meteo: chiusa aprendo un altro sentiero')
  await p.context().close()
}

// ---------------- meteo a tendina (telefono)
{
  const p = await open('mobile')
  await openTrail(p, 'e310')
  check(!(await p.locator('.wxacc').evaluate((d) => d.open)), 'telefono: meteo chiuso di default')
  const box = await p.locator('.wxsum').boundingBox()
  check(box && box.height >= 44, `telefono: intestazione toccabile (${Math.round(box?.height ?? 0)} px)`)
  await p.locator('.wxsum').tap()
  await p.waitForTimeout(300)
  check(await p.locator('.wxacc .wxtable').isVisible(), 'telefono: tocco apre i dettagli')
  await p.context().close()
}

console.log(`OK (${ok.length})`)
for (const m of ok) console.log('  ' + m)
console.log(`\nFALLITI (${fail.length}):`)
for (const m of fail) console.log('  ' + m)
console.log('\nERRORI', errors)
await browser.close()
process.exit(fail.length || errors.length ? 1 : 0)
