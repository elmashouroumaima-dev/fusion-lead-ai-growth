# API : exploitation des envois (J39)

Toutes les routes : session + entreprise active vérifiée (jamais d'`organization_id` dans le corps : un champ en trop donne 400), `Idempotency-Key` obligatoire, erreurs `{ code, message, request_id }`.

## `POST /api/send/emergency-stop`
Corps : `{ "paused": boolean }`. Réponse 200 : `{ "paused": boolean }`.
- Rôles : owner, admin, marketing manager (permission `sending:emergency_stop`). Commercial, analyste : 403. Anonyme : 401.
- Effet : `organizations.settings.send_paused` ; audit `send.emergency_stop`. Rejouable (même clé = même réponse, un seul audit).
- Runbook : `docs/runbooks/emergency-stop.md`.

## `POST /api/jobs/dead-letters/replay`
Corps : `{ "job_id": uuid }`. Réponse 200 : `{ "replayed": true }`.
- Rôles : owner et admin (permission `dead_letter:replay`). Autres : 403.
- 404 si le job n'existe pas dans l'entreprise active **ou** n'est pas en `dead_letter` (la réponse ne dit pas lequel).
- Effet : le job repart en file (`queued`, tentatives remises à 0) ; audit `job.replayed` avec l'acteur humain.

## Lecture des dead letters
Pas de route : la page `/[locale]/operations` lit `jobs` par le client de l'utilisateur ; la RLS limite la lecture à owner et admin. Colonnes lues : `id`, `kind`, `attempts`, `last_error` (déjà nettoyée par `job_clean_error`), `finished_at`. Jamais de charge utile.

## Alertes
Un job `send_message` qui passe en `dead_letter` crée une notification `send.failed` pour chaque owner et admin actif (payload : `job_id`, `job_kind` ; aucune donnée de contact ni corps de message). Une seule alerte par job et par destinataire (`dedupe_key`).

## Débit
`message_send_claim` compte les envois de l'heure sur **tous les canaux du même type** de l'entreprise (e-mail, WhatsApp). Les plafonds restent `EMAIL_SENDS_PER_HOUR` et `WHATSAPP_SENDS_PER_HOUR` (provisoires).

## Limites connues
- Pas de quota `messages_per_month` (prévu au J57, plan).
- Pas de purge des payloads de webhooks ni des rejets (J58).
- Les alertes `send.failed` n'ont pas encore de panneau dans l'interface (la table est lue par le destinataire seulement ; affichage à prévoir avec le centre de notifications).
- Le plafond de débit est par type de canal ; un plafond par fournisseur d'intégration (Postmark, SMTP…) reste à décider.
