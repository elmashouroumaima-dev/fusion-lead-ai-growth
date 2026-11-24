# Test réel e-mail avec Resend (à côté de Postmark)

Guide pour la personne qui teste. Il couvre le nouveau fournisseur e-mail **Resend** : connexion depuis l'écran, envoi réel, statuts de livraison par webhook signé. Postmark reste disponible (choix par intégration).

- **Durée estimée** : 1 heure 30.
- **Règle d'or** : pour chaque cas, noter **OK** ou **KO** dans la fiche de résultats. En cas de **KO**, noter l'identifiant du cas, le code d'erreur affiché, jamais une clé ni un secret.
- **Données** : adresses de test uniquement. **Sans domaine vérifié, Resend ne livre qu'à l'adresse de votre propre compte Resend** : c'est normal et c'est ce que ce guide utilise.
- **Hypothèses à confirmer par ce test** (marquées **À CONFIRMER**) : la forme exacte de la signature des webhooks (standard Svix), la validation d'une clé « envoi seul », le type de rebond « Permanent ».

---

## 0. Préparation (une seule fois)

1. Démarrer l'application et le worker (deux terminaux) :
   ```bash
   pnpm db:reset
   pnpm dev
   pnpm worker:dev
   ```
   `pnpm db:reset` applique aussi la migration `20261219100000_email_gateway_resend.sql`.
2. Ouvrir un tunnel public vers l'application (Resend doit joindre votre poste), par exemple :
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Noter l'adresse `https://….trycloudflare.com` : appelée `<TUNNEL>` plus bas. L'application doit connaître cette adresse comme `SITE_URL` (HTTPS exigé par les webhooks hors développement local : en local `http`, le test se fait quand même).
3. Compte Resend (gratuit) : créer une **nouvelle clé d'API** (droit **Sending access**, la plus restreinte). **Ne jamais réutiliser une clé qui a été collée dans un message ou un document** : la révoquer et en créer une autre.
4. Adresse d'expéditeur : `onboarding@resend.dev`. Adresse du destinataire : **l'adresse e-mail de votre compte Resend**.
5. Se connecter à l'application avec `alpha-owner` ou `shared@seed.test` (mot de passe de développement : constante `dev_password` de `supabase/seed.sql`).

---

## R. Connexion de Resend depuis l'écran

| ID | Étapes | Résultat attendu |
|---|---|---|
| R1 | Ouvrir **Intégrations**, bloc **Connecter un e-mail**. | Une liste **Fournisseur** (Postmark, Resend). Par défaut : **Postmark**, avec le champ « Jeton du serveur Postmark ». |
| R2 | Choisir **Resend**. | Le champ devient « Clé d'API Resend » ; apparaissent « Secret de signature Resend (whsec_…) » et l'**adresse du webhook** `…/api/webhooks/resend`. |
| R3 | Chez Resend (Webhooks), créer un webhook : adresse `<TUNNEL>/api/webhooks/resend`, événements **email.delivered**, **email.bounced**, **email.complained** seulement. Copier son **Signing secret** (`whsec_…`). | Le webhook existe chez Resend. **Ne pas cocher email.received ni d'événement de domaine ou de contact.** |
| R4 | Remplir : expéditeur `onboarding@resend.dev`, clé d'API de l'étape 3, secret `whsec_…` ; **Connecter et vérifier**. | Message de succès ; l'intégration apparaît avec le canal e-mail **actif**. Les champs de clé et de secret sont vidés. **À CONFIRMER** : une clé « envoi seul » est reconnue valide. |
| R5 | Recommencer avec une clé inventée (`re_faux`). | Message « clé refusée » ; le canal n'est pas actif. |
| R6 | Choisir Resend, laisser le **secret de signature** vide, valider. | Rien n'est envoyé : le secret est obligatoire. |
| R7 | Recommencer avec la même adresse expéditrice déjà connectée. | Message « Cette adresse ou ce compte est déjà connecté. » |

---

## S. Envoi réel et statuts

| ID | Étapes | Résultat attendu |
|---|---|---|
| S1 | Créer le contact et sa conversation (une seule fois), en remplaçant l'adresse par **celle de votre compte Resend** : `docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 -v mail_sender='onboarding@resend.dev' -v wa_sender='' -v tester_name='Testeur Resend' -v tester_email='<votre-adresse-resend>' -v tester_phone='' < docs/testing/fixtures/c3-contact.sql`. Puis ouvrir **Boîte de réception** (Inbox), la conversation du contact, écrire une réponse et l'envoyer (c'est la réponse humaine : l'approbation est faite par le clic sur Envoyer). | Le message passe de **en file** à **accepté** en quelques secondes (worker lancé). |
| S2 | Ouvrir votre boîte e-mail. | Le message est arrivé, expéditeur `onboarding@resend.dev`, avec le **pied de page de désabonnement** et les en-têtes `List-Unsubscribe` (afficher l'original). |
| S3 | Attendre une minute, rafraîchir la conversation. | Le message passe à **délivré** (événement `email.delivered` reçu par webhook). Dans la liste des événements de Resend : livraison **200**. |
| S4 | Dans Resend, rejouer l'événement de livraison (**Resend** / renvoyer). | Réponse 200 chez Resend ; **aucun second changement** de statut dans l'application (déduplication). |
| S5 | Dans l'Inbox, répondre à un **autre** contact dont l'adresse n'est pas celle de votre compte Resend (en créer un par le fixture avec une autre adresse). | Le message échoue avec le code **sender_not_allowed** ; il n'est **pas** renvoyé en boucle (échec définitif). |
| S6 | Si Resend le permet : envoyer à l'adresse de test de rebond de Resend (`bounced@resend.dev`). | **À CONFIRMER** : l'événement de rebond arrive ; un rebond « Permanent » marque l'adresse comme supprimée, un autre type ne la supprime pas. |

---

## T. Sécurité et non-régression (technique)

Remplacer `<TUNNEL>` par votre adresse. Aucune de ces commandes ne contient de vrai secret.

| ID | Étapes | Résultat attendu |
|---|---|---|
| T1 | Faux événement sans signature : `curl -i -X POST <TUNNEL>/api/webhooks/resend -H "content-type: application/json" -d '{"type":"email.delivered","data":{"email_id":"x","from":"onboarding@resend.dev","to":["a@b.test"]}}'` | **401** (jamais 200). |
| T2 | Même commande avec `-H "svix-id: msg_1" -H "svix-timestamp: 1700000000" -H "svix-signature: v1,AAAA"`. | **401** (signature invalide ou horodatage hors fenêtre). Le journal de l'application ne contient ni le corps ni la signature. |
| T3 | Dans les journaux de l'application et du worker, chercher `re_` et `whsec_`. | **Aucune** occurrence : ni clé d'API, ni secret de signature. |
| T4 | Ouvrir une intégration **Postmark** existante (ou en connecter une avec un faux jeton). | Elle fonctionne comme avant : choix par défaut Postmark, aucune différence d'envoi. |
| T5 | **Déconnecter** l'intégration Resend, puis rejouer un événement chez Resend. | **401** : une intégration déconnectée n'accepte plus de webhook. |
| T6 | Dans Resend, désactiver le webhook puis envoyer un message. | Le message est **accepté** mais reste « accepté » (pas de statut « délivré » sans webhook) : comportement attendu. |

---

## U. Réception des réponses (domaine privé requis, facultatif)

À faire seulement quand un **domaine privé** est vérifié chez Resend avec la **réception activée** (enregistrement MX indiqué dans le tableau de bord, priorité la plus basse). L'adresse `onboarding@resend.dev` ne reçoit rien. Chez Resend, ajouter l'événement **email.received** au webhook (R3), connecter l'intégration avec un expéditeur de ce domaine (ex. `ventes@votre-domaine`) et refaire S1 avec cette adresse.

| ID | Étapes | Résultat attendu |
|---|---|---|
| U1 | Depuis la boîte du contact de test, **répondre** à l'e-mail reçu en S2. | Dans les 15 secondes, la réponse apparaît dans l'**Inbox**, dans la conversation du contact (nouveau message entrant). **À CONFIRMER** : forme réelle de la réponse de l'API de réception. |
| U2 | Dans les événements du webhook chez Resend, ouvrir `email.received`. | Livraison **200**. |
| U3 | Répondre une deuxième fois, puis rejouer l'événement `email.received` chez Resend. | **Un seul** message dans l'Inbox (déduplication). |
| U4 | Écrire à l'adresse du canal depuis une adresse **inconnue** (pas un contact). | Aucun contact créé : le message va dans la file des cas ambigus. |
| U5 | Chercher `re_` et `whsec_` dans les journaux. | **Aucune** occurrence. |

---

## Résultats de l'essai du 23 et 24 novembre 2026

Essai fait en local (base locale, application et worker lancés, tunnel `cloudflared`, compte Resend gratuit, expéditeur `onboarding@resend.dev`, destinataire = adresse du compte Resend). Les cas notés **OK** ont été constatés ; **non testé** n'est pas un échec.

| Cas | Résultat | Constat |
|---|---|---|
| R1, R2 | OK | Liste Fournisseur (Postmark par défaut) ; champs Resend et adresse du webhook affichés. |
| R3 | OK | Webhook créé chez Resend (adresse du tunnel + secret `whsec_`). |
| R4 | OK | « Connexion vérifiée », canal **actif**, intégration à la passerelle `resend`. Le type de la clé (envoi seul ou accès complet) n'a pas été relevé : l'hypothèse « une clé d'envoi seul est reconnue valide » reste **À CONFIRMER**. |
| R5, R6 | non testé | |
| R7 | OK (constaté autrement) | « Cette adresse ou ce compte est déjà connecté. » vu sur un reliquat d'essai déconnecté (les adresses restent réservées après déconnexion : voir plus bas). |
| S1 | OK | Réponse envoyée depuis l'Inbox : en file, approuvée, acceptée en moins de 2 secondes. |
| S2 | OK | E-mail reçu dans la boîte du destinataire. Pied de page de désabonnement et en-têtes `List-Unsubscribe` : non relevés. |
| S3 | OK | Statut **délivré** en 3 secondes par webhook signé (2 messages ; événements `processed`, signature valide). |
| S4 | OK | Événement rejoué chez Resend : réponse 200 `duplicate` (visible dans le journal de l'application), aucune ligne en plus, statut du message inchangé. |
| S5 | OK | Message vers une autre adresse : `failed` / **`sender_not_allowed`**, une seule tentative (pas de nouvel essai). |
| S6 | non testé | Rebond « Permanent » : **À CONFIRMER**. |
| T1, T2 | OK | Sans signature, fausse signature, horodatage ancien : **401** et ligne `rejected` / `signature_invalid` sans contenu. Compte inconnu : 401 identique, rien d'enregistré. Corps illisible ou événement de domaine : 400. |
| T3 | OK (en partie) | Aucune clé `re_…` ni secret `whsec_…` dans `audit_logs`, `jobs`, `idempotency_keys`, `webhook_events`, `messages`, `integrations`, `notifications`, ni dans le journal du serveur de développement, ni dans les journaux des conteneurs de la base. Le terminal du worker n'a pas été relu. |
| T4 | OK (en partie) | Tests de Postmark (adaptateur, aiguillage, envoi du worker) et parcours d'acceptation en HTTP réel verts ; pas d'essai avec un vrai jeton Postmark. |
| T5 | OK | Après déconnexion, l'adresse du webhook ne retrouve plus l'intégration (vérifié dans une transaction annulée) : réponse 401 identique à un compte inconnu. |
| T6 | non testé | À faire chez Resend (désactiver le webhook). |
| U1 à U5 | non testé | Demande un domaine privé avec réception activée. |

**Constats de l'essai (corrigés depuis)**
- Le service enregistrait toute intégration e-mail à la passerelle `meta` (Postmark), même en choisissant Resend : corrigé (PR 75), test ajouté.
- La page Intégrations passe en deux onglets (E-mail, WhatsApp) : deux tests d'acceptation ont dû être adaptés (PR 76).
- Les webhooks exigent HTTPS : en local, une requête `curl` doit porter `x-forwarded-proto: https`, comme le fait le tunnel.
- À noter : une adresse déconnectée reste réservée, on ne peut pas la reconnecter telle quelle (comportement existant, à décider avec la responsable technique).
- L'adresse du tunnel change à chaque lancement : mettre à jour le webhook chez Resend.

---

## Ce que ce guide ne couvre pas (à connaître)

- **Domaine vérifié et envoi à des clients** : demande un domaine privé (SPF, DKIM, DMARC) ; hors de ce guide.
- Postmark : voir le guide du test réel C3.

## Fiche d'anomalie

Pour chaque **KO** : identifiant du cas, ce que vous avez fait, ce que vous attendiez, ce qui s'est passé, code d'erreur affiché (jamais une clé), capture d'écran sans secret.
