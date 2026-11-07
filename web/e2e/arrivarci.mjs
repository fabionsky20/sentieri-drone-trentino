// Prova di "Come arrivarci": clic su un punto (lago) → percorsi da tutti i parcheggi vicini, filtri.
// Uso: npm run build && npx vite preview --port 4173   poi   node e2e/arrivarci.mjs [url] [cartella] [canale]
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

for (const kind of ['desktop', 'mobile']) {
  const ctx = await browser.newContext(kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } })
  await mockWeather(ctx)
  await ctx.route(/overpass/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' }))
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`))
  await p.goto(BASE)
  await p.waitForFunction(() => document.querySelector('#day-label')?.textContent, null, { timeout: 60000 })
  await p.waitForTimeout(1500)
  await p.fill('#search-input', 'lago di tovel')
  await p.locator('#search-results button').first().click()
  await p.waitForFunction(() => /Come arrivarci · \d+/.test(document.querySelector('.reach')?.textContent ?? ''), null, { timeout: 30000 })
  const head = await p.locator('.reach .section-label').first().innerText()
  const n = Number(/(\d+)/.exec(head)?.[1] ?? 0)
  check(n > 0, `${kind}: ${head}`)
  const feats = await p.evaluate(() => window.__q120map.getSource('reach')._data?.features?.length ?? window.__q120map.querySourceFeatures('reach').length)
  check(feats > 0, `${kind}: percorsi evidenziati sulla mappa (${feats} elementi)`)
  if (kind === 'desktop') {
    await p.screenshot({ path: `${OUT}/arrivarci-pc.png` })
    // filtro: lunghezza max 3 km → meno percorsi, tutti ≤ 3 km
    await p.locator('.reachfilters > summary').click()
    await p.waitForTimeout(300)
    await p.locator('.reachfilters input[aria-label="Lunghezza max"]').evaluate((el) => {
      el.value = '3'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await p.waitForTimeout(1500)
    const head2 = await p.locator('.reach .section-label').first().innerText()
    const n2 = Number(/(\d+)/.exec(head2)?.[1] ?? 0)
    check(n2 < n, `filtro 3 km: da ${n} a ${n2} percorsi`)
    const kms = (await p.locator('.reach .card-km').allInnerTexts()).map((k) => Number(k.replace(' km', '').replace(',', '.')))
    check(kms.every((v) => v <= 3), 'filtro 3 km: tutti entro 3 km')
    check((await p.locator('.reachfilters input[aria-label="Lunghezza max"]').count()) === 1, 'i filtri restano aperti durante il ricalcolo')
    await p.screenshot({ path: `${OUT}/arrivarci-filtro.png` })
    if (n2) {
      await p.locator('.reach .card-main').first().click()
      await p.waitForTimeout(1500)
      check(/Lago di Tovel/i.test(await p.locator('.trail .title').innerText()), 'apre il percorso scelto')
    }
  } else {
    await p.screenshot({ path: `${OUT}/arrivarci-telefono.png` })
  }
  await ctx.close()
}
await browser.close()
console.log(ok.map((m) => `ok   ${m}`).join('\n'))
console.log(fail.map((m) => `FAIL ${m}`).join('\n'))
if (errors.length) console.log('errori in pagina:\n' + [...new Set(errors)].join('\n'))
process.exit(fail.length || errors.length ? 1 : 0)
