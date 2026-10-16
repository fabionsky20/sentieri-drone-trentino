// Avvio di Firebase condiviso da account.ts e boards.ts (caricato solo quando serve).

import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import { firebaseConfig } from './firebase-config'

// Solo per le prove in locale: con "?emulatori" su localhost usa gli emulatori Firebase
// (progetto demo, nessun contatto con i dati veri). Sul sito pubblicato non si attiva mai.
export const EMULATORS = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulatori')

export const app = initializeApp(EMULATORS ? { ...firebaseConfig, projectId: 'demo-quota120' } : firebaseConfig)
export const auth = getAuth(app) // sessione salvata nel browser: il login resta finché non si esce
// Cache locale persistente: dati visibili anche senza rete (utile in montagna).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
if (EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}
