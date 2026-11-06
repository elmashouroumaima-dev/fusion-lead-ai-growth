# ADR 002 — Monorepo pnpm + Turborepo

- **Statut :** Proposed
- **Date :** 2026-11-10
- **Section de spec :** §6 (structure du dépôt)

## Contexte
La spec propose `apps/web`, `apps/worker`, `packages/{domain,adapters,permissions}`, `supabase/migrations`, `docs`. Le plan demande pnpm + Turborepo.

## Décision
- Workspace **pnpm** (`pnpm-workspace.yaml`), orchestration **Turborepo** (`turbo.json`) pour `lint`, `typecheck`, `test`, `build`.
- Arborescence identique au §6 de la spec ; ajouts autorisés : `tests/` (e2e, acceptance), `scripts/`, `supabase/tests`, `supabase/rollbacks`.
- Règles de dépendance : `packages/domain` ne dépend d'aucun autre package interne ni d'I/O ; `packages/permissions` dépend de `domain` ; `packages/adapters` dépend de `domain` ; `apps/*` dépendent des packages, jamais l'inverse ; `apps/web` n'importe pas `apps/worker` (et inversement).
- Versions de Node et pnpm épinglées (`packageManager`, `.nvmrc`), lockfile commité.

## Alternatives
- npm/yarn workspaces : pnpm retenu (stockage partagé, strict sur les dépendances fantômes).
- Nx : plus lourd, non demandé.

## Conséquences
CI en cache Turborepo ; une règle ESLint de frontières de packages empêche les imports interdits.
