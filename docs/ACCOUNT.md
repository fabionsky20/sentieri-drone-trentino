# Account, profilo e dati utente (Firebase)

## Come funziona

- **Login aperto** con Google (Firebase Authentication): chiunque accede ottiene un profilo creato in automatico. Mappa, filtri e schede funzionano anche senza login; il login serve per salvare, per il profilo e (in futuro) per le funzioni con gli amici.
- L'accesso resta salvato nel browser. Su iPhone conviene aggiungere l'app alla schermata Home: Safari cancella i dati dei siti non usati per 7 giorni.
- Al primo accesso: **onboarding** in 3 schermate saltabili (nome, zona di casa, droni).
- Il codice Firebase si scarica solo quando serve (Salva, Salvati, Profilo) o se il dispositivo aveva già fatto login.
- Tutto resta nel **piano gratuito Spark**: solo Authentication e Firestore, nessuna Cloud Function.

## Dati in Firestore (progetto `sentieri-e-drone`)

| Percorso | Contenuto | Chi lo vede |
|---|---|---|
| `users/{uid}` | `nome`, `zona`, `avatar` (foto Google), `onboarding`, `migrato`, `attestato_scadenza`, `dflight_scadenza` (AAAA-MM-GG), `creato`, `aggiornato` | solo l'utente |
| `users/{uid}/saved/{sentiero}` | sentieri salvati ("I miei"), `aggiunto` | solo l'utente |
| `users/{uid}/droni/{id}` | `modello`, `classe` (C0/C1/C2/legacy), `peso_g`, `assicurazione_scadenza` | solo l'utente |
| `condivisi/{sentiero}` | lista condivisa storica (`da`, `aggiunto`) | solo i **membri storici** |
| `membri/{uid}` | membri storici (`nome`), aggiunti a mano dalla console | i membri storici |
| `utenti/{uid}/salvati/…` | **vecchia** posizione dei salvati (prima del passo A) | solo l'utente, sola lettura |

**Regola fissa:** nessun campo per la quota a cui si è volato né per log di volo. Le regole rifiutano qualunque campo non previsto.

### Migrazione dal vecchio formato

Al primo accesso dopo l'aggiornamento, l'app copia `utenti/{uid}/salvati/*` in `users/{uid}/saved/*` e segna il profilo come `migrato`. I vecchi documenti **restano** (nessuna perdita); si cancellano solo con l'eliminazione dell'account. La data di aggiunta dei salvati migrati diventa quella della migrazione (le regole accettano solo l'ora del server).

### Lista condivisa storica

Resta com'era: visibile e modificabile solo da chi è nella raccolta `membri`. Gli utenti nuovi non la vedono (il pulsante "Condivisi" compare solo ai membri storici). Al passo B diventerà la prima **bacheca** con inviti, e la raccolta `membri` non servirà più.

## Regole di sicurezza

Il file [`firestore.rules`](../firestore.rules) è la copia di riferimento. **Va pubblicato a mano** nella console:

1. https://console.firebase.google.com → progetto **sentieri-e-drone** → *Build* → **Firestore Database** → scheda **Regole**.
2. Seleziona tutto il testo e sostituiscilo con il contenuto di `firestore.rules` (su GitHub: apri il file → pulsante *Copy raw file*).
3. **Pubblica**. Ha effetto entro un minuto.

Le regole sono provate sull'emulatore Firebase (36 casi: accessi incrociati, campi non previsti, date e pesi non validi, lista storica, eliminazione).

## Eliminazione account

"Elimina account" nel profilo cancella: profilo, droni, salvati, vecchi salvati, i sentieri che l'utente ha aggiunto alla lista condivisa, la sua iscrizione ai membri storici, e infine l'account di accesso. Google può chiedere di confermare l'accesso con un popup.

## Prove in locale con gli emulatori

Con `?emulatori` nell'indirizzo, **solo su localhost**, l'app usa gli emulatori Firebase (progetto `demo-quota120`, nessun contatto con i dati veri). Servono Java 21 e `firebase-tools`:

```
npx firebase emulators:start --only firestore,auth --project demo-quota120
# poi: http://localhost:5173/?emulatori
```
