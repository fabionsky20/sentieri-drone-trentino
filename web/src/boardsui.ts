// Interfaccia delle bacheche: elenco, vista della bacheca, scelta dalla scheda del sentiero,
// notifiche e finestra di invito via link. Solo presentazione: le operazioni sono in boards.ts.

import type { Board, BoardItem, BoardsState, Copertina, DirectInvite, LinkPreview, Notif, PublicUser, Ruolo } from './boards'
import { COVER_COLORS, LINK_DAYS } from './boards'
import { segmented } from './filters'
import { dotDate, flightBar, h, kmVal } from './panel'
import { avatarEl, validDate, dateMax, DATE_MIN } from './profilepage'
import type { Colore, Trail } from './types'
import { icon } from './ui'

export const RUOLO_LABEL: Record<Ruolo, string> = { owner: 'Proprietario', editor: 'Può modificare', viewer: 'Può solo vedere' }

export interface BoardsActions {
  openBoard: (id: string) => void
  openTrail: (trail: string) => void
  createBoard: (nome: string, copertina: Copertina) => Promise<string>
  updateBoard: (id: string, patch: { nome?: string; copertina?: Copertina }) => Promise<void>
  deleteBoard: (id: string) => Promise<void>
  leaveBoard: (id: string) => Promise<void>
  setRole: (id: string, uid: string, ruolo: 'editor' | 'viewer') => Promise<void>
  removeMember: (id: string, uid: string) => Promise<void>
  addTrail: (id: string, trail: string) => Promise<void>
  removeTrail: (id: string, trail: string) => Promise<void>
  setTrailDate: (id: string, trail: string, data: string | null) => Promise<void>
  setCiSto: (id: string, trail: string, on: boolean) => Promise<void>
  addNote: (id: string, trail: string, testo: string) => Promise<void>
  deleteNote: (id: string, noteId: string) => Promise<void>
  createLink: (id: string, ruolo: 'editor' | 'viewer', days: number) => Promise<string>
  revokeLink: (id: string, token: string) => Promise<void>
  searchUsers: (q: string) => Promise<PublicUser[]>
  inviteUser: (id: string, user: PublicUser, ruolo: 'editor' | 'viewer') => Promise<void>
  cancelInvite: (inviteId: string) => Promise<void>
  acceptInvite: (inv: DirectInvite) => Promise<void>
  declineInvite: (inv: DirectInvite) => Promise<void>
  migrateLegacy: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  toast: (msg: string) => void
}

export interface TrailInfo {
  trails: Map<string, Trail>
  kmOf: (id: string) => Record<Colore, number>
  closed: (id: string) => boolean
}

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })
const fmt = (d: Date | null) => (d ? dateFmt.format(d).replace(/\//g, '.') : '—')

function ago(d: Date | null): string {
  if (!d) return 'ora'
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'ora'
  if (s < 3600) return `${Math.floor(s / 60)} min fa`
  if (s < 86400) return `${Math.floor(s / 3600)} h fa`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} g fa`
  return fmt(d)
}

/** Esegue un'azione asincrona sul pulsante, con messaggio in caso di errore. */
async function run(btn: HTMLElement | null, fn: () => Promise<unknown>, a: BoardsActions): Promise<boolean> {
  if (btn) (btn as HTMLButtonElement).disabled = true
  try {
    await fn()
    return true
  } catch (e) {
    a.toast(`Non riuscito: ${(e as Error).message}`)
    return false
  } finally {
    if (btn) (btn as HTMLButtonElement).disabled = false
  }
}

function button(cls: string, content: (Node | string)[], onClick: (b: HTMLButtonElement) => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, ...attrs }, ...content) as HTMLButtonElement
  b.addEventListener('click', () => onClick(b))
  return b
}

const trailTitle = (info: TrailInfo, id: string) => {
  const t = info.trails.get(id)
  return t ? `${t.numero} · ${t.titolo}` : id
}

// ---------------------------------------------------------------- copertina

export function coverEl(board: Pick<Board, 'copertina' | 'nome'>, info: TrailInfo, tall = false): HTMLElement {
  if (board.copertina.tipo === 'sentiero' && info.trails.has(board.copertina.valore)) {
    const t = info.trails.get(board.copertina.valore)!
    return h('div', { class: `cover trail${tall ? ' tall' : ''}` }, h('span', { class: 'mono' }, t.numero), h('span', { class: 'cover-title' }, t.titolo), flightBar(info.kmOf(t.id), true))
  }
  return h('div', { class: `cover${tall ? ' tall' : ''}`, style: `background:${board.copertina.valore}` })
}

function colorPicker(value: string, onPick: (c: string) => void): HTMLElement {
  const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colore della copertina' })
  for (const c of COVER_COLORS) {
    const b = button('swatch', [], () => {
      for (const x of wrap.querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b))
      onPick(c)
    }, { role: 'radio', 'aria-checked': String(c === value), 'aria-label': `Colore ${c}`, style: `background:${c}` })
    wrap.append(b)
  }
  return wrap
}

function memberStack(board: Board): HTMLElement {
  const wrap = h('span', { class: 'stack' })
  for (const m of board.membri.slice(0, 5)) wrap.append(avatarEl(m.avatar, m.nome, 24))
  if (board.membri.length > 5) wrap.append(h('span', { class: 'mono small muted' }, `+${board.membri.length - 5}`))
  return wrap
}

// ---------------------------------------------------------------- elenco (sezione Salvati)

function newBoardForm(a: BoardsActions, onDone: (id: string) => void, onCancel: () => void): HTMLElement {
  const nome = h('input', { type: 'text', maxlength: '60', placeholder: 'es. Lagorai d’autunno', 'aria-label': 'Nome della bacheca' }) as HTMLInputElement
  let colore = COVER_COLORS[0]
  const save = h('button', { type: 'submit', class: 'btn-primary' }, 'CREA') as HTMLButtonElement
  const form = h(
    'form',
    { class: 'card editing boardform' },
    h('label', { class: 'field' }, h('span', { class: 'field-k' }, 'Nome della bacheca'), nome),
    h('div', { class: 'field' }, h('span', { class: 'field-k' }, 'Copertina'), colorPicker(colore, (c) => (colore = c))),
    h('div', { class: 'form-actions' }, button('btn-text', ['ANNULLA'], onCancel), save),
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!nome.value.trim()) return void nome.focus()
    let id = ''
    if (await run(save, async () => (id = await a.createBoard(nome.value, { tipo: 'colore', valore: colore })), a)) onDone(id)
  })
  setTimeout(() => nome.focus(), 0)
  return form
}

export function inviteCards(inviti: DirectInvite[], a: BoardsActions): HTMLElement | null {
  if (!inviti.length) return null
  const list = h('ul', { class: 'cards' })
  for (const inv of inviti) {
    list.append(
      h(
        'li',
        { class: 'card invite' },
        h('div', { class: 'invite-body' }, h('span', { class: 'section-label' }, 'Invito'), h('span', { class: 'card-title' }, inv.bachecaNome), h('span', { class: 'muted small' }, `${inv.daNome} ti invita come “${RUOLO_LABEL[inv.ruolo].toLowerCase()}” · scade il ${fmt(inv.scade)}`)),
        h(
          'div',
          { class: 'form-actions' },
          button('btn-text', ['RIFIUTA'], (b) => void run(b, () => a.declineInvite(inv), a)),
          button('btn-primary', ['ACCETTA'], (b) => void run(b, async () => {
            await a.acceptInvite(inv)
            a.openBoard(inv.bacheca)
          }, a)),
        ),
      ),
    )
  }
  return list
}

export function boardsList(st: BoardsState, info: TrailInfo, a: BoardsActions, rerender: () => void): HTMLElement[] {
  const parts: HTMLElement[] = []
  let adding = false
  const addBox = h('div', {})
  const drawAdd = () => {
    addBox.replaceChildren(
      adding
        ? newBoardForm(a, (id) => a.openBoard(id), () => ((adding = false), drawAdd()))
        : button('btn-outline wide', [icon('plus', 18), 'NUOVA BACHECA'], () => ((adding = true), drawAdd())),
    )
  }
  drawAdd()
  parts.push(addBox)
  const boards = [...st.boards.values()].sort((x, y) => x.nome.localeCompare(y.nome, 'it'))
  if (!boards.length) {
    parts.push(h('p', { class: 'muted empty-list' }, 'Nessuna bacheca. Creane una e invita gli amici, oppure accetta un invito.'))
    return parts
  }
  const list = h('ul', { class: 'cards' })
  for (const b of boards) {
    const open = button('card-main', [
      coverEl(b, info),
      h('span', { class: 'card-title' }, b.nome),
      h('span', { class: 'card-top' }, h('span', { class: 'mono muted' }, `${b.sentieri.size} sentieri · ${b.membri.length} membri`), b.ruolo ? h('span', { class: 'pill tiny' }, RUOLO_LABEL[b.ruolo].toUpperCase()) : null),
      memberStack(b),
    ], () => a.openBoard(b.id))
    list.append(h('li', { class: 'card boardcard' }, open))
  }
  parts.push(list)
  void rerender
  return parts
}

export function migrationBanner(a: BoardsActions): HTMLElement {
  const btn = button('btn-primary wide', ['TRASFORMA IN BACHECA'], (b) => void run(b, async () => {
    await a.migrateLegacy()
    a.openBoard('condivisi')
  }, a))
  return h(
    'section',
    { class: 'notice attention' },
    h('p', { class: 'section-label' }, 'Lista “Condivisi”'),
    h('p', {}, 'La vecchia lista condivisa diventa una bacheca con tutti i sentieri e i membri storici. Chi la trasforma ne diventa il proprietario.'),
    btn,
  )
}

// ---------------------------------------------------------------- vista bacheca

export interface BoardViewCtx {
  board: Board
  me: string
  info: TrailInfo
  a: BoardsActions
  rerender: () => void
  openNotes: Set<string> // sentieri con le note aperte (resta tra un ridisegno e l'altro)
  lastLink: { url: string | null } // ultimo link creato: sopravvive ai ridisegni della vista
}

function itemCard(ctx: BoardViewCtx, item: BoardItem): HTMLElement {
  const { board, info, a, me } = ctx
  const can = board.ruolo === 'owner' || board.ruolo === 'editor'
  const t = info.trails.get(item.trail)
  const names = item.ciSto.map((u) => board.membri.find((m) => m.uid === u)?.nome ?? 'un ex membro')
  const mine = item.ciSto.includes(me)
  const notes = board.note.filter((n) => n.sentiero === item.trail)

  const title = button('linkish card-title', [t ? t.titolo : item.trail], () => a.openTrail(item.trail))
  const top = h(
    'div',
    { class: 'card-top' },
    h('span', { class: 'mono muted' }, [t?.numero ?? item.trail, t?.difficolta].filter(Boolean).join(' · ')),
    info.closed(item.trail) ? h('span', { class: 'pill tiny closed' }, h('i', { class: 'dot rosso' }), 'CHIUSO') : null,
    h('span', { class: 'mono card-km' }, t ? kmVal((t.lunghezza_m ?? 0) / 1000) : ''),
  )

  // Data prevista
  let dateEl: HTMLElement
  if (can) {
    const input = h('input', { type: 'date', min: DATE_MIN, max: dateMax(), 'aria-label': `Data prevista per ${item.trail}` }) as HTMLInputElement
    input.value = item.data ?? ''
    input.addEventListener('change', () => {
      if (!validDate(input.value)) return
      void run(null, () => a.setTrailDate(board.id, item.trail, input.value || null), a)
    })
    dateEl = h('label', { class: 'datefield' }, h('span', { class: 'field-k' }, 'Data prevista'), input)
  } else {
    dateEl = h('span', { class: 'mono small' }, item.data ? `Data prevista: ${dotDate(item.data)}` : 'Data da decidere')
  }

  // Ci sto
  const ciSto = h(
    'div',
    { class: 'cisto' },
    can ? button(`cisto-btn${mine ? ' on' : ''}`, [icon(mine ? 'check' : 'plus', 16), mine ? 'CI STO' : 'CI STO?'], (b) => void run(b, () => a.setCiSto(board.id, item.trail, !mine), a), { 'aria-pressed': String(mine) }) : null,
    h('span', { class: 'small' }, names.length ? `Ci stanno: ${names.join(', ')}` : 'Ancora nessuno'),
  )

  // Note
  const open = ctx.openNotes.has(item.trail)
  const notesToggle = button('btn-link', [`NOTE · ${notes.length}`], () => {
    if (open) ctx.openNotes.delete(item.trail)
    else ctx.openNotes.add(item.trail)
    ctx.rerender()
  }, { 'aria-expanded': String(open) })
  const notesBox = h('div', { class: 'notes' })
  if (open) {
    for (const n of notes) {
      const del = n.autore === me || board.ruolo === 'owner'
        ? button('iconbtn small', [icon('trash', 16)], (b) => void run(b, () => a.deleteNote(board.id, n.id), a), { 'aria-label': 'Elimina nota', title: 'Elimina nota' })
        : null
      notesBox.append(h('div', { class: 'note' }, h('div', { class: 'note-head' }, h('strong', {}, n.autoreNome), h('span', { class: 'mono small muted' }, ago(n.creato)), del), h('p', {}, n.testo)))
    }
    if (!notes.length) notesBox.append(h('p', { class: 'muted small' }, 'Nessuna nota.'))
    if (can) {
      const ta = h('textarea', { rows: '2', maxlength: '1000', placeholder: 'Scrivi una nota per il gruppo…', 'aria-label': 'Nuova nota' }) as HTMLTextAreaElement
      const send = h('button', { type: 'submit', class: 'btn-primary' }, 'INVIA') as HTMLButtonElement
      const f = h('form', { class: 'noteform' }, ta, send)
      f.addEventListener('submit', async (e) => {
        e.preventDefault()
        if (!ta.value.trim()) return
        if (await run(send, () => a.addNote(board.id, item.trail, ta.value), a)) ta.value = ''
      })
      notesBox.append(f)
    }
  }

  const remove = can
    ? button('iconbtn card-remove', [icon('close', 18)], (b) => {
        if (confirm(`Togliere ${t?.numero ?? item.trail} dalla bacheca?`)) void run(b, () => a.removeTrail(board.id, item.trail), a)
      }, { 'aria-label': `Togli ${item.trail} dalla bacheca`, title: 'Togli dalla bacheca' })
    : null

  return h(
    'li',
    { class: 'card item' },
    h(
      'div',
      { class: 'item-body' },
      top,
      title,
      t ? flightBar(info.kmOf(t.id), true) : null,
      h('span', { class: 'muted small' }, `Aggiunto da ${item.daNome} · ${fmt(item.aggiunto)}`),
      dateEl,
      ciSto,
      notesToggle,
      open ? notesBox : null,
    ),
    remove,
  )
}

function membersSection(ctx: BoardViewCtx): HTMLElement {
  const { board, a, me } = ctx
  const owner = board.ruolo === 'owner'
  const list = h('ul', { class: 'members' })
  for (const m of board.membri) {
    const right: HTMLElement[] = []
    if (owner && m.uid !== me && m.ruolo !== 'owner') {
      const sel = h('select', { 'aria-label': `Ruolo di ${m.nome}` }) as HTMLSelectElement
      for (const r of ['editor', 'viewer'] as const) sel.append(h('option', { value: r }, RUOLO_LABEL[r]))
      sel.value = m.ruolo
      sel.addEventListener('change', () => void run(sel, () => a.setRole(board.id, m.uid, sel.value as 'editor' | 'viewer'), a))
      right.push(sel, button('iconbtn', [icon('close', 18)], (b) => {
        if (confirm(`Togliere ${m.nome} dalla bacheca?`)) void run(b, () => a.removeMember(board.id, m.uid), a)
      }, { 'aria-label': `Togli ${m.nome}`, title: 'Togli dalla bacheca' }))
    } else {
      right.push(h('span', { class: 'mono small muted' }, RUOLO_LABEL[m.ruolo] + (m.uid === me ? ' · tu' : '')))
    }
    list.append(h('li', {}, avatarEl(m.avatar, m.nome, 32), h('span', { class: 'member-name' }, m.nome), ...right))
  }
  return h('section', {}, h('p', { class: 'section-label' }, `Membri · ${board.membri.length}`), list)
}

function inviteSection(ctx: BoardViewCtx): HTMLElement {
  const { board, a } = ctx
  let ruolo: 'editor' | 'viewer' = 'editor'
  let days: number = 7
  const linkOut = h('div', { class: 'linkout' })
  const showLink = (url: string) => {
    ctx.lastLink.url = url
    const input = h('input', { type: 'text', readonly: '', value: url, 'aria-label': 'Link di invito' }) as HTMLInputElement
    input.addEventListener('focus', () => input.select())
    const copy = button('btn-outline', [icon('link', 16), 'COPIA'], async (b) => {
      try {
        await navigator.clipboard.writeText(url)
        b.lastChild!.textContent = 'COPIATO'
      } catch {
        input.select()
      }
    })
    const share = 'share' in navigator ? button('btn-primary', [icon('share', 16), 'CONDIVIDI'], () => void navigator.share({ title: `Invito a «${board.nome}»`, text: `Ti invito nella bacheca «${board.nome}» su Quota 120`, url }).catch(() => {})) : null
    linkOut.replaceChildren(input, h('div', { class: 'form-actions' }, copy, share))
  }
  if (ctx.lastLink.url) showLink(ctx.lastLink.url)

  // Il link si memorizza e si ridisegna la vista: l'aggiornamento dei link in arrivo può aver
  // già sostituito questa parte di pagina mentre si aspettava la creazione.
  const create = button('btn-primary wide', [icon('link', 18), 'CREA LINK DI INVITO'], (b) => void run(b, async () => {
    ctx.lastLink.url = await a.createLink(board.id, ruolo, days)
    ctx.rerender()
  }, a))

  const now = Date.now()
  const links = h('ul', { class: 'linklist2' })
  for (const l of board.links) {
    const expired = l.scade.getTime() < now
    const status = l.revocato ? 'revocato' : expired ? 'scaduto' : `scade il ${fmt(l.scade)}`
    links.append(
      h(
        'li',
        {},
        h('span', { class: 'small' }, RUOLO_LABEL[l.ruolo]),
        h('span', { class: `mono small ${l.revocato || expired ? 'muted' : ''}` }, status),
        !l.revocato && !expired ? button('btn-text', ['REVOCA'], (b) => void run(b, () => a.revokeLink(board.id, l.token), a)) : null,
      ),
    )
  }

  // Ricerca per nome
  const q = h('input', { type: 'search', placeholder: 'Nome di chi usa Quota 120', 'aria-label': 'Cerca persone', autocomplete: 'off' }) as HTMLInputElement
  const results = h('ul', { class: 'people' })
  let timer = 0
  q.addEventListener('input', () => {
    clearTimeout(timer)
    timer = window.setTimeout(async () => {
      const found = await a.searchUsers(q.value).catch(() => [])
      results.replaceChildren()
      const members = new Set(board.membri.map((m) => m.uid))
      const pending = new Set(board.invitiInviati.map((i) => i.uid))
      for (const u of found) {
        const right = members.has(u.uid)
          ? h('span', { class: 'mono small muted' }, 'già membro')
          : pending.has(u.uid)
            ? h('span', { class: 'mono small muted' }, 'invitato')
            : button('btn-outline', ['INVITA'], (b) => void run(b, async () => {
                await a.inviteUser(board.id, u, ruolo)
                b.replaceWith(h('span', { class: 'mono small muted' }, 'invitato'))
              }, a))
        results.append(h('li', {}, avatarEl(u.avatar, u.nome, 28), h('span', { class: 'member-name' }, u.nome), right))
      }
      if (q.value.trim().length >= 2 && !found.length) results.append(h('li', { class: 'muted small' }, 'Nessuno trovato (o non visibile nella ricerca).'))
    }, 250)
  })

  const pending = board.invitiInviati.length
    ? h(
        'ul',
        { class: 'linklist2' },
        ...board.invitiInviati.map((i) =>
          h('li', {}, h('span', { class: 'small' }, i.uNome ?? 'Utente'), h('span', { class: 'mono small muted' }, `${RUOLO_LABEL[i.ruolo]} · in attesa`), button('btn-text', ['RITIRA'], (b) => void run(b, () => a.cancelInvite(i.id), a))),
        ),
      )
    : null

  return h(
    'section',
    { class: 'invite-section' },
    h('p', { class: 'section-label' }, 'Invita'),
    h('div', { class: 'field' }, h('span', { class: 'field-k' }, 'Ruolo di chi entra'), segmented<'editor' | 'viewer'>([['editor', 'Può modificare'], ['viewer', 'Può solo vedere']], ruolo, (v) => (ruolo = v), 'small')),
    h('div', { class: 'field' }, h('span', { class: 'field-k' }, 'Il link scade dopo'), segmented<string>(LINK_DAYS.map((d) => [String(d), d === 1 ? '1 giorno' : `${d} giorni`]), String(days), (v) => (days = Number(v)), 'small')),
    create,
    linkOut,
    board.links.length ? h('div', {}, h('p', { class: 'field-k' }, 'Link creati'), links) : null,
    h('div', { class: 'field' }, h('span', { class: 'field-k' }, 'Oppure per nome'), q),
    results,
    pending ? h('div', {}, h('p', { class: 'field-k' }, 'Inviti in attesa'), pending) : null,
  )
}

function settingsSection(ctx: BoardViewCtx): HTMLElement {
  const { board, a, info } = ctx
  const nome = h('input', { type: 'text', maxlength: '60', value: board.nome, 'aria-label': 'Nome della bacheca' }) as HTMLInputElement
  const save = button('btn-outline', ['RINOMINA'], (b) => {
    if (nome.value.trim() && nome.value.trim() !== board.nome) void run(b, () => a.updateBoard(board.id, { nome: nome.value }), a)
  })
  const trailSel = h('select', { 'aria-label': 'Sentiero di copertina' }) as HTMLSelectElement
  trailSel.append(h('option', { value: '' }, 'Usa un sentiero della bacheca…'))
  for (const id of board.sentieri.keys()) trailSel.append(h('option', { value: id }, trailTitle(info, id)))
  if (board.copertina.tipo === 'sentiero') trailSel.value = board.copertina.valore
  trailSel.addEventListener('change', () => {
    if (trailSel.value) void run(trailSel, () => a.updateBoard(board.id, { copertina: { tipo: 'sentiero', valore: trailSel.value } }), a)
  })
  const del = button('btn-danger wide', ['ELIMINA BACHECA'], (b) => {
    if (confirm(`Eliminare la bacheca «${board.nome}» per tutti i membri? Sentieri, note e inviti verranno cancellati.`)) void run(b, () => a.deleteBoard(board.id), a)
  })
  return h(
    'section',
    { class: 'settings' },
    h('p', { class: 'section-label' }, 'Impostazioni'),
    h('div', { class: 'row-input' }, nome, save),
    h('div', { class: 'field' }, h('span', { class: 'field-k' }, 'Copertina'), colorPicker(board.copertina.tipo === 'colore' ? board.copertina.valore : '', (c) => void run(null, () => a.updateBoard(board.id, { copertina: { tipo: 'colore', valore: c } }), a)), trailSel),
    del,
  )
}

export function renderBoard(ctx: BoardViewCtx): HTMLElement[] {
  const { board, info, a } = ctx
  const items = [...board.sentieri.values()].sort((x, y) => (x.data ?? '9999').localeCompare(y.data ?? '9999') || (x.aggiunto?.getTime() ?? 0) - (y.aggiunto?.getTime() ?? 0))
  const parts: (HTMLElement | null)[] = [
    coverEl(board, info, true),
    h('div', { class: 'board-meta' }, board.ruolo ? h('span', { class: 'pill' }, RUOLO_LABEL[board.ruolo]) : null, memberStack(board)),
    h(
      'section',
      {},
      h('p', { class: 'section-label' }, `Sentieri · ${items.length}`),
      items.length ? h('ul', { class: 'cards' }, ...items.map((i) => itemCard(ctx, i))) : h('p', { class: 'muted' }, 'Nessun sentiero. Dalla scheda di un sentiero usa “Aggiungi a bacheca”.'),
    ),
    membersSection(ctx),
    board.ruolo === 'owner' ? inviteSection(ctx) : null,
    board.ruolo === 'owner'
      ? settingsSection(ctx)
      : button('btn-danger wide', ['ESCI DALLA BACHECA'], (b) => {
          if (confirm(`Uscire dalla bacheca «${board.nome}»? Per rientrare servirà un nuovo invito.`)) void run(b, () => a.leaveBoard(board.id), a)
        }),
  ]
  return parts.filter((x): x is HTMLElement => !!x)
}

// ---------------------------------------------------------------- scelta della bacheca (scheda sentiero)

export function renderBoardPicker(trail: string, st: BoardsState, info: TrailInfo, a: BoardsActions, close: () => void): HTMLElement {
  const editable = [...st.boards.values()].filter((b) => b.ruolo === 'owner' || b.ruolo === 'editor').sort((x, y) => x.nome.localeCompare(y.nome, 'it'))
  const list = h('ul', { class: 'pickerlist' })
  for (const b of editable) {
    const has = b.sentieri.has(trail)
    list.append(
      h(
        'li',
        {},
        coverEl(b, info),
        h('span', { class: 'member-name' }, b.nome, h('span', { class: 'mono small muted' }, ` · ${b.sentieri.size}`)),
        has
          ? h('span', { class: 'mono small ok-tag' }, icon('check', 16), 'PRESENTE')
          : button('btn-outline', ['AGGIUNGI'], (btn) => void run(btn, async () => {
              await a.addTrail(b.id, trail)
              a.toast(`Aggiunto a «${b.nome}»`)
              close()
            }, a)),
      ),
    )
  }
  const nome = h('input', { type: 'text', maxlength: '60', placeholder: 'Nome della nuova bacheca', 'aria-label': 'Nome della nuova bacheca' }) as HTMLInputElement
  const create = h('button', { type: 'submit', class: 'btn-primary' }, 'CREA E AGGIUNGI') as HTMLButtonElement
  const form = h('form', { class: 'row-input' }, nome, create)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!nome.value.trim()) return void nome.focus()
    await run(create, async () => {
      const id = await a.createBoard(nome.value, { tipo: 'sentiero', valore: trail })
      await a.addTrail(id, trail) // attende che la bacheca nuova sia confermata dal server
      a.toast(`Creata «${nome.value.trim()}» con ${trail}`)
      close()
    }, a)
  })
  return h(
    'div',
    { class: 'ob-card picker', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'picker-title' },
    h('div', { class: 'ob-head' }, h('p', { class: 'section-label' }, 'Aggiungi a bacheca'), button('iconbtn', [icon('close')], close, { 'aria-label': 'Chiudi' })),
    h('h2', { class: 'title small', id: 'picker-title' }, trailTitle(info, trail)),
    editable.length ? list : h('p', { class: 'muted' }, 'Non hai ancora bacheche in cui puoi aggiungere sentieri.'),
    h('p', { class: 'field-k' }, 'Nuova bacheca'),
    form,
  )
}

// ---------------------------------------------------------------- notifiche

function notifText(n: Notif, info: TrailInfo): string {
  const t = n.sentiero ? trailTitle(info, n.sentiero) : ''
  switch (n.tipo) {
    case 'invito':
      return `${n.daNome} ti ha invitato nella bacheca «${n.bachecaNome}»`
    case 'accettato':
      return `${n.daNome} è entrato nella bacheca «${n.bachecaNome}»`
    case 'sentiero':
      return `${n.daNome} ha aggiunto ${t} a «${n.bachecaNome}»`
    case 'cisto':
      return `${n.daNome} ci sta per ${t} («${n.bachecaNome}»)`
    case 'nota':
      return `${n.daNome} ha scritto una nota su ${t}${n.testo ? `: “${n.testo}”` : ''}`
  }
}

export function renderNotifications(list: Notif[], info: TrailInfo, a: BoardsActions, openFrom: (n: Notif) => void): HTMLElement[] {
  const unread = list.filter((n) => !n.letta).length
  const head = h(
    'div',
    { class: 'section-head' },
    h('p', { class: 'section-label' }, unread ? `Da leggere · ${unread}` : 'Tutte lette'),
    unread ? button('btn-text', ['SEGNA TUTTE COME LETTE'], (b) => void run(b, a.markAllRead, a)) : null,
  )
  if (!list.length) return [head, h('p', { class: 'muted empty-list' }, 'Nessuna notifica. Qui arrivano inviti, nuovi sentieri, “ci sto” e note delle tue bacheche.')]
  const ul = h('ul', { class: 'notifs' })
  for (const n of list) {
    ul.append(
      h(
        'li',
        { class: n.letta ? '' : 'unread' },
        button('notif', [
          h('i', { class: 'notif-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'notif-text' }, notifText(n, info)),
          h('span', { class: 'mono small muted' }, ago(n.creato)),
        ], () => {
          if (!n.letta) void a.markRead(n.id).catch(() => {})
          openFrom(n)
        }, { 'aria-label': `${n.letta ? '' : 'Non letta: '}${notifText(n, info)}` }),
      ),
    )
  }
  return [head, ul]
}

// ---------------------------------------------------------------- invito via link

export function renderLinkInvite(p: LinkPreview | null | 'login' | 'caricamento', a: BoardsActions, login: () => void, accept: () => void, close: () => void): HTMLElement {
  const card = h('div', { class: 'ob-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'inv-title' })
  const head = h('div', { class: 'ob-head' }, h('p', { class: 'section-label' }, 'Invito a una bacheca'), button('iconbtn', [icon('close')], close, { 'aria-label': 'Chiudi' }))
  card.append(head)
  if (p === 'caricamento') {
    card.append(h('p', { class: 'muted' }, 'Controllo l’invito…'))
  } else if (p === 'login') {
    card.append(
      h('h2', { class: 'title', id: 'inv-title' }, 'Hai ricevuto un invito'),
      h('p', { class: 'muted' }, 'Accedi con Google per vedere l’invito e unirti alla bacheca.'),
      button('btn-primary wide', ['ACCEDI CON GOOGLE'], login),
    )
  } else if (!p) {
    card.append(h('h2', { class: 'title', id: 'inv-title' }, 'Invito non trovato'), h('p', { class: 'muted' }, 'Il link non è valido o la bacheca è stata eliminata.'), button('btn-outline wide', ['CHIUDI'], close))
  } else if (p.stato === 'membro') {
    card.append(h('h2', { class: 'title', id: 'inv-title' }, p.bachecaNome), h('p', { class: 'muted' }, 'Fai già parte di questa bacheca.'), button('btn-primary wide', ['APRI LA BACHECA'], accept))
  } else if (p.stato !== 'valido') {
    card.append(
      h('h2', { class: 'title', id: 'inv-title' }, p.stato === 'scaduto' ? 'Invito scaduto' : 'Invito revocato'),
      h('p', { class: 'muted' }, `Chiedi a ${p.daNome} un nuovo link per la bacheca «${p.bachecaNome}».`),
      button('btn-outline wide', ['CHIUDI'], close),
    )
  } else {
    void a
    card.append(
      h('h2', { class: 'title', id: 'inv-title' }, p.bachecaNome),
      h('p', {}, `${p.daNome} ti invita nella bacheca come “${RUOLO_LABEL[p.ruolo].toLowerCase()}”.`),
      h('p', { class: 'mono small muted' }, `Il link scade il ${fmt(p.scade)}`),
      h('div', { class: 'ob-foot' }, button('btn-text', ['RIFIUTA'], close), button('btn-primary wide', ['ACCETTA'], accept)),
    )
  }
  return card
}
