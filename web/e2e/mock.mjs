// Risposte finte di Open-Meteo e NOAA per le prove automatiche: non consumano la quota gratuita
// di Open-Meteo e danno risultati ripetibili. Formato uguale all'API vera (più modelli → suffisso
// _<modello>; ICON-CH senza vento a 80/120 m né visibilità).
const VARS = {
  temperature_2m: 't',
  precipitation_probability: 'pp',
  precipitation: 'mm',
  wind_speed_10m: 'w10',
  wind_speed_80m: 'w80',
  wind_speed_120m: 'w120',
  wind_gusts_10m: 'g10',
  cloud_cover_low: 'cl',
  visibility: 'vis',
}
const MISSING = { meteoswiss_icon_seamless: ['w80', 'w120', 'vis'] }

export const calm = () => ({ t: 10, pp: 0, mm: 0, w10: 5, w80: 8, w120: 9, g10: 12, cl: 0, vis: 40000 })

export function fakeOpenMeteo(url, scenario = calm) {
  const u = new URL(url)
  const lats = u.searchParams.get('latitude').split(',')
  const day = u.searchParams.get('start_date')
  const models = (u.searchParams.get('models') ?? 'best_match').split(',')
  const hours = Array.from({ length: 24 }, (_, h) => h)
  const loc = () => {
    const hourly = { time: hours.map((h) => `${day}T${String(h).padStart(2, '0')}:00`) }
    const daily = { time: [day] }
    for (const m of models) {
      const sfx = models.length > 1 ? `_${m}` : ''
      for (const [name, k] of Object.entries(VARS)) hourly[name + sfx] = hours.map((h) => ((MISSING[m] ?? []).includes(k) ? null : (scenario(day, h, m)[k] ?? null)))
      daily[`sunrise${sfx}`] = [`${day}T07:20`]
      daily[`sunset${sfx}`] = [`${day}T18:30`]
    }
    return { utc_offset_seconds: 7200, hourly, daily }
  }
  return lats.length === 1 ? loc() : lats.map(loc)
}

/** Intercetta Open-Meteo e NOAA in un contesto Playwright. */
export async function mockWeather(ctx, scenario = calm) {
  await ctx.route('https://api.open-meteo.com/**', (r) => r.fulfill({ json: fakeOpenMeteo(r.request().url(), scenario), headers: { 'access-control-allow-origin': '*' } }))
  await ctx.route('https://services.swpc.noaa.gov/**', (r) => r.fulfill({ json: [], headers: { 'access-control-allow-origin': '*' } }))
}
