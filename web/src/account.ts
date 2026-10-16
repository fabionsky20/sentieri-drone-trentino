// Account: login Google (Firebase Auth), profilo creato in automatico, hangar droni,
// sentieri salvati, lista condivisa storica. Dati in Firestore sotto users/{uid}.
// Caricato solo quando serve (import dinamico da main.ts): chi non fa login non scarica Firebase.
//
// REGOLA FISSA: nessun dato sulla quota a cui l'utente ha volato, né log di volo.

import {
  deleteUser,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore'

export type ListName = 'miei' | 'condivisi'
export type DroneClass = 'C0' | 'C1' | 'C2' | 'legacy'

export interface Profile {
  nome: string
  zona: string | null
  avatar: string | null
  onboarding: boolean // true = onboarding completato o saltato
  migrato: boolean
  cercabile: boolean // nella rubrica pubblica (nome e foto) per gli inviti
  attestato_scadenza: string | null // AAAA-MM-GG
  dflight_scadenza: string | null
}

export interface Drone {
  id: string
  modello: string
  classe: DroneClass
  peso_g: number
  assicurazione_scadenza: string | null
}

export interface AccountState {
  status: 'anonimo' | 'caricamento' | 'pronto' | 'errore'
  user: { uid: string; nome: string | null; email: string | null; foto: string | null } | null
  profile: Profile | null
  droni: Drone[]
  miei: Map<string, { aggiunto: Date | null }>
  condivisi: Map<string, { aggiunto: Date | null; da: string }>
  membri: Map<string, string> // uid → nome (solo membri storici)
  legacyMember: boolean // può vedere la lista condivisa storica
  errore?: string
}

import { purgeBoardsData, startBoards, stopBoards } from './boards'
import { auth, db } from './fb'

export * from './boards'

const EMPTY = (): Omit<AccountState, 'status' | 'user'> => ({
  profile: null,
  droni: [],
  miei: new Map(),
  condivisi: new Map(),
  membri: new Map(),
  legacyMember: false,
})
let state: AccountState = { status: 'caricamento', user: null, ...EMPTY() }
const listeners = new Set<(s: AccountState) => void>()
let unsubs: Unsubscribe[] = []

function emit(patch: Partial<AccountState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

export function subscribe(fn: (s: AccountState) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

const toDate = (v: unknown): Date | null => (v as { toDate?: () => Date })?.toDate?.() ?? null
const fail = (e: unknown) => emit({ status: 'errore', errore: (e as Error)?.message ?? String(e) })

// ---------------------------------------------------------------- avvio sessione

/** Crea il profilo al primo accesso e sposta i vecchi salvati (utenti/{uid}/salvati) nel nuovo posto. */
/** Rubrica pubblica: solo nome e foto, per essere trovati e invitati nelle bacheche. */
async function publishDirectory(uid: string, nome: string, avatar: string | null): Promise<void> {
  await setDoc(doc(db, 'profili', uid), { nome: nome.slice(0, 60), nomeMin: nome.slice(0, 60).toLowerCase(), avatar, aggiornato: serverTimestamp() })
}

async function ensureProfile(user: User): Promise<{ nome: string; avatar: string | null; cercabile: boolean }> {
  const ref = doc(db, 'users', user.uid)
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    await setDoc(ref, {
      nome: (user.displayName ?? user.email?.split('@')[0] ?? 'Pilota').slice(0, 60),
      zona: null,
      avatar: user.photoURL?.slice(0, 600) ?? null,
      onboarding: false,
      migrato: false,
      attestato_scadenza: null,
      dflight_scadenza: null,
      creato: serverTimestamp(),
      aggiornato: serverTimestamp(),
    })
  }
  const migrato = snap.exists() && snap.get('migrato') === true
  if (!migrato) {
    const old = await getDocs(collection(db, 'utenti', user.uid, 'salvati'))
    const batch = writeBatch(db)
    for (const d of old.docs) batch.set(doc(db, 'users', user.uid, 'saved', d.id), { aggiunto: serverTimestamp() })
    batch.set(ref, { migrato: true, aggiornato: serverTimestamp() }, { merge: true })
    await batch.commit()
    // I vecchi documenti restano dove sono (nessuna perdita); si cancellano solo con l'account.
  }
  const now = (await getDoc(ref)).data()!
  const info = { nome: String(now.nome), avatar: (now.avatar as string | null) ?? null, cercabile: now.cercabile !== false }
  if (info.cercabile) await publishDirectory(user.uid, info.nome, info.avatar).catch(() => {})
  return info
}

async function start(user: User): Promise<void> {
  unsubs.forEach((u) => u())
  unsubs = []
  emit({ status: 'caricamento', user: { uid: user.uid, nome: user.displayName, email: user.email, foto: user.photoURL }, ...EMPTY() })
  let info: { nome: string; avatar: string | null; cercabile: boolean }
  try {
    info = await ensureProfile(user)
  } catch (e) {
    fail(e)
    return
  }
  const uid = user.uid
  unsubs.push(
    onSnapshot(
      doc(db, 'users', uid),
      (s) => {
        if (!s.exists()) return
        const d = s.data()
        emit({
          status: 'pronto',
          profile: {
            nome: d.nome,
            zona: d.zona ?? null,
            avatar: d.avatar ?? null,
            onboarding: !!d.onboarding,
            migrato: !!d.migrato,
            cercabile: d.cercabile !== false,
            attestato_scadenza: d.attestato_scadenza ?? null,
            dflight_scadenza: d.dflight_scadenza ?? null,
          },
        })
      },
      fail,
    ),
    onSnapshot(
      collection(db, 'users', uid, 'saved'),
      (s) => emit({ miei: new Map(s.docs.map((d) => [d.id, { aggiunto: toDate(d.get('aggiunto')) }])) }),
      fail,
    ),
    onSnapshot(
      collection(db, 'users', uid, 'droni'),
      (s) =>
        emit({
          droni: s.docs
            .map((d) => ({
              id: d.id,
              modello: String(d.get('modello')),
              classe: d.get('classe') as DroneClass,
              peso_g: Number(d.get('peso_g')),
              assicurazione_scadenza: d.get('assicurazione_scadenza') ?? null,
            }))
            .sort((a, b) => a.modello.localeCompare(b.modello, 'it')),
        }),
      fail,
    ),
  )
  // Lista condivisa storica: solo per chi è nella raccolta "membri".
  try {
    const m = await getDoc(doc(db, 'membri', uid))
    if (m.exists()) {
      emit({ legacyMember: true })
      unsubs.push(
        onSnapshot(collection(db, 'membri'), (s) => emit({ membri: new Map(s.docs.map((d) => [d.id, String(d.get('nome') ?? 'senza nome')])) }), () => {}),
        onSnapshot(
          collection(db, 'condivisi'),
          (s) => emit({ condivisi: new Map(s.docs.map((d) => [d.id, { aggiunto: toDate(d.get('aggiunto')), da: String(d.get('da') ?? '') }])) }),
          () => {},
        ),
      )
    }
  } catch {
    // non membro storico: nessuna lista condivisa storica
  }
  await startBoards({ uid, nome: info.nome, avatar: info.avatar }, state.legacyMember).catch(() => {})
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    unsubs.forEach((u) => u())
    unsubs = []
    stopBoards()
    emit({ status: 'anonimo', user: null, ...EMPTY() })
    return
  }
  start(user)
})

/** Riprova dopo un errore di rete o di permessi. */
export function retry(): void {
  if (auth.currentUser) start(auth.currentUser)
}

// ---------------------------------------------------------------- accesso

export async function login(): Promise<void> {
  // Finestra popup: funziona anche su un sito non ospitato da Firebase (github.io).
  await signInWithPopup(auth, new GoogleAuthProvider())
}

export async function logout(): Promise<void> {
  await signOut(auth)
}

function uid(): string {
  const u = auth.currentUser?.uid
  if (!u) throw new Error('Serve il login')
  return u
}

// ---------------------------------------------------------------- profilo

export type ProfilePatch = Partial<Pick<Profile, 'nome' | 'zona' | 'onboarding' | 'attestato_scadenza' | 'dflight_scadenza'>>

export async function updateProfile(patch: ProfilePatch): Promise<void> {
  await setDoc(doc(db, 'users', uid()), { ...patch, aggiornato: serverTimestamp() }, { merge: true })
  // Il nome compare anche nella rubrica pubblica e nelle nuove azioni sulle bacheche.
  if (patch.nome && state.profile) {
    if (state.profile.cercabile) await publishDirectory(uid(), patch.nome, state.profile.avatar)
    const u = auth.currentUser
    if (u) await startBoards({ uid: u.uid, nome: patch.nome, avatar: state.profile.avatar }, state.legacyMember)
  }
}

/** Visibile o no nella ricerca per nome (per ricevere inviti diretti). */
export async function setSearchable(on: boolean): Promise<void> {
  const u = uid()
  await setDoc(doc(db, 'users', u), { cercabile: on, aggiornato: serverTimestamp() }, { merge: true })
  if (on && state.profile) await publishDirectory(u, state.profile.nome, state.profile.avatar)
  else await deleteDoc(doc(db, 'profili', u))
}

// ---------------------------------------------------------------- hangar

export type DroneInput = Omit<Drone, 'id'>

export async function saveDrone(d: DroneInput, id?: string): Promise<void> {
  const ref = id ? doc(db, 'users', uid(), 'droni', id) : doc(collection(db, 'users', uid(), 'droni'))
  await setDoc(ref, {
    modello: d.modello.trim().slice(0, 60),
    classe: d.classe,
    peso_g: Math.round(d.peso_g),
    assicurazione_scadenza: d.assicurazione_scadenza || null,
    aggiornato: serverTimestamp(),
  })
}

export async function removeDrone(id: string): Promise<void> {
  await deleteDoc(doc(db, 'users', uid(), 'droni', id))
}

// ---------------------------------------------------------------- salvati

export async function save(list: ListName, trailId: string): Promise<void> {
  const u = uid()
  if (list === 'miei') await setDoc(doc(db, 'users', u, 'saved', trailId), { aggiunto: serverTimestamp() })
  else await setDoc(doc(db, 'condivisi', trailId), { aggiunto: serverTimestamp(), da: u })
}

export async function remove(list: ListName, trailId: string): Promise<void> {
  const u = uid()
  await deleteDoc(list === 'miei' ? doc(db, 'users', u, 'saved', trailId) : doc(db, 'condivisi', trailId))
}

// ---------------------------------------------------------------- eliminazione account

/** Cancella TUTTI i dati dell'utente (profilo, droni, salvati, vecchi salvati, contributi alla
 *  lista condivisa, iscrizione ai membri storici) e poi l'account di accesso. */
export async function deleteAccount(): Promise<void> {
  const user = auth.currentUser
  if (!user) throw new Error('Serve il login')
  const u = user.uid
  // Prima le bacheche (esce da tutte, elimina le proprie), poi i dati personali.
  await purgeBoardsData()
  unsubs.forEach((x) => x())
  unsubs = []

  const refs = [
    ...(await getDocs(collection(db, 'users', u, 'saved'))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'users', u, 'droni'))).docs.map((d) => d.ref),
    ...(await getDocs(collection(db, 'utenti', u, 'salvati'))).docs.map((d) => d.ref),
  ]
  if (state.legacyMember) {
    refs.push(...(await getDocs(query(collection(db, 'condivisi'), where('da', '==', u)))).docs.map((d) => d.ref))
  }
  // A blocchi da 400 (limite di 500 operazioni per batch).
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db)
    for (const r of refs.slice(i, i + 400)) batch.delete(r)
    await batch.commit()
  }
  // L'iscrizione ai membri va tolta per ultima: serviva per cancellare i contributi condivisi.
  if (state.legacyMember) await deleteDoc(doc(db, 'membri', u))
  await deleteDoc(doc(db, 'profili', u))
  await deleteDoc(doc(db, 'users', u))

  try {
    await deleteUser(user)
  } catch (e) {
    // Google chiede un accesso recente per eliminare l'account: si conferma con un popup.
    if ((e as { code?: string }).code === 'auth/requires-recent-login') {
      await reauthenticateWithPopup(user, new GoogleAuthProvider())
      await deleteUser(user)
    } else {
      throw e
    }
  }
}
