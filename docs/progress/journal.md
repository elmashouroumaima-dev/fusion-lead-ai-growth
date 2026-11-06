# Journal de progression — Fusion Leap AI Growth

Avancement réel = somme des heures estimées des tâches **validées** (critères cochés ET tests verts) / 378 h. Code écrit mais non testé = 0 %.

## J00 — lun 9 nov 2026 — Phase 0
Cible : 1,6 % | Réel : en cours | Statut : —

### Tâches
| Tâche | Estimé | Validée |
|---|---|---|
| Préparation du dépôt (CLAUDE.md, spec, plan) | 0,5 h | oui |
| Prompt 0-A : spec-understanding + gaps-and-questions | 1,5 h | oui (en attente de relecture) |
| Prompt 0-B : development-plan.md | 1 h | proposé, en attente de « PLAN VALIDÉ » |
| Relecture, réponses Q1–Q5, validation | 1,5 + 1,5 h | non |

### Validation : message « PLAN VALIDÉ » reçu — plan et D1–D9 retenus (hors ADR 010–012 à confirmer explicitement).
### Tests : n/a (aucun code)
### Écarts à la spec : aucun
### Décisions : hypothèse §14 confirmée pour Q1–Q5 (CRM interne, un fournisseur e-mail, WhatsApp de test, Salla marketing, plans manuels)
### Blocages : aucun
### Demain : J1 (ADR 001–007, ERD) après « PLAN VALIDÉ »

## J01 — mar 10 nov 2026 — Phase 0
Cible : 3,2 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| ADR 001–006 (stack, monorepo, jobs, secrets, multi-tenancy, conventions) | 2,5 h | oui (Proposed) | en attente de relecture |
| ADR 007 modèle de données réconcilié + ADR 014 matrice RBAC | 2 h | oui (Proposed) | en attente de relecture |
| ERD Mermaid `docs/architecture/erd.md` | 1 h | oui | en attente |
| Revue ERD ↔ spec §7 | 0,5 h | à faire avec la responsable technique | non |

### Tests : n/a (docs)
### Écarts à la spec : platform_admin sort de l'enum des rôles d'organisation (table `private.platform_admins`, ADR 005 §10) — diffère du prompt J6 du plan fourni ; 18 tables ajoutées (« ajout ADR »)
### Décisions / ADR : 001–007, 014 en statut Proposed ; ADR 004 option B (AES-256-GCM applicatif) recommandée après vérification de la doc Supabase Vault (2026-11-05)
### Blocages : relecture sécurité ADR 004/005/014 requise
### Demain : J2 (fiches intégrations, ADR 008/010/011/012, data-flow)

## J02 — mer 11 nov 2026 — Phase 0
Cible : 4,8 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Fiche CRM | 1 h | oui (tout « À CONFIRMER », aucune info sur le CRM existant) | en attente de Q1 |
| Fiche e-mail + ADR 008 | 1,5 h | oui | en attente de relecture |
| Fiche WhatsApp | 1,5 h | oui (sources Meta citées) | en attente de relecture |
| Fiche Salla | 1 h | oui (sources Salla citées) | en attente de relecture |
| data-flow + ADR 010/011/012 | 1 h | oui | en attente de relecture |

### Tests : n/a (docs)
### Écarts à la spec : aucun
### Constats importants
- Postmark (candidat e-mail) n'a pas de signature HMAC sur ses webhooks (Basic Auth + IP).
- WhatsApp : retries jusqu'à 7 jours (dédup obligatoire) ; webhooks non envoyés en mode dev de l'app ; durée de la fenêtre de service non confirmée.
- Salla : refresh token à usage unique (verrou obligatoire) ; Easy Mode seul autorisé pour apps publiées ; `store_id` non défini, seul `merchant` est documenté.
- Supabase : aucune région Moyen-Orient listée (Q5 à traiter).
### Blocages : Q1, Q2 (domaine), Q5 sans réponse précise ; accès Meta à demander
### Demain : J3 (menaces, stratégie de test, backlog, gate G0')

### Comptes externes (suivi, sans secret)
- 2026-11-06 : projet Supabase cloud **fusion-leap-staging** créé (organisation « Fusion Leap Dev », plan Free, région Central EU / Frankfurt `eu-central-1`, Data API activée, « expose new tables » désactivé, RLS automatique activée). Usage : **staging uniquement, aucune donnée réelle** (ADR 010, Q5 ouverte). Mot de passe base et clés : dans le gestionnaire de mots de passe, jamais dans le dépôt.
- Meta for Developers : création de l'app commencée (cas d'usage WhatsApp) ; bloquée par « compte Facebook trop récent » pour créer le portefeuille d'entreprise — nouvelle tentative à faire.

## J03 — jeu 12 nov 2026 — Phase 0 (préparé en avance, NON commité)
Cible : 6,3 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Threat model STRIDE (`docs/security/threat-model.md`) | 2 h | oui (≈50 menaces : contrôle + test + jour) | en attente de relecture |
| Stratégie de test (`docs/testing/strategy.md`) | 1,5 h | oui | en attente |
| Backlog J4–J62 (`docs/backlog/`, 59 fiches + README) | 1,5 h | oui (généré depuis le plan validé) | en attente |
| Checkpoint C0 (`docs/checkpoints/C0.md`) | 1 h | oui — **NO-GO provisoire** : ADR toujours « Proposed » | en attente |

### Tests : n/a (docs)
### Écarts à la spec : aucun
### Décisions / ADR : aucun ADR passé en « Accepted » (seule la responsable technique peut le faire)
### Blocages : acceptation des ADR 001–008, 014 ; ADR 010–012 (hors stack) ; Q1, Q2, Q5 ; accès Meta
### Demain : J4 après acceptation des ADR (ou démarrage en parallèle de J4–J5 qui ne dépendent pas des ADR 008/010–012)

## J04 — ven 13 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-04-monorepo-scaffolding`)
Cible : 7,9 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| pnpm + Turborepo, 7 dossiers §6 | 2 h | oui | oui (install, lint, typecheck, test, build verts) |
| TS strict, ESLint (frontières de packages, no-any, no-only), Prettier, Vitest | 1,5 h | oui | oui |
| CI GitHub Actions (lint, typecheck, test) | 1,5 h | fichier écrit | **non exécutée** (pas de remote GitHub vérifié, `gh` absent) |
| README | 1 h | oui | oui |

### Tests : 5 tests Vitest (smoke, 1 par package) ✓ · lint ✓ · typecheck 5/5 ✓ · `next build` ✓ · prettier ✓ · test négatif du lint (import interdit, `any`, `.only`) ✓
### Écarts à la spec : aucun
### Décisions / écarts de version : TypeScript 6.0.3 (pas 7) car typescript-eslint <6.1.0 ; Node ≥ 22.12 car Vitest 5 ; ESLint 9.39.5 — consignés dans ADR 001
### Blocages : CI non vérifiée (pas de remote) ; ADR 001/002/006 toujours « Proposed »
### Demain : J5 (Supabase CLI local, env zod serveur/client, `.env.example`, garde-fou NEXT_PUBLIC_*)

## J05 — lun 16 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-05-environments-secrets`)
Cible : 9,5 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Supabase CLI 3.0.0 + projet local (`supabase/config.toml`), scripts `db:start/stop/reset/migrate` | 1,5 h | oui | oui (`pnpm db:reset` exit 0 sur la pile locale Docker) |
| Validation zod de l'env, séparation serveur/client (`packages/domain/src/env`, `apps/web/lib/env`, worker) | 2 h | oui | oui (le serveur Next.js et le worker sortent en code 1 si une variable manque ; démarrage OK avec un env valide) |
| `.env.{development,staging,production}.example` (sans valeur réelle) | 1 h | oui | oui |
| Garde-fou CI anti-fuite (`pnpm check:leaks`) + test par fuite volontaire | 1,5 h | oui | oui (échoue sur variable publique au nom de secret et sur secret dans le bundle ; repasse au vert après retrait) |

### Tests : 31 tests Vitest ✓ (domain 22, web 4, worker 3, permissions 1, adapters 1) · lint ✓ · typecheck 5/5 ✓ · build ✓ · prettier ✓ · `check:leaks --require-bundle` ✓
### Écarts à la spec : aucun
### Constats / décisions
- Next.js journalise une erreur levée dans `instrumentation.ts` **sans arrêter le processus** (constaté : le serveur restait en vie) ; ajout de `process.exit(1)` dans un module Node-only (`lib/env/startup-check.ts`).
- Clés Supabase locales : le CLI 3.0 fournit `PUBLISHABLE_KEY` / `SECRET_KEY` (formats `sb_publishable_…` / `sb_secret_…`) ; variables retenues : `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`.
- pnpm signale que ESLint 9.39.5 est « deprecated » (10.14.0 disponible) : à réévaluer (typescript-eslint accepte ESLint 10 ; reste à vérifier eslint-config-next).
- Remote `origin` existe (repo GitHub) : la CI n'a toujours pas été exécutée.
### Blocages : ADR 001/002/006 toujours « Proposed » ; premier `supabase start` a téléchargé les images Docker (long)
### Demain : J6 (migrations du noyau tenant : organizations, organization_members, subscriptions, usage_counters ; schéma `private`)

## J06 — mar 17 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-06-core-tenant-migrations`)
Cible : 11,1 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `organizations`, `organization_members` (5 rôles), `subscriptions`, `usage_counters` (+ `plans`) | 3 h | oui, 2 migrations + 2 scripts de retour | oui |
| Schéma `private` + `is_member` / `has_role` (security definer, search_path vide) | 2 h | oui | oui |
| Seed : 2 entreprises, utilisateur commun à 2 rôles, Analyst, Marketing Manager | 1 h | oui | oui (connexion Auth du compte seed : HTTP 200) |

### Tests : 57 tests pgTAP ✓ (36 contraintes/verrouillage + 21 fonctions d'aide) · mutation : retrait du trigger anti-transfert + RLS désactivée + GRANT ajouté → 4 tests échouent comme attendu · rollbacks 2→1 exécutés proprement (0 table, 0 schéma private) puis base rétablie · lint, typecheck, tests TS inchangés ✓
### Écarts à la spec / au plan fourni : `platform_admin` hors de l'enum (ADR 005 §10, validé) ; `plans` créé au J6 (validé) ; RLS activée sans politique + REVOKE dès J6 (validé) — consignés dans ADR 005 et 007
### Constats : privilèges par défaut du rôle `supabase_admin` encore ouverts à anon/authenticated dans `public` (tables créées depuis le tableau de bord) — mitigations notées (ADR 005, J7 schema lint, J57)
### Blocages : `test:db` n'est pas encore branché sur la CI (J7 : démarrage Supabase en CI) ; ADR 001/002/005/006/007 toujours « Proposed »
### Demain : J7 (politiques RLS par rôle, harnais `test:rls` avec JWT, schema lint)
