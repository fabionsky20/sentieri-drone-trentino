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
// Se una prova si blocca, si vede comunque cosa era già passato.
process.on('uncaughtException', (e) => {
  console.log(`OK (${ok.length})`)
  for (const m of ok) console.log('  ' + m)
  console.log(`FALLITI (${fail.length})`)
  for (const m of fail) console.log('  ' + m)
  console.log('INTERROTTA:', e.message.split('\n')[0])
  process.exit(1)
})
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

const browser = await chromium.launch({ channel: 'msedge' })
async function open(kind = 'desktop') {
  const ctx = await browser.newContext(kind === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } })
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

// ---- 3. anteprima 3D
const profiles = await get('profiles.json')
const trailsList = await get('trails.json')
const poisFC = await get('pois.geojson')
const fly = (p) => p.evaluate(() => window.__q120fly.state?.() ?? null)
const camAlt = (p) => p.evaluate(() => window.__q120map._camera.transform.getCameraAltitude())
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 77_000, (a[1] - b[1]) * 111_000)
/** Aspetta che la camera sia ferma (quota e direzione assestate). */
async function settle(p, ms = 15000) {
  const t0 = Date.now()
  let prev = null
  while (Date.now() - t0 < ms) {
    await p.waitForTimeout(400)
    const s = await fly(p)
    const turn = s ? Math.abs(((s.brg - s.bearing + 540) % 360) - 180) : 99
    if (prev && s && Math.abs(s.alt - s.want) < 0.3 && turn < 0.3 && !s.playing && s.heading !== 'giro') return s
    prev = s
  }
  return fly(p)
}
async function setRange(p, label, v) {
  await p.evaluate(
    ({ label, v }) => {
      const i = document.querySelector(`.fly-panel input[aria-label="${label}"]`)
      i.value = String(v)
      i.dispatchEvent(new Event('input', { bubbles: true }))
    },
    { label, v },
  )
}
/** Pixel viola su tutta la scena (campione a griglia). */
async function hlOnScreen(p) {
  return p.evaluate(
    (HL) =>
      new Promise((res) => {
        const m = window.__q120map
        m.once('render', () => {
          const gl = m.getCanvas()
          const cv = document.createElement('canvas')
          cv.width = gl.width
          cv.height = gl.height
          const g = cv.getContext('2d')
          g.drawImage(gl, 0, 0)
          const d = g.getImageData(0, 0, cv.width, cv.height).data
          let n = 0
          for (let y = 0; y < cv.height; y += 3) {
            for (let x = 0; x < cv.width; x += 3) {
              const i = (y * cv.width + x) * 4
              if (Math.abs(d[i] - HL[0]) + Math.abs(d[i + 1] - HL[1]) + Math.abs(d[i + 2] - HL[2]) < 50) n++
            }
          }
          res(n)
        })
        m.triggerRepaint()
      }),
    HL,
  )
}
async function enter3d(p) {
  await p.locator('.flybox').getByRole('button', { name: /ANTEPRIMA VOLO/i }).click()
  await p.waitForFunction(() => document.body.classList.contains('fly3d') && window.__q120fly.state?.()?.alt != null, null, { timeout: 20000 })
  await p.evaluate(() => new Promise((r) => window.__q120map.once('idle', r))).catch(() => {})
}

for (const kind of ['desktop', 'mobile']) {
  const p = await open(kind)
  await openTrail(p, 'E325')
  const before = await p.evaluate(() => ({ c: window.__q120map.getCenter().toArray(), z: window.__q120map.getZoom() }))
  if (kind === 'mobile') await p.locator('#sheet-handle').click()
  await p.locator('.flybox').scrollIntoViewIfNeeded()
  await enter3d(p)
  const s = await settle(p)
  // parte dal punto più alto
  const prof = profiles.E325
  const iMax = prof.q.indexOf(Math.max(...prof.q))
  const T = trailsList.find((x) => x.id === 'E325')
  const mMax = ((iMax * prof.passo) / prof.lung) * T.lunghezza_m
  check(Math.abs(s.at - mMax) < 40, `${kind}: parte dal punto più alto (km ${(s.at / 1000).toFixed(2)}, atteso ${(mMax / 1000).toFixed(2)})`)
  const ca = await camAlt(p)
  check(Math.abs(s.alt - s.ground - 120) < 2 && Math.abs(ca - s.alt) < 2, `${kind}: camera 120 m sopra il terreno (${Math.round(s.alt - s.ground)} m, camera MapLibre ${Math.round(ca)} m s.l.m.)`)
  check((await hlOnScreen(p)) > 30, `${kind}: percorso in viola anche in 3D`)
  check(/E325/.test(await focusOn(p)), `${kind}: in 3D gli altri sentieri restano attenuati`)
  await p.screenshot({ path: `${OUT}/vista3d_1_${kind}.png` })
  // cursore: inizio e fine, sempre all'altezza scelta sopra il terreno di QUEL punto
  await setRange(p, 'Lungo il percorso', 0)
  const s0 = await settle(p)
  await setRange(p, 'Lungo il percorso', Math.round(s.L))
  const s1 = await settle(p)
  check(s0.at === 0 && dist(s0.pos, at('E325', 0)) < 30, `${kind}: cursore all'inizio del percorso`)
  check(Math.abs(s1.at - s.L) < 2 && dist(s1.pos, at('E325', 1)) < 30, `${kind}: cursore alla fine del percorso`)
  check(Math.abs(s0.alt - s0.ground - 120) < 3 && Math.abs(s1.alt - s1.ground - 120) < 3 && Math.abs(s0.ground - s1.ground) > 100, `${kind}: 120 m sopra il terreno in ogni punto (inizio ${Math.round(s0.ground)} m +${Math.round(s0.alt - s0.ground)}, fine ${Math.round(s1.ground)} m +${Math.round(s1.alt - s1.ground)})`)
  const readAt = await p.locator('.fly-along .fly-k .mono').innerText()
  check(/km [\d,]+ · [\d.]+ m/.test(readAt), `${kind}: km e quota del punto (${readAt})`)
  // altezza: avviso oltre 120 m, tetto a 500 m
  check(await p.locator('.fly-warn').isHidden(), `${kind}: a 120 m nessun avviso`)
  await setRange(p, 'Altezza sul terreno', 300)
  const s3 = await settle(p)
  check((await p.locator('.fly-warn').isVisible()) && /Solo visualizzazione/.test(await p.locator('.fly-warn').innerText()) && Math.abs(s3.alt - s3.ground - 300) < 3, `${kind}: a 300 m camera più alta e avviso "Solo visualizzazione" (${Math.round(s3.alt - s3.ground)} m, avviso ${await p.locator('.fly-warn').isVisible()})`)
  await setRange(p, 'Altezza sul terreno', 900)
  const s4 = await settle(p)
  check(s4.height === 500, `${kind}: altezza al massimo 500 m (${s4.height})`)
  await p.screenshot({ path: `${OUT}/vista3d_2_500m_${kind}.png` })
  await setRange(p, 'Altezza sul terreno', 120)
  check(await p.locator('.fly-warn').isHidden(), `${kind}: tornando a 120 m l'avviso sparisce`)
  // play / pausa, avanti e indietro
  await setRange(p, 'Lungo il percorso', 1000)
  await settle(p)
  await p.locator('.fly-play').click()
  await p.waitForTimeout(4000)
  const a1 = (await fly(p)).at
  await p.locator('.fly-play').click()
  const a2 = (await fly(p)).at
  await p.waitForTimeout(800)
  const a3 = (await fly(p)).at
  check(a1 > 1000 + 20 && Math.abs(a3 - a2) < 1, `${kind}: PLAY avanza (${Math.round(a1)} m), PAUSA si ferma`)
  await p.locator('.fly-panel [role="radio"]', { hasText: 'INDIETRO' }).click()
  await p.locator('.fly-play').click()
  await p.waitForTimeout(1500)
  await p.locator('.fly-play').click()
  check((await fly(p)).at < a3 - 10, `${kind}: all'indietro torna verso l'inizio`)
  // stabilità: fermi, orientamento fisso → quota costante
  await p.locator('.fly-panel [role="radio"]', { hasText: 'FISSO' }).click()
  const q0 = await settle(p)
  await p.waitForTimeout(3000)
  check(Math.abs((await camAlt(p)) - q0.alt) < 1, `${kind}: camera ferma, quota costante entro 1 m`)
  // gira 360°: cambia la direzione, non la quota
  await p.locator('.fly-panel [role="radio"]', { hasText: 'GIRA' }).click()
  const g0 = await fly(p)
  await p.waitForTimeout(4000)
  const g1 = await fly(p)
  check(Math.abs(g1.bearing - g0.bearing) > 5 && Math.abs(g1.alt - g0.alt) < 1, `${kind}: GIRA 360° ruota senza cambiare quota (${Math.round(g0.bearing)}° → ${Math.round(g1.bearing)}°, ${(g1.alt - g0.alt).toFixed(1)} m)`)
  await p.locator('.fly-panel [role="radio"]', { hasText: 'DIREZIONE' }).click()
  // modalità libera e ritorno sul percorso
  const onPath = await settle(p)
  await p.locator('.fly-free').click()
  if (kind === 'desktop') {
    await p.mouse.move(700, 400)
    await p.keyboard.down('w')
    await p.waitForTimeout(3000)
    await p.keyboard.up('w')
    await p.mouse.wheel(0, -300)
  } else {
    // due dita: spostamento; pizzico: altezza (eventi touch via CDP)
    const cdp = await p.context().newCDPSession(p)
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
    await touch('touchStart', [[150, 200], [250, 200]])
    for (let k = 1; k <= 10; k++) await touch('touchMove', [[150 - k * 6, 200 + k * 12], [250 + k * 6, 200 + k * 12]])
    await touch('touchEnd', [])
  }
  const fr = await settle(p)
  check(fr.free && dist(fr.pos, onPath.pos) > 40, `${kind}: modalità libera, la camera si stacca dal percorso (${Math.round(dist(fr.pos, onPath.pos))} m)`)
  check(fr.height !== 120, `${kind}: ${kind === 'desktop' ? 'rotella' : 'pizzico'} cambia l'altezza (${fr.height} m)`)
  check(await p.evaluate(() => !!window.__q120map.getLayer('fly-path-line')), `${kind}: percorso ancora disegnato in modalità libera`)
  await p.screenshot({ path: `${OUT}/vista3d_3_libera_${kind}.png` })
  await p.locator('.fly-back').click() // TORNA SUL PERCORSO (pulsante sulla scena)
  const back = await settle(p)
  check(!back.free && dist(back.pos, onPath.pos) < 5, `${kind}: "Torna sul percorso" riporta al punto del cursore`)
  // uscita: tutto come prima
  await p.keyboard.press('Escape')
  await p.waitForTimeout(800)
  const after = await p.evaluate(() => ({
    c: window.__q120map.getCenter().toArray(),
    z: window.__q120map.getZoom(),
    terrain: !!window.__q120map.getTerrain(),
    layers: window.__q120map.getStyle().layers.filter((l) => l.id.startsWith('fly-')).length,
    fly: document.body.classList.contains('fly3d'),
  }))
  check(!after.fly && !after.terrain && after.layers === 0 && dist(after.c, before.c) < 50 && Math.abs(after.z - before.z) < 0.01, `${kind}: uscita, mappa e vista come prima`)
  check(/E325/.test(await focusOn(p)), `${kind}: dopo l'anteprima il sentiero resta evidenziato (scheda aperta)`)
  await p.context().close()
}

// ---- 4. anteprima di un percorso personalizzato con un pezzo fuori sentiero (tratteggiato)
{
  const poiById = new Map(poisFC.features.map((f) => [f.properties.id, f]))
  let lake = null
  for (const t of trailsList) {
    const x = t.poi.find((q) => poiById.get(q.id)?.properties.categoria === 'lago' && q.d > 80 && q.d < 300 && q.km > 1)
    if (x) {
      lake = { trail: t.id, poi: poiById.get(x.id) }
      break
    }
  }
  const p = await open()
  const a = at(lake.trail, 0.05)
  const c = lake.poi.geometry.coordinates
  await frame(p, [a, c])
  await p.click('#route-btn')
  await tap(p, a)
  await p.waitForFunction(() => /ARRIVO/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 10000 })
  await tap(p, c)
  await p.waitForFunction(() => /Percorso pronto/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 15000 })
  await p.click('.route-bar >> text=CHIUDI')
  await p.locator('.flybox').scrollIntoViewIfNeeded()
  await enter3d(p)
  const s = await settle(p)
  const dash = await p.evaluate(() => window.__q120map.querySourceFeatures('fly-path').filter((f) => f.properties.kind === 'straight').length)
  check(dash > 0, 'percorso: il pezzo fuori sentiero è tratteggiato sul terreno')
  await setRange(p, 'Lungo il percorso', Math.round(s.L) - 20)
  const e = await settle(p)
  const readE = await p.locator('.fly-along .fly-k .mono').innerText()
  check(/in linea retta/.test(readE) && dist(e.pos, c) < 60, `percorso: la camera attraversa in linea retta fino a ${lake.poi.properties.nome} (${readE})`)
  check(e.alt >= e.ground + 117, 'percorso: anche lì sopra il terreno')
  await p.screenshot({ path: `${OUT}/vista3d_4_percorso.png` })
  await p.keyboard.press('Escape')
  await p.context().close()
}

console.log(`OK (${ok.length})`)
for (const m of ok) console.log('  ' + m)
console.log(`\nFALLITI (${fail.length}):`)
for (const m of fail) console.log('  ' + m)
console.log('\nERRORI', errors)
await browser.close()
process.exit(fail.length || errors.length ? 1 : 0)
