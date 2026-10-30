// Prova dei percorsi personalizzati: partenza a metà sentiero, cambio di sentiero a un bivio,
// arrivo su una meta fuori sentiero (tratteggio), reti non collegate (buco segnalato).
// Uso: npm run build && npx vite preview --port 4173   poi   node e2e/percorsi.mjs [url]
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

// ---- dati per scegliere i casi
const [segments, trails, net, poisFC] = await Promise.all([get('segments.geojson'), get('trails.json'), get('network.json'), get('pois.geojson')])
const coordsOf = (id) =>
  segments.features
    .filter((f) => f.properties.sentiero_id === id && f.geometry?.type === 'LineString')
    .sort((a, b) => Number(a.properties.id.split('#')[1]) - Number(b.properties.id.split('#')[1]))
    .flatMap((f) => f.geometry.coordinates)
const at = (id, frac) => {
  const c = coordsOf(id)
  return c[Math.min(c.length - 1, Math.max(0, Math.round((c.length - 1) * frac)))]
}
const T = new Map(trails.map((t) => [t.id, t]))
const comps = new Map() // sentiero → componente
for (const [a, , trail] of net.archi) comps.set(trail, net.nodi[a][2])
const poiById = new Map(poisFC.features.map((f) => [f.properties.id, f]))

// Caso 3: un lago tra 80 e 300 m da un sentiero (meta fuori sentiero)
let lakeCase = null
for (const t of trails) {
  const p = t.poi.find((x) => poiById.get(x.id)?.properties.categoria === 'lago' && x.d > 80 && x.d < 300 && x.km > 1)
  if (p) {
    lakeCase = { trail: t.id, poi: poiById.get(p.id) }
    break
  }
}
// Caso 4: due sentieri vicini (estremi a meno di 2 km) in reti diverse
let gapCase = null
const ends = trails.map((t) => ({ id: t.id, c: [at(t.id, 0), at(t.id, 1)] }))
const dm = (a, b) => Math.hypot((a[0] - b[0]) * 77_000, (a[1] - b[1]) * 111_000)
outer: for (let i = 0; i < ends.length; i++) {
  for (let j = i + 1; j < ends.length; j++) {
    if (comps.get(ends[i].id) === comps.get(ends[j].id)) continue
    for (const a of ends[i].c) for (const b of ends[j].c) {
      const d = dm(a, b)
      if (d > 400 && d < 2000) {
        gapCase = { a: ends[i].id, b: ends[j].id, d }
        break outer
      }
    }
  }
}
console.log('Casi:', { lago: lakeCase && `${lakeCase.trail} → ${lakeCase.poi.properties.nome}`, buco: gapCase && `${gapCase.a} ↔ ${gapCase.b} (~${Math.round(gapCase.d)} m)` })

// ---- browser
const browser = await chromium.launch({ channel: 'msedge' })
async function open(kind = 'desktop') {
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
/** Inquadra i punti e aspetta che la mappa sia ferma (le linee devono essere disegnate per il tocco). */
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
const routeFeatures = (p) => p.evaluate(() => window.__q120map.querySourceFeatures('route').map((f) => ({ kind: f.properties.kind, label: f.properties.label })))
async function makeRoute(p, a, b) {
  await frame(p, [a, b])
  await p.click('#route-btn')
  await p.waitForSelector('.route-bar')
  await tap(p, a)
  await p.waitForFunction(() => /ARRIVO/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 10000 })
  await tap(p, b)
  await p.waitForFunction(() => /Percorso pronto/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 15000 })
  await p.waitForTimeout(800)
}

// 1. dentro un unico sentiero, partenza a metà
{
  const p = await open()
  check(await p.locator('#route-btn').isVisible(), 'pulsante "Crea percorso" sulla mappa')
  await makeRoute(p, at('E325', 0.25), at('E325', 0.6))
  const pieces = await txt(p, '.routepieces')
  check(/^E325 per [\d,]+ km$/.test(pieces), `un solo sentiero, partenza a metà: ${pieces}`)
  const km = Number(pieces.match(/([\d,]+) km/)[1].replace(',', '.'))
  const expected = (T.get('E325').lunghezza_m / 1000) * 0.35
  check(Math.abs(km - expected) < expected * 0.25, `lunghezza plausibile (${km} km, attesi ~${expected.toFixed(1)})`)
  check(/PERCORSO/.test(await txt(p, '#panel-body .chiprow')) && /DIST/.test(await txt(p, '.tiles')), 'scheda come un sentiero (riquadri)')
  check(await p.locator('.profile canvas').isVisible(), 'profilo altimetrico')
  check(/Spazio aereo/i.test(await txt(p, '#panel-body')), 'spazio aereo / colori di volabilità')
  check((await p.locator('.route-pin').count()) === 2, 'segnaposto A e B')
  const f = await routeFeatures(p)
  check(f.some((x) => x.kind === 'walk') && !f.some((x) => x.kind === 'gap'), 'percorso disegnato, nessun buco')
  await p.screenshot({ path: `${OUT}/percorso_1_stesso_sentiero.png` })
  await p.context().close()
}

// 2. cambio di sentiero a un bivio (E310 → E322 al Passo Manghen)
{
  const p = await open()
  await makeRoute(p, at('E310', 0.3), at('E322', 0.3))
  const pieces = await txt(p, '.routepieces')
  const list = pieces.split(' → ')
  check(/^E310 per/.test(list[0]) && /^E322 per/.test(list[list.length - 1]) && list.length >= 2 && list.length <= 5, `cambio di sentiero ai bivi: ${pieces}`)
  check(!/per 0,0 km/.test(pieces), 'nessun salto tra sentieri che condividono il tracciato')
  await p.screenshot({ path: `${OUT}/percorso_2_bivio.png` })
  await p.context().close()
}

// 3. arrivo su una meta fuori sentiero (lago)
if (lakeCase) {
  const p = await open()
  const lake = lakeCase.poi.geometry.coordinates
  await frame(p, [at(lakeCase.trail, 0.05), lake])
  await p.click('#route-btn')
  await tap(p, at(lakeCase.trail, 0.05))
  await p.waitForFunction(() => /ARRIVO/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 10000 })
  await tap(p, lake)
  await p.waitForFunction(() => /Percorso pronto/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {})
  await p.waitForTimeout(800)
  const info = await txt(p, '.routeinfo').catch(() => '')
  check(new RegExp(`Ultimo pezzo fuori sentiero fino a ${lakeCase.poi.properties.nome}: [\\d.]+ m`).test(info), `meta fuori sentiero: ${info.match(/Ultimo pezzo[^.]*\./)?.[0]}`)
  const f = await routeFeatures(p)
  check(f.some((x) => x.kind === 'tail' && / m$/.test(x.label)), 'ultimo pezzo tratteggiato con la distanza')
  await p.screenshot({ path: `${OUT}/percorso_3_meta_fuori_sentiero.png` })
  await p.context().close()
} else check(false, 'trovato un lago fuori sentiero per la prova')

// 4. reti non collegate: buco segnalato
if (gapCase) {
  const p = await open()
  await makeRoute(p, at(gapCase.a, 0.5), at(gapCase.b, 0.5))
  const info = await txt(p, '.routeinfo')
  check(/Non collegato da sentieri SAT: un buco di [\d,]+ km in linea d'aria/.test(info), `buco segnalato nella scheda: ${info.match(/un buco di [\d,]+ km/)?.[0]}`)
  const f = await routeFeatures(p)
  check(f.some((x) => x.kind === 'gap' && /Non collegato da sentieri SAT · [\d.]+ m in linea d'aria/.test(x.label)), 'buco tratteggiato sulla mappa con etichetta')
  check(new RegExp(`${gapCase.a} per`).test(await txt(p, '.routepieces')), `mezzi percorsi da entrambi i lati: ${await txt(p, '.routepieces')}`)
  await p.screenshot({ path: `${OUT}/percorso_4_non_collegato.png` })
  await p.context().close()
} else check(false, 'trovata una coppia di reti non collegate per la prova')

// 5. telefono: la modalità funziona anche col tocco
{
  const p = await open('mobile')
  const a = at('E325', 0.25)
  const b = at('E325', 0.6)
  await frame(p, [a, b])
  await p.locator('#route-btn').tap()
  await p.waitForSelector('.route-bar')
  for (const c of [a, b]) {
    const xy = await p.evaluate((c) => {
      const m = window.__q120map
      const px = m.project(c)
      const r = m.getCanvas().getBoundingClientRect()
      return { x: px.x + r.left, y: px.y + r.top }
    }, c)
    await p.touchscreen.tap(xy.x, xy.y)
    await p.waitForTimeout(800)
  }
  await p.waitForFunction(() => /Percorso pronto/.test(document.querySelector('.route-bar')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {})
  check(await p.locator('#sheet .routepieces').isVisible(), 'telefono: percorso creato con due tocchi, scheda aperta')
  await p.screenshot({ path: `${OUT}/percorso_5_telefono.png` })
  await p.context().close()
}

// 6. "Come arrivare" calcolato nel browser = quello precalcolato dalla pipeline (stessa partenza)
{
  const access = await get('access.json')
  const p = await open()
  const roadside = Object.keys(access).find((k) => access[k].inizio?.tipo === 'strada' && T.get(k)?.lunghezza_m > 2000)
  for (const id of ['E325', roadside].filter(Boolean)) {
    const ref = access[id]?.inizio
    await makeRoute(p, at(id, 0.002), at(id, 0.3))
    await p.waitForSelector('#panel-body .access a[href*="google.com/maps"]', { timeout: 15000 }).catch(() => {})
    const href = await p.locator('#panel-body .access a[href*="google.com/maps"]').first().getAttribute('href').catch(() => null)
    const m = href?.match(/destination=([\d.]+),([\d.]+)/)
    if (!ref || ref.tipo === 'nessuno') {
      check(!m, `${id}: nessun accesso, come nella pipeline`)
      continue
    }
    const d = m ? dm([Number(m[2]), Number(m[1])], [ref.lon, ref.lat]) : Infinity
    check(d < 60, `${id}: stesso punto d'arrivo in auto della pipeline (${ref.tipo}${ref.nome ? ' ' + ref.nome : ''}, scarto ${Math.round(d)} m)`)
    await p.click('.route-bar >> text=CHIUDI').catch(() => {})
  }
  await p.screenshot({ path: `${OUT}/percorso_6_come_arrivare.png` })
  await p.context().close()
}

console.log(`OK (${ok.length})`)
for (const m of ok) console.log('  ' + m)
console.log(`\nFALLITI (${fail.length}):`)
for (const m of fail) console.log('  ' + m)
console.log('\nERRORI', errors)
await browser.close()
process.exit(fail.length || errors.length ? 1 : 0)
