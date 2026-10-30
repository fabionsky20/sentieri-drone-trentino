// Evidenziazione del sentiero/percorso aperto (2D e 3D) e anteprima di volo 3D.
// Uso: npm run build && npx vite preview --port 4173   poi   node e2e/vista3d.mjs [url]
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
const get = async (f) => (await fetch(new URL(`data/${f}`, BASE))).json()
const HL = [0x7c, 0x3a, 0xed] // HIGHLIGHT in src/highlight.ts

const segments = await get('segments.geojson')
const coordsOf = (id) =>
  segments.features
    .filter((f) => f.properties.sentiero_id === id && f.geometry?.type === 'LineString')
    .sort((a, b) => Number(a.properties.id.split('#')[1]) - Number(b.properties.id.split('#')[1]))
    .flatMap((f) => f.geometry.coordinates)
const at = (id, frac) => {
  const c = coordsOf(id)
  return c[Math.min(c.length - 1, Math.max(0, Math.round((c.length - 1) * frac)))]
}

const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
async function open(kind = 'desktop') {
  const ctx = await browser.newContext(kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } })
  await mockWeather(ctx)
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && !/Cross-Origin-Opener-Policy|Failed to load resource/.test(m.text()) && errors.push(`${kind}: ${m.text()}`))
  await p.goto(BASE)
  await p.waitForFunction(() => document.querySelector('#day-label')?.textContent)
  await p.waitForTimeout(1500)
  return p
}
const phone = (p) => p.viewportSize().width < 768
async function frame(p, pts) {
  await p.evaluate(
    ({ pts, phone }) => {
      const m = window.__q120map
      const lon = pts.map((x) => x[0])
      const lat = pts.map((x) => x[1])
      m.fitBounds([Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)], { padding: phone ? { top: 300, bottom: 260, left: 60, right: 90 } : 140, maxZoom: 15, duration: 0 })
    },
    { pts, phone: phone(p) },
  )
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
  if (phone(p)) await p.touchscreen.tap(xy.x, xy.y)
  else await p.mouse.click(xy.x, xy.y)
  await p.waitForTimeout(600)
}
/** Colori disegnati sulla mappa attorno a un punto (letti dal canvas WebGL durante il render). */
async function pixelsAround(p, c, r = 6) {
  return p.evaluate(
    ({ c, r }) =>
      new Promise((res) => {
        const m = window.__q120map
        m.once('render', () => {
          const gl = m.getCanvas()
          const k = gl.width / gl.clientWidth
          const px = m.project(c)
          const cv = document.createElement('canvas')
          cv.width = gl.width
          cv.height = gl.height
          const g = cv.getContext('2d')
          g.drawImage(gl, 0, 0)
          const d = g.getImageData(Math.round((px.x - r) * k), Math.round((px.y - r) * k), Math.round(2 * r * k), Math.round(2 * r * k)).data
          const out = []
          for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]])
          res(out)
        })
        m.triggerRepaint()
      }),
    { c, r },
  )
}
const near = (a, b, tol = 40) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < tol
const hasHL = (px) => px.filter((x) => near(x, HL)).length
const focusOn = (p) => p.evaluate(() => JSON.stringify(window.__q120map.getPaintProperty('seg-line', 'line-opacity')))

async function openTrail(p, q) {
  if (phone(p)) await p.locator('#search-input').tap()
  await p.fill('#search-input', q)
  await p.locator('#search-results button').first().click()
  await p.waitForTimeout(1500)
}

// ---- 1. evidenziazione 2D di un sentiero SAT, e ritorno alla normalità
for (const kind of ['desktop', 'mobile']) {
  const p = await open(kind)
  const pt = at('E325', 0.5)
  await frame(p, [at('E325', 0.3), at('E325', 0.7)])
  const before = hasHL(await pixelsAround(p, pt))
  await openTrail(p, 'E325')
  await frame(p, [at('E325', 0.3), at('E325', 0.7)])
  const filt = await p.evaluate(() => JSON.stringify(window.__q120map.getFilter('seg-sel')))
  const px = await pixelsAround(p, pt)
  check(before === 0 && hasHL(px) > 5 && /E325/.test(filt), `${kind}: sentiero aperto in violetto (${hasHL(px)} pixel, prima ${before})`)
  check(/E325/.test(await focusOn(p)), `${kind}: gli altri sentieri attenuati`)
  await p.screenshot({ path: `${OUT}/evidenzia_2d_${kind}.png` })
  await p.locator('#panel-close').click()
  await p.waitForTimeout(500)
  check(!/E325/.test(await focusOn(p)) && hasHL(await pixelsAround(p, pt)) === 0, `${kind}: chiusa la scheda torna tutto normale`)
  await p.context().close()
}

// ---- 2. evidenziazione 2D di un percorso personalizzato
{
  const p = await open()
  const a = at('E310', 0.3)
  const b = at('E322', 0.3)
  await frame(p, [a, b])
  await p.click('#route-btn')
  await tap(p, a)
  await p.waitForFunction(() => /ARRIVO/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 10000 })
  await tap(p, b)
  await p.waitForFunction(() => /Percorso pronto/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 15000 })
  await p.waitForTimeout(800)
  const color = await p.evaluate(() => window.__q120map.getPaintProperty('route-line', 'line-color'))
  check(String(color).toLowerCase() === '#7c3aed', `percorso nel colore di evidenziazione (${color})`)
  check(/percorso:/.test(await focusOn(p)), 'percorso aperto: sentieri SAT attenuati')
  await p.screenshot({ path: `${OUT}/evidenzia_2d_percorso.png` })
  await p.context().close()
}

console.log(`OK (${ok.length})`)
for (const m of ok) console.log('  ' + m)
console.log(`\nFALLITI (${fail.length}):`)
for (const m of fail) console.log('  ' + m)
console.log('\nERRORI', errors)
await browser.close()
process.exit(fail.length || errors.length ? 1 : 0)
