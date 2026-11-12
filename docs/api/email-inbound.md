# E-mail entrant et statuts (J32)

Migration `20261202100000_email_inbound.sql` (retour arrière : `supabase/rollbacks/20261202100000_email_inbound.sql`). Spec §9.2, ADR 007 (G-D5), ADR 008 ; menaces C1 à C5. Route publique : `POST /api/webhooks/email` (pipeline commun du J29, `docs/api/webhooks.md`). Pas d'écran : la boîte de réception et le rattachement humain arrivent au J37.

## Flux
`Postmark` envoie un événement à `https://<site>/api/webhooks/email` avec un Basic Auth > la route authentifie, **normalise** et enregistre l'événement (`webhook_events`) et met un job `process_webhook` en file > le worker applique l'événement avec les fonctions SQL `email_status_apply` ou `email_inbound_apply`. L'acquittement est rapide (200) ; le traitement est différé.

## Authentification (décision actée : ADR 008)
Postmark ne signe pas ses webhooks. L'adaptateur `postmarkWebhookAdapter` (`packages/adapters/src/email/postmark-webhook.ts`) exige un **Basic Auth** :
- **utilisateur** = l'identifiant du compte de l'intégration (`external_account_id`) : il retrouve l'entreprise (jamais un champ du corps) ;
- **mot de passe** = le **secret de webhook** de l'intégration, **distinct du jeton d'envoi** : un secret de webhook divulgué ne permet pas d'envoyer.
Comparaison à temps constant (empreintes SHA-256). Compte inconnu = le même 401 qu'un mauvais mot de passe (revue J29). Le secret circule à chaque requête : en production et en staging (`SITE_URL` en `https://`), **une requête non HTTPS est refusée 400 avant toute lecture** (protocole vu par l'application : `x-forwarded-proto` du proxy de confiance, sinon l'adresse demandée). Pas de liste d'adresses IP (Postmark indique qu'elles changent). Corps limité à 5 Mo (413 au-delà).

### Secret de webhook
- `POST /api/integrations/webhook-secret` `{ integration_id, secret }` : owner et admin, `Idempotency-Key` obligatoire, réponse `{ replaced: true }` (le secret n'est **jamais** renvoyé). `secret` : 32 à 200 caractères ASCII imprimables sans espace (à générer, par exemple 32 octets aléatoires en hexadécimal ou base64 URL). **Le secret de webhook ne peut pas être égal au jeton d'envoi** (400), et le jeton d'envoi ne peut pas être remplacé par le secret de webhook : comparaison à temps constant côté serveur sur les clairs (la base ne le peut pas : chiffrés avec un nonce aléatoire).
- Chiffré dans l'application (AES-256-GCM, AAD de l'entreprise) puis stocké dans `private.secrets` ; colonne `integrations.webhook_secret_ref` **illisible** par l'API (seul `has_webhook_secret` l'est) ; remplacer = rotation ; **déconnecter l'intégration le supprime**. Audit : `integration.webhook_secret_set` / `integration.webhook_secret_rotated` (aucune valeur).
- Fonctions : `set_integration_webhook_secret` (owner, admin), `get_integration_webhook_secret` (service_role : la route du webhook).
- Les secrets de WhatsApp (App Secret, J34) utiliseront ce même emplacement.

## Événements normalisés (`packages/adapters/src/email/events.ts`)
Ce qui est conservé dans `webhook_events.payload` est la **forme normalisée** (pas le corps brut) : ni pièces jointes, ni HTML, ni vidage complet d'un rebond ou d'une plainte, ni détail du serveur distant.
| Postmark | Événement | Identifiant de déduplication |
|---|---|---|
| `Delivery` | `delivered` | `delivery:<MessageID>:<empreinte(Recipient, DeliveredAt)>` |
| `Bounce` | `bounced` (`hard` si `TypeCode` vaut 1 (HardBounce) ou 100000 (BadEmailAddress, adresse invalide) ; blocage du FAI (100006), désactivation manuelle (100002) et rebonds doux : non durs) | `bounce:<ID>` |
| `SpamComplaint` | `complaint` | `complaint:<ID>` |
| entrant (sans `RecordType`, avec `FromFull`) | `inbound` | `inbound:<MessageID>` |
| autre (ouverture, clic...) | `ignored` | acquitté 200, jamais traité |
Adresses normalisées (minuscules, forme stricte). L'identifiant de NOTRE message revient dans les `Metadata` (`fusion_message_id`, ajouté à l'envoi, J31). Texte nettoyé avant stockage : NUL retirés, surrogates isolés remplacés, coupure par point de code (un corps que la base refuserait ferait réessayer le fournisseur jusqu'à perdre le message). Identifiant d'événement toujours conforme à la contrainte de la base (haché quand l'identifiant du fournisseur ne l'est pas).

## Statuts (`email_status_apply`, service_role)
Le message est cherché **dans l'entreprise ET l'intégration authentifiées**, par l'identifiant du fournisseur (prioritaire) ou par `fusion_message_id` ; deux références qui se contredisent = ignoré.
- **delivered** : `accepted` ou `sent` vers `delivered` ; rejeu = sans effet.
- **rebond dur** : le message passe à `bounced` ; l'adresse **où le message est réellement parti** (`approved_recipient`, figée à l'approbation, jamais le payload) est ajoutée à `suppressions` (`bounce`) ; **`do_not_contact` n'est PAS modifié** (adresse invalide ≠ refus du contact). **Rebond doux** : ignoré.
- **plainte** : adresse ajoutée à `suppressions` (`complaint`, qui remplace un `bounce`) **et `do_not_contact = true`** (refus explicite) ; le statut du message ne change pas.
- **réconciliation** : un message `failed` / `send_outcome_unknown` (J31) que le fournisseur confirme est repassé à `accepted` avec son identifiant, puis traité ; de même un message resté `queued` avec une tentative posée depuis **plus de 5 minutes** (worker mort avant l'enregistrement) dès que l'événement porte l'identifiant du fournisseur.
- **envoi encore en cours** (tentative posée depuis moins de 5 minutes, ou sans identifiant du fournisseur) : `retry_later`, le job est rejoué ; jamais envoyé : ignoré.
- La plainte ne remplace qu'une suppression `bounce` : celle d'un `manual` ou d'un `unsubscribe` garde sa provenance (`do_not_contact` est posé dans tous les cas).
- Audit : `message.delivered`, `message.bounced`, `message.complaint`, `message.reconciled`, `suppression.added` (raison seulement : jamais d'adresse ni d'identifiant du fournisseur).

## Réception (`email_inbound_apply`, service_role)
1. **Canal** : l'adresse destinataire (`OriginalRecipient`, posée par le fournisseur ; l'en-tête « To », que l'expéditeur écrit comme il veut, ne sert qu'à défaut) doit être, **exactement**, celle d'**un seul** canal e-mail non déconnecté de l'intégration authentifiée ; à défaut de correspondance exacte, la même adresse **sans l'étiquette `+xxx`** ; sinon `no_channel` ou `ambiguous_channel`.
2. **Spam** (`X-Spam-Status: Yes`, un en-tête suffit) : `spam`. **Expéditeur non authentifié POUR L'ADRESSE QU'IL AFFICHE** : `sender_unverified`, jamais rattaché à un contact. Un « Pass » SPF ne vaut que pour le domaine de l'enveloppe : il faut que le domaine de `envelope-from` / `smtp.mailfrom` soit celui de l'adresse « From » (même domaine ou sous-domaine à la frontière d'un point) ; ou un DKIM valide du domaine de l'auteur (`DKIM_VALID_AU`). **Un en-tête de même nom présent plusieurs fois (celui du fournisseur et un autre, éventuellement forgé par l'expéditeur) rend l'authentification non fiable.**
3. **Contact** : l'adresse expéditrice est celle d'un contact de l'entreprise, sinon `unknown_sender`. **Un expéditeur inconnu ne crée JAMAIS de contact.**
4. Rattachement : fil du couple (contact, canal) (J30 : un seul fil), `message_record` entrant (déduplication par identifiant du fournisseur) ; un fil fermé se rouvre ; un contact « ne plus contacter » ou supprimé peut répondre. Un fil plein (10 000 messages) : `conversation_full`.
5. Tout cas non rattaché va dans **`inbound_unmatched`** (canal, expéditeur, objet, **corps tronqué à 2 000 caractères**, raison, statut `pending`). Plafonds sérialisés : **20 en attente par expéditeur** (au-delà : résultat `dropped` / `sender_limit`, ignoré) et **10 000 par entreprise** (au-delà : `dropped` / `queue_full`, le job échoue **visiblement et définitivement** avec le code `unmatched_queue_full` ; l'événement et son contenu restent conservés, rejouables après le tri). Un même identifiant du fournisseur reçu avec un autre contenu est rangé sous la raison `id_conflict` (jamais un second message, jamais un abandon silencieux).
Plan pour les cas ambigus : le rattachement humain (choisir le contact, ou écarter) arrive avec la boîte de réception (J37).

### `inbound_unmatched`
Lecture **owner et admin** seulement (le corps est une donnée personnelle) ; **aucune écriture directe**, même service_role. Statuts `pending`, `attached`, `discarded` (changés par les fonctions du J37). Raisons : `unknown_sender`, `sender_unverified`, `no_channel`, `ambiguous_channel`, `spam`, `conversation_full`, `id_conflict`.

## Écarts à la spec et au plan
- **Pas de rattachement par `Message-ID` / `In-Reply-To` / `References`** : le J30 impose un fil par contact et par canal ; la réponse se rattache par l'adresse expéditrice dans ce canal (les en-têtes n'ajoutent rien pour choisir le fil).
- Table `inbound_unmatched` et second secret par intégration : **ajouts à l'ADR 007** (amendement dans ce commit).
- Le secret de webhook est **fourni par l'administrateur** (comme le jeton d'envoi) et non généré par le serveur et affiché une fois : même chemin de chiffrement et d'idempotence que le J28, aucune valeur renvoyée.

## Limites connues
- **Postmark reste une hypothèse** (ADR 008) : l'envoi de `Metadata`, la présence de `Received-SPF` sur les entrants et le comportement réel (`TypeCode`, nouvelles tentatives) sont **À CONFIRMER** sur un compte sandbox (checkpoint C3). Les fixtures de test sont les exemples de la documentation officielle.
- **Anti-usurpation (limite connue)** : l'authentification de l'expéditeur repose sur les en-têtes que Postmark ajoute (`Received-SPF`, `X-Spam-Tests`) ; leur présence, leur ordre et leur forme réels sont **À CONFIRMER** sur un compte sandbox. Tant que l'alignement échoue ou que l'en-tête est ambigu, la réponse va dans `inbound_unmatched` (jamais perdue, jamais rattachée à tort). Un jeton de réponse non devinable par conversation (adresse de réponse à étiquette) renforcera l'ensemble avec la boîte de réception (J37).
- La file n'a pas de purge avant le J37 (TTL à prévoir, J39) ; un événement `failed` / `unmatched_queue_full` doit être rejoué par un humain.
- L'authentification d'un compte inconnu ne lit pas le secret (résidu du J29 : écart de temps possible entre compte inconnu et compte connu) : risque accepté.
- Un entrant dont le corps brut dépasse 5 Mo (pièces jointes) est refusé 413 ; les pièces jointes ne sont de toute façon pas conservées.
- Le mot de passe du Basic Auth circule dans chaque requête (plus faible qu'une signature) : HTTPS obligatoire, secret propre à chaque intégration, rotation possible.
- `webhook_events.payload` (adresses, corps des entrants) n'est pas purgé : rétention à définir (J39, J58).
- Aucun flux n'active encore un canal ou une intégration e-mail (validation des identifiants) : l'envoi réel et la réception réelle attendent ce flux et le checkpoint C3.
- Les événements `delivered` d'un message `failed` pour une autre raison, ou `bounced` d'un message `failed`, sont ignorés (`status_conflict`).
