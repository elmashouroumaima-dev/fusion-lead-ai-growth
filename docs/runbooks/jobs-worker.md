# Jobs et worker (file Postgres)

## Principe
Les jobs vivent dans `public.jobs` (ADR 003). Le worker (`apps/worker`) ne touche jamais la table : il appelle des fonctions SQL réservées à `service_role` (`claim_jobs`, `heartbeat_job`, `complete_job`, `fail_job`). La création (`enqueue_job`), l'annulation (`cancel_job`) et le rejeu (`replay_dead_letter`) passent aussi par ces fonctions. Lecture : owner et admin d'une organisation (RLS), pour la future page Exploitation.

États : `queued` → `running` → `succeeded` | `queued` (nouvel essai avec backoff) | `dead_letter` ; `cancelled` pour un job en attente annulé.

## Lancer le worker en local
```bash
pnpm db:start
pnpm worker:dev
```
Le worker lit `SUPABASE_URL` et `SUPABASE_SECRET_KEY` (fichiers `.env` / `.env.local`, jamais commités). Il journalise une ligne JSON par événement sur stdout ; jamais de charge utile, de jeton ni de message d'exception.

Créer un job de démonstration (SQL, local seulement) :
```sql
select private.enqueue_job('<organization_id>', 'noop', '{}'::jsonb, 'demo-' || gen_random_uuid());
```

## Réglages (valeurs par défaut du Runner)
| Réglage | Défaut | Rôle |
|---|---|---|
| `concurrency` | 4 | jobs en parallèle par worker (max 50) |
| `leaseSeconds` | 60 | durée du bail ; un worker mort libère ses jobs au plus tard à l'expiration |
| `heartbeatMs` | bail / 3 | renouvellement du bail pendant l'exécution |
| `pollMs` | 1000 | pause quand la file est vide ou en cas d'erreur de la base |
| `shutdownTimeoutMs` | 30000 | délai laissé aux jobs en cours à l'arrêt |
| `handlerTimeoutMs` | 900000 | durée maximale d'un handler ; au-delà : signal puis échec `HandlerTimeout` (reprenable) |

Backoff (calculé en base) : `10 s × 2^(essai−1)`, plafonné à 1 h, multiplié par un jitter de 0,5 à 1. `max_attempts` par défaut : 5 (1 à 20).

## Arrêt
`SIGTERM` / `SIGINT` : plus aucun nouveau job, attente des jobs en cours (≤ 30 s), code de sortie 0. Si des jobs doivent être abandonnés, code 1 : leurs baux expirent et la base les remet en file (ou en `dead_letter` si les essais sont épuisés). Sous Windows, les signaux ne sont pas transmis aux processus enfants : l'arrêt propre est vérifié par test unitaire (`shutdown.test.ts`), pas en lançant le processus.

## Dead letter
Un job passe en `dead_letter` quand les essais sont épuisés, quand le handler lève une `NonRetryableError`, quand le type est inconnu ou la charge utile invalide, ou quand son bail expire alors que les essais sont épuisés. `last_error` ne contient qu'un **code** (jamais un message) ; l'événement est écrit dans `audit_logs` (`job.dead_lettered`, sans charge utile).

Inspecter (SQL, propriétaire) :
```sql
select id, organization_id, kind, attempts, last_error, finished_at from public.jobs where status = 'dead_letter' order by finished_at desc;
```
Rejouer après correction de la cause (audité `job.replayed`, remet `attempts` à 0) :
```sql
select private.replay_dead_letter('<organization_id>', '<job_id>');
```
Annuler un job en attente (audité `job.cancelled`) : `select private.cancel_job('<organization_id>', '<job_id>');`

## Écrire un handler
```ts
import { z } from "zod";
import { defineHandler } from "./handlers";
export const sendDraft = defineHandler({
  kind: "email.send",                       // ^[a-z0-9_.]{1,64}$
  schema: z.object({ message_id: z.uuid() }).strict(),
  run: async (ctx, payload) => { /* ctx.organizationId vient de la LIGNE du job */ },
});
```
Règles : la charge utile ne porte que des identifiants de lignes (jamais de jeton ni de corps de message ; l'`enqueue` refuse tout ce que `audit_redact` modifierait) ; le handler applique `ctx.organizationId` à chaque accès (service_role contourne la RLS) ; une erreur définitive lève `NonRetryableError("code_court")` ; respecter `ctx.signal` (bail perdu ou arrêt forcé).

## Garanties de livraison
Exécution **au moins une fois** : si l'enregistrement du succès échoue, ou si le worker meurt, le bail expire et le job est repris. Chaque handler doit donc être idempotent (`ctx.idempotencyKey`). À l'arrêt forcé, aucune tentative n'est consommée.

## Limites connues
- `cancel_job` et `replay_dead_letter` enregistrent un acteur « système » et font confiance à `p_org` (service_role) : à compléter par un `p_actor` vérifié avant toute exposition à une action humaine (page Exploitation, J39).
- Sans plafond de longueur de file : la quantité de jobs par organisation est limitée par les quotas du J14, pas encore par la base.
- Les lignes `succeeded`, `cancelled` et `dead_letter` ne sont pas purgées : purge et rétention à définir (J57).
- La page d'exploitation (liste et rejeu des dead letters dans l'interface) est prévue au J39 ; en attendant, SQL.
- Le registre contient seulement `noop` : les handlers métier arrivent avec leurs modules.
