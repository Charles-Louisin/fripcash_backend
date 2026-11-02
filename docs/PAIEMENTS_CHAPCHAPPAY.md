# Paiements et reversements — Chap Chap Pay

Implémentation de `paiement.md` (racine du dépôt mobile). Ce document décrit ce qui est en place,
comment le configurer, et ce qui reste à valider avec le prestataire avant la production.

## 1. Principe

```
Client ──(1 paiement, page hébergée Chap Chap Pay)──► compte marchand FripCash
                                                        │
ParentOrder FC-20261102-AB12CD34                        │ (fonds conservés)
 ├─ SellerOrder A ── allocation vendeur A ── Payout A ──┤ après réception de A
 ├─ SellerOrder B ── allocation vendeur B ── Payout B ──┤ après réception de B
 ├─ SellerOrder C ── allocation vendeur C ── Payout C ──┤ après réception de C
 ├─ Delivery     ── allocation livreur   ── Payout D ──┘ après confirmation CLIENT
 └─ allocation plateforme (commission) : reste sur le compte marchand → « retained »
```

* **SellerOrder ≠ Payout.** La collection existante `orders` (modèle `Order`) est déjà une
  commande par vendeur : c'est la SellerOrder (préparer, livrer). Le `Payout` est l'argent à envoyer.
  Ce sont deux cycles de vie séparés, avec des statuts séparés (`Order.status` / `Order.payoutStatus`
  / `Payout.status`).
* **Aucun contrôleur ne transfère d'argent.** Les routes (réception, livraison, litige) appellent
  `DeliveryService` / `FinancialService`, qui rendent une allocation éligible et créent son Payout.
  Le **worker** exécute le transfert depuis une **file persistante** (`outboxevents`).
* **Seul le statut vérifié via l'API fait foi** : un webhook ou un retour navigateur déclenche
  une vérification (`GET /ecommerce/{operation_id}` ou `GET /push/{code}/request/{id}`), jamais une
  écriture directe.

## 2. API Chap Chap Pay utilisée

Référence : `https://chapchappay.com/api/swagger.json` (le guide `/guide/` en est le résumé).

| Usage | Endpoint | Signature |
|---|---|---|
| Lien de paiement (E-Commerce) | `POST /api/ecommerce/create` | `CCP-Api-Key` (+ HMAC envoyé) |
| Statut d'un paiement | `GET /api/ecommerce/{operation_id}` | `CCP-Api-Key` |
| Statut par notre référence | `GET /api/ecommerce/order/{order_id}` | `CCP-Api-Key` |
| Reversement (PUSH) | `POST /api/push/{access_code}/request` | `CCP-Api-Key` + `CCP-HMAC-Signature` |
| Statut d'un reversement | `GET /api/push/{access_code}/request/{request_id}` | `CCP-Api-Key` |
| Solde et services | `GET /api/account/info` | `CCP-Api-Key` |
| Transactions du compte | `GET /api/account/transaction?page=N` | `CCP-Api-Key` |

* `CCP-HMAC-Signature` = HMAC-SHA256 hexadécimal du **corps JSON brut**, clé = « clé d'encryptage ».
* Webhooks (`callback_url`) : même signature sur le corps brut + en-tête `CCP-Api-Key` ; vérifiés
  avant toute lecture (`express.raw` sur `/payments/webhook` et `/payouts/webhook`).
* Statuts E-Commerce : `new`, `pending`, `success` (définitif), `canceled`, `failed`, `error`,
  `expired` (lien expiré après 72 h). Un `canceled` peut être suivi d'un `success` tardif.
* Statuts PUSH : `initiating`, `pending`, `success` (définitif), `error` (un succès tardif reste possible).
* **Pas de clé d'idempotence ni de PUSH groupé chez Chap Chap Pay.** D'où :
  * chaque tentative envoie un `order_id` unique (`<payoutReference>-A<n>`), persisté avant l'appel ;
  * après un timeout, la tentative est retrouvée par cet `order_id` dans `/account/transaction` ;
  * un « lot » est un regroupement interne : chaque Payout part en requête individuelle.
* Montants en GNF entiers. `fee_handling=deduct` : les frais sont retenus sur le compte marchand,
  le client paie exactement le total de la commande et le bénéficiaire reçoit exactement son dû.

## 3. Variables d'environnement (Railway)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `CHAPCHAPPAY_API_KEY` | oui | Clé test **ou** production (64 hex) — elle détermine le mode. |
| `CHAPCHAPPAY_ENCRYPTION_KEY` | oui | Clé d'encryptage HMAC (tableau de bord). |
| `CHAPCHAPPAY_PUSH_ACCESS_CODE` | pour les reversements | Code d'accès (6 chiffres) de l'**Agent API** ayant la permission PUSH. |
| `PUBLIC_API_URL` | oui | URL HTTPS publique de l'API (webhooks et page de retour). |
| `CHAPCHAPPAY_BASE_URL` | non | `https://chapchappay.com/api` par défaut. |
| `CHAPCHAPPAY_FEE_HANDLING` | non | `deduct` (défaut) ou `add`. |
| `CHAPCHAPPAY_MIN_PAYMENT_GNF` | non | Minimum de commande (5000 par défaut, valeur des modules officiels). |
| `CHAPCHAPPAY_MIN_PAYOUT_GNF` | non | En dessous, le Payout est `blocked` (`BELOW_MINIMUM`) pour décision admin. |
| `CHAPCHAPPAY_TIMEOUT_MS` | non | 20000 par défaut. |
| `CHAPCHAPPAY_ACCEPT_TEST_NUMBERS` | non | Hors production uniquement : accepte les numéros fictifs du mode test (72… Orange, 76… MTN) comme destination de reversement. |
| `PAYOUT_AUTO_EXECUTE` | non | `true` : un reversement éligible part seul ; `false` : l'admin lance (individuel ou lot). |
| `PAYOUT_MAX_ATTEMPTS` | non | Limite des relances automatiques (requêtes jamais parties). |
| `FINANCE_WORKER_ENABLED` | non | `true` : worker dans le processus API. Mettre `false` si un service worker dédié tourne. |
| `FINANCE_WORKER_POLL_MS` | non | 5000 par défaut. |
| `FINANCE_REQUIRE_TRANSACTIONS` | non | `true` par défaut en production : refuse d'écrire sans replica set MongoDB. |

Dans le tableau de bord Chap Chap Pay : activer E-Commerce et PUSH API, créer l'Agent API (PUSH),
et laisser vide l'URL de callback par défaut (le backend fournit la sienne à chaque opération) :
`<PUBLIC_API_URL>/api/v1/payments/webhook/chapchappay` et `<PUBLIC_API_URL>/api/v1/payouts/webhook/chapchappay`.

**MongoDB doit être un replica set** (transactions). MongoDB Atlas l'est ; un conteneur Mongo
Railway « standalone » ne l'est pas : convertir en replica set ou passer sur Atlas.

### Worker dédié (recommandé en production)

Créer un second service Railway sur le même dépôt : `startCommand = "node dist/worker.js"`,
et `FINANCE_WORKER_ENABLED=false` sur le service API. Plusieurs instances sont sûres
(verrous atomiques par Payout, baux `workerleases` pour les tâches périodiques).

## 4. Garanties anti-double paiement

1. Références uniques en base : `ParentOrder.orderNumber`, `allocationKey`, `payoutReference`,
   `attemptReference`, un Payout par allocation, un paiement client par ParentOrder.
2. Verrou atomique `queued → processing` (`lockedBy`, `lockExpiresAt`) avant tout appel externe.
3. Tentative enregistrée avant l'appel ; timeout / 5xx ⇒ `unknown` ⇒ **vérification**, jamais renvoi.
4. Verrou expiré ⇒ vérification de la tentative (pas de renvoi) ; aucune tentative créée ⇒ remise en file.
5. Relance admin : uniquement un Payout `failed`, délai de 10 min, revérification préalable des
   tentatives (succès tardif), destination relue en base, action journalisée.
6. Aucune transaction MongoDB ouverte pendant un appel HTTP.
7. Ledger (`financialledger`) et audit (`financialauditlogs`) immuables, écritures à clé unique.

## 5. Endpoints

```
POST /api/v1/checkout                          crée ParentOrder + Payment, renvoie payment.paymentUrl
GET  /api/v1/payments/config                   fournisseur actif (public)
GET  /api/v1/payments/return/:ref              retour de la page hébergée → redirection app (public)
POST /api/v1/payments/webhook/chapchappay      webhook paiement (signé)
GET  /api/v1/payments/:ref                     état (vérifie chez le prestataire si en attente)
POST /api/v1/payments/:ref/verify              vérification explicite
POST /api/v1/payouts/webhook/chapchappay       webhook PUSH (signé)

GET  /api/v1/orders/:id/financial-summary      vue filtrée par rôle (vendeur : sa sous-commande seule)
GET  /api/v1/orders/:id/seller-orders
POST /api/v1/seller-orders/:id/confirm-receipt (= /orders/:id/confirm-reception)
GET  /api/v1/deliveries/:id
POST /api/v1/deliveries/:id/confirm-delivery   client uniquement (ou admin)

Admin (audience ADMIN ; * = en-tête X-Admin-Password requis)
GET  /api/v1/admin/payouts                     ?status=&beneficiaryType=&parentOrderId=
GET  /api/v1/admin/payouts/:id                 + tentatives, allocation, webhooks
GET  /api/v1/admin/payouts/:id/attempts
POST /api/v1/admin/payouts/:id/retry           *
POST /api/v1/admin/payouts/:id/resolve-unknown * { outcome, note } après contrôle du tableau de bord
POST /api/v1/admin/payouts/:id/block|unblock   * { reason }
POST /api/v1/admin/payouts/execute-batch       * { payoutIds? }
GET  /api/v1/admin/payout-batches/:batchId
POST /api/v1/admin/deliveries/:id/validate     *
GET  /api/v1/admin/finance/parent-orders
GET  /api/v1/admin/finance/orders/:parentId    vue §21 (sous-commandes, livraison, commission, situation)
GET  /api/v1/admin/finance/payments|refunds|ledger|audit
GET  /api/v1/admin/finance/reconciliation      derniers rapports
POST /api/v1/admin/finance/reconciliation/run
```

## 6. Réconciliation automatique (toutes les 15 min, et récupération chaque minute)

* paiements en attente → vérification ; encaissements chez le prestataire sans paiement confirmé ;
* reversements `processing`/`unknown` ou verrou expiré → vérification ;
* Payouts en file sans tâche active → tâche recréée (le verrou empêche tout doublon) ;
* allocations éligibles sans Payout ; Payouts en échec / bloqués depuis plus de 24 h ;
* plusieurs succès pour un même Payout ; allocations ≠ encaissement ;
* solde marchand < sommes encore dues.

Aucun écart n'est corrigé en inventant un mouvement : rapport (`reconciliation.report`) + alerte admins.

## 7. Commandes antérieures et migration

* CinetPay a été **retiré du projet** : plus de code, de variables ni de webhook `/api/v1/cpn`.
  Supprimer aussi les variables `CINETPAY_*` et `PAYMENT_PROVIDER` sur Railway.
* Toute nouvelle commande passe par Chap Chap Pay (`parentOrderId` présent).
* Les commandes antérieures (sans `parentOrderId`) restent consultables. Leur argent n'étant pas
  dans le système Chap Chap Pay, aucune action ne déclenche de transfert : une réception confirmée
  prévient les admins (« Ancienne commande à régler »), et une demande de remboursement / libération
  sur une commande encore « en attente » renvoie l'erreur `LEGACY_ORDER` (règlement manuel).
* `npm run finance:audit` (lecture seule) liste ces commandes et leurs incohérences.
* Pas de migration rétroactive des montants : on n'invente pas de photographie financière a posteriori.

## 8. À faire valider par Chap Chap Pay AVANT la production

Le modèle est un **encaissement centralisé avec règlement différé** : FripCash encaisse sur son
compte marchand, conserve temporairement les fonds, puis reverse vendeurs et livreurs après
réception. Même sans parler de « séquestre », il faut obtenir **par écrit** du prestataire :

1. que le contrat autorise l'usage **marketplace** (encaissement pour le compte de tiers) ;
2. que la **conservation temporaire des fonds** puis la redistribution via PUSH est permise,
   avec les délais maximums acceptés ;
3. les plafonds PUSH (par transfert, par jour), les frais PUSH et E-Commerce, le délai d'expiration ;
4. le format exact attendu pour `account_number` (9 chiffres locaux `62…`/`65…`, utilisé ici) ;
5. si `order_id` est unique côté PUSH (protection supplémentaire contre les doublons) ;
6. la conformité avec la réglementation de la BCRG sur les services de paiement / monnaie
   électronique et les obligations KYC/LBC-FT applicables aux vendeurs reversés.

Les textes affichés dans l'app parlent de « paiement protégé » et non de « séquestre ».

## 9. Paiement non abouti

* `canceled` (le client annule) ou `expired` (72 h) : commande close, stock rendu.
* `failed` / `error` (numéro introuvable, solde insuffisant…) : la page Chap Chap Pay laisse le
  client réessayer sur le même lien. La commande reste réservée **30 minutes**, puis est close
  si aucun essai n'a réussi. Un succès arrivant après clôture est remboursé automatiquement.

## 10. Vérifications en conditions réelles

* `npm run ccp:check` : appelle le vrai compte (solde, services activés, création et lecture d'un
  lien de paiement de test). Aucun reversement.
* `npm run db:local` : MongoDB locale en replica set (port 27027) pour lancer le serveur sans
  toucher la base Atlas : `MONGODB_URI="mongodb://127.0.0.1:27027/fripcash_local?replicaSet=rs0"`.
* Numéros de test Chap Chap Pay (mode TEST) : Orange Money 720000001, MTN MoMo 760000001,
  PayCard 111000001, Kulu 740000001, Soutra 730000001, Akiba 750000001.
* Chap Chap Pay exige des URL de callback HTTPS : en local, garder `PUBLIC_API_URL` HTTPS ;
  la confirmation passe alors par la vérification API (le webhook part vers cette URL).

## 11. Tests

`npm test` — MongoDB en mémoire (replica set) + double du prestataire. Couvre les 11 scénarios
de la spécification : paiement, réception isolée, échec partiel, relance ciblée, webhook en double,
timeout (exécuté / non exécuté), workers concurrents, lot partiel, livraisons séparées, litige,
remboursement, plus la réconciliation.
