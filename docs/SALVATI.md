# Sentieri salvati: come funzionano e come aggiungere un membro

## Come funziona

- **Login** con Google (Firebase Authentication). L'accesso resta salvato nel browser: non serve rifarlo.
  Su iPhone conviene aggiungere l'app alla schermata Home: Safari cancella i dati dei siti non usati per 7 giorni, le app sulla Home no.
- **Dati** in Cloud Firestore (progetto Firebase `sentieri-e-drone`, piano gratuito Spark, che non viene sospeso per inattività):
  - `membri/{uid}`: chi può usare i salvati, un documento per persona;
  - `utenti/{uid}/salvati/{sentiero}`: i preferiti di ciascuno, visibili solo al proprietario;
  - `condivisi/{sentiero}`: la lista comune, che tutti i membri vedono e modificano.
- **Sicurezza:** le regole in [`firestore.rules`](../firestore.rules), pubblicate nella console. Chi non è in `membri` non legge e non scrive nulla, anche dopo aver fatto login con Google.
- Nel repo c'è solo la configurazione web (`web/src/firebase-config.ts`), che è pubblica per natura. Nessuna email e nessun dato personale.

## Prima configurazione (una volta sola)

1. **Creare Cloud Firestore** (non il "Realtime Database", che è un altro prodotto):
   console Firebase → *Build* → **Firestore Database** → *Crea database* → modalità **produzione** → posizione `eur3 (europe-west)` → *Crea*.
2. **Pubblicare le regole:** *Firestore Database* → scheda **Regole** → sostituire tutto il testo con il contenuto di `firestore.rules` → **Pubblica**.

## Aggiungere un membro (tu, un amico, chiunque)

1. La persona apre l'app → icona **Salvati** (il segnalibro) → **Accedi con Google**.
2. L'app mostra "*non è ancora tra i membri*" e il suo **ID utente** (una sigla lunga, es. `aB3dE…`), con il pulsante **Copia**. La persona te lo manda.
3. Nella console Firebase → **Firestore Database** → *Dati*:
   - la prima volta: **+ Avvia raccolta** → ID raccolta `membri`;
   - le volte successive: apri la raccolta `membri` → **+ Aggiungi documento**;
   - **ID documento**: incolla l'ID utente (esattamente, senza spazi);
   - aggiungi un campo: nome `nome`, tipo *string*, valore il nome da mostrare (es. `Fabio`);
   - **Salva**.
4. La persona tocca **Riprova** nella sezione Salvati (o ricarica la pagina): vede le liste.

Per **togliere** un membro: elimina il suo documento da `membri`. Da quel momento non legge più nulla; i suoi salvati restano nel database finché non li cancelli (`utenti/{uid}`).

## Problemi comuni

| Messaggio | Causa | Soluzione |
|---|---|---|
| "non è ancora tra i membri" dopo averlo aggiunto | ID copiato male, o documento nella raccolta sbagliata | controlla che la raccolta si chiami `membri` e che l'ID documento coincida |
| "Accesso non riuscito (auth/unauthorized-domain)" | il dominio dell'app non è autorizzato | *Authentication* → *Impostazioni* → *Domini autorizzati* → aggiungi `fabionsky20.github.io` |
| "il browser ha bloccato la finestra di accesso" | popup bloccati | consenti i popup per il sito e riprova |
| Errore con "Cloud Firestore API has not been used" | Firestore non creato | punto 1 della prima configurazione |
