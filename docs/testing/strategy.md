# Stratégie de test — Fusion Leap AI Growth

- **Statut :** Proposed (J3)
- **Sources :** spec §12, §13 ; plan §11 ; `docs/security/threat-model.md` ; ADR 001, 005, 006

## 1. Principes
1. **L'isolation est le critère n°1** : les tests RLS pèsent autant que les tests unitaires et ne sont **jamais reportés** (spec §12, invariant 15).
2. **Test négatif d'abord** : tout contrôle d'accès s'écrit avec ce qui doit être refusé avant le code.
3. **Deux entreprises dans chaque fixture** : le seed de test contient au moins deux organisations et un utilisateur commun à deux rôles, pour que chaque test puisse vérifier l'absence de fuite.
4. **Fournisseurs simulés en CI** ; comptes sandbox réels uniquement au checkpoint C3 et à la recette (J59–J62).
5. **Aucune donnée client réelle** dans les tests ni dans les prompts IA (§9.5).
6. **Un bug corrigé = un test de non-régression dans le même commit.**
7. **Un test n'est jamais modifié pour le faire passer** : si un test est faux, on le dit et on le corrige explicitement.
8. Chaque test cite la section de spec ou la menace (`threat-model.md`) qu'il prouve (commentaire `// spec §x` / `// threat A1`).

## 2. Pyramide
| Niveau | Ce qu'il prouve | Outil | Où | Seuil / règle |
|---|---|---|---|---|
| Unitaire | Règles pures : normalisation, dédup, machine d'états, `can()`, `assertCanSend`, coût par lead | Vitest | `packages/domain`, `packages/permissions` | Couverture ≥ 80 % ; tests table-driven |
| RLS / base | Aucune fuite inter-tenant, rôles, triggers, immutabilité de l'audit | pgTAP via `supabase test db`, ou Vitest avec JWT par utilisateur de seed (choix tranché au J7) | `supabase/tests` | Par table tenant : matrice utilisateur × entreprise × CRUD dès sa migration ; **schema lint** en CI |
| Intégration | Services + base + worker ensemble ; adaptateurs avec fournisseurs simulés | Vitest + Supabase local + MSW | `apps/*/tests/integration` | Chaque endpoint §8 et chaque handler de job |
| Contrat fournisseurs | Parsing des webhooks et réponses réels | Vitest + fixtures copiées des docs officielles | `packages/adapters/*/fixtures` | Une fixture par type d'événement utilisé |
| E2E / acceptation | Parcours utilisateur et critères §13 | Playwright (AR RTL et EN) | `tests/e2e`, `tests/acceptance` | 10 critères + scénarios T1–T5 avant G5 |

## 3. Choix d'outils (à confirmer à J4/J7)
- **Vitest** pour unitaire/intégration. **MSW** pour simuler Resend/Postmark, Meta, Salla, fournisseur IA.
- **RLS** : option A pgTAP (`supabase test db`, SQL pur, proche de la base) ; option B Vitest avec JWT signés par utilisateur de seed (même langage que le reste). Reco : **B pour la matrice** (lisible, table-driven) + **A pour les triggers/immutabilité** ; décision finale au J7 après essai.
- **Playwright** pour E2E ; projets de test `ar` (RTL) et `en`.
- **Schema lint** : requête SQL sur `information_schema`/`pg_policies` exécutée en CI ; échoue si une table `public` n'a pas `organization_id not null`, un index, RLS activée et une politique par opération.
- **Garde-fous CI** : fuite `NEXT_PUBLIC_*`/`service_role` dans le bundle ; scan de secrets ; `pnpm audit`.

## 4. Données de test
- Seed : Org A (« Alpha ») et Org B (« Beta »), un utilisateur `shared@…` Owner chez A et Sales Agent chez B, un Analyst, un Marketing Manager ; deux projets par organisation ; pipeline par défaut.
- Fixtures CSV : `tests/fixtures/leads-100.csv` (doublons, téléphones marocains/saoudiens variés).
- Fixtures de webhooks (une par type) copiées des docs officielles avec date de consultation.
- Générateur de JWT de test **uniquement** dans le code de test ; jamais de secret réel.

## 5. Scénarios d'acceptation (spec §13)
| ID | Scénario | Jour |
|---|---|---|
| T1 | 2 entreprises, utilisateur à 2 rôles, 2 projets par entreprise : aucune fuite (UI, API, RLS, worker) | J15 (fait : `tests/acceptance`), complété au J16 (2 projets et un produit par entreprise dans le seed, tables découvertes automatiquement), J59 |
| T2 | 100 leads importés avec doublons et formats de téléphone variés, puis assignation et rapports | J26 |
| T3 | Série d'e-mails vers liste consentante, désabonnement en cours | J40 |
| T4 | WhatsApp client + template, webhook dupliqué, panne 503 | J40 |
| T5 | Changement d'entreprise en session, puis lien profond de l'ancienne entreprise | J15 (fait : `tests/acceptance`), J59 |

Exécution locale des scénarios T1 et T5 : `pnpm db:start`, `pnpm db:reset`, `pnpm dev`, puis `pnpm test:e2e` (adresse de l'application : `E2E_BASE_URL`, défaut `http://localhost:3000`). Les comptes sont ceux du seed local, le mot de passe est lu dans `supabase/seed.sql`.

## 6. Exécution en CI
À chaque PR : `pnpm lint && pnpm typecheck && pnpm test && pnpm test:rls` (+ schema lint, garde-fous). E2E sur un environnement local (Supabase Docker) à chaque PR touchant l'UI ; suite complète sur staging pour la recette. Une PR rouge ne se fusionne pas.

## 7. Seuils de qualité
- Couverture ≥ 80 % sur `packages/domain` et `packages/permissions`.
- 0 test RLS rouge ; 0 table sans test RLS.
- Aucun test `skip`/`only` committé (lint).
- Suivi de l'avancement : seules les tâches dont les tests sont verts comptent (plan §12).

## 8. Traçabilité menaces → tests
Chaque ligne de `docs/security/threat-model.md` indique son jour de test ; la traçabilité exigence → jour → test est dans `docs/plan/development-plan.md` §7.
