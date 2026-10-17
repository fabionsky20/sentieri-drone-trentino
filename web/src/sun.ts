// Posizione del sole, alba e tramonto (formule astronomiche standard, come SunCalc).
// Precisione di circa un minuto: basta per capire dove sarà l'ombra.

const RAD = Math.PI / 180
const DAY_MS = 86_400_000
const J1970 = 2440588
const J2000 = 2451545
const E = RAD * 23.4397 // obliquità dell'eclittica

const toDays = (d: Date) => d.getTime() / DAY_MS - 0.5 + J1970 - J2000
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS)

const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l))
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l))
const solarMeanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d)
function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  return M + C + RAD * 102.9372 + Math.PI
}
const siderealTime = (d: number, lw: number) => RAD * (280.16 + 360.9856235 * d) - lw

/** Azimut (gradi da nord, in senso orario) e altezza sull'orizzonte (gradi). */
export function sunPosition(date: Date, lat: number, lon: number): { azimuth: number; altitude: number } {
  const lw = RAD * -lon
  const phi = RAD * lat
  const d = toDays(date)
  const L = eclipticLongitude(solarMeanAnomaly(d))
  const dec = declination(L, 0)
  const ra = rightAscension(L, 0)
  const H = siderealTime(d, lw) - ra
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H))
  return { azimuth: (az / RAD + 180 + 360) % 360, altitude: alt / RAD }
}

/** Alba e tramonto del giorno (ora locale del dispositivo), null se il sole non sorge/tramonta. */
export function sunTimes(date: Date, lat: number, lon: number): { sunrise: Date | null; sunset: Date | null } {
  const lw = RAD * -lon
  const phi = RAD * lat
  const d = toDays(date)
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI))
  const ds = 0.0009 + lw / (2 * Math.PI) + n
  const M = solarMeanAnomaly(ds)
  const L = eclipticLongitude(M)
  const dec = declination(L, 0)
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L)
  const h0 = RAD * -0.833
  const cosW = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))
  if (cosW < -1 || cosW > 1) return { sunrise: null, sunset: null }
  const w = Math.acos(cosW)
  const a = 0.0009 + (w + lw) / (2 * Math.PI) + n
  const Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L)
  const Jrise = Jnoon - (Jset - Jnoon)
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) }
}

export const hhmm = (d: Date | null) => (d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '–')
