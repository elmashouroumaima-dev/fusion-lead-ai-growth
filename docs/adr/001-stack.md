# ADR 001 — Stack technique

- **Statut :** Accepted (2026-11-09, décision de la responsable technique par délégation, après les audits de conformité C1 et C2)
- **Date :** 2026-11-10
- **Section de spec :** §6 (architecture), §15 (références)

## Contexte
La spec impose Next.js App Router, Supabase (Auth, Postgres avec RLS, Storage), un worker Node séparé, `zod` pour la validation et des environnements dev/staging/production séparés (§6, §8). Les versions de paquets doivent être épinglées avec un fichier de verrouillage (§6). La méthode SSR Supabase doit suivre la documentation « au moment de l'implémentation » (§6).

## Décision
| Domaine | Choix |
|---|---|
| Langage | TypeScript en mode `strict` partout (web, worker, packages) |
| Web | Next.js App Router (UI, API routes, webhooks, session) |
| Données / Auth / fichiers | Supabase : Auth, Postgres (RLS), Storage |
| Worker | Node.js + TypeScript, process séparé (`apps/worker`) |
| Validation | `zod` sur toute entrée (API, webhook, job payload, env) |
| Logs | `pino` en JSON, `request_id`, redaction des secrets |
| Tests | Vitest (unitaire/intégration), pgTAP ou Vitest+JWT (RLS), Playwright (E2E), MSW (fournisseurs) |
| Qualité | ESLint, Prettier, `tsc --noEmit` |
| Accès base | Client Supabase + SQL/RPC. **Pas d'ORM** (un ORM contournerait la RLS et masquerait le SQL de sécurité). |

Les **versions exactes** ne sont pas figées ici : elles sont vérifiées dans la documentation officielle et épinglées au J4 (lockfile commité), et la version du paquet SSR Supabase est citée au J8.

## Alternatives écartées
- **ORM (Prisma/Drizzle)** : ajoute une couche hors spec ; le service-role des ORM ignore la RLS ; rejeté sauf ADR ultérieur.
- **API séparée (NestJS/Fastify)** : la spec place API routes et webhooks dans Next.js.
- **Autre BaaS** : la spec nomme Supabase.

## Conséquences
- Toute bibliothèque ajoutée hors de ce tableau nécessite un ADR (i18n : ADR 011 ; IA : ADR 012).
- L'audit de conformité (§15 du plan) vérifie l'absence d'ORM, de file externe et de n8n.

## Versions épinglées au J4 (2026-11-06)
Vérifiées via `npm view` et les documentations officielles consultées ce jour ; lockfile `pnpm-lock.yaml` commité.

| Outil | Version | Remarque |
|---|---|---|
| Node.js | ≥ 22.12 (`.nvmrc` 24.13.1) | **Vitest 5.1.0 exige Node `^22.12 \|\| ^24 \|\| >=26`** ; Next 16.4.5 exige Node ≥ 20.9. Node 20 n'est donc pas supporté. |
| pnpm | 12.18.0 | via `packageManager` + corepack ; `allowBuilds` explicite (esbuild) car `strictDepBuilds` est activé par défaut. |
| Next.js / React | 16.4.5 / 19.3.1 | Doc Next : TypeScript minimum 5.1 ; `next lint` supprimé, ESLint appelé directement. |
| **TypeScript** | **6.0.3** (et non 7.0.2, dernière version publiée) | `typescript-eslint` 8.72.1 déclare `typescript >=4.8.4 <6.1.0` : TypeScript 7 n'est pas supporté par le linter. À réévaluer quand typescript-eslint l'acceptera. |
| ESLint | 9.39.5 (et non 10.x) | `eslint-config-next` 16.4.5 accepte `>=9` ; 9.x choisi par prudence de compatibilité des plugins. |
| Vitest | 5.1.0 | |
| Turborepo | 2.11.10 | |
| Prettier | 3.9.10 | |

GitHub Actions : `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6` (tags de version majeure ; dernières versions consultées le 2026-11-06).
