// Sentieri salvati: login Google (Firebase Auth) e liste sincronizzate (Firestore).
// Questo modulo viene caricato solo quando serve (vedi savedClient in main.ts), così chi
// non usa i salvati non scarica l'SDK di Firebase.

import { initializeApp } from 'firebase/app'
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { firebaseConfig } from './firebase-config'

export type ListName = 'miei' | 'condivisi'

export interface SavedState {
  status: 'anonimo' | 'caricamento' | 'non-membro' | 'membro' | 'errore'
  user: { uid: string; nome: string | null; email: string | null } | null
  miei: Map<string, { aggiunto: Date | null }>
  condivisi: Map<string, { aggiunto: Date | null; da: string }>
  membri: Map<string, string> // uid → nome
  errore?: string
}

const app = initializeApp(firebaseConfig)
const auth = getAuth(app) // sessione salvata nel browser: il login resta finché non si esce
// Cache locale persistente: le liste restano visibili anche senza rete (utile in montagna).
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})

let state: SavedState = { status: 'caricamento', user: null, miei: new Map(), condivisi: new Map(), membri: new Map() }
const listeners = new Set<(s: SavedState) => void>()
let unsubs: Unsubscribe[] = []

function emit(patch: Partial<SavedState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

export function subscribe(fn: (s: SavedState) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

const isPermissionError = (e: unknown) => (e as { code?: string })?.code === 'permission-denied'

function watch(user: User): void {
  unsubs.forEach((u) => u())
  unsubs = []
  const fail = (e: unknown) => {
    if (isPermissionError(e)) emit({ status: 'non-membro' })
    else emit({ status: 'errore', errore: (e as Error)?.message ?? String(e) })
  }
  // L'elenco dei membri fa anche da prova di appartenenza: se è negato, l'utente non è membro.
  unsubs.push(
    onSnapshot(
      collection(db, 'membri'),
      (snap) => {
        const membri = new Map(snap.docs.map((d) => [d.id, String(d.get('nome') ?? 'senza nome')]))
        emit({ membri, status: membri.has(user.uid) ? 'membro' : 'non-membro' })
      },
      fail,
    ),
    onSnapshot(
      collection(db, 'utenti', user.uid, 'salvati'),
      (snap) => emit({ miei: new Map(snap.docs.map((d) => [d.id, { aggiunto: d.get('aggiunto')?.toDate?.() ?? null }])) }),
      fail,
    ),
    onSnapshot(
      collection(db, 'condivisi'),
      (snap) =>
        emit({
          condivisi: new Map(
            snap.docs.map((d) => [d.id, { aggiunto: d.get('aggiunto')?.toDate?.() ?? null, da: String(d.get('da') ?? '') }]),
          ),
        }),
      fail,
    ),
  )
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    unsubs.forEach((u) => u())
    unsubs = []
    emit({ status: 'anonimo', user: null, miei: new Map(), condivisi: new Map(), membri: new Map() })
    return
  }
  emit({ status: 'caricamento', user: { uid: user.uid, nome: user.displayName, email: user.email } })
  watch(user)
})

/** Riprova a leggere le liste (es. appena l'utente è stato aggiunto ai membri). */
export function retry(): void {
  const user = auth.currentUser
  if (!user) return
  emit({ status: 'caricamento' })
  watch(user)
}

export async function login(): Promise<void> {
  // Finestra popup: funziona anche su un sito non ospitato da Firebase (github.io).
  await signInWithPopup(auth, new GoogleAuthProvider())
}

export async function logout(): Promise<void> {
  await signOut(auth)
}

export async function save(list: ListName, trailId: string): Promise<void> {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Serve il login')
  if (list === 'miei') await setDoc(doc(db, 'utenti', uid, 'salvati', trailId), { aggiunto: serverTimestamp() })
  else await setDoc(doc(db, 'condivisi', trailId), { aggiunto: serverTimestamp(), da: uid })
}

export async function remove(list: ListName, trailId: string): Promise<void> {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Serve il login')
  await deleteDoc(list === 'miei' ? doc(db, 'utenti', uid, 'salvati', trailId) : doc(db, 'condivisi', trailId))
}
