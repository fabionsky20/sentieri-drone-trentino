// Chiusure dei sentieri (da data/closures.yaml via la pipeline), applicate alla data scelta.

export interface Closure {
  tipo: 'stagionale' | 'puntuale'
  dal: string // stagionale "MM-GG", puntuale "AAAA-MM-GG"
  al: string | null // puntuale senza fine = fino a nuovo avviso
  motivo: string | null
  fonte: string | null
}

export type Closures = Record<string, Closure[]>

/** La chiusura vale nel giorno `day` (AAAA-MM-GG)? Estremi inclusi. */
export function isClosedOn(c: Closure, day: string): boolean {
  if (c.tipo === 'stagionale') {
    const md = day.slice(5)
    const al = c.al ?? c.dal
    // Se scavalca il capodanno (es. 11-01 → 05-31) vale prima di "al" o dopo "dal".
    return c.dal <= al ? md >= c.dal && md <= al : md >= c.dal || md <= al
  }
  return day >= c.dal && (c.al == null || day <= c.al)
}

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']

function md(s: string): string {
  const [m, d] = s.split('-').map(Number)
  return `${d} ${MESI[m - 1]}`
}

function full(s: string): string {
  const [y, m, d] = s.split('-').map(Number)
  return `${d} ${MESI[m - 1]} ${y}`
}

/** Periodo leggibile: "ogni anno dal 1 novembre al 31 maggio", "dal 20 ottobre 2026 al …". */
export function periodLabel(c: Closure): string {
  if (c.tipo === 'stagionale') return `ogni anno dal ${md(c.dal)} al ${md(c.al ?? c.dal)}`
  return c.al ? `dal ${full(c.dal)} al ${full(c.al)}` : `dal ${full(c.dal)} fino a nuovo avviso`
}
