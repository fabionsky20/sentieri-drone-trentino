// Foto vicine da Wikimedia Commons, caricate al momento (non nella pipeline), con autore e licenza.
// API pubblica senza chiave: ricerca geografica dei file (namespace 6) attorno a uno o più punti.

import { h } from './panel'

interface Photo {
  pageid: number
  title: string
  thumb: string
  page: string
  author: string
  license: string
  licenseUrl: string | null
}

const API = 'https://commons.wikimedia.org/w/api.php'
const MAX_PHOTOS = 6
const cache = new Map<string, Promise<Photo[]>>()

/** Testo semplice da un campo HTML dei metadati (DOMParser non esegue script). */
function text(html: string | undefined): string {
  if (!html) return ''
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function search(lon: number, lat: number, radius: number): Promise<Photo[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(Math.min(10_000, Math.max(10, Math.round(radius)))),
    ggsnamespace: '6',
    ggslimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime',
    iiurlwidth: '480',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
  })
  const res = await fetch(`${API}?${params}`)
  if (!res.ok) throw new Error(`Commons: HTTP ${res.status}`)
  const data = await res.json()
  const pages = Object.values<any>(data?.query?.pages ?? {})
  return pages
    .map((p): Photo | null => {
      const info = p.imageinfo?.[0]
      if (!info?.thumburl || !/^image\/(jpeg|png|webp)$/.test(info.mime)) return null
      const meta = info.extmetadata ?? {}
      return {
        pageid: p.pageid,
        title: String(p.title).replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
        thumb: info.thumburl,
        page: info.descriptionurl,
        author: text(meta.Artist?.value) || 'autore sconosciuto',
        license: text(meta.LicenseShortName?.value) || 'licenza non indicata',
        licenseUrl: meta.LicenseUrl?.value ?? null,
      }
    })
    .filter((p): p is Photo => p !== null)
    .sort((a, b) => (a.pageid < b.pageid ? -1 : 1))
}

function load(points: [number, number][], radius: number): Promise<Photo[]> {
  const key = `${points.map((p) => p.map((v) => v.toFixed(4)).join(',')).join(';')}|${radius}`
  let p = cache.get(key)
  if (!p) {
    p = Promise.all(points.map(([lon, lat]) => search(lon, lat, radius))).then((lists) => {
      // Alterna i punti (inizio, metà, fine…) così le foto coprono tutto il percorso.
      const seen = new Set<number>()
      const out: Photo[] = []
      for (let i = 0; out.length < MAX_PHOTOS && lists.some((l) => l.length > i); i++) {
        for (const l of lists) {
          const ph = l[i]
          if (ph && !seen.has(ph.pageid) && out.length < MAX_PHOTOS) {
            seen.add(ph.pageid)
            out.push(ph)
          }
        }
      }
      return out
    })
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

/** Sezione "Foto vicine": si riempie da sola quando arrivano i risultati. */
export function photosSection(points: [number, number][], radius: number): HTMLElement {
  const grid = h('div', { class: 'photos' }, h('p', { class: 'muted small' }, 'Cerco foto su Wikimedia Commons…'))
  const section = h('section', {}, h('h3', {}, 'Foto vicine'), grid)
  load(points, radius)
    .then((photos) => {
      grid.replaceChildren()
      if (!photos.length) {
        grid.append(h('p', { class: 'muted small' }, 'Nessuna foto su Wikimedia Commons in questa zona.'))
        return
      }
      for (const ph of photos) {
        const img = h('img', { src: ph.thumb, alt: ph.title, loading: 'lazy' })
        const license = ph.licenseUrl
          ? h('a', { href: ph.licenseUrl, target: '_blank', rel: 'noopener' }, ph.license)
          : ph.license
        grid.append(
          h(
            'figure',
            {},
            h('a', { href: ph.page, target: '_blank', rel: 'noopener', title: ph.title }, img),
            h('figcaption', {}, `${ph.author.slice(0, 60)} · `, license),
          ),
        )
      }
      grid.append(h('p', { class: 'muted small credit' }, 'Foto da Wikimedia Commons: tocca una foto per la pagina originale.'))
    })
    .catch(() => {
      grid.replaceChildren(h('p', { class: 'muted small' }, 'Foto non disponibili (serve la connessione).'))
    })
  return section
}
