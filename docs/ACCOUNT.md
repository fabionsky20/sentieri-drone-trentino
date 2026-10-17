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
| `users/{uid}` | `nome`, `zona`, `avatar` (foto Google), `onboarding`, `migrato`, `attestato_scadenza`, `dflight_scadenza` (AAAA-MM-GG), `cercabile`, `invito_codice` (il proprio link), `invitato_da` / `invitato_da_nome` (fissati alla creazione), `creato`, `aggiornato` | solo l'utente |
| `users/{uid}/saved/{sentiero}` | sentieri salvati ("I miei"), `aggiunto` | solo l'utente |
| `users/{uid}/droni/{id}` | `modello`, `classe` (C0/C1/C2/legacy), `peso_g`, `assicurazione_scadenza` | solo l'utente |
| `users/{uid}/bacheche/{b}` | indice delle bacheche dell'utente | solo l'utente |
| `users/{uid}/notifiche/{n}` | notifiche in-app (inviti, ingressi, sentieri, ci sto, note), `letta` | solo l'utente (gli altri possono solo crearle, legate a una bacheca comune) |
| `users/{uid}/uscite/{id}` | sentieri fatti: `sentiero`, `data`, `con` (nomi) + `conUid`, `commento`, `drone` (sì/no), `gpx_km`, `gpx_dplus`; uscite parziali: `parziale`, `partenza` (inizio/fine), `fino_m` (metri fatti da quel capo), `ar` (andata e ritorno). Senza questi campi l'uscita è completa | solo l'utente |
| `users/{uid}/note/{sentiero}` | nota personale sul sentiero (`testo`, max 2000) | solo l'utente |
| `users/{uid}/amici/{uid}` | amici entrati con il mio link: `nome`, `avatar`, `entrato` | solo l'utente (li scrive l'invitato mentre crea il profilo, solo con il codice giusto) |
| `codiciInvito/{codice}` | link "Invita amici": `uid` e `nome` di chi invita | chiunque abbia il codice (anche senza login), nessun elenco |
| `profili/{uid}` | rubrica per la ricerca per nome: `nome`, `avatar` | utenti con login; si toglie con "Visibile nella ricerca" nel profilo |
| `boards/{b}` | bacheca: `nome`, `copertina` (colore o sentiero), `owner` | solo i membri |
| `boards/{b}/partecipanti/{uid}` | `ruolo` (owner / editor / viewer), `nome`, `avatar`, `via` | solo i membri |
| `boards/{b}/sentieri/{id}` | `da`, `aggiunto`, `data` prevista, `ciSto` | membri; scrive solo chi "può modificare" |
| `boards/{b}/note/{n}` | note del gruppo (max 1000 caratteri) | membri; scrive chi "può modificare" |
| `boards/{b}/links/{token}` | link d'invito: `ruolo`, `scade` (max 30 giorni), `revocato` | il proprietario; chi ha il link legge solo quello |
| `inviti/{b}_{uid}` | invito diretto per nome (scade in 30 giorni) | invitato e proprietario |
| `condivisi/{sentiero}` | lista condivisa storica, **sola lettura** (fonte della migrazione) | solo i **membri storici** |
| `membri/{uid}` | membri storici (`nome`), aggiunti a mano dalla console | i membri storici |
| `utenti/{uid}/salvati/…` | **vecchia** posizione dei salvati (prima del passo A) | solo l'utente, sola lettura |

**Regola fissa:** nessun campo per la quota a cui si è volato né per log di volo. Le regole rifiutano qualunque campo non previsto.

### Migrazione dal vecchio formato

Al primo accesso dopo l'aggiornamento, l'app copia `utenti/{uid}/salvati/*` in `users/{uid}/saved/*` e segna il profilo come `migrato`. I vecchi documenti **restano** (nessuna perdita); si cancellano solo con l'eliminazione dell'account. La data di aggiunta dei salvati migrati diventa quella della migrazione (le regole accettano solo l'ora del server).

### Lista condivisa storica

Dal passo B è in sola lettura. Nei Salvati i membri storici vedono il pulsante **TRASFORMA IN BACHECA** finché la bacheca non esiste: chi lo preme per primo ne diventa **proprietario**, tutti i sentieri passano nella bacheca e gli altri membri storici vi entrano in automatico come "può modificare".

## Invita amici

- Nel profilo, **INVITA AMICI** crea (una volta) un codice casuale e il link personale `…/?amico=<codice>`. Sul telefono apre la condivisione nativa, su PC copia negli appunti.
- Facoltativo: "Anche nella bacheca «…»" aggiunge al link un invito alla bacheca (può modificare, 30 giorni).
- Chi apre il link vede "Fabio ti ha invitato su Quota 120". Il codice resta nel browser per 30 giorni: se il profilo viene **creato** in quel momento, registra chi ha invitato e compare tra i suoi amici. Chi era già registrato non cambia nulla.

## Bacheche e inviti (senza Cloud Functions)

- Chiunque abbia fatto login crea bacheche. Ruoli: **proprietario**, **può modificare** (aggiunge/toglie sentieri, data, note, ci sto), **può solo vedere**.
- **Invito con link**: il proprietario sceglie ruolo e scadenza (1, 7 o 30 giorni); il link contiene un codice casuale di 24 caratteri, non indovinabile. Le regole controllano scadenza e revoca: un link scaduto o revocato non fa entrare nessuno.
- **Invito per nome**: cerca nella rubrica `profili`. L'invitato vede solo nome della bacheca e di chi invita, finché non accetta.
- Il proprietario cambia i ruoli e toglie membri; un membro può uscire. Eliminare la bacheca cancella tutto il contenuto.

## Regole di sicurezza

Il file [`firestore.rules`](../firestore.rules) è la copia di riferimento. **Va pubblicato a mano** nella console:

1. https://console.firebase.google.com → progetto **sentieri-e-drone** → *Build* → **Firestore Database** → scheda **Regole**.
2. Seleziona tutto il testo e sostituiscilo con il contenuto di `firestore.rules` (su GitHub: apri il file → pulsante *Copy raw file*).
3. **Pubblica**. Ha effetto entro un minuto.

Le regole sono provate sull'emulatore Firebase (36 casi sui dati personali + 83 sulle bacheche + 27 sugli inviti all'app + 46 su uscite (anche parziali) e note: chi non è membro non legge nulla, chi può solo vedere non scrive, link scaduti o revocati falliscono, nessuno entra senza invito valido, date fino a +10 anni).

## Eliminazione account

"Elimina account" nel profilo cancella: le bacheche di cui è proprietario (con tutto il contenuto), la sua partecipazione alle altre, inviti e notifiche, la voce nella rubrica, il codice di invito, l'elenco degli amici invitati e la propria voce in quello di chi l'ha invitato, profilo, droni, salvati, vecchi salvati, la sua iscrizione ai membri storici, e infine l'account di accesso. Google può chiedere di confermare l'accesso con un popup.

## Prove in locale con gli emulatori

Con `?emulatori` nell'indirizzo, **solo su localhost**, l'app usa gli emulatori Firebase (progetto `demo-quota120`, nessun contatto con i dati veri). Servono Java 21 e `firebase-tools`:

```
npx firebase emulators:start --only firestore,auth --project demo-quota120
# poi: http://localhost:5173/?emulatori
```
