# ADR 017 — Passerelle WhatsApp : Kapso

- **Statut :** Accepted le 2026-11-21 par la responsable technique (voir « Décision de la responsable technique »)
- **Date :** 2026-11-21
- **Section de spec :** §9.3 (WhatsApp Cloud API officielle), §11 (webhooks), §13-5, §14 (hypothèses d'exécution) ; ADR 004 (secrets), 007 (modèle de données), 008 (webhooks e-mail, modèle d'authentification) ; CLAUDE.md (interdits : WhatsApp Web non officiel, secrets dans les journaux, envoi sans approbation)

## Contexte
Aujourd'hui l'application parle **directement** à l'API Graph de Meta (`graph.facebook.com`) : jeton d'accès par intégration, signature des webhooks `X-Hub-Signature-256` avec le « secret de l'app » (J34 à J36, J36b). Ce chemin est complet et testé sur des fixtures ; il n'a jamais été essayé sur un compte réel (checkpoint C3).

Le chemin direct impose un compte développeur Meta, une application Meta, un compte WhatsApp Business et un numéro non inscrit ailleurs. Pour l'équipe de test, ces prérequis bloquent (compte développeur refusé comme « trop récent », numéro déjà enregistré lors de l'inscription intégrée). **Kapso** (kapso.com) est une passerelle qui expose l'API WhatsApp Cloud de Meta (donc officielle, pas un contournement de type WhatsApp Web) avec : un numéro de test partagé (« sandbox »), l'inscription intégrée d'un numéro réel, et une adresse d'API compatible avec le format de Meta.

La spec et les ADR ne prévoient qu'un seul chemin (Meta direct). Ajouter Kapso est un **nouveau fournisseur** : le CLAUDE.md impose une décision validée avant tout code.

## Ce que la documentation de Kapso annonce (à reconfirmer : pages de 2 à 5 mois)
- **Envoi** : même corps de requête et de réponse que Meta ; `POST https://api.kapso.ai/meta/whatsapp/{version}/{phone_number_id}/messages` (la documentation cite `v24.0`) ; authentification par l'en-tête `X-API-Key` (clé du projet) ; l'identifiant de numéro est celui de Meta.
- **Webhooks** : enregistrés par l'API de Kapso (URL, `secret_key` choisie par nous, type `kapso` ou `meta`). Livraison au moins une fois ; deux réessais (à 10 s et 40 s, environ 50 s au total).
  - type **`kapso`** : charge utile propre à Kapso (`message`, `conversation`, `phone_number_id`…), en-têtes `X-Webhook-Event`, `X-Webhook-Signature`, `X-Idempotency-Key`, `X-Webhook-Payload-Version` ; signature **HMAC-SHA256 hexadécimale sans préfixe** du corps brut, clé = `secret_key` ;
  - type **`meta`** : transmission de la charge utile brute de Meta, avec un `X-Idempotency-Key` ; **la signature de ce type n'est pas établie** par ce que nous avons lu.
- **Sandbox** : un numéro de test **partagé** ; seuls les numéros enregistrés comme « sessions » (code d'activation à envoyer, valable 15 minutes) peuvent échanger avec lui ; pas de synchronisation de modèles.
- **Plan gratuit** : 1 numéro par projet (écran des numéros : « 0 / 1 »).

## Options comparées
| Critère | A. Meta direct (actuel) | B. Kapso, webhooks de type `meta` | C. Kapso, webhooks de type `kapso` |
|---|---|---|---|
| Officialité du canal | Cloud API de Meta | Cloud API de Meta, via un tiers | Idem B |
| Prérequis de test | Compte développeur, app, WABA, numéro | Compte Kapso ; sandbox sans numéro réel | Idem B |
| Envoi | Existant | Même corps ; **autre adresse et autre authentification** | Idem B |
| Réception : analyse des événements | Existante (`events.ts`) | **Réutilisable** si la charge utile est celle de Meta | **Nouvel analyseur** (format Kapso) |
| Signature des webhooks | `X-Hub-Signature-256` (`sha256=<hex>`) | **Inconnue** (à établir) | `X-Webhook-Signature` (hex, sans préfixe) : documentée |
| Déduplication | Empreinte du corps (pas d'identifiant chez Meta) | `X-Idempotency-Key` (valeur à préciser : clé de livraison ou empreinte) | `X-Idempotency-Key` |
| Sous-traitant des données | Meta seulement | **Meta + Kapso** voient messages et numéros | Idem B |
| Modèles de messages (hors fenêtre de 24 h) | Existant (`message_templates`) | À vérifier chez Kapso ; indisponible en sandbox | Idem B |
| Volume de code | Aucun | Moyen : adaptateur d'envoi, vérification de signature, choix par intégration | Plus : en plus, un analyseur d'événements |

## Décision recommandée
**Option B si, et seulement si, la signature des webhooks de type `meta` est documentée et vérifiable (HMAC sur le corps brut avec notre `secret_key`)**, sinon **option C**. Dans tous les cas :
1. **Meta direct reste le chemin par défaut** ; Kapso est un second « fournisseur de passerelle » choisi **par intégration** (pas de bascule globale).
2. **Aucune adresse configurable par l'utilisateur** : l'adresse de Kapso est une constante du code (comme Graph aujourd'hui), jamais saisie.
3. **Test réel d'abord en sandbox Kapso** (numéro de test partagé, numéro du testeur comme session) ; un numéro réel plus tard, après vérification de l'entreprise chez Meta.

## Conséquences (si accepté)
- **Modèle de données** (ADR 007 amendé, nouvelle migration + retour arrière) : la table `integrations` garde `provider = 'whatsapp'` ; une nouvelle colonne **`gateway`** (`meta` par défaut, `kapso`) porte le choix. Aucune table nouvelle. Contrainte : un `external_account_id` (identifiant de numéro) ne peut pas exister à la fois chez Meta et chez Kapso (déjà unique globalement).
- **Secrets** (ADR 004) : l'emplacement du « jeton d'accès » reçoit la **clé API de Kapso** ; l'emplacement du « secret de webhook » reçoit la `secret_key` choisie par nous. Même chiffrement (AES-256-GCM, AAD liée à l'entreprise), jamais renvoyés, jamais journalisés. Rotation par l'écran existant.
- **Adaptateur** `packages/adapters/src/whatsapp/` : constante `KAPSO_BASE`, authentification `X-API-Key`, vérification `X-Webhook-Signature` (comparaison en temps constant, corps brut, taille bornée), analyse des événements selon l'option retenue ; mêmes codes courts (`provider_auth`, `provider_account`, `provider_unavailable`, `provider_unreadable`) ; aucun texte du fournisseur recopié.
- **Chaîne d'envoi inchangée** : approbation humaine, contrôle final (consentement, `do_not_contact`, fenêtre de 24 h, modèle, arrêt d'urgence, débit) restent dans le worker ; Kapso n'est qu'un transport. Aucune logique « agent », « flux » ni « diffusion » de Kapso n'est utilisée.
- **Écran Intégrations** : choix « Meta » ou « Kapso » à la connexion d'un numéro ; champs adaptés (clé API ; secret de webhook).
- **Tests, refus d'abord** : signature fausse, absente, mal préfixée, corps modifié, rejeu (même `X-Idempotency-Key`), numéro d'une autre entreprise, intégration d'une autre passerelle, clé API refusée, panne du fournisseur ; aucun secret ni corps de message dans les journaux et l'audit.
- **Documentation** : runbook `whatsapp-setup.md` (variante Kapso), guide du test réel (C3) en sandbox, `docs/api/webhooks`, CHANGELOG.

## Risques et réserves
- **Sous-traitant supplémentaire** : Kapso voit tous les messages, numéros et statuts de l'entreprise cliente. À valider avec la responsable technique (contrat et accord de traitement des données, lieu de traitement, durée de conservation, politique de confidentialité) **avant tout client réel**. Pour le test avec des données factices, aucun client n'est concerné.
- **Disponibilité et dépendance** : un tiers de plus sur le chemin d'envoi ; réessais de Kapso courts (environ 50 s) : le traitement des webhooks doit rester asynchrone et idempotent (il l'est déjà).
- **Documentation incomplète ou datée** : signature du type `meta`, valeur de `X-Idempotency-Key`, version de l'API (`v24.0` cité, nous utilisons `v25.0` chez Meta), limites du plan gratuit, modèles de messages : **tout est à confirmer au checkpoint C3**.
- **Sandbox** : numéro partagé, adapté au test seulement ; jamais pour des clients.
- **Plan gratuit limité à 1 numéro** : à reconsidérer avant le pilote (plan payant).

## Questions ouvertes pour la responsable technique
1. Accepte-t-on Kapso comme second fournisseur de passerelle (oui / non) ?
2. Sous-traitant : accord de traitement des données et lieu de traitement acceptables ?
3. Option B (webhooks `meta`) ou C (webhooks `kapso`), selon la signature établie ?
4. Kapso pour la production, ou seulement pour les tests et le pilote ?

## Hypothèses à confirmer (C3)
Signature des webhooks `meta` ; valeur et stabilité de `X-Idempotency-Key` ; adresse et version exactes de l'API ; payloads réels des événements (messages, statuts, STOP) ; comportement du sandbox (fenêtre de 24 h, modèles) ; limites de débit.

## Sources (consultées le 2026-11-21)
Documentation officielle de Kapso : vue d'ensemble et sécurité des webhooks, événements de messages, envoi de message, utilisation du sandbox (docs.kapso.ai).

## Décision de la responsable technique (2026-11-21)
1. **Kapso est la seule passerelle WhatsApp utilisée** : Meta en direct n'est plus voulu. *Mise en œuvre retenue par défaut (à contredire si besoin)* : le code Meta direct, déjà écrit et testé, **n'est pas supprimé** et reste sans écran de connexion ; les nouvelles intégrations WhatsApp passent toutes par Kapso (`gateway = 'kapso'` par défaut) ; le retrait du code Meta direct fera l'objet d'une décision séparée.
2. **Sous-traitant** : les essais se font avec des **données factices** (sandbox, numéro du testeur) ; aucun client réel avant l'accord de traitement des données avec Kapso (voir réserve ci-dessous).
3. **Webhooks de type `kapso` (option C)** : signature `X-Webhook-Signature` (HMAC-SHA256 hexadécimal du corps brut, sans préfixe), analyseur d'événements propre à Kapso. *Lecture retenue* : la réponse « C sinon » est comprise comme « option C » (l'option B reste écartée tant que la signature du type `meta` n'est pas établie).
4. **Kapso aussi en production**, pas seulement pour les tests et le pilote.

**Réserve liée à la décision 4** : avant le premier client réel, il faut un contrat et un accord de traitement des données avec Kapso (lieu et durée de conservation), un **plan payant** (le plan gratuit n'offre qu'un numéro) et la **vérification de l'entreprise chez Meta** pour un numéro réel. Ce point est suivi dans le document des tâches de la responsable technique.

## Mise en œuvre prévue (après validation du plan)
Migration `gateway` (retour arrière) ; constante d'adresse de Kapso et authentification `X-API-Key` ; vérification de signature et analyseur d'événements Kapso ; connexion d'un numéro Kapso depuis l'écran ; tests refus d'abord ; guide du test réel (C3) en sandbox ; runbook et documentation de l'API.

## Confirmé sur le sandbox réel (2026-11-21)
Trois appels sortants, avec la clé du projet du testeur (aucun message envoyé, aucune donnée de client) :
- `GET https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}?fields=id` avec `X-API-Key` : **200** `{"id":"<phone_number_id>"}` : l'adresse, la version `v24.0`, l'en-tête et la route de vérification utilisés par l'adaptateur sont **bons** ;
- même appel avec une clé invalide : **401** (`provider_auth`) ; avec la bonne clé et un autre numéro : **404** (`provider_account`) : les codes courts de la vérification se comportent comme prévu ;
- l'API de plateforme (`/platform/v1/whatsapp/phone_numbers`, même clé) liste le numéro « Sandbox WhatsApp ».
**Reste à confirmer** : envoi réel d'un message à la session du testeur, événements réels reçus sur le webhook (messages, statuts), codes d'erreur d'un envoi refusé, STOP, modèles.
