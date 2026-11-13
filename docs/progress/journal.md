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

## Refonte de l'interface (Tailwind v4 + shadcn/ui) — branche `day-11-ui-shadcn`
Demande : reprendre le rendu du tableau de bord ONMD (projet frontend, en lecture seule). Décision d'architecture : ADR 015 (Proposed).
- **Fait** : design system (jetons clair/sombre, Poppins + Cairo), composants shadcn, coquille d'application (barre latérale repliable, en-tête, sélecteur d'organisation, langue, thème, profil), pages de connexion/inscription/réinitialisation (mise en page scindée sur dégradé), onboarding, sélecteur d'organisation, tableau de bord (données réelles seulement), membres (tables et dialogues), invitation. RTL : barre latérale à droite en arabe, classes logiques uniquement.
- **Tests** : web 1821 · domain 364 · permissions 394 · worker 3 · adapters 1 ; lint, typecheck, build (env de CI) et `check:leaks` verts. Vérifié en navigateur : `/fr/login`, `/ar/login`, connexion, sélecteur d'organisation, tableau de bord, membres.
- **Revues** : sécurité (A5) : audit des dépendances sans vulnérabilité, aucun script d'installation, licences MIT/ISC/Apache, J8–J11 intacts ; ajout d'en-têtes anti-clickjacking ; contrastes AA corrigés ; polices converties en WOFF2.
- **Reste / à valider** : couleur primaire (vert ONMD `#006a4e`) et rôles affichés en rouge (couleur secondaire ONMD) à confirmer ; vérification visuelle du mode sombre et de la page d'invitation ; ADR 015 ; succès des actions membres annoncé à la fois par toast et zone aria-live.

## J12 — jeu 26 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-12-audit-logs`)
Cible : 20,6 % | Réel : à valider | Statut : —

### Organisation du travail
Manager + agents : A2 base de données, A3 logger et contexte de requête, A5 sécurité et A6 qualité (lecture seule), F2/F3/F4 corrections, A5b re-vérification.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `audit_logs` append-only (REVOKE + déclencheurs `ENABLE ALWAYS`, G-D10) | 2 h | oui (migration + retour arrière) | oui |
| Audit par déclencheurs (organisations, membres, invitations), caviardage et masquage d'e-mail | 1,5 h | oui | oui |
| Logger JSON (`request_id`, caviardage) et contexte de requête | 1,5 h | oui | oui |
| Branchement membres/invitations | 1 h | oui (déclencheurs : aucun oubli possible) | oui |

### Tests : domain 364 ✓ · permissions 394 ✓ · web 2018 ✓ · worker 3 · adapters 1 · pgTAP 1049 ✓ · RLS 274 ✓ · lint, typecheck, `next build` (env de CI) et `check:leaks --require-bundle` verts
### Écarts à la spec / plan
- Audit **dans la base** (déclencheurs) plutôt que dans le code applicatif ; logger maison au lieu de `pino` (ADR 006) ; migration modifiée sur place avant tout commit.
- `ip` NULL (pas de proxy de confiance) ; pas d'écran « Journal d'activité » (hors périmètre).
### Constats de sécurité (A5/A5b)
- Corrigés : parité des listes de clés SQL/TS, déclencheurs d'audit en `ENABLE ALWAYS`, masquage d'e-mail court, contexte de requête prioritaire sur les champs de l'appelant, masquage des secrets dans les valeurs (URL, `Basic`, chaînes de connexion, jetons d'invitation), noms de clés et erreurs non `Error`, séparateurs U+2028/2029.
- A5b : append-only non contournable (même avec `session_replication_role = replica`, `service_role`, falsification de JWT), isolation entre organisations, aucun secret dans l'audit, ReDoS écarté (20 entrées adverses de 1 Mo), 200 requêtes concurrentes sans fuite de contexte.
- Restent (faible, documentés) : croissance non bornée du journal (rétention J13/J57) ; `request_id` = indice (contrôlable par un client appelant l'API directement) ; super-utilisateur et propriétaire de table peuvent désactiver les déclencheurs ; actions d'authentification (J8) sans `request_id` ; lignes d'audit orphelines après les tests RLS.
### Blocages / à faire
- Politique de rétention de l'audit ; écran de consultation éventuel ; valider ADR 015 (UI) et ADR 014.
### Demain : J13 (jobs et worker)

## J13 — ven 27 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-13-jobs-worker`)
Cible : 22,2 % | Réel : à valider | Statut : —

### Organisation du travail
Manager + A5 (revue sécurité adverse, lecture seule et attaques réelles sur la base locale). Fonctions SQL, worker, tests et documentation par le manager.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Table `jobs` + fonctions (`enqueue`, `claim` `SKIP LOCKED`, bail, `heartbeat`, `complete`, `fail`, `cancel`, `replay`) | 2 h | oui (migration + retour arrière) | oui |
| Claim, bail, heartbeat, reprise des baux expirés | 2 h | oui (SQL + `Runner`) | oui |
| Retry exponentiel avec jitter + `dead_letter` | 1,5 h | oui | oui |
| Job `noop` + registre de handlers typés | 0,5 h | oui (le fallback du plan n'a pas été nécessaire) | oui |

### Tests : domain 388 ✓ · permissions 394 ✓ · web 2045 ✓ · worker 33 ✓ · adapters 1 · pgTAP 1174 ✓ (080_jobs : 75) · RLS 291 ✓ (jobs : 8, dont 8 requêtes simultanées sur 60 jobs, 3 exécutions consécutives identiques) · lint et typecheck verts
Démonstration locale : worker lancé sur la base locale, job `noop` → `succeeded`, type inconnu → `dead_letter` (`unknown_kind`).
### Écarts à la spec / plan
- Aucun écart. Décision validée : accès du worker par RPC Supabase avec `service_role` (pas de client `pg` direct). Le test d'arrêt SIGTERM est unitaire (Windows ne transmet pas les signaux).
### Constats de sécurité (A5)
- Aucune faille critique ou élevée : droits (anon, authenticated, service_role sans accès direct), isolation entre organisations (JWT forgés, `user_metadata`), claim exclusif sous 8 sessions parallèles, baux expirés (100 par passe), validation de la charge utile, `p_run_at` extrême.
- Corrigés : `last_error` réduit à l'alphabet `[A-Za-z0-9_.:-]` (bidi, zéro-largeur) ; délai maximal par handler ; aucune tentative consommée à l'arrêt forcé ; succès non enregistré ne déclenche plus d'échec.
- Restent (documentés, ADR 003 et runbook) : acteur « système » et `p_org` non vérifié pour `cancel_job` / `replay_dead_letter` (à compléter par `p_actor` avant exposition à l'interface, J39) ; validation de charge utile heuristique ; exécution « au moins une fois » (handlers idempotents) ; pas de purge ni de quota par organisation (J14 / J57).
### Blocages / à faire
- Branche empilée sur `feat-settings-colors` (PR n°9) elle-même sur `day-12-audit-logs` (PR n°8) : fusionner dans l'ordre.
### Demain : J14 (plans et quotas, rôle Platform Admin)

## J14 — lun 30 nov 2026 — Phase 1 (préparé en avance, NON commité, branche `day-14-plans-quotas`)
Cible : 23,8 % | Réel : à valider | Statut : —

### Organisation du travail
Manager + A5 (revue sécurité adverse, attaques réelles sur la base locale). Migration, domaine, application, tests et documentation par le manager.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Définitions des plans et limites (trial / starter / growth, valeurs **provisoires**) | 1,5 h | oui | oui (valeurs à valider) |
| `assert_within_limit` + incrément atomique `usage_counters` (flux) et contrôle de stock | 2 h | oui (UPDATE conditionnel, verrou consultatif) | oui |
| Alerte avant seuil et blocage (`near_limit` à 80 %, `quota_exceeded`) | 1 h | oui (carte sur le tableau de bord, limite `users` sur les invitations) | oui |
| Écran Platform Admin d'activation | 1,5 h | oui (`/admin/organizations`, `private.platform_admins`) | oui |

### Tests : domain 400 ✓ · permissions 394 ✓ · web 2071 ✓ · worker 33 ✓ · adapters 1 · pgTAP 1249 ✓ (090_plans_quotas : 75) · RLS 300 ✓ (quotas : 9, dont 60 consommations simultanées pour une limite de 25 : exactement 25 réussissent) · lint, typecheck, `next build` (env de CI), `check:leaks --require-bundle` verts
### Écarts à la spec / plan
- Table `notifications` non créée : l'alerte est le drapeau `near_limit` affiché sur le tableau de bord (persistance avec le centre d'exploitation, J39).
- `private.platform_admins` n'ouvre aucun accès aux données d'une organisation (sessions de support non construites).
- Plans et abonnements sans droit d'écriture direct, même pour `service_role` ; les tests existants (040, 060, RLS invitations) reçoivent des abonnements à limite d'utilisateurs très haute ; les organisations du seed passent au plan growth (5 et 3 membres actifs).
- Palette et logo : toujours modifiables par tout owner/admin d'organisation (décision J14 : inchangé).
### Constats de sécurité (A5)
- Aucune escalade (JWT forgés, `user_metadata`, anon, service_role), aucune fuite d'administration, concurrence tenue (40 sessions parallèles pour une limite de 10 : exactement 10 ; 12 invitations simultanées pour 1 place : 1).
- **Moyenne, corrigée** : le quota `users` était contournable par réactivation directe d'un membre (UPDATE `status`) : déclencheur `enforce_member_quota` (la place déjà réservée par une invitation en attente n'est pas recomptée). Test pgTAP ajouté.
- **Faibles, corrigés** : motif d'abonnement limité à 200 caractères, sans caractère de contrôle ni bidi (SQL et zod) avec avertissement dans l'interface ; audit de tout changement (motif, décideur, début de période) ; droits d'écriture directe de `service_role` sur plans et abonnements retirés.
- Restent (documentés) : un abonnement dont `period_end` est dépassé ou `past_due` reste utilisable (pas d'expiration automatique) ; liste d'administration limitée aux 100 premières organisations ; texte libre du motif non filtré contre les secrets (avertissement seulement) ; valeurs de plans provisoires.
### Blocages / à faire
- Valider les valeurs des plans ; décider du comportement `past_due` / fin d'essai ; piles de PR : #8 → #9 → #10 → J14.
### Demain : J15 (jalon C1 / gate G1 : isolation de deux entreprises)


## J15 — mar 1 déc 2026 — Phase 1, checkpoint C1 / gate G1 (préparé en avance, branche `day-15-checkpoint-g1`)
Cible : 25,4 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Scénario T1 automatisé (RLS / API, worker, pages) | 2 h | oui (`tests/acceptance/src/t1-isolation.test.ts`) | oui |
| Scénario T5 (changement d'entreprise, lien profond) | 1 h | oui (`t5-org-switch.test.ts`) | oui |
| Corrections (créneau tampon) | 2 h | aucune fuite trouvée ; 2 corrections de tests | oui |
| Audit de conformité Phase 1 | 1 h | oui (`docs/checkpoints/C1.md`) | à valider |

### Tests : acceptation 35 ✓ · domain 419 ✓ · permissions 394 ✓ · web 2108 ✓ · worker 33 ✓ · adapters 10 ✓ · pgTAP 1314 ✓ · RLS 308 ✓ · lint, typecheck, `check:leaks` verts
### Écarts à la spec / plan
- Pas de table `projects` avant J16 : T1 couvre les tables existantes et couvrira les projets automatiquement (découverte du catalogue) quand le seed en contiendra.
- Couche « UI » testée par HTTP (vraie session), sans navigateur piloté ; worker testé au niveau de la file.
- `pnpm test:e2e` n'est pas branché sur la CI (il demande l'application démarrée).
### Constats
- Aucune fuite d'une entreprise vers l'autre (lecture, écriture, file de jobs, pages) ; l'autorisation est revérifiée à chaque requête (révocation en cours de session prouvée).
- Les tests pgTAP de `050_service_layer` échouent si `idempotency_keys` et `rate_limit_buckets` contiennent des lignes laissées par l'usage manuel de l'application : vider ces tables ou `pnpm db:reset`.
### Blocages / à faire
- Décision de la responsable technique : GO / NO-GO du C1 ; ADR « Proposed » ; branchement de `test:e2e` en CI ; navigateur piloté (téléchargement de binaires).
### Demain : J16 (projets et produits), après GO


## J16 — mer 2 déc 2026 — Phase 2 (préparé en avance, NON commité, branche `day-16-projects-products`)
Cible : 27,0 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Organisation du travail
Manager + A5 (revue sécurité adverse, attaques réelles sur la base locale). Migration, domaine, application, tests et documentation par le manager.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Migrations `projects`, `products` + RLS + tests | 2,5 h | oui (lecture seule, écriture par fonctions, FK composites) | oui |
| Services CRUD avec quota | 2 h | oui (`apps/web/lib/projects`, `POST /api/projects`) | oui |
| Schémas zod de réglages par type | 1,5 h | oui (4 types stricts) | oui |

### Tests : domain 444 ✓ · web 2144 ✓ · pgTAP 1442 ✓ (110_projects_products : 128) · RLS 332 ✓ (projects : 24, dont 12 créations simultanées pour 5 places : exactement 5) · acceptation 45 ✓ (projects-api : 10) · lint, typecheck verts
### Constats de sécurité (A5, attaques réelles sur la base locale)
- Aucune faille bloquante : rôles, JWT forgés, p_org falsifié, identifiants d'une autre entreprise, accès direct aux tables, quota sous concurrence (25 créations parallèles), assets, idempotence : refusés.
- **Moyennes, corrigées** : caractères invisibles et de direction non filtrés (U+061C, U+2060 à U+206F…) ; la base ne reproduisait pas zod (réglages, liens, hôtes internes, port) ; aucun plafond de produits (100 par projet ajouté).
- **Faibles** : `update_project` effaçait le propriétaire s'il était omis (corrigé : explicite) ; `not_found` en HTTP 500 (corrigé : PT404, 404) ; membre suspendu restait propriétaire (corrigé : NULL) ; pas de contrôle `Origin` sur les mutations (non traité, valable pour toutes les routes).
- Reste (documenté) : adresse des liens à revalider (DNS) avant tout chargement serveur.
### Écarts à la spec / plan
- Archivage à la place de la suppression (matrice ADR 014 ; ADR 007 disait « delete ») : aucun DELETE.
- Aucun archivage de produit (la spec ne lui donne pas de statut) : point soumis à la responsable technique.
- `products.kind` : texte court contrôlé, pas d'énumération (la spec n'en définit pas) ; `salla_theme` : les captures d'écran (Storage) viennent au J17.
- Nouveau code d'erreur `conflict` (409) pour un projet archivé.
### Blocages / à faire
- GO du C1 ; valider les 5 choix du mini-plan J16 ; interface des projets au J17.
### Demain : J17 (UI projets et Storage)


## J17 — jeu 3 déc 2026 — Phase 2, partie 1 (préparé en avance, NON commité, branche `day-17-projects-ui`)
Cible : 28,6 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Organisation du travail
Manager + A5 (revue sécurité adverse : actions appelées directement avec de vraies sessions). Interface, actions, tests et documentation par le manager.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Liste et création de projets | 2 h | oui (`/projects`, `/projects/new`, filtre Actifs / Archivés) | oui (navigateur) |
| Formulaires dynamiques par type | 2,5 h | oui (4 types ; listes « une ligne par élément », lignes répétables) | oui |
| Assets Storage tenant | 1,5 h | **reporté (partie 2)** : bucket privé, politiques, envoi de fichiers | — |
| Détail, produits, archivage (ajout au plan) | — | oui (fenêtres, confirmation d'archivage) | oui |

### Tests : web 2217 ✓ · acceptation 56 ✓ (projects-pages : 11) · domain 444 · lint, typecheck, `check:leaks` verts · vérifié dans le navigateur : création, produit, archivage
### Écarts à la spec / plan
- Storage et envoi de fichiers : partie 2 (le produit affiche « 0 fichier », les fichiers déjà associés sont conservés à la modification).
- Pas de sélecteur de propriétaire : le créateur est propriétaire (la liste des membres n'a pas d'identité lisible).
- Les erreurs s'affichent dans la page (règle d'accessibilité de cette pile) ; les notifications rouges sont dans la PR `feat-toast-style`.
### Constats de sécurité (A5)
- Aucune faille bloquante ni moyenne : rôles, isolation (identifiants d'une autre entreprise, cookie d'entreprise, organization_id falsifié), idempotence, quota sous concurrence, XSS stocké, CSRF natif de Next : tenus.
- **Faibles, corrigés** : `__proto__` accepté dans les réglages à la modification ; JSON très profond (erreur interne) ; corps de plus de 1 Mo (plafond 512 Ko).
- **Documentés** : DNS rebinding des liens (avant tout chargement serveur) ; `X-Forwarded-Host` client (à retirer au reverse proxy) ; identifiants d'URL très longs.
### Blocages / à faire
- GO du C1 ; Storage (partie 2) ; décider de la présence des notifications rouges (PR `feat-toast-style`).


## J17 partie 2 — Storage et fichiers des produits (préparé en avance, NON commité, branche `day-17-storage`)
Cible : 28,6 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Bucket privé `assets` + politiques Storage par entreprise (G-D11) | 1 h | oui (migration `20261119100000`, retour arrière) | oui |
| Envoi, retrait et lecture des fichiers d'un produit | 1,5 h | oui (Server Actions, octets réels, liens signés 60 s) | oui (navigateur) |

### Revue sécurité (0 bloquant, 5 moyens, 5 faibles) — corrigés : pertes de mises à jour sous concurrence et rattachement d'un fichier à un autre produit (fonctions SQL atomiques `append_product_asset` / `remove_product_asset`, `update_product` n'écrit plus `assets`, liste client ignorée, objet partagé jamais supprimé) ; acceptés et documentés : durée des liens signés, jeton d'envoi signé, plafond par entreprise, purge des orphelins.

### Tests : domain 462 ✓ · web 2238 ✓ (assets : 17) · pgTAP 1487 (dont 120_storage_assets : 45) ✓ · API Storage réelle 17 ✓ (RLS : 349) · acceptation 56 ✓ · lint, typecheck verts · vérifié dans le navigateur : envoi PNG et PDF, refus d'un SVG déguisé en .png et d'un fichier vide, retrait
### Écarts à la spec / plan
- 5 Mo pour tous les types (spec : 10 Mo pour un PDF) : limite des corps de Server Actions à 6 Mo ; à relever avec une route dédiée.
- CSV : au J23 (import des leads).
- Purge des objets non rattachés : à prévoir avec le worker (runbook `storage-assets.md`).

## J18 — Contacts et consentement (branche `day-18-contacts`, NON commité)
Cible : 30,2 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `contacts` + `consent_events` + RLS | 2 h | oui (migration `20261120100000`, retour arrière, écriture par fonctions, quota) | oui (pgTAP, API réelle) |
| Normalisation e-mail / E.164 (libphonenumber) | 1,5 h | oui (`packages/domain/src/contacts`) | oui (téléphones marocains et saoudiens) |
| Déduplication intra-entreprise | 1,5 h | oui (règle `findDuplicate` + index uniques partiels) | oui (12 créations simultanées : 1 contact) |
| Tests | 1 h | oui | oui |

### Validation du jour
- Même e-mail dans deux entreprises -> deux contacts (pgTAP + API réelle) ; même e-mail dans la même entreprise -> refusé.
- `06 12 34 56 78` (MA) -> `+212612345678` ; `050 123 4567` (SA) -> `+966501234567`.

### Revue sécurité (1 bloquant, 3 moyens, 3 faibles) — corrigés : contournement de « ne plus contacter » par échange d'identifiants, consentement lié à l'adresse, canal cohérent, plafond de 50 consentements, e-mail ASCII, caractères dans les attributs ; documentés : journaux Postgres, fonction `can_contact` et table de suppression d'identifiants (décisions pour la responsable technique).

### Tests : domain 511 ✓ · web 2288 ✓ (contacts : 23) · pgTAP 1598 (dont 130_contacts_consent : 111) ✓ · API réelle 365 ✓ (contacts : 16) · acceptation 56 ✓ · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Le commercial (« own ») et l'analyste n'ont aucun accès aux contacts au J18 (le commercial l'obtient avec les leads, J19).
- Pas d'écran (le plan n'en prévoit pas au J18).
- Conflit e-mail / téléphone : refus `conflict`, pas de table de file de revue (non prévue par la spec ni un ADR).
- `suppressions` et désinscription : avec l'e-mail (J31–33), comme dans le plan validé (le prompt parlait de « J18–20 désabonnement »).

## J19 — Pipelines, leads et deals (branche `day-19-leads`, NON commité)
Cible : 31,7 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `pipelines` / `pipeline_stages` (E1) | 1,5 h | oui (migration `20261121100000`, étapes par défaut par langue, étape système) | oui (pgTAP, API réelle) |
| `leads` | 1,5 h | oui (FK composites, responsable, étape cohérente, UTM, score) | oui |
| `deals` | 2 h | oui (won / lost cohérents avec l'étape, devise, valeur) | oui |
| Tests RLS | 1 h | oui | oui |

### Validation du jour
- Un lead ne peut référencer qu'un projet et un contact de **son** entreprise (FK composites ; refus testé en base et par l'API).
- Les étapes sont configurables par entreprise (création, renommage, repositionnement, suppression contrôlée, pipeline par défaut).

### Revue sécurité (0 bloquant, 3 moyens, 6 faibles) — corrigés : marketing ne choisit plus le responsable à la création, NaN et dates infinies, lead qui change de pipeline, libération des leads à la suppression de la ligne et à la rétrogradation, verrou sur le membre assigné, abonnement actif exigé, plafonds de leads et deals, audit sans réglage de session, erreurs NOT NULL ; documenté : idempotence au niveau des routes.

### Tests : domain 527 ✓ · web 2310 ✓ (leads : 22) · pgTAP 1780 (dont 140_leads_pipelines_deals : 182) ✓ · API réelle 379 ✓ (leads : 13) · acceptation 56 ✓ · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Le commercial ne crée pas de lead au J19 (il ne voit pas les contacts non assignés) : avec la capture et l'assignation (J21–22).
- `campaign_id` sans clé étrangère jusqu'au J42 ; pas d'unicité (contact, projet) avant le J21.
- Pas d'écran (le plan prévoit l'UI CRM au J24) ; l'historique des changements d'étape est l'audit jusqu'au J20 (`activities`).

## J20 — Activités et chronologie (branche `day-20-activities`, commité, PR ouverte)
Cible : 33,3 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `activities` (note, appel, e-mail, tâche — E2) | 1,5 h | oui (migration `20261122100000`, contenu par type, historique immuable) | oui (pgTAP, API réelle) |
| Journal automatique des changements d'étape | 1,5 h | oui (déclencheurs lead et deal, assignation comprise) | oui |
| Chronologie du lead | 2 h | oui (service : chronologie paginée, sans écran : J24) | oui |
| Tâches dues | 1 h | oui (service : tâches dues, prochaine action) | oui |

### Validation du jour
- Statut (étape), responsable et prochaine action d'un lead lisibles : `leads.stage_id`, `leads.assignee_id` et `nextAction` des tâches.
- Un commercial ne voit et ne modifie que les activités de **ses** leads assignés (RLS, API réelle).

### Revue sécurité (0 bloquant, 1 moyen, 5 faibles) — corrigés : plafond atteignable par les entrées automatiques (plafonds séparés), contenu validé avant insertion, tâche confiée seulement à un commercial responsable du lead, échéance obligatoire à la modification ; documentés : auteur effacé après suppression d'un membre, débit d'audit, interblocage rare ; à confirmer : le marketing lit toutes les activités.

### Tests : domain 539 ✓ · web 2327 ✓ (activities : 17) · pgTAP 1887 (dont 150_activities : 107) ✓ · API réelle 393 ✓ (activities : 14) · acceptation 56 ✓ · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Contenu des activités dans `metadata` (pas de colonne texte dans l'ADR).
- Pas d'écran (le plan prévoit l'UI CRM au J24) ; pas de rappels d'échéance (worker avec les canaux) ; pas d'activité sans lead.
- Bug trouvé en test et corrigé : supprimer la ligne d'un membre échouait quand il avait écrit une entrée de chronologie (clé étrangère « set null » bloquée par l'immutabilité).

## J21 — Capture publique (branche `day-21-capture`, commité, PR ouverte)
Cible : 34,9 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Clés de formulaire par projet | 1 h | oui (migration `20261123100000`, empreinte, origines, plafond) | oui (pgTAP, API réelle) |
| `POST /api/leads` (origine, rate limit, honeypot, zod) | 2 h | oui (route publique + préflight CORS) | oui (HTTP réel) |
| Transaction contact + lead + consent + job d'assignation | 2 h | oui (`capture_lead`) | oui (12 soumissions simultanées : 1 contact) |
| Tests | 1 h | oui | oui |

### Validation du jour
- Deux soumissions identiques → **un contact** (§13-3) : HTTP réel, 8 et 12 soumissions simultanées.
- Source, UTM, `landing_page_id`, texte et version du consentement stockés ; **organisation déduite de la clé**, jamais du corps (un corps qui nomme une entreprise ou un projet est refusé).

### Revue sécurité (1 bloquant, 4 moyens, 3 faibles) — corrigés : réactivation d'un contact désinscrit par la voie publique (bloquant), adresse du visiteur et proxys de confiance, seau de débit par clé inventée, préflight limité, finalités ; **soumis à la responsable technique** : double opt-in avant le premier envoi, défi anti-robot ou quota de captures publiques, oracle au quota plein, planification de `rate_limit_purge`, un usage de plus de `service_role`.

### Tests : domain 553 ✓ · web 2377 ✓ (capture : 48) · worker 34 ✓ · pgTAP 2024 (dont 160_capture : 137) ✓ · API réelle 407 ✓ (capture : 14) · acceptation 68 ✓ (capture : 12) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Colonne `key_prefix` ajoutée à `form_keys` (non secrète).
- Le traitement du job `lead.assign` est le J22 (handler provisoire sans effet).
- Pas de double opt-in (spec muette) : consentement non vérifié ; à traiter avant tout envoi marketing.
- Pas d'écran de gestion des clés (J24).

## J22 — Assignation (branche `day-22-assignment`, commité, PR ouverte)
Cible : 36,5 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `assignment_rules` (E8) round-robin et par projet | 2 h | oui (migration `20261124100000`, règle projet / défaut) | oui (pgTAP, API réelle) |
| Handler worker `lead.assign` idempotent | 1,5 h | oui (`auto_assign_lead` + handler, dernier essai = alerte) | oui (unitaires, acceptation) |
| File « non assignés » + alerte manager | 1,5 h | oui (`notifications`, `listUnassignedLeads`) | oui |
| Tests | 1 h | oui | oui |

### Validation du jour
- Échec d'assignation → le lead reste dans la file « non assignés » et chaque owner / admin reçoit **une** alerte.
- Rejeu du job : aucune double assignation, aucune double alerte (acceptation HTTP : capture → job → assignation → rejeu).

### Revue sécurité (0 bloquant, 2 moyens, 7 faibles) — corrigés : évincement des notifications lues au plafond, plafond de règles sérialisé, réactivation refusée si abonnement suspendu, tableau 2D / NULL, curseur, motif ; **soumis à la responsable technique** : leads libérés sans nouveau job, membre ré-ajouté, projet archivé, délai dépassé, abonnement des jobs en vol.

### Tests : domain 559 ✓ · web 2389 ✓ (assignment : 12) · worker 39 ✓ · pgTAP 2110 (dont 170_assignment : 86) ✓ · API réelle 415 ✓ (assignment : 8) · acceptation 71 ✓ (assignation : 3) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Table `notifications` créée au J22 (l'ADR 007 J14 la renvoyait au J39) : nécessaire à l'alerte du plan.
- Vue « Leads non assignés » = UI (J24) ; le J22 livre le service et l'API.
- Un lead créé à la main (J19) ne passe pas par la règle (la spec ne le prévoit que pour la capture) ; le commercial ne crée toujours pas de lead.

## J23 — Import CSV (branche `day-23-import`, commité, PR ouverte)
Cible : 38,1 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Envoi + analyse en continu | 1,5 h | oui (route `POST /api/imports`, parseur CSV sans dépendance, bucket privé `imports`) | oui (unitaires, Storage réel) |
| Mapping + aperçu 20 lignes | 2 h | oui (`/api/imports/preview`, n'écrit rien) | oui (HTTP réel) |
| Rapport de dédup | 1 h | oui (nouveaux, connus, doublons, erreurs par ligne ; rapport CSV téléchargeable) | oui |
| Commit via job | 1,5 h | oui (`/api/imports/confirm` -> job `import_csv`, handler worker idempotent) | oui |

### Validation du jour
- **Rien n'est écrit avant la confirmation** (HTTP réel : après l'envoi et l'aperçu, aucun contact, lead ni job).
- `leads-100.csv` : **65 contacts créés, 17 rattachés, 18 lignes refusées**, un job d'assignation par lead (67), **aucun consentement** ; rejeu du job sans doublon ; rapport sans donnée de contact.

### Revue sécurité (0 bloquant, 6 moyens, 6 faibles) — corrigés : rapport lu par blocs (plus de troncature à 1000), projet archivé, corps lu après l'authentification, lot « running » annulable si son job est mort, fichier retiré à l'annulation, plafond de lots sur 90 jours, jobs d'assignation étalés ; **soumis à la responsable technique** : purge du Storage, écart avec l'ADR 014 (owner et admin seulement), hash du fichier, double opt-in.

### Tests : domain 574 ✓ · web 2406 ✓ (imports : 17) · worker 56 ✓ (import_csv : 12) · pgTAP 2227 (dont 180_imports : 117) ✓ · API réelle 425 ✓ (imports : 10) · acceptation 83 ✓ (import : 12) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Tables `import_batches` / `import_rows` et bucket `imports` : ajouts (addendum ADR 007).
- Import réservé à owner et admin (l'ADR 014 y ajoute marketing et commercial « assigné à soi »).
- Pas d'écran (J24) ; pas de purge du Storage (à planifier avec le worker).
- Numéros du rapport = numéros d'enregistrement (lignes vides ignorées).

## J24 — UI CRM (branche `day-24-crm-ui`, commité, PR ouverte)
Cible : 39,7 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Liste + filtres + recherche | 2,5 h | oui (`/leads`, `search_leads`, pagination serveur) | oui (pgTAP, API réelle, HTTP réel, vérification visuelle fr / ar / en) |
| Kanban des deals | 2,5 h | oui (`/deals`, glisser-déposer + menu clavier, `POST /api/deals/move`) | oui (HTTP réel, déplacement vérifié en base) |
| Export CSV | 1 h | oui (`GET /api/leads/export`, audité, sans troncature, anti-formule) | oui |

### Validation du jour
- Recherche et export limités à l'entreprise active **et au rôle** : le commercial ne voit que ses leads, l'analyste est renvoyé au tableau de bord, Beta ne voit rien d'Alpha (HTTP réel).
- Export **journalisé** (`export.created` : nombre de lignes et noms de filtres) avant l'envoi du fichier.

### Revue sécurité (0 bloquant, 2 moyens, 7 faibles) — corrigés : GET d'export inter-sites refusé, export tronqué refusé (413), paramètre invalide refusé (400), formule précédée d'espaces, total conservé hors page, `no-referrer` sur `/leads` ; **soumis à la responsable technique** : « export » comme barrière de lecture, lecture en volume par `rpc/search_leads`, Playwright, recherche sans accents.

### Tests : domain 589 ✓ · web 2452 ✓ (crm : 7 + messages 14) · worker 56 ✓ · pgTAP 2290 (dont 190_crm_search : 63) ✓ · API réelle 431 ✓ (crm : 6) · acceptation 99 ✓ (crm : 16) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Pas de Playwright (non installé) : acceptation HTTP + vérification visuelle dans le navigateur intégré (fr, ar, en).
- Glisser-déposer natif (aucune bibliothèque) + menu « Déplacer vers… » ; extension `pg_trgm`.
- Pas de fiche détaillée d'un lead ; responsable affiché par un identifiant court.

## J25 — Adaptateur CRM (branche `day-25-crm-adapter`, commité, PR ouverte)
Cible : 41,3 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Interface `CrmAdapter` | 1,5 h | oui (`packages/adapters/src/crm`) | oui (contrat commun testé) |
| Adaptateur interne + CSV | 2 h | oui (`internal`, `csv` aller-retour, dates ISO strictes) | oui |
| `crm_field_mappings` + `source_of_truth` | 1,5 h | oui (migration `20261127100000`, moteur de conflit) | oui (pgTAP, domaine) |
| Statut de synchro | 1 h | oui (`/crm`, API, « Réessayer ») | oui (HTTP réel, vérification visuelle fr / ar) |

### Validation du jour
- **Aucune synchro bidirectionnelle sans règle de conflit** : conflit seulement si les deux côtés ont changé, `source_of_truth` par champ, perdant dans l'audit.
- **Échec visible et rejouable sans doublon** : statut « En échec » + code d'erreur, « Réessayer » rejoue le même job (acceptation HTTP + navigateur).

### Revue sécurité (0 bloquant, 2 moyens, 8 faibles) — corrigés : faux conflits (curseur de fin), lot de fichier consommé (`synced`), colonne d'identifiant absente, dates ISO strictes, cellule vide, source propre à l'intégration, abonnement ; **soumis à la responsable technique** : documentation du CRM Fusion Leap, équité du worker pour les gros fichiers, `external_id` libre pour le marketing.

### Tests : domain 608 ✓ · adapters 34 ✓ · worker 76 ✓ (crm_sync : 21) · web 2469 ✓ · pgTAP 2397 (dont 200_crm_sync : 107) ✓ · API réelle 436 ✓ (crm-sync : 5) · acceptation 106 ✓ (crm-sync : 7) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- **Pas de squelette du CRM Fusion Leap** (API non documentée, Q1) ; adaptateurs `internal` et `csv` seulement.
- Table `integrations` créée ici en version minimale (le J28 l'étend avec les secrets).
- Synchro de contacts seulement ; pas d'historique dédié (état = job).

## J26 — Tests ventes (branche `day-26-sales-tests`, commité, PR ouverte)
Cible : 42,9 % | Réel : à valider | Statut : — (le C1 attend le GO de la responsable technique)

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| T2 automatisé | 2,5 h | oui (`t2-sales.test.ts`, 11 tests) | oui (vert, HTTP réel + vrais handlers `import_csv` et `lead.assign`) |
| Dédup inter-entreprises | 1 h | oui (même fichier chez Alpha puis Beta ; formulaire public déjà couvert par `capture-api`) | oui |
| Rôles sur le CRM | 1,5 h | oui (`crm-roles-matrix.test.ts`, 17 tests : 13 routes + capture publique + 3 pages x 5 rôles + anonyme) | oui |
| Couverture | 1 h | oui (seuil 80 % appliqué ; domain 97,9 % / 94,8 %, permissions 98,4 % / 98,4 %) | oui |

### Validation du jour
- **T2 vert** : 100 lignes -> 65 créés, 17 rattachés (15 doublons du fichier + 2 déjà connus), 18 refusées ; 67 leads assignés en round-robin (écart maximal 1) ; rejeu = 0 doublon ; totaux affichés cohérents avec la base et le rapport.
- **§13-3 démontré** : même fichier chez deux entreprises = deux jeux de contacts séparés ; deux envois identiques du formulaire dans une entreprise = un contact (`capture-api`, 8 soumissions simultanées).
- **§13-2** : matrice des rôles du CRM sans trou sur les routes et pages existantes ; Analyst ne déplace pas un deal, commercial ne touche ni l'intégration ni l'export, ni un lead non assigné.
- Constat : la recherche par domaine retrouve 66 leads sur 67 (le contact créé avec un téléphone seul n'a pas d'e-mail) : le test distingue les deux nombres.

### Tests : domain 608 ✓ · adapters 34 ✓ · permissions 394 ✓ · worker 76 ✓ · web 2469 ✓ · pgTAP 2397 ✓ · API réelle 436 ✓ · acceptation 134 ✓ (+28 : t2-sales 11, crm-roles-matrix 17) · lint, typecheck, check:leaks verts
### Revue adverse (0 bloquant) — corrigés : matrice incomplète (import, mapping, capture publique ajoutés), statuts exacts au lieu de « pas 403 », vrai handler `lead.assign`, ordre de rotation vérifié, totaux Beta stricts, aucun doublon intra-entreprise, contexte forgé, rapport CSV lu par colonne, chemins Storage lus en base. **Non corrigé, à décider** : la couverture n'est pas exécutée en CI (commande manuelle `test:coverage`) ; suppression des règles d'assignation par projet dans les nettoyages (le seed n'en a pas).
### Écarts à la spec / plan
- Aucun code applicatif ni migration : le jour ne contient que des tests.
- Constat : `POST /api/imports` valide le type de contenu avant le rôle (un marketing avec un type refusé reçoit 400, pas 403) ; sans conséquence (rien n'est écrit), signalé.
- `@vitest/coverage-v8` ajouté en devDependency de `packages/domain` (validé au mini-plan) ; déjà présent pour `packages/permissions`.

## J27 — Checkpoint C2 / Gate G2 (branche `day-27-checkpoint-c2`, commité, PR ouverte)
Cible : 44,4 % | Réel : à valider | Statut : GO du C2 donné par la responsable technique (9 nov 2026) ; écrans, ADR et job CI restent à décider

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| E2E formulaire -> lead -> assignation -> deal gagné | 2,5 h | oui (`g2-lead-to-deal.test.ts`, 9 tests, HTTP réel + vrai handler `lead.assign`) | oui (vert, 3 exécutions de suite) |
| Corrections | 2 h | aucune correction applicative nécessaire | — |
| Audit de conformité Phase 2 | 1,5 h | oui (relecteur indépendant, sans code ; 0 bloquant, 3 majeurs, 9 mineurs) | oui |
| `docs/checkpoints/C2.md` | — | oui (GO avec réserves proposé) | à valider |

### Validation du jour
- **§13-4** : lead capturé -> assigné -> deal créé -> gagné, avec l'historique d'activités (assignation, sortie de « non assigné », appel, changements d'étape du deal) lu à l'identique par les rôles autorisés et jamais par l'analyste ni l'autre entreprise ; échec de synchro CRM rejoué sans doublon (`crm-sync-flow`, relancé).
- **Réserve principale (écart 1 du C2)** : le parcours n'est démontré qu'au niveau service, API et base : aucun écran ne crée un lead ou un deal, ne note une activité, ni n'affiche la chronologie ; le test crée le deal par la fonction SQL et la clé de formulaire et la règle d'assignation par SQL.
- Observation : l'assignation et la sortie de l'étape « non assigné » ont le même horodatage (même transaction) ; leur ordre dans la chronologie n'est pas défini.

### Revue adverse : l'audit Phase 2 tient lieu de revue du jour (tests seulement ce jour-là) ; correction documentaire : en-têtes J20 à J26 du journal (« NON commité » devenu « commité, PR ouverte »).

### Tests : domain 608 ✓ · adapters 34 ✓ · permissions 394 ✓ · worker 76 ✓ · web 2469 ✓ · pgTAP 2397 ✓ · API réelle 436 ✓ · acceptation 143 ✓ (+9 : g2-lead-to-deal) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Aucun code applicatif ni migration. Helper `assign-worker.ts` extrait (partagé par `t2-sales` et G2).
- Pas de Playwright (HTTP réel, comme T1 et T2) : réserve C1 n°2 maintenue.

### Décision C2 du 9 nov 2026 (suite du J27)
- GO du C2 donné par la responsable technique. Écrans CRM : **option A** (avant G3), mise en œuvre dans le plan : J30b contacts et consentement, J30c et J30d fiche lead, J39b configuration, J39c import. Plan : 68 jours, G3 le lun 18 jan 2027, fin le mar 16 fév 2027. Cibles de tous les jours recalculées sur 68 jours (les cibles citées plus haut sont celles de l'ancien plan à 63 jours).
- Restent à décider : relecture et acceptation des ADR (004 et 008 avant J28 ; 007 pour les 8 tables de la Phase 2), job CI de bout en bout.

### Décisions du 2026-11-09 (ADR, CI, Playwright)
- ADR acceptés par délégation de la responsable technique : 001 à 006, 014, 015 ; 007 pour les Phases 1 et 2 ; 016 sous condition (avant J54). Restent Proposed : 008 (Q2, à trancher au début de J31), 010 (Q5), 012 (avant J47). Job CI e2e (option A) avant J29 ; Playwright décidé au J58 ; `libphonenumber-js` épinglé. Q1 reste ouverte ; fusion des PR #8 à #31 en attente de l'ordre de la responsable technique.

### Job CI de bout en bout (9 nov 2026, branche `ci-e2e-job`)
- `.github/workflows/ci.yml` : job `e2e` (Supabase local, build, `next start`, `pnpm test:e2e`) et étape de couverture 80 % dans `verify`. Ferme l'écart 3 du C2 (réserve C1 n°4). Aucun code applicatif ni migration.

## J28 — Intégrations et secrets (branche `day-28-integrations`, NON commité)
Cible : 42,6 % (plan à 68 jours) | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `integrations` + `channels` + RLS | 2 h | oui (migration `20261128100000`, SELECT par colonnes, fonctions owner / admin) | oui (pgTAP 119, API réelle 12) |
| Stockage chiffré `secret_ref` (ADR 004) | 2 h | oui (`store.ts`, rotation, reconnexion, lecture service_role) | oui (adapters 10, acceptation avec déchiffrement réel) |
| Écran « Intégrations » sans secret brut | 2 h | oui (`/integrations` fr / ar / en, écriture seule) | oui (HTTP réel ; la vérification visuelle dans un navigateur reste à faire) |

### Validation du jour
- **Aucun jeton lisible** via la Data API ni par un Company Admin : `secret_ref` et `select *` refusés, `private.secrets` sans droit, `get_integration_secret` réservé à service_role ; le jeton n'apparaît ni dans les réponses, ni dans les pages, ni dans l'audit, ni dans `idempotency_keys`.
- **Rotation testée** : remplacer le jeton supprime l'ancien secret dans la même transaction ; reconnexion et déconnexion testées ; isolation Alpha / Beta (AAD et clé composite).

### Revue sécurité (0 bloquant, 3 majeurs, 4 moyens) — corrigés : identité de canal (format), compte déconnecté verrouillé (reconnexion), rejeu d'une clé d'idempotence avec un autre jeton (HMAC), plafond en octets, statuts servis par `get_integration_secret`, tests renforcés ; **soumis à la responsable technique** : squat et énumération du compte global (valider le jeton auprès du fournisseur avant de réserver ? libérer un `pending` après un délai ?), unicité globale des expéditeurs de canal, fonctions d'écriture appelables directement par la Data API avec un chiffré arbitraire.

### Tests : domain 615 ✓ · adapters 44 ✓ · permissions 394 ✓ · worker 76 ✓ · web 2492 ✓ · pgTAP 2516 (dont 210_integrations_secrets : 119) ✓ · API réelle 448 (integrations-secrets : 12) ✓ · acceptation 153 ✓ (+1 test réservé à un serveur sans clé maître ; integrations-flow : 9) · couverture domain 97,9 % · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Pas de formulaire de création dans l'écran (chaque fournisseur a ses champs : J31 e-mail, J34 WhatsApp) : création par l'API seulement ; l'écran liste, remplace, reconnecte et déconnecte.
- Pas de rotation de la clé maître (J58 et J59, `docs/runbooks/secret-rotation.md`).
- Aucune validation par un fournisseur réel : toute intégration reste `pending`.

## J29 — Pipeline webhook (branche `day-29-webhooks`, NON commité)
Cible : 44,1 % (plan à 68 jours) | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `webhook_events` + unicité | 1,5 h | oui (migration `20261129100000`, unicité par entreprise) | oui (pgTAP 78, API réelle 6) |
| Route `/api/webhooks/[provider]` | 2,5 h | oui (taille, signature, tenant par le compte, limitation de débit) | oui (route 11, acceptation 16) |
| ACK rapide + job | 1 h | oui (job `process_webhook` dans la même transaction, handler worker) | oui (worker 12, acceptation) |
| Tests | 1 h | oui | oui |

### Validation du jour
- **Signature invalide rejetée et journalisée** : 401, ligne `rejected` sans payload ; **rejeu traité une seule fois** (8 envois simultanés : un événement, un job) ; **payload trop gros** : 413 ; **compte inconnu** : même 401 que la signature invalide (aucun oracle) ; **tenant forgé dans le payload** : l'événement reste à l'entreprise du compte.
- Réserve : aucun adaptateur de production n'existe (e-mail J32, WhatsApp J34 et J35) : la route répond 404 pour tous les fournisseurs et les scénarios de signature tournent avec un adaptateur de test injecté sur les vraies fonctions SQL (pas de test HTTP de signature avant J32).

### Revue sécurité (0 bloquant, 2 majeurs, 5 moyens) — corrigés : oracle d'existence d'un compte (même réponse et même travail), seau de débit (IPv6 /64 et adresse inconnue), secret absent, horodatage strict, adaptateur qui lève, sans processeur = `failed` re-jouable, marge de taille et caractère nul du jsonb, plafond de file sur 7 jours, tests (magasin, réponses identiques) ; **à décider avant le J34** : secret de webhook distinct et propre à chaque entreprise (App Secret WhatsApp), identifiant d'événement dérivé de contenu signé ; **avec l'exploitation (J39)** : balayage des événements bloqués, rétention du payload et des rejets, limite par intégration.

### Tests : domain 615 ✓ · adapters 63 ✓ · permissions 394 ✓ · worker 88 ✓ · web 2509 ✓ · pgTAP 2594 (dont 220_webhook_events : 78) ✓ · API réelle 454 (webhooks : 6) ✓ · acceptation 169 ✓ (+1 test réservé à un serveur sans clé maître ; webhooks-flow : 16) · couverture domain 97,9 % · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Unicité `(organization_id, provider, external_event_id)` au lieu de `(provider, external_event_id)` (ADR 007 mis à jour).
- Pas de purge du payload ni des rejets (J39, J58) ; pas de limite par intégration.

## J30 — Conversations et messages (branche `day-30-conversations`, NON commité)
Cible : 45,6 % (plan à 68 jours) | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Tables + RLS | 2 h | oui (migration `20261130100000`, lecture par rôle, aucune écriture directe) | oui (pgTAP 126, API réelle 12) |
| Cohérence d'entreprise des messages | 1 h | oui (clé composite + déclencheurs d'immuabilité) | oui |
| Unicité `provider_message_id` | 1 h | oui (+ clé d'idempotence, conflit si rejeu contradictoire) | oui (8 envois simultanés = 1 message) |
| Services d'état et d'assignation | 2 h | oui (fonctions SQL par rôle + service web) | oui |

### Validation du jour
- **Un message ne peut porter une autre `organization_id`** (ni un autre canal) que sa conversation : refusé par la base, y compris en insertion forgée.
- **Le commercial ne lit que SES conversations** (et leurs messages) ; la file `to_triage`, marketing, analyste, l'autre entreprise et l'anonyme : rien.

### Revue sécurité (0 bloquant, 2 majeurs, 5 moyens) — corrigés : rejeu contradictoire (autre conversation ou autre corps) devenu un conflit d'idempotence, corps de message dans le DETAIL des erreurs de contrainte (validation avant insertion), `pending` sans responsable et CHECK état / responsable, ordre des verrous (membre puis conversation), index du tri, plafond de messages par conversation, horodatage clampé, canal déconnecté, tests renforcés (PATCH vacuous, erreurs précises) ; **à noter** : un message sortant naît `queued` sans approbation (le worker d'envoi J31 doit exiger la chaîne de contrôle), `handled_by` et verrou sans écrivain avant J38, effacement RGPD d'un contact avec messages (anonymisation à définir), pas de quota `messages_per_month`.

### Tests : domain 621 ✓ · adapters 63 ✓ · permissions 394 ✓ · worker 88 ✓ · web 2515 ✓ · pgTAP 2720 (dont 230_conversations_messages : 126) ✓ · API réelle 466 (conversations : 12) ✓ · acceptation 169 ✓ (+1 test réservé à un serveur sans clé maître) · lint, typecheck, check:leaks verts
### Écarts à la spec / plan
- Statut de message `received` ajouté (entrants seulement) ; états par `CHECK` et non par enum.
- Pas de route ni d'écran (J37) ; pas d'envoi ni de réception réels (J31, J32, J35).

## J31 — Envoi d'e-mail derrière la chaîne de contrôles (branche `day-31-email-send`, NON commité)
Cible : 51,5 % (plan à 68 jours) | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| `assertCanSend` (chaîne de contrôles) | 2 h | oui (`packages/domain/src/outbound`, 15 refus typés, échec fermé) | oui (33 tests) |
| Adaptateur e-mail (ADR 008) | 2,5 h | oui (interface + Postmark, `fetch` injecté) | oui (11 tests, aucun appel réel) |
| Handler `send_message` | 1,5 h | oui (+ migration, approbation, tentative unique) | oui (worker 30 tests, pgTAP 94, API 10) |

### Validation du jour
- **Contrôle final dans le worker juste avant l'appel** : l'état est relu dans une transaction verrouillée (`message_send_claim`) puis `checkCanSend` décide ; aucune route HTTP n'envoie.
- **`accepted` n'est pas `delivered`** : le worker s'arrête à `accepted` ; la base interdit `queued` vers `delivered` et tout envoi accepté sans approbation.

### Revue sécurité (0 bloquant, 2 majeurs, 5 moyens) — corrigés : entreprise suspendue ou abonnement inactif ignorés, clé étrangère de `approved_by` qui bloquait la suppression d'un compte, approbation jamais revalidée (approbateur rétrogradé, durée), adresse du contact modifiable après approbation, `accepted` perdu après une panne base ou un second worker, 502 / 504 classés « renvoyable » ; mineurs traités : compteur de débit sérialisé, secret mal formé refusé avant l'appel ; **à noter** : lien de désabonnement (J33), annulation d'un message approuvé (J38), quota `messages_per_month` (J39).

### Tests : domain 654 ✓ · adapters 74 ✓ · permissions 394 ✓ · worker 118 ✓ · web 2515 ✓ · pgTAP 2814 (dont 240_send_chain : 94) ✓ · API réelle 476 (send-chain : 10) ✓ · lint, typecheck, check:leaks verts · acceptation 169 ✓ (+1 réservé à un serveur sans clé maître)
### Écarts à la spec / plan
- `message_approve` (owner et admin) ajoutée : point d'entrée de l'approbation humaine avant les écrans J38 et J44 ; l'approbation met le job en file.
- Objet de l'e-mail dérivé du corps (pas de colonne `subject` avant J40) ; limite de débit provisoire de 100 e-mails par heure et par canal ; `fetch` injecté au lieu de MSW (non installé).
- Aucun flux n'active encore un canal ou une intégration e-mail : le premier envoi réel attend la validation des identifiants (J32) et le checkpoint C3 ; Postmark reste une hypothèse (Q2).

## J32 — E-mail entrant et statuts (branche `day-32-email-inbound`, NON commité)
Cible : 52,9 % (plan à 68 jours) | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Webhook de statuts | 2 h | oui (adaptateur Postmark, `email_status_apply`, processeur worker, secret de webhook) | oui (adaptateur 32, worker 11, pgTAP 114, API 9, acceptation HTTP réelle) |
| Réception + rattachement | 2,5 h | oui (canal par adresse destinataire, contact par adresse expéditrice, un fil par contact et canal) | oui |
| File des cas ambigus | 1,5 h | oui (`inbound_unmatched`, jamais de contact créé, plafonds) | oui |

### Validation du jour
- **Une réponse est rattachée à la bonne conversation** : celle du contact et du canal désignés par les adresses, déduplication par identifiant du fournisseur, un fil fermé se rouvre (acceptation HTTP réelle).
- **Un rebond met à jour le message et le contact** : message `bounced`, adresse en `suppressions`, `do_not_contact` inchangé ; une plainte pose aussi `do_not_contact` (décision de la responsable technique).

### Revue sécurité (1 bloquant, 1 majeur, 5 moyens) — corrigés : usurpation d'expéditeur (SPF non aligné sur l'adresse affichée, en-têtes dupliqués), file des cas ambigus sans plafond effectif (corps, expéditeur, entreprise, jamais perdue en silence), texte invalide qui faisait réessayer le fournisseur sans fin, identifiants d'événement hors contrainte, canal choisi par l'en-tête « To » de l'expéditeur, secret de webhook égal au jeton d'envoi, couverture des rebonds (BadEmailAddress), plainte qui écrasait la provenance, réclamation ancienne jamais réconciliée, HTTPS non imposé ; **résiduel accepté** : mot de passe Basic dans chaque requête, écart de temps pour un compte inconnu (J29).

### Tests : domain 654 ✓ · adapters 106 ✓ · permissions 394 ✓ · worker 129 ✓ · web 2523 ✓ · pgTAP 2928 (dont 250_email_inbound : 114) ✓ · API réelle 485 (email-inbound : 9) ✓ · acceptation 185 ✓ (+1 réservé à un serveur sans clé maître) · lint, typecheck, check:leaks verts
### À surveiller
- Le test pgTAP `230_conversations_messages` (n° 106) a échoué deux fois de suite puis réussi trois fois sans changement de code : cause non trouvée, à surveiller en CI.
### Écarts à la spec / plan
- Pas de rattachement par `Message-ID` / `In-Reply-To` / `References` : un fil par contact et canal (J30), le rattachement se fait par l'adresse expéditrice dans le canal.
- Secret de webhook fourni par l'administrateur (et non généré par le serveur) ; table `inbound_unmatched` et second secret : amendements de l'ADR 007.
- Tout ce qui dépend de Postmark reste À CONFIRMER sur un compte sandbox (checkpoint C3) : en-têtes SPF / DKIM des entrants, `Metadata` des événements, codes de rebond.
- Aucun flux n'active encore un canal e-mail : ni envoi réel ni réception réelle avant ce flux et C3.

## J33 — Désabonnement (branche `day-33-unsubscribe`)
Cible : 54,4 % (plan à 68 jours) | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Lien signé + `List-Unsubscribe` | 2 h | oui (jeton HMAC sans donnée personnelle, en-têtes One-Click, pied de page, en-têtes Postmark en liste blanche) | oui (adaptateurs 116, worker 132) |
| Page publique | 1,5 h | oui (`/api/unsubscribe/[token]` GET et POST, page `/{fr,ar,en}/unsubscribe/[token]`) | oui (web 2544, acceptation HTTP) |
| Révocation + annulation des jobs | 2 h | oui (`unsubscribe_apply` : consentements révoqués, adresse supprimée, envois en file annulés) | oui (pgTAP 42) |
| Tests | 0,5 h | oui | oui |

### Validation du jour
- **Message suivant bloqué** : après le désabonnement, la réclamation d'envoi voit « pas de consentement » et « adresse supprimée » ; le contrôle final refuse.
- **Jobs en attente → `cancelled`** : messages en file non réclamés et leurs jobs annulés ; un envoi déjà réclamé n'est pas touché (le contrôle final le refuse, fenêtre de quelques secondes documentée).
- **Ouvrir le lien ne désabonne pas** : GET redirige vers une page de confirmation ; le un-clic RFC 8058 passe par POST.

### Revue sécurité (0 bloquant, 1 majeur, 3 moyens) — corrigés : jeton valide sous plusieurs écritures de la version de clé (zéro initial), validation du jeton AVANT la limite de débit et la base, échec du worker avant la réclamation sans clé, démarrage du worker avec clé invalide, motif de chemin public inutile retiré. Le majeur (rotation de clé : les anciens liens cessent de fonctionner) n'est pas corrigé : limite du trousseau à une seule clé en production, commune au chiffrement des secrets ; documentée comme point ouvert.

### Tests : domain 654 ✓ · adapters 116 ✓ · permissions 394 ✓ · worker 132 ✓ · web 2544 ✓ · pgTAP 2970 (dont 260_unsubscribe : 42) ✓ · API réelle 485 ✓ · acceptation HTTP réelle (unsubscribe-flow : 8) · lint, typecheck ✓
### À surveiller
- **Rotation de clé** : le trousseau de production n'a qu'une clé ; une rotation casserait les anciens liens de désabonnement et le déchiffrement des anciens secrets. Variable des clés précédentes à décider avant la première rotation.
- **Réabonnement** : aucune fonction pour lever une désinscription (action auditée à prévoir avec l'écran contacts, J30b).
### Écarts à la spec / plan
- Pas de suppression de l'adresse courante si l'e-mail du contact a changé depuis l'approbation (l'adresse supprimée est celle où le message est parti).
- Hypothèse à confirmer à C3 : Postmark transmet tels quels les en-têtes `List-Unsubscribe` de `Headers`.

## J34 — Connexion WhatsApp Cloud API (branche `day-34-whatsapp-connect`)
Cible : 55,9 % (plan à 68 jours) | Réel : à valider | Statut : —
⚠ Chemin critique externe : aucun compte Meta réel ; développement contre des fixtures (plan B), test réel à C3.

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| connect/validate | 2,5 h | oui (`integration_set_validation`, client Graph à adresse fixe, route `POST /api/integrations/validate`) | oui (pgTAP 30, adaptateurs 129, web 2560) |
| Vérification du webhook + signature | 2 h | oui (adaptateur `X-Hub-Signature-256`, poignée de main GET, `WHATSAPP_VERIFY_TOKEN`) | oui (acceptation HTTP 9) |
| Écran de connexion | 1,5 h | oui (« Connecter un numéro WhatsApp », « Vérifier la connexion », fr / ar / en) | partiel (écran vérifié par les tests, pas visuellement dans un navigateur) |

### Validation du jour
- **Signature** : événement signé accepté et dédupliqué ; signature fausse, absente, sans préfixe ou corps modifié : 401 ; numéro inconnu : le même 401.
- **Activation** : seul le serveur, après essai du jeton auprès de Meta, peut passer une intégration à `active` (fonction service_role) ; une panne de Meta n'écrit rien.

### Revue sécurité (0 bloquant, 0 majeur, 4 moyens) — corrigés : notifications Meta sans numéro refusées à tort (400, risque de désactivation de l'abonnement), limites de débit de Graph prises pour une erreur de compte, acteur absent de l'audit, activation possible sans secret d'app, identifiant de numéro non numérique accepté. Non corrigé (documenté) : numéro réservable par une intégration jamais validée, fenêtre de remplacement du jeton, trace des refus sans purge.

### Tests : domain 656 ✓ · adapters 129 ✓ · permissions 394 ✓ · worker 132 ✓ · web 2560 ✓ · pgTAP 3000 (dont 270_integration_validation : 30) ✓ · API réelle 485 ✓ · acceptation HTTP réelle (whatsapp-connect : 9) · lint, typecheck ✓
### À surveiller
- Tout ce qui touche Meta est une hypothèse à confirmer à C3 (version Graph v21.0, forme des payloads, nouvel essai).
- Le J35 doit dédupliquer par identifiant de message et de statut (le webhook ne dédoublonne qu'au niveau du corps).
### Écarts à la spec / plan
- Nouvelle variable serveur optionnelle `WHATSAPP_VERIFY_TOKEN` (jeton de la plateforme : la poignée de main GET ne porte aucun compte) ; décision d'architecture à valider.
- Pas de traitement des événements WhatsApp avant le J35 : sans processeur, un événement passe `failed` (`no_processor`) et reste rejouable.

