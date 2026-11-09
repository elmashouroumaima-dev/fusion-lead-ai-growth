# ADR 006 — Conventions de code, de données et de livraison

- **Statut :** Accepted (2026-11-09, décision de la responsable technique par délégation, après les audits de conformité C1 et C2)
- **Date :** 2026-11-10
- **Section de spec :** §7, §8, §12 (migrations réversibles), CLAUDE.md

## Décisions
**Nommage** : `snake_case` en base, `camelCase` en TypeScript, `kebab-case` pour les fichiers ; tables au pluriel ; enums Postgres en `snake_case` minuscule (rôles : `company_owner`, `company_admin`, `marketing_manager`, `sales_agent`, `analyst`).

**Erreurs API** : `{ code, message, request_id }` ; codes stables (`forbidden`, `validation_failed`, `quota_exceeded`, `idempotency_conflict`, `not_found`…) ; jamais de détail interne ni de donnée sensible ; statuts : 400/422 validation, 401, 403, 404, 409, 429.

**Mutations** : `Idempotency-Key` sur toute mutation rejouable ; stockage `(organization_id, key, request_hash, response, expires_at)` ; même clé + corps différent → 422.

**Migrations** : fichiers horodatés dans `supabase/migrations`, **jamais modifiés après application** ; Supabase applique en avant seulement, donc la réversibilité est assurée par un script **`supabase/rollbacks/<même horodatage>_*.sql`** (ou une procédure documentée dans le fichier de migration si le retour est destructif) ; chaque migration tenant est livrée avec ses politiques RLS et ses tests dans la même PR.

**Données** : `created_at timestamptz default now()`, `updated_at` maintenu par trigger ; heures en UTC, fuseau IANA stocké séparément ; téléphone E.164 ; e-mail normalisé (minuscules, trim) dans `email_normalized` ; montants `numeric(14,2)` + `currency` ISO 4217.

**Statuts** : tout champ d'état est un enum ou une contrainte `check` ; les transitions de campagne, conversation et job sont des machines d'états dans `packages/domain` (table de transitions + gardes).

**Config** : variables d'environnement validées par zod au démarrage (`serverEnv` / `clientEnv`) ; aucune valeur réelle dans le dépôt ; `.env.example` par environnement.

**Git** : une branche par jour `day-XX-sujet` ; Conventional Commits (`feat(scope):`, `fix`, `test`, `docs`, `chore`) ; un sujet par commit ; PR avec la checklist du jour ; un bug corrigé = un test de non-régression dans le même commit.

**Logs** : JSON pino avec `request_id`, `organization_id`, `actor_id` ; redaction obligatoire des jetons et corps de message ; `audit_logs` ne contient ni texte IA ni payload de webhook sensible (§7).

**Tests** : voir `docs/testing/strategy.md` (J3) ; deux entreprises minimum dans chaque fixture.

## Conséquences
Ces conventions sont appliquées par ESLint/CI (frontières de packages, interdiction de `any` non justifié, schema lint SQL).

## Mise en œuvre J11 (2026-11-06)
- Couche service `apps/web/lib/service/` : voir `docs/api/service-layer.md`. Les erreurs `{ code, message, request_id }` sont produites par un seul module (`errors.ts`) ; `lib/api/` a été supprimé.
- **Idempotence** : durée 24 h, reprise d'une requête bloquée après 5 minutes, `attempt_id` par tentative, quota de 200 lignes vivantes par (organisation, acteur), réponse stockée limitée à 16 Ko. Les réponses contenant un secret ne sont jamais stockées (`storeResponse: false`).
- **Écarts au plan** : la migration `20261112100000_service_layer.sql` a été modifiée sur place après revue de sécurité (jamais commitée ni appliquée ailleurs). `acceptInvitationAction` passe par la couche service ; les actions d'authentification (J8) et `/auth/confirm` restent hors couche (à migrer avec J12).

## Mise en œuvre J12 (2026-11-07) — logs
- Logger JSON **maison** (`apps/web/lib/service/logger.ts`), sans dépendance : une ligne JSON par appel, `request_id` / `organization_id` / `actor_id` pris dans le contexte de requête (`AsyncLocalStorage`) et non modifiables par l'appelant, silencieux sous test. Écart à cet ADR (qui citait `pino`) : décision de la responsable technique, pour éviter une dépendance et les problèmes de bundling avec Next.
- Caviardage : clés sensibles (même liste que `private.audit_redact`, test de parité) et valeurs (JWT, `Bearer` / `Basic`, clés `sb_secret_` / `sb_publishable_`, e-mails, secrets dans les URL et chaînes de connexion, jetons d'invitation) ; une `Error` n'est journalisée que par son nom et son code, jamais son message.
- Le client Supabase serveur envoie l'en-tête `x-request-id` (identifiant généré côté serveur) pour que l'audit porte le même `request_id`.
- Reste : migrer les actions d'authentification (J8) et `/auth/confirm` sur la couche service ; le message de démarrage (`startup-check`) utilise encore `console`.
