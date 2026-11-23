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
| S1 | Créer un contact avec **votre adresse Resend**, lui enregistrer un consentement e-mail (finalité marketing ou transactionnelle), ouvrir sa conversation, rédiger un message et l'**approuver** (voir le guide « Conversations et envoi d'e-mails »). | Le message passe de **en file** à **accepté** en quelques secondes (worker lancé). |
| S2 | Ouvrir votre boîte e-mail. | Le message est arrivé, expéditeur `onboarding@resend.dev`, avec le **pied de page de désabonnement** et les en-têtes `List-Unsubscribe` (afficher l'original). |
| S3 | Attendre une minute, rafraîchir la conversation. | Le message passe à **délivré** (événement `email.delivered` reçu par webhook). Dans la liste des événements de Resend : livraison **200**. |
| S4 | Dans Resend, rejouer l'événement de livraison (**Resend** / renvoyer). | Réponse 200 chez Resend ; **aucun second changement** de statut dans l'application (déduplication). |
| S5 | Envoyer un message à un **autre** contact (adresse qui n'est pas celle de votre compte Resend). | Le message échoue avec le code **sender_not_allowed** ; il n'est **pas** renvoyé en boucle (échec définitif). |
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

## Ce que ce guide ne couvre pas (à connaître)

- **Réponses entrantes** par Resend (`email.received`) : non traité, aucun cas ici.
- **Domaine vérifié et envoi à des clients** : demande un domaine privé (SPF, DKIM, DMARC) ; hors de ce guide.
- Postmark : voir le guide du test réel C3.

## Fiche d'anomalie

Pour chaque **KO** : identifiant du cas, ce que vous avez fait, ce que vous attendiez, ce qui s'est passé, code d'erreur affiché (jamais une clé), capture d'écran sans secret.
