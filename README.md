# Fusion Leap AI Growth

Plateforme SaaS multi-tenant (CRM interne, boîte de réception e-mail + WhatsApp, campagnes avec approbation, agents IA en mode brouillon). Spécification : [`docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md`](docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md) (v1.0, en arabe).

> **État :** Phase 1 (fondations), J4 — squelette du monorepo. Aucune fonctionnalité métier avant J5+. Plan : [`docs/plan/development-plan.md`](docs/plan/development-plan.md) · journal : [`docs/progress/journal.md`](docs/progress/journal.md).

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
| `pnpm test:rls`, `test:e2e`, `db:reset`, `db:migrate` | **Pas encore disponibles** : échouent volontairement (prévus J5–J15) |

## Conventions

Voir [`CLAUDE.md`](CLAUDE.md) et [`docs/adr/006-conventions.md`](docs/adr/006-conventions.md) : TypeScript strict, Conventional Commits, une branche par jour (`day-XX-sujet`), migrations jamais modifiées après application, aucun secret dans le dépôt (`.env*` ignorés).

## Secrets

Ne jamais committer de `.env`. Les valeurs réelles vivent dans le gestionnaire de mots de passe / de secrets ; les modèles `.env.example` arrivent au J5.
