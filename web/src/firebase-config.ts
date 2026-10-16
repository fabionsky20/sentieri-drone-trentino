// Configurazione web di Firebase. NON è un segreto: identifica il progetto ed è visibile
// in qualunque app web che usa Firebase. La protezione dei dati sta nelle regole di
// sicurezza di Firestore (firestore.rules), che ammettono solo gli utenti in "membri".
// Analytics volutamente non usato.

export const firebaseConfig = {
  apiKey: 'AIzaSyBHcBsHbJGPv4nrdSO2pPsqujzucLC6fN4',
  authDomain: 'sentieri-e-drone.firebaseapp.com',
  projectId: 'sentieri-e-drone',
  storageBucket: 'sentieri-e-drone.firebasestorage.app',
  messagingSenderId: '1057088115184',
  appId: '1:1057088115184:web:b46e1763b2fe728ada4d35',
}
