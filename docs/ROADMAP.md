# Quota 120 — Roadmap

## Obiettivo

App per chi fa foto e video con il drone in montagna:

- **sceglie dove andare** (sentieri, punti di interesse, spazio aereo);
- **sa se e quanto può volare quel giorno** (zone D-Flight, NOTAM, meteo);
- **si organizza con gli amici** (bacheche condivise, inviti);
- **tiene traccia di dove è stato** (sentieri fatti, note, statistiche private).

## Contesto e vincoli

- **Uso attuale: privato**, un gruppo di circa 10 amici.
- **Costo zero:** GitHub Pages + Firebase piano gratuito (Spark). Nessun servizio a pagamento, nessuna carta di credito.
- **Niente di commerciale per ora:** niente pubblicità, niente pagamenti, niente abbonamenti. Un eventuale lancio pubblico arriverà solo dopo aver ottenuto i permessi da D-Flight.
- **Privacy:** storico e statistiche sono privati per impostazione; si condivide solo ciò che l'utente sceglie.

## Regola fissa

> **L'app non registra, non chiede e non mostra MAI la quota a cui l'utente ha volato, e non importa log di volo.**
> Nessuna statistica di quota volata, in nessuna fase.

L'app mostra soltanto i **limiti** dello spazio aereo (es. "libero fino a 45 m") presi dai dati ufficiali.
Le regole di sicurezza di Firestore rifiutano qualunque campo non previsto, quindi anche un eventuale campo di quota.

## Fase 1 — Fondamenta

| Passo | Contenuto | Stato |
|---|---|---|
| **A** | Login aperto con Google, profilo creato in automatico, onboarding (nome, zona, droni), **hangar** droni (classe C0/C1/C2/legacy, peso, assicurazione), documenti del pilota con scadenza (attestato A1/A3, abbonamento D-Flight), avvisi a 30 giorni, eliminazione account | ✅ |
| **B** | **Bacheche condivise con inviti**: la vecchia lista "Condivisi" diventa la prima bacheca. Ruoli (proprietario / può modificare / può solo vedere), data prevista, "ci sto", note, inviti via link (scadenza, revoca) e per nome, notifiche in-app | ✅ |
| **C** | **Note sui sentieri**, "**segna come fatto**", **statistiche** (private di default) | da fare |
| **D** | **Meteo** (Open-Meteo) e **indice di volabilità del giorno** | da fare |

## Fase 2 — Beta

- **PWA installabile con offline** (mappe, dati e salvati disponibili senza rete).
- **Notifiche push** (es. scadenze, inviti a una bacheca).
- **Anteprima di volo 3D**: camera a 120 m sopra un punto del sentiero che ruota a 360°.
- **Ostacoli per droni** da OpenStreetMap (cavi di teleferiche e funivie, linee elettriche, elisuperfici) con avviso sul tratto.
- **Segnalazioni dal sentiero** con scadenza (es. "lavori forestali fino al 20/10").
- **App Android** in test chiuso.

## Dopo

- Luce: ora d'oro, posizione del sole.
- Previsione del mare di nubi.
- "Cosa vedo da qui" (panorama con vette e nomi).
- Punti di decollo segnalati dalla community.
- Passaporto e badge.
- Card dell'uscita per Instagram.
- Lista inquadrature.

## Già fatto (prima della roadmap)

Mappa dei sentieri SAT colorata con le zone D-Flight (verde/giallo/rosso) e NOTAM per data,
POI da OpenStreetMap con badge, profilo altimetrico dal LiDAR PAT, filtri, ricerca, foto
Wikimedia, chiusure dei sentieri, redesign grafico. Dettagli in [CLAUDE.md](../CLAUDE.md).
