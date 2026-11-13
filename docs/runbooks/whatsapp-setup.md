# Runbook — Configurer WhatsApp (Meta) pour une entreprise

Pré-requis (chemin critique externe, plan §6) : une **app Meta**, un **compte WhatsApp Business** et un **numéro** (un numéro de test suffit pour C3). Tant qu'ils n'existent pas, tout est testé contre des fixtures ; rien de ce runbook n'a été exécuté contre Meta.

1. **Plateforme** (une fois) : définir `WHATSAPP_VERIFY_TOKEN` (16 à 200 caractères ASCII sans espace, secret serveur, jamais dans le dépôt ni dans un `NEXT_PUBLIC_*`) et publier l'application en HTTPS (`SITE_URL`).
2. **Meta for Developers** : dans l'app, produit WhatsApp → Configuration → Webhook : URL de rappel `https://<site>/api/webhooks/whatsapp`, jeton de vérification = `WHATSAPP_VERIFY_TOKEN` ; Meta appelle alors le `GET` de poignée de main. S'abonner au champ `messages`.
3. **Récupérer** : l'identifiant du numéro (Phone number ID), un jeton d'accès (idéalement un jeton système de longue durée) et le **secret de l'app** (Paramètres de l'app → De base).
4. **Application** : page Intégrations → « Connecter un numéro WhatsApp » : coller les trois valeurs ; l'écran enregistre le jeton et le secret (chiffrés) puis vérifie la connexion. L'intégration passe « active » si Meta accepte le jeton pour ce numéro.
5. **Dépannage** : `provider_auth` = jeton refusé ou expiré (le remplacer, « Remplacer le jeton »), `provider_account` = numéro introuvable ou jeton sans accès à ce numéro, `provider_unreadable` = réponse inattendue. Un 401 sur le webhook = secret de l'app différent de celui enregistré. Rotation des secrets : `docs/runbooks/secret-rotation.md`.
6. **Hypothèses à confirmer à C3** : version de l'API Graph (`v25.0`), forme exacte des payloads, absence d'identifiant d'événement unique, délai de nouvel essai de Meta.
