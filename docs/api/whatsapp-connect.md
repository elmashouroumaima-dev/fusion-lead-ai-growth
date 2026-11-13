# Connexion WhatsApp et webhook (J34)

Migration `20261204100000_integration_validation.sql` (retour arrière : `supabase/rollbacks/20261204100000_integration_validation.sql`). Spec §9.3 et §11, ADR 007 (G-D5). Réception des messages : J35 ; envoi : J36. **Aucun compte Meta réel n'est utilisé** : tout est développé et testé contre des fixtures (plan B du plan, §6) ; le test réel est au checkpoint C3.

## Connexion d'un numéro (`ConnectWhatsApp`, page Intégrations)
Owner et admin saisissent trois valeurs, en **écriture seule** (vidées dès l'envoi, jamais relues) :
1. **Identifiant du numéro** (`phone_number_id`, 5 à 30 chiffres) → `external_account_id` de l'intégration (unique dans toute la plateforme, G-R6) ;
2. **Jeton d'accès** → chiffré côté serveur (AES-256-GCM, AAD de l'entreprise), `POST /api/integrations` ;
3. **Secret de l'app Meta** → `POST /api/integrations/webhook-secret` (même emplacement que le secret de webhook e-mail, J32 ; 32 à 200 caractères sans espace).
Puis **`POST /api/integrations/validate`** `{ integration_id }` (bouton « Vérifier la connexion » aussi).

## Vérification (`POST /api/integrations/validate`)
Owner et admin (action `connect`), `Idempotency-Key` obligatoire, limite « sensible ». Le serveur relit l'intégration **avec le client de l'utilisateur** (RLS : son entreprise seulement), déchiffre le jeton en mémoire, appelle `GET https://graph.facebook.com/v25.0/<phone_number_id>?fields=id` (adresse **fixe**, jeton dans l'en-tête `Authorization`, délai 10 s, réponse lue sur 64 Ko), puis écrit le résultat par `integration_set_validation` (**service_role seulement** : un utilisateur ne peut pas se déclarer « actif »).
- `200 { status: "active" }` : le jeton lit le numéro ; `200 { status: "error", code }` avec `code` ∈ `provider_auth` (jeton refusé ou expiré), `provider_account` (numéro introuvable ou non autorisé), `provider_unreadable` ;
- `503` : panne ou limite de Meta ; **rien n'est écrit** (une intégration active ne passe pas en erreur pour une coupure) ;
- `400` : autre fournisseur (l'e-mail attend le compte d'essai, C3), intégration sans jeton, déconnectée ou désactivée ; `404` : intégration d'une autre entreprise ; `403` : autres rôles.
Aucun texte de Meta n'est recopié (il peut citer le numéro ou le jeton) : `integrations.last_error` ne reçoit qu'un code d'une liste fermée. Audit : `integration.validated` / `integration.validation_failed` (fournisseur, code et **identifiant de l'acteur** : sous service_role `auth.uid()` est vide, le serveur fournit l'utilisateur qui a demandé la vérification). Pour WhatsApp, une validation **réussie exige le secret de l'app** enregistré (sinon aucun événement reçu ne passerait la signature : `400`). Limites et pannes de Meta (HTTP 429, 5xx et codes Graph 1, 2, 4, 17, 32, 341, 368, 613, 80007, 130429, 131056, souvent en HTTP 400) donnent `503` sans rien écrire. L'identifiant du numéro est numérique (5 à 30 chiffres) dès la création.

## Webhook `POST /api/webhooks/whatsapp`
Même pipeline que l'e-mail (J29) avec l'adaptateur `whatsappWebhookAdapter` (`packages/adapters/src/whatsapp/webhook.ts`) :
- **signature** `X-Hub-Signature-256: sha256=<hex>` : HMAC-SHA256 du corps **brut** avec le secret de l'app de l'intégration, comparaison à temps constant ; préfixe obligatoire ;
- **compte** = `phone_number_id` du payload (non authentifié : il ne sert qu'à retrouver l'intégration et son secret). Une requête qui mélange **plusieurs numéros** est refusée (400). Compte inconnu = le **même 401** qu'une signature fausse ;
- les notifications de Meta **sans numéro** (état du compte, qualité du numéro, état d'un modèle) sont acceptées (200) tant qu'un autre changement de la requête désigne le numéro ; une requête sans aucun numéro ou avec deux numéros différents est refusée (400) ;
- **forme conservée** : depuis le J35 `parse` normalise le corps (messages reçus et statuts de nos messages seulement, sans profils ni médias : voir `docs/api/whatsapp-inbound.md`) ;
- **déduplication** : Meta n'envoie pas d'identifiant unique par événement (un corps contient une liste de messages et de statuts) ; l'identifiant de la **requête** est l'empreinte (SHA-256, 40 hex) de la forme normalisée : un nouvel essai de Meta (même corps) donne le même identifiant ; chaque **message** est dédupliqué au traitement par son `wamid` (J35) ;
- 3 Mo au plus, HTTPS obligatoire en staging et production, limite par adresse (300 en rafale, 10 par seconde), ACK rapide : l'événement est enregistré, le traitement est différé.
- **Traitement** (J35) : le worker applique les messages et les statuts (`docs/api/whatsapp-inbound.md`).

## Poignée de main d'abonnement `GET /api/webhooks/whatsapp`
Meta appelle `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` une seule fois à la configuration de l'app. Le jeton de vérification est celui de la **plateforme** (variable serveur `WHATSAPP_VERIFY_TOKEN`) : la requête ne porte aucun compte. `200` + défi en texte brut (caractères `A-Za-z0-9_-`, 200 au plus), `403` sinon, `404` si le jeton n'est pas configuré ou pour un autre fournisseur, `429` au-delà de la limite. Comparaison à temps constant ; n'écrit rien.

## Limites connues (revue de sécurité J34, acceptées ou à traiter)
- **Numéro « squatté »** : un numéro n'est réservé qu'à la création (index unique global) et la preuve de propriété vient de la vérification par Meta ; une entreprise malveillante pourrait créer une intégration `pending` sur le numéro d'une autre (disponibilité seulement : elle ne reçoit jamais ses données, la signature échouerait). À traiter avant la production (libérer les intégrations jamais validées après un délai, ou ne résoudre que les intégrations `active`).
- **Jeton remplacé pendant une vérification** : la validation de l'ancien jeton peut marquer `active` le nouveau (fenêtre étroite, nécessite l'owner lui-même).
- **Refus tracés** : jusqu'à 200 lignes `rejected` par heure et par intégration (sans contenu), sans purge ; un appelant peut remplir cette trace pour une intégration connue (la traiter avec la purge du J39).
- **Déduplication de la requête au niveau du corps** : deux envois de Meta qui se recouvrent ont des empreintes différentes ; **traité au J35** (chaque message est dédupliqué par `wamid`). Il n'y a pas de fenêtre de rejeu (un corps signé capturé est rejoué indéfiniment, dédupliqué tant que sa ligne existe : sans danger depuis le J35 grâce à la déduplication par `wamid`).
- **Poignée de main sans adresse source** : seau commun « inconnu » (négligeable).

## Tests
pgTAP `270_integration_validation` (30), adaptateurs (WhatsApp : 13), web (validation, poignée de main, registre), env (jeton), acceptation HTTP `whatsapp-connect`.
