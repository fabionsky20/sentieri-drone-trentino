// Bacheche condivise (Fase 1 · passo B): bacheche con membri e ruoli, sentieri con data
// prevista e "ci sto", note, inviti via link o per nome, notifiche in app.
// Tutta la sicurezza è nelle regole di Firestore (firestore.rules): qui solo le operazioni.

import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type Unsubscribe,
  type WriteBatch,
} from 'firebase/firestore'
import { db } from './fb'

export type Ruolo = 'owner' | 'editor' | 'viewer'
export type Copertina = { tipo: 'colore' | 'sentiero'; valore: string }

export interface Me {
  uid: string
  nome: string
  avatar: string | null
}

export interface Member {
  uid: string
  ruolo: Ruolo
  nome: string
  avatar: string | null
}

export interface BoardItem {
  trail: string
  da: string
  daNome: string
  aggiunto: Date | null
  data: string | null
  ciSto: string[]
}

export interface BoardNote {
  id: string
  sentiero: string
  testo: string
  autore: string
  autoreNome: string
  creato: Date | null
}

export interface LinkInvite {
  token: string
  ruolo: Ruolo
  scade: Date
  revocato: boolean
}

export interface DirectInvite {
  id: string
  bacheca: string
  uid: string
  uNome: string | null
  ruolo: Ruolo
  da: string
  daNome: string
  bachecaNome: string
  scade: Date
}

export interface Board {
  id: string
  nome: string
  copertina: Copertina
  owner: string
  ruolo: Ruolo | null // il mio
  membri: Member[]
  sentieri: Map<string, BoardItem>
  note: BoardNote[]
  links: LinkInvite[] // solo per il proprietario
  invitiInviati: DirectInvite[] // solo per il proprietario
}

export type NotifTipo = 'invito' | 'accettato' | 'sentiero' | 'cisto' | 'nota'

export interface Notif {
  id: string
  tipo: NotifTipo
  bacheca: string
  bachecaNome: string
  sentiero: string | null
  da: string
  daNome: string
  testo: string | null
  creato: Date | null
  letta: boolean
}

export interface BoardsState {
  boards: Map<string, Board>
  inviti: DirectInvite[] // ricevuti, non scaduti
  notifiche: Notif[]
  /** Membro storico senza ancora la bacheca "Condivisi": può avviare la migrazione. */
  migrabile: boolean
}

export const LINK_DAYS = [1, 7, 30] as const
export const COVER_COLORS = ['#0B6E84', '#2F6F8A', '#5E6B5F', '#8A5A00', '#7A4FB3', '#B5401C']

// ---------------------------------------------------------------- stato

let me: Me | null = null
let state: BoardsState = { boards: new Map(), inviti: [], notifiche: [], migrabile: false }
const listeners = new Set<(s: BoardsState) => void>()
let rootUnsubs: Unsubscribe[] = []
const boardUnsubs = new Map<string, Unsubscribe[]>()

function emit(patch: Partial<BoardsState> = {}): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

export function subscribeBoards(fn: (s: BoardsState) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

export function getBoardsState(): BoardsState {
  return state
}

const toDate = (v: unknown): Date | null => (v as { toDate?: () => Date })?.toDate?.() ?? null

function blank(id: string): Board {
  return { id, nome: '…', copertina: { tipo: 'colore', valore: COVER_COLORS[0] }, owner: '', ruolo: null, membri: [], sentieri: new Map(), note: [], links: [], invitiInviati: [] }
}

function patchBoard(id: string, patch: Partial<Board>): void {
  if (!boardUnsubs.has(id)) return // bacheca già chiusa
  const boards = new Map(state.boards)
  boards.set(id, { ...(boards.get(id) ?? blank(id)), ...patch })
  emit({ boards })
}

function dropBoard(id: string): void {
  boardUnsubs.get(id)?.forEach((u) => u())
  boardUnsubs.delete(id)
  const boards = new Map(state.boards)
  boards.delete(id)
  emit({ boards })
}

const inviteFrom = (id: string, d: DocumentData): DirectInvite => ({
  id,
  bacheca: d.bacheca,
  uid: d.uid,
  uNome: d.uNome ?? null,
  ruolo: d.ruolo,
  da: d.da,
  daNome: d.daNome,
  bachecaNome: d.bachecaNome,
  scade: toDate(d.scade) ?? new Date(0),
})

/** Ascolta una bacheca. Se l'accesso viene negato (rimosso dalla bacheca, bacheca eliminata)
 *  la toglie e pulisce l'indice personale. */
function watchBoard(id: string): void {
  if (boardUnsubs.has(id) || !me) return
  const uid = me.uid
  const unsubs: Unsubscribe[] = []
  boardUnsubs.set(id, unsubs)
  // Un errore di permesso può essere solo una corsa (la bacheca appena creata o appena
  // raggiunta non è ancora sul server): prima di considerarsi fuori si verifica sul server.
  let checking = false
  const lost = async () => {
    if (checking || !boardUnsubs.has(id)) return
    checking = true
    boardUnsubs.get(id)?.forEach((u) => u())
    const mine = await getDocFromServer(doc(db, 'boards', id, 'partecipanti', uid)).catch(() => null)
    boardUnsubs.delete(id)
    if (mine?.exists() && me?.uid === uid) {
      setTimeout(() => watchBoard(id), 800) // ancora membro: si riprova
      return
    }
    dropBoard(id)
    if (mine) void deleteDoc(doc(db, 'users', uid, 'bacheche', id)).catch(() => {})
  }
  let ownerWatch = false
  unsubs.push(
    onSnapshot(
      doc(db, 'boards', id),
      (s) => {
        if (!s.exists()) {
          if (!s.metadata.fromCache) void lost()
          return
        }
        const d = s.data()
        patchBoard(id, { nome: d.nome, copertina: d.copertina, owner: d.owner })
      },
      () => void lost(),
    ),
    onSnapshot(
      collection(db, 'boards', id, 'partecipanti'),
      (s) => {
        const membri = s.docs.map((x) => ({ uid: x.id, ruolo: x.get('ruolo') as Ruolo, nome: String(x.get('nome')), avatar: x.get('avatar') ?? null }))
        const mine = membri.find((m) => m.uid === uid)
        if (!mine) {
          if (!s.metadata.fromCache) void lost()
          return
        }
        patchBoard(id, { membri: membri.sort((a, b) => (a.ruolo === 'owner' ? -1 : b.ruolo === 'owner' ? 1 : a.nome.localeCompare(b.nome, 'it'))), ruolo: mine.ruolo })
        // Il proprietario vede anche link e inviti in sospeso.
        if (mine.ruolo === 'owner' && !ownerWatch) {
          ownerWatch = true
          unsubs.push(
            onSnapshot(collection(db, 'boards', id, 'links'), (l) =>
              patchBoard(id, {
                links: l.docs
                  .map((x) => ({ token: x.id, ruolo: x.get('ruolo') as Ruolo, scade: toDate(x.get('scade')) ?? new Date(0), revocato: !!x.get('revocato') }))
                  .sort((a, b) => b.scade.getTime() - a.scade.getTime()),
              }),
            () => {}),
            onSnapshot(query(collection(db, 'inviti'), where('bacheca', '==', id)), (l) =>
              patchBoard(id, { invitiInviati: l.docs.map((x) => inviteFrom(x.id, x.data())) }),
            () => {}),
          )
        }
      },
      () => void lost(),
    ),
    onSnapshot(
      collection(db, 'boards', id, 'sentieri'),
      (s) =>
        patchBoard(id, {
          sentieri: new Map(
            s.docs.map((x) => [
              x.id,
              {
                trail: x.id,
                da: x.get('da'),
                daNome: x.get('daNome'),
                aggiunto: toDate(x.get('aggiunto')),
                data: x.get('data') ?? null,
                ciSto: Object.keys(x.get('ciSto') ?? {}),
              },
            ]),
          ),
        }),
      () => {},
    ),
    onSnapshot(
      query(collection(db, 'boards', id, 'note'), orderBy('creato', 'asc')),
      (s) =>
        patchBoard(id, {
          note: s.docs.map((x) => ({
            id: x.id,
            sentiero: x.get('sentiero'),
            testo: x.get('testo'),
            autore: x.get('autore'),
            autoreNome: x.get('autoreNome'),
            creato: toDate(x.get('creato')),
          })),
        }),
      () => {},
    ),
  )
}

/** Avvio per l'utente collegato. `legacy`: membro storico della vecchia lista "Condivisi". */
export async function startBoards(who: Me, legacy: boolean): Promise<void> {
  stopBoards()
  me = who
  const uid = who.uid
  emit({ boards: new Map(), inviti: [], notifiche: [], migrabile: false })
  rootUnsubs.push(
    onSnapshot(collection(db, 'users', uid, 'bacheche'), { includeMetadataChanges: true }, (s) => {
      // Si ascolta una bacheca solo quando il server ha confermato l'ingresso (niente corse).
      const ids = new Set(s.docs.filter((d) => !d.metadata.hasPendingWrites).map((d) => d.id))
      const pending = new Set(s.docs.filter((d) => d.metadata.hasPendingWrites).map((d) => d.id))
      for (const id of ids) watchBoard(id)
      for (const id of [...boardUnsubs.keys()]) if (!ids.has(id) && !pending.has(id)) dropBoard(id)
    }),
    onSnapshot(query(collection(db, 'inviti'), where('uid', '==', uid)), (s) => {
      const now = Date.now()
      emit({ inviti: s.docs.map((d) => inviteFrom(d.id, d.data())).filter((i) => i.scade.getTime() > now) })
    }),
    onSnapshot(query(collection(db, 'users', uid, 'notifiche'), orderBy('creato', 'desc'), limit(50)), (s) =>
      emit({
        notifiche: s.docs.map((d) => ({
          id: d.id,
          tipo: d.get('tipo'),
          bacheca: d.get('bacheca'),
          bachecaNome: d.get('bachecaNome'),
          sentiero: d.get('sentiero') ?? null,
          da: d.get('da'),
          daNome: d.get('daNome'),
          testo: d.get('testo') ?? null,
          creato: toDate(d.get('creato')),
          letta: !!d.get('letta'),
        })),
      }),
    ),
  )
  // Membri storici: la bacheca "Condivisi" (migrata) va nel proprio indice; se non esiste
  // ancora, si offre la migrazione.
  if (legacy) {
    const mine = await getDoc(doc(db, 'boards', 'condivisi', 'partecipanti', uid)).catch(() => null)
    if (mine?.exists()) await setDoc(doc(db, 'users', uid, 'bacheche', 'condivisi'), { aggiunta: serverTimestamp() }).catch(() => {})
    else emit({ migrabile: true })
  }
}

export function stopBoards(): void {
  rootUnsubs.forEach((u) => u())
  rootUnsubs = []
  for (const id of [...boardUnsubs.keys()]) dropBoard(id)
  me = null
  emit({ boards: new Map(), inviti: [], notifiche: [], migrabile: false })
}

function who(): Me {
  if (!me) throw new Error('Serve il login')
  return me
}

/** Come who(), ma attende l'avvio delle bacheche (il profilo può risultare pronto un attimo prima). */
async function whoReady(ms = 8000): Promise<Me> {
  const end = Date.now() + ms
  while (!me) {
    if (Date.now() > end) throw new Error('Serve il login')
    await new Promise((r) => setTimeout(r, 100))
  }
  return me
}

// ---------------------------------------------------------------- notifiche

/** Aggiunge al blocco una notifica per ogni altro membro della bacheca. */
function notifyMembers(b: WriteBatch, board: Board, tipo: NotifTipo, extra: { sentiero?: string; testo?: string } = {}): void {
  const m = who()
  for (const x of board.membri) {
    if (x.uid === m.uid) continue
    b.set(doc(collection(db, 'users', x.uid, 'notifiche')), {
      tipo,
      bacheca: board.id,
      bachecaNome: board.nome.slice(0, 60),
      sentiero: extra.sentiero ?? null,
      da: m.uid,
      daNome: m.nome.slice(0, 60),
      testo: extra.testo?.slice(0, 200) ?? null,
      creato: serverTimestamp(),
      letta: false,
    })
  }
}

function notifyOne(b: WriteBatch, to: string, boardId: string, boardName: string, tipo: NotifTipo): void {
  const m = who()
  b.set(doc(collection(db, 'users', to, 'notifiche')), {
    tipo,
    bacheca: boardId,
    bachecaNome: boardName.slice(0, 60),
    sentiero: null,
    da: m.uid,
    daNome: m.nome.slice(0, 60),
    testo: null,
    creato: serverTimestamp(),
    letta: false,
  })
}

export async function markRead(id: string): Promise<void> {
  await updateDoc(doc(db, 'users', who().uid, 'notifiche', id), { letta: true })
}

export async function markAllRead(): Promise<void> {
  const unread = state.notifiche.filter((n) => !n.letta)
  for (let i = 0; i < unread.length; i += 400) {
    const b = writeBatch(db)
    for (const n of unread.slice(i, i + 400)) b.update(doc(db, 'users', who().uid, 'notifiche', n.id), { letta: true })
    await b.commit()
  }
}

// ---------------------------------------------------------------- bacheche

function participant(ruolo: Ruolo, via: 'creazione' | 'link' | 'invito', token?: string): DocumentData {
  const m = who()
  return {
    uid: m.uid,
    ruolo,
    nome: m.nome.slice(0, 60),
    avatar: m.avatar,
    via,
    ...(token ? { token } : {}),
    entrato: serverTimestamp(),
  }
}

export async function createBoard(nome: string, copertina: Copertina): Promise<string> {
  const m = await whoReady()
  const ref = doc(collection(db, 'boards'))
  const b = writeBatch(db)
  b.set(ref, { nome: nome.trim().slice(0, 60), copertina, owner: m.uid, creato: serverTimestamp(), aggiornato: serverTimestamp() })
  b.set(doc(db, 'boards', ref.id, 'partecipanti', m.uid), participant('owner', 'creazione'))
  b.set(doc(db, 'users', m.uid, 'bacheche', ref.id), { aggiunta: serverTimestamp() })
  await b.commit()
  return ref.id
}

export async function updateBoard(id: string, patch: { nome?: string; copertina?: Copertina }): Promise<void> {
  await updateDoc(doc(db, 'boards', id), { ...patch, ...(patch.nome ? { nome: patch.nome.trim().slice(0, 60) } : {}), aggiornato: serverTimestamp() })
}

/** Elimina la bacheca con tutto il contenuto (solo il proprietario). */
export async function deleteBoard(id: string): Promise<void> {
  const m = who()
  const refs = [
    ...(await getDocs(collection(db, 'boards', id, 'sentieri'))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'boards', id, 'note'))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'boards', id, 'links'))).docs.map((d) => d.ref),
    ...(await getDocs(query(collection(db, 'inviti'), where('bacheca', '==', id)))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'boards', id, 'partecipanti'))).docs.filter((d) => d.id !== m.uid).map((d) => d.ref),
  ]
  // Prima i contenuti a blocchi, poi bacheca + propria partecipazione insieme.
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db)
    for (const r of refs.slice(i, i + 400)) b.delete(r)
    await b.commit()
  }
  const b = writeBatch(db)
  b.delete(doc(db, 'boards', id))
  b.delete(doc(db, 'boards', id, 'partecipanti', m.uid))
  b.delete(doc(db, 'users', m.uid, 'bacheche', id))
  await b.commit()
  dropBoard(id)
}

export async function leaveBoard(id: string): Promise<void> {
  const m = who()
  await deleteDoc(doc(db, 'boards', id, 'partecipanti', m.uid))
  await deleteDoc(doc(db, 'users', m.uid, 'bacheche', id))
  dropBoard(id)
}

export async function setRole(id: string, uid: string, ruolo: 'editor' | 'viewer'): Promise<void> {
  await updateDoc(doc(db, 'boards', id, 'partecipanti', uid), { ruolo })
}

export async function removeMember(id: string, uid: string): Promise<void> {
  await deleteDoc(doc(db, 'boards', id, 'partecipanti', uid))
}

// ---------------------------------------------------------------- sentieri, ci sto, note

/** Bacheca appena creata o raggiunta: arriva nello stato dopo la conferma del server. */
async function waitBoard(id: string, ms = 8000): Promise<Board> {
  const end = Date.now() + ms
  for (;;) {
    const b = state.boards.get(id)
    if (b && b.ruolo) return b
    if (Date.now() > end) throw new Error('Bacheca non trovata')
    await new Promise((r) => setTimeout(r, 150))
  }
}

export async function addTrail(id: string, trail: string): Promise<void> {
  const board = await waitBoard(id)
  if (board.sentieri.has(trail)) return
  const m = who()
  const b = writeBatch(db)
  b.set(doc(db, 'boards', id, 'sentieri', trail), { da: m.uid, daNome: m.nome.slice(0, 60), aggiunto: serverTimestamp(), data: null, ciSto: {} })
  notifyMembers(b, board, 'sentiero', { sentiero: trail })
  await b.commit()
}

export async function removeTrail(id: string, trail: string): Promise<void> {
  await deleteDoc(doc(db, 'boards', id, 'sentieri', trail))
}

export async function setTrailDate(id: string, trail: string, data: string | null): Promise<void> {
  await updateDoc(doc(db, 'boards', id, 'sentieri', trail), { data })
}

export async function setCiSto(id: string, trail: string, on: boolean): Promise<void> {
  const board = state.boards.get(id)
  if (!board) throw new Error('Bacheca non trovata')
  const m = who()
  const b = writeBatch(db)
  b.update(doc(db, 'boards', id, 'sentieri', trail), { [`ciSto.${m.uid}`]: on ? true : deleteField() })
  if (on) notifyMembers(b, board, 'cisto', { sentiero: trail })
  await b.commit()
}

export async function addNote(id: string, trail: string, testo: string): Promise<void> {
  const board = state.boards.get(id)
  if (!board) throw new Error('Bacheca non trovata')
  const m = who()
  const t = testo.trim().slice(0, 1000)
  if (!t) return
  const b = writeBatch(db)
  b.set(doc(collection(db, 'boards', id, 'note')), { sentiero: trail, testo: t, autore: m.uid, autoreNome: m.nome.slice(0, 60), creato: serverTimestamp() })
  notifyMembers(b, board, 'nota', { sentiero: trail, testo: t })
  await b.commit()
}

export async function deleteNote(id: string, noteId: string): Promise<void> {
  await deleteDoc(doc(db, 'boards', id, 'note', noteId))
}

// ---------------------------------------------------------------- inviti via link

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Indirizzo di invito: ?invito=<bacheca>~<token> (il token non si può indovinare). */
export function linkUrl(boardId: string, token: string): string {
  const u = new URL(location.href)
  u.search = `?invito=${encodeURIComponent(`${boardId}~${token}`)}`
  u.hash = ''
  return u.toString()
}

export function parseInviteParam(value: string | null): { board: string; token: string } | null {
  if (!value) return null
  const [board, token] = value.split('~')
  return board && token && /^[\w-]{1,40}$/.test(board) && /^[\w-]{20,64}$/.test(token) ? { board, token } : null
}

export async function createLink(id: string, ruolo: 'editor' | 'viewer', days: number): Promise<string> {
  const board = state.boards.get(id)
  if (!board) throw new Error('Bacheca non trovata')
  const m = who()
  const token = randomToken()
  await setDoc(doc(db, 'boards', id, 'links', token), {
    ruolo,
    scade: Timestamp.fromMillis(Date.now() + days * 86_400_000),
    revocato: false,
    da: m.uid,
    daNome: m.nome.slice(0, 60),
    bachecaNome: board.nome.slice(0, 60),
    creato: serverTimestamp(),
  })
  return linkUrl(id, token)
}

export async function revokeLink(id: string, token: string): Promise<void> {
  await updateDoc(doc(db, 'boards', id, 'links', token), { revocato: true })
}

export interface LinkPreview {
  board: string
  token: string
  bachecaNome: string
  daNome: string
  da: string
  ruolo: Ruolo
  scade: Date
  stato: 'valido' | 'scaduto' | 'revocato' | 'membro'
}

/** Legge l'invito di un link (solo l'invito: la bacheca resta invisibile fino all'accettazione). */
export async function previewLink(board: string, token: string): Promise<LinkPreview | null> {
  const m = await whoReady()
  const s = await getDoc(doc(db, 'boards', board, 'links', token)).catch(() => null)
  if (!s?.exists()) return null
  const d = s.data()
  const already = await getDoc(doc(db, 'boards', board, 'partecipanti', m.uid)).catch(() => null)
  const scade = toDate(d.scade) ?? new Date(0)
  return {
    board,
    token,
    bachecaNome: d.bachecaNome,
    daNome: d.daNome,
    da: d.da,
    ruolo: d.ruolo,
    scade,
    stato: already?.exists() ? 'membro' : d.revocato ? 'revocato' : scade.getTime() < Date.now() ? 'scaduto' : 'valido',
  }
}

export async function joinByLink(p: LinkPreview): Promise<void> {
  const m = await whoReady()
  const b = writeBatch(db)
  if (p.stato !== 'membro') {
    b.set(doc(db, 'boards', p.board, 'partecipanti', m.uid), participant(p.ruolo, 'link', p.token))
    notifyOne(b, p.da, p.board, p.bachecaNome, 'accettato')
  }
  b.set(doc(db, 'users', m.uid, 'bacheche', p.board), { aggiunta: serverTimestamp() })
  await b.commit()
}

// ---------------------------------------------------------------- inviti diretti e rubrica

export interface PublicUser {
  uid: string
  nome: string
  avatar: string | null
}

export async function searchUsers(q: string): Promise<PublicUser[]> {
  const s = q.trim().toLowerCase()
  if (s.length < 2) return []
  const res = await getDocs(query(collection(db, 'profili'), orderBy('nomeMin'), where('nomeMin', '>=', s), where('nomeMin', '<', `${s}`), limit(10)))
  return res.docs.filter((d) => d.id !== me?.uid).map((d) => ({ uid: d.id, nome: d.get('nome'), avatar: d.get('avatar') ?? null }))
}

export async function inviteUser(id: string, user: PublicUser, ruolo: 'editor' | 'viewer'): Promise<void> {
  const uid = user.uid
  const board = state.boards.get(id)
  if (!board) throw new Error('Bacheca non trovata')
  const m = who()
  const b = writeBatch(db)
  b.set(doc(db, 'inviti', `${id}_${uid}`), {
    bacheca: id,
    uid,
    uNome: user.nome.slice(0, 60),
    ruolo,
    da: m.uid,
    daNome: m.nome.slice(0, 60),
    bachecaNome: board.nome.slice(0, 60),
    scade: Timestamp.fromMillis(Date.now() + 30 * 86_400_000),
    creato: serverTimestamp(),
  })
  notifyOne(b, uid, id, board.nome, 'invito')
  await b.commit()
}

export async function cancelInvite(inviteId: string): Promise<void> {
  await deleteDoc(doc(db, 'inviti', inviteId))
}

export async function acceptInvite(inv: DirectInvite): Promise<void> {
  const m = await whoReady()
  const b = writeBatch(db)
  b.set(doc(db, 'boards', inv.bacheca, 'partecipanti', m.uid), participant(inv.ruolo, 'invito'))
  b.delete(doc(db, 'inviti', inv.id))
  b.set(doc(db, 'users', m.uid, 'bacheche', inv.bacheca), { aggiunta: serverTimestamp() })
  notifyOne(b, inv.da, inv.bacheca, inv.bachecaNome, 'accettato')
  await b.commit()
}

export async function declineInvite(inv: DirectInvite): Promise<void> {
  await deleteDoc(doc(db, 'inviti', inv.id))
}

// ---------------------------------------------------------------- migrazione della lista storica

/** La vecchia lista "Condivisi" diventa la bacheca "condivisi": chi la avvia ne è il
 *  proprietario, gli altri membri storici entrano come "può modificare", con tutti i sentieri. */
export async function migrateLegacy(membri: Map<string, string>, condivisi: Map<string, { da: string }>): Promise<void> {
  const m = who()
  const b = writeBatch(db)
  b.set(doc(db, 'boards', 'condivisi'), { nome: 'Condivisi', copertina: { tipo: 'colore', valore: COVER_COLORS[0] }, owner: m.uid, creato: serverTimestamp(), aggiornato: serverTimestamp() })
  b.set(doc(db, 'boards', 'condivisi', 'partecipanti', m.uid), participant('owner', 'creazione'))
  const others = [...membri].filter(([uid]) => uid !== m.uid)
  for (const [uid, nome] of others) {
    b.set(doc(db, 'boards', 'condivisi', 'partecipanti', uid), { uid, ruolo: 'editor', nome: (nome || 'Membro').slice(0, 60), avatar: null, via: 'migrazione', entrato: serverTimestamp() })
  }
  const known = new Set([m.uid, ...others.map(([uid]) => uid)])
  for (const [trail, info] of condivisi) {
    const da = known.has(info.da) ? info.da : m.uid
    const daNome = da === m.uid ? m.nome : (membri.get(da) ?? 'Membro')
    b.set(doc(db, 'boards', 'condivisi', 'sentieri', trail), { da, daNome: daNome.slice(0, 60), aggiunto: serverTimestamp(), data: null, ciSto: {} })
  }
  b.set(doc(db, 'users', m.uid, 'bacheche', 'condivisi'), { aggiunta: serverTimestamp() })
  await b.commit()
  emit({ migrabile: false })
}

// ---------------------------------------------------------------- eliminazione account

/** Esce da tutte le bacheche, elimina quelle di cui è proprietario, inviti e notifiche. */
export async function purgeBoardsData(): Promise<void> {
  const m = who()
  for (const board of [...state.boards.values()]) {
    if (board.ruolo === 'owner') await deleteBoard(board.id)
    else await leaveBoard(board.id).catch(() => {})
  }
  const refs = [
    ...(await getDocs(query(collection(db, 'inviti'), where('uid', '==', m.uid)))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'users', m.uid, 'notifiche'))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'users', m.uid, 'bacheche'))).docs.map((d) => d.ref),
  ]
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db)
    for (const r of refs.slice(i, i + 400)) b.delete(r)
    await b.commit()
  }
  stopBoards()
}
