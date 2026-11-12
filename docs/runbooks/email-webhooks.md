# Runbook — Brancher les webhooks e-mail (Postmark)

Pour recevoir les statuts (delivered, rebond, plainte) et les réponses d'un canal e-mail. Hypothèse de fournisseur : Postmark (ADR 008, sous réserve de Q2) ; à confirmer sur un compte sandbox avant tout envoi réel (checkpoint C3). Détail technique : `docs/api/email-inbound.md`.

## Prérequis
- Une intégration e-mail de l'entreprise (Paramétrage > Intégrations), avec son **identifiant de compte** (`external_account_id`) et son jeton d'envoi enregistré.
- Un site en **HTTPS** (le secret de webhook circule dans chaque requête : jamais en HTTP).
- La clé maître de chiffrement configurée côté serveur (ADR 004) ; sans elle, l'enregistrement du secret répond 503.

## 1. Générer et enregistrer le secret de webhook
1. Générer un secret **propre à cette intégration**, d'au moins 32 caractères, jamais réutilisé et jamais partagé par message ou e-mail. Exemple : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. L'enregistrer (owner ou admin) : `POST /api/integrations/webhook-secret` avec `{ "integration_id": "<id>", "secret": "<secret>" }` et un en-tête `Idempotency-Key`. La réponse est `{ "replaced": true }` ; le secret n'est jamais affiché de nouveau : le garder dans le gestionnaire de mots de passe de l'équipe.
3. Vérifier : l'intégration indique `has_webhook_secret = true`.

## 2. Configurer Postmark
Dans le serveur Postmark de l'entreprise (flux « outbound » pour les statuts, flux « inbound » pour les réponses) :
- **URL du webhook** : `https://<identifiant-de-compte>:<secret>@<site>/api/webhooks/email` (Postmark transmet l'utilisateur et le mot de passe en Basic Auth). L'utilisateur est l'identifiant du compte de l'intégration.
- **Événements à cocher** : Delivery, Bounce, Spam complaint (statuts) ; **Inbound** (réponses). Les autres événements (ouvertures, clics) sont acquittés puis ignorés : inutile de les activer.
- Pour recevoir les réponses : l'adresse du canal (`sender_identity`, par exemple `ventes@exemple.com`) doit arriver au flux inbound de Postmark (transfert de la boîte ou enregistrement MX, selon le domaine : question Q2).
- Utiliser l'outil d'essai de Postmark (envoi d'un événement de test) et vérifier la réponse 200.

## 3. Vérifier
- Un événement valide répond **200** (`accepted`, ou `duplicate` s'il est rejoué) ; un mauvais mot de passe ou un compte inconnu répond **401** (le même) ; un corps qui n'est pas un événement répond 400.
- Le job `process_webhook` traite l'événement (worker démarré : `pnpm worker:dev`). Un événement bloqué en `received` signale un worker arrêté.
- Un e-mail entrant d'un contact inconnu **n'est pas perdu** : il est dans `inbound_unmatched` (lisible owner et admin) en attendant le rattachement humain (J37).

## Rotation du secret
1. Enregistrer un nouveau secret (même endpoint) : l'ancien est supprimé immédiatement.
2. Mettre à jour l'URL du webhook dans Postmark **tout de suite** : entre les deux étapes, les événements sont refusés (401) et Postmark les ré-essaie (6 tentatives sur environ 50 minutes d'après leur documentation, puis abandon de l'événement).
3. Le secret divulgué (message, journal, capture) est à remplacer sans attendre.

## Déconnexion
Déconnecter l'intégration supprime le jeton d'envoi **et** le secret de webhook, met ses canaux en pause : les webhooks de ce compte sont refusés. Pour reconnecter : enregistrer de nouveaux secrets (jeton d'envoi, puis secret de webhook).

## Problèmes fréquents
| Symptôme | Cause et remède |
|---|---|
| 401 sur tous les événements | mot de passe différent du secret enregistré, ou utilisateur différent de l'identifiant du compte, ou intégration déconnectée : refaire la rotation et recopier l'URL |
| 503 sur le webhook | adresse source de la requête introuvable (`TRUSTED_PROXY_HOPS` mal réglé derrière le proxy) |
| 413 | corps de plus de 5 Mo (entrant avec de grosses pièces jointes) : refus voulu, l'expéditeur peut renvoyer sans pièce jointe |
| un message reste « accepted » | pas encore d'événement Delivery : normal tant que le fournisseur n'a pas livré ; `delivered` ne vient jamais de l'acceptation de l'API |
| réponse d'un client dans `inbound_unmatched` / `sender_unverified` | l'expéditeur n'est pas authentifié par SPF (usurpation possible) : ne pas rattacher sans vérification |
