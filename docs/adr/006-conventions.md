# ADR 006 — Conventions de code, de données et de livraison

- **Statut :** Proposed
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
