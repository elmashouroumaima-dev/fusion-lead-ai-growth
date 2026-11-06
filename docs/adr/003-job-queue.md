# ADR 003 — File de jobs : table Postgres + worker

- **Statut :** Proposed
- **Date :** 2026-11-10
- **Section de spec :** §6 (worker, jobs, lease, retry, dead_letter), §7 (`jobs`), §10 (idempotency_key)

## Contexte
La spec laisse le choix entre une table `jobs` et « un queue managé » (§6). n8n est exclu ; les campagnes longues ne s'exécutent jamais dans une requête HTTP.

## Décision
**Table `jobs` dans Postgres + worker Node séparé.**
- Colonnes : `id`, `organization_id`, `kind`, `payload` (jsonb validé par zod, sans secret), `status` (`queued | running | succeeded | failed | dead_letter | cancelled`), `attempts`, `max_attempts`, `next_run_at`, `lease_until`, `locked_by`, `idempotency_key`, `last_error` (sans donnée sensible), timestamps.
- **Claim** : `SELECT … WHERE status='queued' AND next_run_at<=now() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT n` ; passage à `running` avec `lease_until` ; heartbeat de renouvellement ; reprise des jobs dont le lease est expiré.
- **Retry** : backoff exponentiel avec jitter ; après `max_attempts` → `dead_letter` (visible et rejouable, rejeu audité).
- **Idempotence** : `unique (organization_id, idempotency_key)` ; toute opération d'envoi a une clé dérivée de (campagne, version, contact) ou (message).
- **Enqueue transactionnel** : un job est créé dans la même transaction que l'écriture métier (pas de perte ni de double effet).
- **Annulation** : `cancelled` pour les jobs en attente d'un contact désabonné ou d'une campagne arrêtée.
- Le worker utilise `service_role` mais chaque handler reçoit et applique explicitement `organization_id` (§11).
- Un job ne contient jamais de jeton ni de corps de message : il référence des lignes (`message_id`, etc.).

## Alternatives
- **File managée / Redis (BullMQ)** : technologie hors stack, second système à sécuriser et à restaurer ; écartée au MVP. À réévaluer si le débit dépasse la capacité de Postgres (critère documenté : latence de claim, volume > ordre de grandeur de dizaines de milliers de messages/heure).
- **pg_cron seul** : insuffisant pour retry/lease par job.

## Conséquences
Observabilité simple (SQL), RLS et audit homogènes, restauration unique. Limites de débit par fournisseur stockées en base (token bucket, ADR 007).
