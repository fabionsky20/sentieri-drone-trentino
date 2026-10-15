// Ricerca testuale locale sull'indice search.json (sentieri, POI, valli, paesi).

import type { SearchItem } from './types'

/** Stessa normalizzazione della pipeline: minuscolo, senza accenti né punteggiatura. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// A parità di testo, prima i luoghi "puntuali" che si cercano di più.
const KIND_WEIGHT: Record<string, number> = {
  passo: 3,
  vetta: 3,
  lago: 3,
  rifugio: 3,
  malga: 2.5,
  bivacco: 2.5,
  cascata: 2.5,
  valle: 2.5,
  paese: 2,
  panoramico: 1,
  sentiero: 1.5,
}

/** Tutte le parole cercate devono essere l'inizio di una parola della voce. */
export function rank(items: SearchItem[], query: string, limit = 25): SearchItem[] {
  const q = normalize(query)
  if (!q) return []
  const words = q.split(' ')
  const scored: [number, SearchItem][] = []
  for (const it of items) {
    const tokens = it.k.split(' ')
    if (!words.every((w) => tokens.some((t) => t.startsWith(w)))) continue
    const name = normalize(it.n)
    let score = KIND_WEIGHT[it.t] ?? 1
    if (name === q) score += 6
    else if (name.startsWith(q)) score += 4
    else if (it.k.includes(q)) score += 2
    // Numero di sentiero esatto (es. "e310").
    if (it.t === 'sentiero' && tokens[0] === q) score += 8
    score -= name.length / 200
    scored.push([score, it])
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, it]) => it)
}
