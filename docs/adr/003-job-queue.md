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

## Mise en œuvre J13 (2026-11-07)
- Table `public.jobs` conforme à la décision (colonnes, `unique (organization_id, idempotency_key)`, enum `job_status`), migration `20261115100000_jobs.sql` et retour arrière. RLS : lecture owner/admin ; **aucun droit d'écriture, même pour `service_role`** : toute opération passe par des fonctions `SECURITY DEFINER` (`enqueue_job`, `claim_jobs`, `heartbeat_job`, `complete_job`, `fail_job`, `cancel_job`, `replay_dead_letter`, `requeue_expired_leases`) dont `EXECUTE` est réservé à `service_role`.
- Claim : `FOR UPDATE SKIP LOCKED`, bail (5 s à 1 h), heartbeat ; chaque claim reprend d'abord les baux expirés (essais restants : remis en file avec backoff ; essais épuisés : `dead_letter`, cause `lease_expired`). Un worker ne peut compléter, échouer ou prolonger qu'un job dont il détient le bail.
- Retry : `10 s × 2^(essai−1)`, plafond 1 h, jitter 0,5 à 1 ; `dead_letter` aussi pour une erreur non reprenable. Une clé d'idempotence dupliquée est **refusée** (`23505 duplicate_job`) plutôt que renvoyée silencieusement : l'appelant décide.
- Charge utile : refusée si `private.audit_redact` la modifierait (clé sensible, chaîne > 200 caractères, profondeur > 16) ; `last_error` ne contient qu'un code (≤ 200 caractères, sans contrôle). Aucun secret ni corps de message.
- Audit (J12) : `job.dead_lettered`, `job.replayed`, `job.cancelled` (sans charge utile, acteur « système » côté worker).
- Worker (`apps/worker`) : accès **par RPC Supabase avec `service_role`** (décision du 2026-11-07 : même pile, pas de mot de passe Postgres direct) ; `Runner` (concurrence, heartbeat, arrêt propre SIGTERM borné), registre de handlers typés (zod) avec `noop`, erreurs réduites à un code. Chaque handler reçoit `organization_id` depuis la ligne du job (jamais la charge utile).
- Revue sécurité adverse (J13) : aucune faille exploitable par un autre rôle que `service_role`. Limites assumées : (1) `cancel_job` et `replay_dead_letter` écrivent un acteur « système » et font confiance à `p_org` : avant de les exposer à une action humaine, ajouter un `p_actor` vérifié contre `organization_members` (owner/admin actif) et transmis à l'audit ; (2) la validation de la charge utile est heuristique (clés sensibles, chaînes > 200 caractères) : elle repose aussi sur la discipline des appelants, d'où des handlers à charge utile stricte (zod) ; (3) exécution « au moins une fois » : tout handler doit être idempotent via `idempotency_key` ; (4) clés d'idempotence uniques à vie, jobs terminés non purgés (rétention J57).
- Reste : enqueue transactionnel depuis l'application (même transaction que l'écriture métier) à brancher avec les premiers modules ; page Exploitation (J39) ; quotas par organisation (J14) ; purge (J57).

