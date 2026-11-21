# Runbook — Configurer WhatsApp pour une entreprise

> **Depuis l'ADR 017 (2026-11-21), la passerelle WhatsApp est Kapso** (qui relaie l'API officielle de Meta). La section « Kapso » ci-dessous est la procédure à suivre ; la section « Meta en direct » plus bas décrit l'ancien chemin, conservé dans le code mais sans écran de connexion.

## Kapso (procédure actuelle)
Pré-requis : un compte Kapso et un projet. Pour un essai : le **sandbox** (numéro de test partagé, sans numéro réel) ; pour un numéro réel : un numéro NEUF non inscrit sur WhatsApp, une entreprise vérifiée chez Meta et un plan payant (le plan gratuit n'offre qu'un numéro).
1. **Kapso → WhatsApp / Phone numbers → Sandbox → Add session** : saisir VOTRE numéro de téléphone de test (format `+212…`) ; envoyer le code d'activation (valable 15 minutes) au numéro du sandbox depuis ce téléphone. Seuls les numéros enregistrés peuvent échanger avec le sandbox ; il n'y a pas de synchronisation de modèles.
2. **Récupérer** : le **Phone number ID** (liste des numéros) et une **clé d'API** (Kapso → Integrate → API keys). Ne jamais les coller dans une conversation ni dans le dépôt.
3. **Plateforme** : `SITE_URL` en https public (en local : un tunnel, par exemple `cloudflared tunnel --url http://localhost:3000`, dont l'adresse change à chaque lancement). Pas de `WHATSAPP_VERIFY_TOKEN` : Kapso n'a pas de poignée de main d'abonnement.
4. **Application** : page Intégrations → « Connecter un numéro WhatsApp (Kapso) » : Phone number ID, clé d'API, et un **secret de webhook** (bouton « Générer » : 64 caractères hexadécimaux, ou le vôtre : 32 à 200 caractères sans espace). L'écran enregistre la clé et le secret (chiffrés), puis vérifie la clé auprès de Kapso. L'adresse du webhook s'affiche à l'écran.
5. **Kapso → webhook du numéro** : créer un webhook de type **`kapso`**, URL `https://<SITE_URL>/api/webhooks/kapso`, `secret_key` = le MÊME secret qu'à l'étape 4, événements de messages (reçu, envoyé, délivré, lu, échec). Si la mise en lot est activée, elle est comprise.
6. **Ajouter le canal** : sur la carte de l'intégration, « Ajouter un numéro » (le numéro WhatsApp du canal, format `+…`), puis « Vérifier la connexion » : le canal devient actif quand la clé est acceptée.
7. **Dépannage** : `provider_auth` = clé refusée (la remplacer : « Remplacer le jeton ») ; `provider_account` = numéro introuvable pour cette clé ; webhook en 401 = secret différent entre l'écran et Kapso ; aucun événement entrant = tunnel arrêté, adresse changée ou numéro non enregistré comme session (sandbox).
8. **Confirmé le 21 novembre sur le sandbox** : adresse et version de l'API (`v24.0`), en-tête `X-API-Key` et route de vérification (`GET /{phone_number_id}?fields=id` : 200, 401 clé invalide, 404 numéro inconnu). **Reste à confirmer au checkpoint C3** : codes d'erreur d'un envoi relayés tels quels de Meta, charges utiles réelles (messages, statuts, lot), valeur de `X-Idempotency-Key` (non utilisée), STOP / préférence marketing (l'événement `whatsapp.contact.marketing_preference_changed` est traité (« stopped » = désinscription complète, « resumed » ne réactive rien) mais sa forme réelle reste à confirmer), synchronisation des modèles (non branchée avec Kapso).

---

## Meta en direct (ancien chemin, sans écran de connexion)

Pré-requis (chemin critique externe, plan §6) : une **app Meta**, un **compte WhatsApp Business** et un **numéro** (un numéro de test suffit pour C3). Tant qu'ils n'existent pas, tout est testé contre des fixtures ; rien de ce runbook n'a été exécuté contre Meta.

1. **Plateforme** (une fois) : définir `WHATSAPP_VERIFY_TOKEN` (16 à 200 caractères ASCII sans espace, secret serveur, jamais dans le dépôt ni dans un `NEXT_PUBLIC_*`) et publier l'application en HTTPS (`SITE_URL`).
2. **Meta for Developers** : dans l'app, produit WhatsApp → Configuration → Webhook : URL de rappel `https://<site>/api/webhooks/whatsapp`, jeton de vérification = `WHATSAPP_VERIFY_TOKEN` ; Meta appelle alors le `GET` de poignée de main. S'abonner au champ `messages`.
3. **Récupérer** : l'identifiant du numéro (Phone number ID), un jeton d'accès (idéalement un jeton système de longue durée) et le **secret de l'app** (Paramètres de l'app → De base).
4. **Application** : page Intégrations → « Connecter un numéro WhatsApp » : coller les trois valeurs ; l'écran enregistre le jeton et le secret (chiffrés) puis vérifie la connexion. L'intégration passe « active » si Meta accepte le jeton pour ce numéro.
5. **Dépannage** : `provider_auth` = jeton refusé ou expiré (le remplacer, « Remplacer le jeton »), `provider_account` = numéro introuvable ou jeton sans accès à ce numéro, `provider_unreadable` = réponse inattendue. Un 401 sur le webhook = secret de l'app différent de celui enregistré. Rotation des secrets : `docs/runbooks/secret-rotation.md`.
6. **Hypothèses à confirmer à C3** : version de l'API Graph (`v25.0`), forme exacte des payloads, absence d'identifiant d'événement unique, délai de nouvel essai de Meta.
