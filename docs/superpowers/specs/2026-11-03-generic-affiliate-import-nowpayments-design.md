# Importazione affiliate e pagamenti NOWPayments — specifica di design

Data: 2026-11-03

Stato: disegno approvato; in revisione della specifica

Repository di destinazione: fork Supaffi enrique-orellana/supaffi

## Obiettivo

Consentire ai merchant di migrare affiliati, codici e storico da un programma esistente usando un formato d’importazione estensibile, quindi attribuire a Supaffi le nuove commissioni su checkout crypto NOWPayments. Il sistema commerce del merchant mantiene la responsabilità di ordini, sconti, accessi e fulfillment; Supaffi diventa la fonte unica per le commissioni dopo il passaggio.

L’integrazione lascia Stripe operativo e definisce un confine riutilizzabile per altri provider. In questa prima consegna i provider supportati sono Stripe e NOWPayments.

## Contesto attuale

Supaffi collega oggi i pagamenti a Stripe. Click e commissioni sono modellati con riferimenti Stripe; una commissione richiede un Click. Non esistono un archivio di payout storici né un contratto generico per i provider. I codici affiliate sono globalmente univoci nell’istanza.

Il nuovo flusso sposta la creazione dell’invoice crypto e la ricezione dell’IPN sotto Supaffi, mantenendo nel sistema commerce del merchant la responsabilità dell’ordine.

## Architettura proposta

### 1. Importazione estensibile e formato d’interscambio

Supaffi definisce un formato d’importazione canonico, versionato e indipendente dalla piattaforma sorgente. Un bundle JSON include manifest, versione schema, data di generazione, conteggi e identificativi sorgente. Contiene affiliati, codici referral, ambiti prodotto, storico commissioni con importi e rimborsi, e snapshot payout.

Gli adattatori sorgente sono moduli separati: convertono un export disponibile nel formato canonico senza introdurre dipendenze specifiche nel core dell’importatore. L’importatore Supaffi accetta il formato canonico; nuovi formati si aggiungono implementando lo stesso contratto di conversione.

Il bundle non contiene credenziali, chiavi provider, password o dati dei clienti. Include nome ed email dell’affiliato perché servono per associarlo a un account Supaffi; conserva gli identificativi sorgente necessari a deduplicare e ricostruire i riferimenti storici. I campi non necessari alla migrazione vengono omessi.

L’importatore offre:
- caricamento locale del bundle e validazione di versione, riferimenti e integrità;
- associazione dei prodotti sorgente ai Merchant Supaffi e scelta dei Program di destinazione;
- anteprima con conteggi, codici non importabili, collisioni e importi non riconciliati;
- conferma esplicita e report finale scaricabile;
- reimport idempotente tramite batch e identificativi sorgente, senza creare doppioni.

Nomi ed email normalizzati possono essere suggeriti per l’associazione. Un conflitto con affiliato o codice già presente richiede una decisione in anteprima; il processo non sovrascrive password, payout details o dati esistenti in modo implicito. Le password non vengono esportate: per i nuovi affiliati Supaffi il merchant invia il normale link di impostazione password.

Gli affiliati e i codici attivi e validi al momento del passaggio diventano affiliati e link live. I codici promozionali restano responsabili degli sconti e dei limiti coupon nel sistema commerce del merchant; Supaffi li usa per attribuire la referral. La percentuale sorgente viene conservata come override del link importato, così codici diversi dello stesso affiliato non perdono la propria percentuale. Per il calcolo la precedenza è: override sul link importato, percentuale personalizzata dell’affiliato, percentuale predefinita del Program. L’importatore conserva date e ambiti prodotto; durante il flusso live il backend commerce resta l’autorità che convalida il codice e passa l’attribuzione soltanto se il codice è valido.

Codici con lo stesso testo possono esistere su prodotti distinti. Supaffi risolve il codice nel contesto del Merchant identificato dall’host e rende l’unicità del codice specifica per Merchant, mantenendo il divieto di riuso nello stesso Merchant. Anche i codici ritirati vengono isolati per Merchant, così il controllo anti-riuso continua a valere senza bloccare codici uguali su prodotti distinti.

### 2. Archivio dello storico

Commissioni e payout importati entrano in un archivio storico immutabile, separato dal ledger operativo. Lo storico è consultabile dal merchant con riferimenti sorgente, valuta, importi, stato originale, rimborso, periodo e riferimento transazione quando presente.

Le commissioni storiche non diventano PENDING, PAYABLE o PAID nel ledger Supaffi e non influenzano il saldo futuro. Gli snapshot payout sono importati una sola volta come aggregati storici, senza inventare quali commissioni individuali siano state pagate e senza duplicare l’importo per ciascun prodotto. Se manca un riferimento prodotto affidabile, il record resta visibile come non allocato nel report storico e non viene attribuito silenziosamente a un Merchant.

L’archivio storico è in sola lettura. Il portale affiliate continua a mostrare il ledger Supaffi operativo; questa prima versione non replica gli aggregati legacy nel portale affiliate.

### 3. Contratto dei provider di pagamento

Supaffi introduce un contratto provider con capacità esplicite per creazione checkout, verifica e normalizzazione webhook, lettura dello stato e rimborsi supportati. Il core lavora su eventi canonici: provider, identificativo evento, riferimento pagamento/checkout, importo e valuta di vendita, importo e asset crypto effettivamente ricevuti quando disponibili, stato e timestamp.

Stripe implementa lo stesso confine mantenendo comportamento e configurazione esistenti. Le credenziali e la configurazione provider sono per Merchant, cifrate a riposo, con attivazione e rotazione separate. La coda webhook usa una chiave idempotente composta da Merchant, provider e ID evento; Stripe conserva il proprio event ID e NOWPayments deriva la chiave da payment ID e stato. Un record pagamento normalizzato ha un vincolo univoco su Merchant, provider e riferimento pagamento esterno; la commissione fa riferimento a questo pagamento, impedendo che eventi ripetuti creino una seconda commissione.

La prima integrazione aggiunge NOWPayments per pagamenti una tantum. Supaffi crea invoice usando le credenziali NOWPayments del Merchant. Il prezzo di vendita e la commissione restano nella valuta fiat scelta per il checkout; asset e importo crypto effettivamente pagati sono conservati separatamente a fini di audit. Non si converte il pagamento crypto in un saldo commissioni.

### 4. Flusso commerce → Supaffi → NOWPayments

1. Il browser conserva il token di referral Supaffi. Il tracking Supaffi riconosce i parametri referral legacy configurati dagli adattatori e i codici importati.
2. Il backend commerce del merchant invia a Supaffi una richiesta checkout autenticata e firmata, con Merchant associato, ID ordine sorgente, importo fiat, valuta, URL di ritorno e token referral già convalidato.
3. Supaffi verifica l’integrazione e il token, applica l’idempotenza per ordine sorgente, crea l’invoice NOWPayments e restituisce URL e riferimento checkout. Il backend commerce registra il riferimento e continua il proprio flusso di redirect.
4. NOWPayments invia l’IPN direttamente a Supaffi. Supaffi verifica la firma con il secret IPN del Merchant prima di accodare l’evento.
5. Dopo un evento finale verificato, Supaffi aggiorna il pagamento e crea al massimo una commissione. Una coda outbox invia al backend commerce l’evento normalizzato e firmato, con ID stabile e riferimento ordine.
6. Il backend commerce applica l’evento al proprio checkout/ordine e mantiene la propria logica di accessi e fulfillment. Una volta completato il cutover, la registrazione locale delle commissioni è disattivata per quel Merchant; ordini, sconti e report non legati alle commissioni continuano a funzionare.

L’API di integrazione usa un HMAC SHA-256 con timestamp e segreto distinto dalle credenziali NOWPayments; Supaffi rifiuta richieste con timestamp oltre ±5 minuti e rende idempotente ogni ordine sorgente. Anche gli eventi inoltrati al backend commerce sono firmati, hanno un ID stabile e sono idempotenti. Un errore temporaneo nell’inoltro o nel fulfillment viene ritentato dalla outbox; non invalida la verifica IPN né crea una seconda commissione.

### 5. Stati e regole NOWPayments

- waiting, confirming, confirmed e sending restano non finali e non creano commissioni.
- partially_paid viene registrato come tentativo aperto; nessuna commissione nasce finché NOWPayments non segnala finished.
- finished marca il pagamento riuscito e calcola una commissione una sola volta sull’importo fiat registrato per il checkout, verificando che i dati firmati dell’IPN siano coerenti.
- failed ed expired chiudono il tentativo senza commissione.
- refunded applica il comportamento di rimborso supportato dalla prima versione: storno completo prima del payout. Rimborsi parziali crypto non vengono stimati in assenza di un importo rimborsato affidabile.
- Un refund che arriva dopo una commissione PAID non recupera automaticamente fondi dall’affiliato; si applica la regola Supaffi esistente sui pagamenti già eseguiti.

Gli eventi firmati validi non associati a un checkout vengono conservati come non riconciliati e ritentati/mostrati al merchant; non sono scartati né trasformati in commissioni.

## Dati Supaffi interessati

- Configurazione integrazione per Merchant, inclusi segreti NOWPayments cifrati.
- Record pagamento normalizzato con Merchant, provider, riferimenti checkout/pagamento, importo fiat, valuta, asset crypto e importo ricevuto; vincolo univoco per Merchant/provider/riferimento pagamento. Le commissioni puntano al record e i riferimenti Stripe esistenti restano consultabili.
- Coda webhook generalizzata e registro degli eventi non riconciliati.
- Override percentuale opzionale sul link importato.
- Batch di migrazione, mappature sorgente→destinazione, commissioni archiviate e snapshot payout archiviati.
- Riferimenti ai checkout commerce, chiave di idempotenza e outbox per l’inoltro degli eventi verificati.

## Sicurezza, cutover e limiti

Le richieste di checkout sono autenticate e legate al Merchant e all’ID ordine; non accettano importi o referral forniti dal browser senza la convalida del backend merchant. Supaffi rifiuta IPN con firma invalida e non registra mai una commissione da un evento non verificato. Import/export e log non includono segreti provider.

Il cutover è esplicito per Merchant: prima si completa l’import e si controlla il report, poi si attiva la creazione checkout Supaffi e l’inoltro IPN, infine si disattiva il ledger commissioni locale. Il report mostra i conteggi prima/dopo e le somme sorgenti/importate. È possibile sospendere la nuova integrazione senza cancellare lo storico.

Fuori dalla prima versione: payout crypto automatici, abbonamenti NOWPayments, rimborsi parziali non documentati nel payload affidabile, marketplace di plugin installabili, e migrazione delle password affiliate. Plug-and-play significa adapter aggiungibili tramite il contratto provider; non un marketplace o caricamento dinamico di codice di terze parti.

## Criteri di accettazione

1. Un bundle nel formato canonico può essere analizzato in anteprima, mappato e importato due volte senza duplicare affiliati, link o storico.
2. Le commissioni e i payout legacy sono consultabili, restano immutabili e non entrano nel saldo operativo né vengono contati due volte.
3. I conflitti, i codici non rappresentabili e i record privi di prodotto sono visibili prima della conferma o nel report, senza perdita silenziosa.
4. Un checkout commerce autenticato crea un invoice NOWPayments tramite Supaffi e conserva l’associazione ordine/referral.
5. IPN non firmati o duplicati non creano commissioni; un pagamento finished crea una sola commissione in valuta fiat e conserva separatamente l’importo crypto.
6. I pagamenti non finali, failed ed expired non creano commissioni; un rimborso completo pre-payout storna la commissione.
7. Gli eventi finali verificati arrivano al backend commerce in modo ritentabile e idempotente, mantenendo accessi e fulfillment.
8. Il cutover disattiva la sola scrittura del ledger affiliate locale, evitando commissioni doppie e lasciando attivi sconti e gestione ordini.
9. La connessione Stripe esistente continua a usare la propria verifica, coda, attribuzione, commissioni e rimborsi.

## Riferimenti provider

- [NOWPayments IPN](https://nowpayments.io/help/what-is/what-is-ipn)
- [Stati di pagamento NOWPayments](https://nowpayments.io/help/dashboard/how-to-view-past-payments-and-purchases)
