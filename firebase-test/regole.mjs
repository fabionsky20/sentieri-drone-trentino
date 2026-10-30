// Prove delle regole Firestore (firestore.rules) sull'emulatore: `npm run regole` (serve Java 21).
// Per ora coprono i percorsi personalizzati: "I miei" (users/{uid}/percorsi) e bacheche (boards/{b}/percorsi).
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, setLogLevel, Timestamp, updateDoc, writeBatch } from 'firebase/firestore'

setLogLevel('silent') // i rifiuti attesi altrimenti riempiono l'output

const env = await initializeTestEnvironment({
  projectId: 'demo-quota120',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
})

let ok = 0
let ko = 0
async function check(name, p) {
  try {
    await p
    ok++
    console.log(`  ok   ${name}`)
  } catch (e) {
    ko++
    console.log(`  NO   ${name}: ${e.message.split('\n')[0]}`)
  }
}

const route = (extra = {}) => ({
  nome: 'Dal lago alla forcella',
  partenza: { lon: 11.2, lat: 46.1, sentiero: 'E325', m: 250.5 },
  arrivo: { lon: 11.21, lat: 46.11, sentiero: 'E322A', m: 0, poi: 'n123', poiNome: 'Lago' },
  tratti: [{ s: 'E325', da: 250.5, a: 900, g: 0 }],
  geometria: '_p~iF~ps|U_ulLnnqC',
  km: 3.25,
  dplus: 410,
  buco_m: null,
  ...extra,
})

// Bacheca "b1": alice proprietaria, bob editor, carla in sola lettura. dave non è membro.
await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore()
  const now = Timestamp.now()
  await setDoc(doc(db, 'boards/b1'), { nome: 'Gita', owner: 'alice', creato: now })
  for (const [uid, ruolo] of [['alice', 'owner'], ['bob', 'editor'], ['carla', 'viewer']]) {
    await setDoc(doc(db, `boards/b1/partecipanti/${uid}`), { uid, ruolo, nome: uid, via: ruolo === 'owner' ? 'creazione' : 'link', entrato: now })
  }
})

const as = (uid) => env.authenticatedContext(uid).firestore()
const alice = as('alice')
const bob = as('bob')
const carla = as('carla')
const dave = as('dave')
const mine = (db, id) => doc(db, `users/alice/percorsi/${id}`)
const ts = { creato: serverTimestamp(), aggiornato: serverTimestamp() }

console.log('I miei percorsi')
await check('salvo un percorso', assertSucceeds(setDoc(mine(alice, 'r1'), { ...route(), ...ts })))
await check('rileggo il mio percorso', assertSucceeds(getDoc(mine(alice, 'r1'))))
await check('un altro non lo legge', assertFails(getDoc(mine(bob, 'r1'))))
await check('un altro non lo scrive', assertFails(setDoc(mine(bob, 'r9'), { ...route(), ...ts })))
await check('rifiuta campi in più (quota di volo)', assertFails(setDoc(mine(alice, 'r2'), { ...route({ quota_volo: 80 }), ...ts })))
await check('rifiuta campi in più nei punti', assertFails(setDoc(mine(alice, 'r2'), { ...route({ partenza: { lon: 11.2, lat: 46.1, sentiero: 'E325', m: 1, quota: 5 } }), ...ts })))
await check('rifiuta punti fuori dal Trentino', assertFails(setDoc(mine(alice, 'r2'), { ...route({ partenza: { lon: 2, lat: 46.1, sentiero: 'E325', m: 1 } }), ...ts })))
await check('rifiuta sentiero non valido', assertFails(setDoc(mine(alice, 'r2'), { ...route({ arrivo: { lon: 11.2, lat: 46.1, sentiero: 'xyz', m: 1 } }), ...ts })))
await check('rifiuta nome vuoto', assertFails(setDoc(mine(alice, 'r2'), { ...route({ nome: '' }), ...ts })))
await check('rifiuta dplus non intero', assertFails(setDoc(mine(alice, 'r2'), { ...route({ dplus: 4.5 }), ...ts })))
await check('rifiuta date del client', assertFails(setDoc(mine(alice, 'r2'), { ...route(), creato: Timestamp.now(), aggiornato: Timestamp.now() })))
await check('accetta il buco in metri', assertSucceeds(setDoc(mine(alice, 'r3'), { ...route({ buco_m: 282 }), ...ts })))
await check('rinomino', assertSucceeds(setDoc(mine(alice, 'r1'), { nome: 'Nuovo nome', aggiornato: serverTimestamp() }, { merge: true })))
await check('non cambio la data di creazione', assertFails(updateDoc(mine(alice, 'r1'), { creato: Timestamp.now(), aggiornato: serverTimestamp() })))
await check('un altro non lo cancella', assertFails(deleteDoc(mine(bob, 'r1'))))
await check('cancello il mio', assertSucceeds(deleteDoc(mine(alice, 'r3'))))

console.log('Percorsi in bacheca')
const bp = (db, id) => doc(db, `boards/b1/percorsi/${id}`)
const by = (uid) => ({ da: uid, daNome: uid, aggiunto: serverTimestamp() })
await check("l'editor aggiunge (con notifica 'percorso')", (async () => {
  const b = writeBatch(bob)
  b.set(bp(bob, 'p1'), { ...route(), ...by('bob') })
  b.set(doc(bob, 'users/alice/notifiche/n1'), { tipo: 'percorso', bacheca: 'b1', bachecaNome: 'Gita', da: 'bob', daNome: 'bob', testo: 'Dal lago alla forcella', creato: serverTimestamp(), letta: false })
  await assertSucceeds(b.commit())
})())
await check('la proprietaria aggiunge', assertSucceeds(setDoc(bp(alice, 'p2'), { ...route(), ...by('alice') })))
await check('chi legge soltanto non aggiunge', assertFails(setDoc(bp(carla, 'p3'), { ...route(), ...by('carla') })))
await check('non si aggiunge a nome di altri', assertFails(setDoc(bp(bob, 'p3'), { ...route(), ...by('alice') })))
await check('rifiuta campi in più', assertFails(setDoc(bp(bob, 'p3'), { ...route({ log: 'x' }), ...by('bob') })))
await check('i membri leggono', assertSucceeds(getDoc(bp(carla, 'p1'))))
await check('chi non è membro non legge', assertFails(getDoc(bp(dave, 'p1'))))
await check("l'editor rinomina", assertSucceeds(updateDoc(bp(bob, 'p2'), { nome: 'Giro corto' })))
await check('non si cambia altro', assertFails(updateDoc(bp(bob, 'p2'), { km: 1 })))
await check('chi legge soltanto non cancella', assertFails(deleteDoc(bp(carla, 'p1'))))
await check("l'editor cancella", assertSucceeds(deleteDoc(bp(bob, 'p1'))))

await env.cleanup()
console.log(`\n${ok} ok, ${ko} falliti`)
process.exit(ko ? 1 : 0)
