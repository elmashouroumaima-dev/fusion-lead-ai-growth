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

## J07 — jeu 19 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-07-rls-core-and-harness`)
Cible : 12,7 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Harnais `pnpm test:rls` (Vitest, Data API, JWT signés par utilisateur de seed) — écrit AVANT les politiques | 2,5 h | oui | oui |
| Politiques select/update/delete par rôle, GRANT par colonne, trigger dernier owner | 2,5 h | oui (migration + retour arrière) | oui |
| Revue GRANT / Data API + schema lint (11 règles, `pnpm test:db`) + job CI `database` | 1 h | oui | lint et tests oui ; **job CI non exécuté** |

### Tests : RLS 84 ✓ (matrice utilisateur × entreprise × opération + dernier owner) · pgTAP 70 ✓ (38 + 21 + 11 de lint) · mutations : 16 tests RLS échouent quand on casse les politiques/GRANT/trigger, 10 règles du lint échouent sur des tables/politiques/fonctions fautives (L1–L10 couvertes) · rollbacks 3→2→1 propres · pile réduite CI (db, auth, kong, rest) validée localement · lint/typecheck/tests TS ✓
### Écarts à la spec : aucun. Décisions validées : A harnais Vitest/PostgREST + pgTAP, B GRANT par colonne, C pas d'INSERT direct sur les adhésions, D trigger dernier owner, E job CI `db`
### Constats
- Bug de mon harnais corrigé en route : la restauration d'état effaçait les compteurs de fixture après chaque test ; les 4 tests concernés ont été trouvés par l'exécution, pas par la lecture.
- Le trigger « dernier owner » s'applique aussi à `service_role` : supprimer un compte qui est le dernier owner échoue tant que la propriété n'est pas transférée.
- Performance : les politiques appellent `private.has_role` par ligne ; mesure prévue au J15 (risque R13).
### Blocages : job CI `database` jamais exécuté (pas de push) ; ADR 001/002/005/006/007/014 toujours « Proposed »
### Demain : J8 (Auth SSR bilingue AR/EN)

## J08 — ven 20 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-08-auth-ssr-i18n`)
Cible : 14,3 % | Réel : à valider | Statut : —

### Organisation du travail
Manager (moi) + agents : A1a/A1b chercheurs (lecture seule), A2 Auth/SSR, A3 i18n + UI, A4 tests, A5 sécurité (hostile, lecture seule), A6 qualité (lecture seule), puis F2/F3 (corrections) et A5b (re-vérification). Propriétés de fichiers disjointes par agent ; aucun commit par les agents.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Clients Supabase SSR navigateur/serveur, `getClaims()`, aucun `getSession()` serveur | 2 h | oui (`apps/web/lib/supabase/*`) | oui |
| Proxy (Next 16 : `proxy.ts`) : next-intl + refresh de session + routes protégées, échec fermé | 1,5 h | oui | oui (78 tests + attaques HTTP) |
| Inscription / connexion / mot de passe oublié / réinitialisation AR/EN, `dir=rtl` | 2,5 h | oui | oui (navigateur : connexion, erreur, déconnexion, redirection) |

### Tests : web 274 ✓ · domain 51 ✓ · worker 3 · adapters 1 · permissions 1 (total 330) · pgTAP 70 ✓ · RLS 84 ✓ · `next build` ✓ · `check:leaks --require-bundle` ✓ · lint et typecheck verts
### Écarts à la spec / plan
- `proxy.ts` au lieu de `middleware.ts` (renommage Next 16 ; doc Supabase : `middleware.ts` n'est jamais appelé sur 15 et avant, et `proxy.ts` est le nom sur 16).
- ADR 011 (`next-intl 4.14.9`) validé par la responsable technique le 2026-11-06 (« OK, go J8 »).
- Ajout : `SITE_URL` dans le schéma d'environnement (requis en staging/production, https) ; `allowBuilds: false` pour `@parcel/watcher` et `@swc/core` ; templates d'e-mail `supabase/templates/*.html` ; 4 skills projet dans `.claude/skills/`.
### Constats de sécurité (A5/A5b)
- HAUT corrigé : un segment de locale encodé (`/%61r/dashboard`) contournait le proxy. Le proxy décode puis échoue fermé ; 13 tests d'attaque échouent sans le correctif.
- MOYEN corrigé : `updatePasswordAction` exige le cookie `fl_recovery` (httpOnly) et vérifie `amr` s'il est présent.
- Corrigés : frontières du matcher, drapeau `Secure` du cookie, types OTP limités à signup/email/recovery, message `link_invalid` traduit, `SITE_URL` validé par zod.
- Restent (faible, documentés) : les chemins contenant un point sortent du matcher (chaque page privée doit appeler `requireClaims`) ; le cookie `fl_recovery` n'est qu'une défense en profondeur (activer « secure password change » avant la production) ; `APP_ENV=development` avec `NODE_ENV=production` utiliserait un `SITE_URL` http.
### Blocages / à faire
- Redémarrer Supabase local après toute modification de `config.toml` (fait ce jour). Limite locale `email_sent = 2`/heure : ralentit les essais d'inscription.
- Mailpit absent de la CI : pas de test e2e des e-mails en CI (à traiter en J57/J60).
- Limitation de débit applicative et CAPTCHA : J57.
### Demain : J9 (organisations et contexte actif)

## J09 — lun 23 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-09-orgs-tenant-context`)
Cible : 15,9 % | Réel : à valider | Statut : —

### Organisation du travail
Manager + agents : A2 base de données, A3 application et UI, A4 tests, A5 sécurité (hostile, lecture seule), A6 qualité (lecture seule), puis F2/F3 (corrections) et A5b (re-vérification). Périmètres de fichiers disjoints ; aucun commit par les agents.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `create_organization()` transactionnelle (security definer) + enveloppe invoker + retour arrière | 2 h | oui | oui (pgTAP 225, RLS 133) |
| `getTenantContext()` relu en base à chaque requête + cookie `fl_active_org` | 2 h | oui | oui |
| `POST /api/orgs` (Idempotency-Key, erreurs normalisées), pages onboarding / sélecteur AR/EN | 1,5 h | oui | oui (navigateur : nouvel utilisateur → onboarding → tableau de bord Owner ; utilisateur à deux organisations → sélecteur) |
| Tests | 0,5 h | oui | oui |

### Tests : web 533 ✓ · domain 239 ✓ · worker 3 · adapters 1 · permissions 1 · pgTAP 225 ✓ · RLS 133 ✓ · lint, typecheck, `next build`, `check:leaks --require-bundle` verts
### Écarts à la spec / plan
- Colonnes `created_by` et `creation_key` sur `organizations` (idempotence de création) : validées par la responsable technique, ADR 005 addendum.
- Pas de pipeline par défaut (J19) ; fonction étendue alors.
- Migration modifiée sur place avant tout commit (voir ADR 005 addendum).
### Constats de sécurité (A5/A5b)
- Moyen corrigé : noms avec caractères bidi/invisibles/contrôle (spoofing) → règles communes zod + SQL, avec tests.
- Moyen corrigé : fuseaux horaires divergents entre Node et Postgres.
- Faibles corrigés : limite de corps appliquée après lecture, rejeu après retrait de l'adhésion (500), champs inconnus ignorés, accessibilité, requêtes dupliquées, code mort.
- Restent (faible, documentés) : pas de plafond ni de limitation de débit (J57) ; liste noire de caractères invisibles incomplète (U+3164, U+00AD…) ; `creation_key` lisible par les membres ; règle lettre/chiffre légèrement plus large côté zod pour quelques chiffres symboliques.
### Blocages / à faire
- Plafond d'organisations par utilisateur : décision de la responsable technique (aucun plafond posé).
- `supabase/config.toml` : modification locale non commitée (SMTP Resend) à trancher.
### Demain : J10 (invitations et RBAC applicatif)

## J10 — mar 24 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-10-members-invitations-rbac`)
Cible : 17,5 % | Réel : à valider | Statut : —

### Organisation du travail
Manager + agents : A2 base de données, A3 permissions/membres/UI, A4 tests, A5 sécurité et A6 qualité (lecture seule), F2/F3 corrections (interrompus par une erreur réseau, code vérifié ensuite par A5b et par moi), F2b tests de régression, A5b re-vérification.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `packages/permissions` : matrice ADR 014 (31 lignes), `can`, `canManageMember`, `assignableRoles` | 2 h | oui | oui (lecture de l'ADR + oracle indépendant) |
| Table `invitations` + `create/revoke/accept_invitation` + `transfer_ownership`, jeton haché, expiration 7 jours | 2 h | oui (migration + retour arrière) | oui (pgTAP 448, RLS 211) |
| Page Membres (inviter, rôle, retirer, révoquer, transférer) et page d'acceptation AR/EN | 2 h | oui | tests, lint, build ; **pas de vérification visuelle en navigateur** |

### Tests : permissions 394 ✓ · domain 346 ✓ · web 713 ✓ · worker 3 · adapters 1 · pgTAP 448 ✓ · RLS 211 ✓ · lint, typecheck, `next build` (env de CI), `check:leaks --require-bundle` verts
### Écarts à la spec / plan
- ADR 014 implémenté tel quel ; 4 interprétations à valider (voir l'ADR, « Mise en œuvre J10»).
- Pas d'e-mail d'invitation (lien affiché une fois) ; liste des membres sans e-mails.
- Migration modifiée sur place après revue (jamais commitée ni appliquée hors base locale) ; `@fusion-leap/permissions` déclaré dans `apps/web`.
### Constats de sécurité (A5/A5b)
- Moyen corrigé : une invitation restait acceptable après retrait de l'inviteur → re-vérification de l'inviteur à l'acceptation.
- Faibles corrigés : ordre des verrous de `transfer_ownership` (deadlock possible), e-mails non ASCII/bidi, lecture base avant `can()`, `Referrer-Policy` sur login/signup, accessibilité du retour d'action.
- A5b : 0 faille exploitable après 150 tours concurrents (2100+ opérations : 0 deadlock, 0 erreur 5xx, jamais 0 owner) ; double acceptation : un seul gagnant.
- Restent (faible, documentés) : `already_member` révèle l'appartenance à owner/admin de leur propre organisation ; pas de plafond d'invitations ni de limitation de débit (J57) ; `service_role` garde les privilèges par défaut sur `invitations`.
### Blocages / à faire
- Validation par la responsable technique de l'ADR 014 (cases [P] et 4 interprétations).
- Décision sur un profil affichable (e-mail/nom des membres).
- Parcours complet à tester en navigateur : inviter → ouvrir le lien → accepter (nécessite deux comptes).
- `supabase/config.toml` : modification locale (SMTP Resend) non commitée.
### Demain : J11 (couche service : `withService`, erreurs, Idempotency-Key, limitation de débit)

## Ajout du français (locale par défaut) — branche `day-10-french-locale`
Demande de la responsable technique : ajouter le français et en faire la locale par défaut (ADR 011, amendement).
- **Fait** : `fr.json`, routage `fr`/`ar`/`en`, source unique des locales dans `packages/domain`, sélecteur à trois langues, formulaire d'organisation, e-mails trilingues, migration `20261111100000_locale_fr.sql` et son retour arrière (avec perte documentée).
- **Tests** : domain 364 · permissions 394 · web 782 · worker 3 · adapters 1 · pgTAP 462 · RLS 214 ; lint, typecheck, build (env de CI) et `check:leaks` verts. Revue de sécurité : proxy fermé avec trois locales (testé en direct), cookie `NEXT_LOCALE` falsifié sans effet, `p_locale` non injectable.
- **Reste** : relecture du français par un locuteur natif, vérification visuelle `/fr` `/ar` `/en`, Referrer-Policy sur forgot/reset (faible).

## J11 — mer 25 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-11-service-layer`)
Cible : 19,0 % | Réel : à valider | Statut : —

### Organisation du travail
Manager + agents : A2 base de données, A3 couche service, A4 tests (écrits avec le code), A5 sécurité et A6 qualité (lecture seule), F2/F3/F4 corrections, A5b re-vérification. Le premier lancement a été interrompu sur demande puis repris : l'état du dépôt a été revérifié avant de continuer.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `withRoute` / `withAction` (pipeline fixe) | 2 h | oui | oui |
| Erreurs normalisées `{ code, message, request_id }` (module unique) | 1 h | oui | oui |
| `Idempotency-Key` : table, fonctions begin/complete/abandon, rejeu, conflit, `attempt_id`, quota | 1,5 h | oui (migration + retour arrière) | oui |
| Limitation de débit : seaux en base, `service_role` confiné à `lib/supabase/admin.ts`, 429 et 503 | 1,5 h | oui | oui |

### Tests : domain 364 ✓ · permissions 394 ✓ · web 1266 ✓ · worker 3 · adapters 1 · pgTAP 722 ✓ · RLS 243 ✓ · lint, typecheck, `next build` (env de CI) et `check:leaks --require-bundle` verts
### Écarts à la spec / plan
- Migration `20261112100000_service_layer.sql` modifiée sur place après revue (jamais commitée ni appliquée ailleurs).
- Deux seaux par appel (organisation + utilisateur, et global par utilisateur) : extension du plan pour empêcher la multiplication par les organisations.
- ESLint pour `apps/web` : `noInlineConfig: true` (plus d'`eslint-disable` en ligne) afin de rendre le confinement de `service_role` incontournable. **Décision à valider** : cela change la convention « `any` justifié par un commentaire ».
- Actions d'authentification (J8) et `/auth/confirm` restent hors couche service.
### Constats de sécurité (A5/A5b)
- Moyen corrigé : `idempotency_keys` sans purge ni quota (un membre au rôle le plus bas pouvait la gonfler) → purge (`service_role`), quota de 200 lignes vivantes par (organisation, acteur), réponse limitée à 16 Ko.
- Faibles corrigés : `attempt_id` (tentative tardive), seau global par utilisateur, confinement ESLint, `x-request-id` du client jamais repris, quota sans course (verrou consultatif).
- Vérifié en direct : 40 `begin` parallèles → 1 seul `new` ; 100 prises sur un seau de 10 → 10 exactement ; privilèges `anon`/`authenticated`/`service_role` conformes ; aucun secret dans le bundle client.
- Restent (faible, documentés) : pas de limite par IP avant J21 ; purge manuelle jusqu'à J13 ; nombre d'organisations par acteur non plafonné (J57).
### Blocages / à faire
- Valider le changement de convention ESLint (`noInlineConfig`).
- Planifier la purge avec le worker (J13).
### Demain : J12 (audit et logs)
