# Fusion Leap AI Growth

Plateforme SaaS multi-tenant (CRM interne, boîte de réception e-mail + WhatsApp, campagnes avec approbation, agents IA en mode brouillon). Spécification : [`docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md`](docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md) (v1.0, en arabe).

> **État :** Phase 1 (fondations), J5 — environnements et secrets. Aucune fonctionnalité métier avant J5+. Plan : [`docs/plan/development-plan.md`](docs/plan/development-plan.md) · journal : [`docs/progress/journal.md`](docs/progress/journal.md).

## Prérequis

- **Node.js ≥ 22.12** (`.nvmrc` : 24.13.1). Vitest 5 exige Node 22.12+ ; Node 20 n'est pas supporté.
- **pnpm 12.18.0** (champ `packageManager`) : `corepack enable` puis `pnpm -v`.
- Docker (Supabase local, à partir de J5).

```bash
nvm use            # lit .nvmrc
corepack enable
pnpm install
```

## Arborescence (spec §6)

| Dossier | Rôle |
|---|---|
| `apps/web` | Next.js App Router : UI, API routes, webhooks, session |
| `apps/worker` | Worker Node séparé : jobs, sync, envois, agent runs |
| `packages/domain` | Types, validation zod, règles métier pures |
| `packages/adapters` | CRM, e-mail, WhatsApp, Salla, IA |
| `packages/permissions` | RBAC et vérifications de politiques |
| `supabase/` | Migrations, retours arrière, tests RLS |
| `docs/` | ADR, architecture, intégrations, sécurité, journal |

Règles de dépendance (ADR 002, imposées par ESLint) : `domain` ne dépend de rien d'interne ; `permissions` et `adapters` ne dépendent que de `domain` ; `web` et `worker` ne s'importent jamais entre eux.

## Commandes

| Commande | Effet |
|---|---|
| `pnpm dev` | Serveur Next.js (apps/web) |
| `pnpm lint` | ESLint (frontières de packages, pas de `any`, pas de `.only`/`.skip`) |
| `pnpm typecheck` | `tsc --noEmit` dans chaque package (Turborepo) |
| `pnpm test` | Vitest dans chaque package |
| `pnpm build` | Build Turborepo (Next.js) |
| `pnpm format` / `format:check` | Prettier (code uniquement, pas `docs/`) |
| `pnpm worker:dev` | Squelette du worker (tsx watch) |
| `pnpm db:start` / `db:stop` | Démarre / arrête la pile Supabase locale (Docker requis) |
| `pnpm db:reset` | Recrée la base locale à partir de `supabase/migrations` (+ `seed.sql` s'il existe) |
| `pnpm db:migrate` | Applique les migrations en attente sur la base locale |
| `pnpm check:leaks [--require-bundle]` | Garde-fou anti-fuite : aucun secret dans `NEXT_PUBLIC_*`, les `.env*.example` ou le bundle client (CI après `pnpm build`) |
| `pnpm test:rls`, `test:e2e` | **Pas encore disponibles** : échouent volontairement (prévus J7 et J15) |

## Conventions

Voir [`CLAUDE.md`](CLAUDE.md) et [`docs/adr/006-conventions.md`](docs/adr/006-conventions.md) : TypeScript strict, Conventional Commits, une branche par jour (`day-XX-sujet`), migrations jamais modifiées après application, aucun secret dans le dépôt (`.env*` ignorés).

## Environnement et secrets

Trois modèles sans valeur réelle : `.env.development.example`, `.env.staging.example`, `.env.production.example`. En local : copier le modèle de développement vers **`.env.local`** à la racine (ignoré par git) et le remplir avec les valeurs de `pnpm exec supabase status` (base locale).

- Validation zod au démarrage (`packages/domain/src/env`) : le serveur Next.js (`apps/web/instrumentation.ts`) et le worker **refusent de démarrer** si une variable manque ; le message nomme les variables, jamais leurs valeurs.
- Séparation : `clientEnvSchema` (variables `NEXT_PUBLIC_*` uniquement) et `serverEnvSchema` (contient la clé secrète Supabase, serveur et worker seulement).
- `pnpm check:leaks` échoue si un secret apparaît dans une variable publique, un modèle `.env*.example` ou le bundle client.
- Ne jamais committer de `.env*` réel. Les valeurs de staging/production vivent dans le gestionnaire de secrets (ADR 010).
