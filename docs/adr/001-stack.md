# ADR 001 — Stack technique

- **Statut :** Proposed (passage à Accepted prévu à la gate G0', J3)
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
