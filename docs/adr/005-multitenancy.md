# ADR 005 — Multi-tenancy et isolation

- **Statut :** Proposed — **relecture de sécurité par la responsable technique requise**
- **Date :** 2026-11-10
- **Section de spec :** §2, §7, §7.2 (RLS), §8, §11, §13-1

## Contexte
L'isolation des entreprises est le critère n°1. Elle doit tenir en UI, API, RLS et worker (§13-1) et la permission est vérifiée deux fois : couche service et base (§11).

## Décisions
1. **Colonne tenant** : `organization_id uuid not null references organizations(id)` + index sur **toute** table tenant (E11). PK `uuid`.
2. **FK composites** : chaque table tenant déclare `unique (organization_id, id)` ; toute FK vers une autre table tenant est composite `(organization_id, x_id) → (organization_id, id)`. Résout E12 (lead ↔ projet, message ↔ conversation, etc.) sans trigger.
3. **Transfert interdit** : trigger `BEFORE UPDATE` refusant tout changement de `organization_id` (spec §2) ; un transfert éventuel passe par une fonction d'administration auditée (hors MVP).
4. **Fonctions d'aide RLS** dans le schéma **`private`** (non exposé à la Data API), `security definer`, `set search_path = ''`, noms qualifiés : `private.is_member(org uuid)`, `private.has_role(org uuid, roles app_role[])`, `private.is_assigned(org uuid, assignee uuid)`. Elles lisent `organization_members` sans déclencher la RLS (évite les boucles). Appels dans les politiques sous forme `(select private.is_member(organization_id))` pour le cache par statement (doc Supabase RLS, consultée 2026-11-05).
5. **Rôle** : source = `organization_members.role` uniquement. **Jamais** `user_metadata` / `raw_user_meta_data` (modifiable par l'utilisateur, avertissement officiel) ; pas non plus de rôle dans le JWT (périmé tant que le jeton n'est pas rafraîchi).
6. **Politiques** : une politique par opération (`select`, `insert`, `update`, `delete`), `to authenticated`, `USING` + `WITH CHECK`, contrôle du rôle ; `anon` n'a aucun GRANT sur les tables tenant ; `GRANT` minimal (révision J7 et J57).
7. **Organisation active (`active_organization_id`, G-R5)** : cookie `httpOnly`/`secure`/`sameSite=lax` contenant l'identifiant choisi, **jamais une preuve d'autorisation**. À chaque requête, `getTenantContext()` relit l'adhésion `active` en base et en déduit le rôle ; sinon 403. Un `organization_id` du corps/de l'URL doit égaler le contexte, sinon 403. L'accès direct (client Supabase navigateur) reste protégé par la RLS, qui ne dépend pas du cookie.
8. **Worker / webhooks** : `service_role` côté serveur uniquement ; chaque requête métier du worker porte un `organization_id` explicite et vérifié ; les webhooks déduisent l'organisation de `integrations (provider, external_account_id)`.
9. **Unicité globale du compte fournisseur (G-R6)** : `unique (provider, external_account_id)` **global** (hors schéma par tenant) ; un compte déjà connecté à une autre entreprise est refusé à la connexion avec un message explicite.
10. **Platform Admin (G-R4, E7)** : pas un membre d'organisation ; table `platform_admins (user_id)` dans le schéma `private`. Accès aux données d'une entreprise **uniquement** via `support_sessions` active (motif, approbation, expiration), vérifiée par `private.has_active_support_session(org)` dans les politiques ; chaque accès audité. Hors session : aucune ligne tenant visible (sauf agrégats de consommation non personnels).
11. **Création d'organisation (G-R7)** : fonction `security definer` transactionnelle `public`-non-exposée appelée par le serveur (organisation + membre owner + subscription trial + pipeline par défaut).
12. **Storage** : chemin `{organization_id}/{project_id}/…`, politiques Storage basées sur `private.is_member`, URL signées courtes.
13. **Messages** : `organization_id` dupliqué, cohérence imposée par FK composite `(organization_id, conversation_id)`.
14. **Tests** : suite `test:rls` obligatoire dès chaque migration ; « schema lint » en CI échoue si une table `public` n'a pas `organization_id`, index, RLS activée et politiques par opération.

## Alternatives
- Schéma ou base par tenant : coûteux en migrations et inadapté à la spec (une base, `organization_id`).
- Rôle dans `app_metadata` du JWT : plus rapide mais périmé après changement de rôle ; rejeté (décision d'accès = lecture d'adhésion).

## Conséquences
Coût de lecture de `organization_members` à chaque ligne : index `(user_id, organization_id)` et `(select …)` en cache ; mesure au J15 (risque R13).

## Mise en œuvre J6 (2026-11-06) — constats de la base locale
- **RLS activée sans politique dès la migration du noyau** (refus total pour `anon`/`authenticated`), avec `REVOKE ALL` sur les tables et `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL … FROM anon, authenticated` : les politiques et les `GRANT` explicites arrivent au J7, table par table.
- **Rôles** : l'enum `app_role` compte 5 valeurs ; `platform_admin` n'en fait pas partie (§10 appliqué).
- **Limite constatée** : la base Supabase locale définit aussi des privilèges par défaut pour le rôle **`supabase_admin`** dans le schéma `public` (accès à `anon`/`authenticated`). Ils ne s'appliquent pas aux objets créés par nos migrations (rôle `postgres`), mais **une table créée depuis le tableau de bord (SQL editor, rôle `supabase_admin`) serait exposée**. Mitigations : option « Enable automatic RLS » activée sur le projet cloud, « schema lint » en CI (J7) qui exige RLS + politiques sur toute table `public`, point dédié dans la revue de la checklist de production (J57).
- Le schéma `private` n'est pas dans `api.schemas` : `POST /rest/v1/rpc/is_member` renvoie 404 ; `authenticated` n'a que `USAGE` sur le schéma et `EXECUTE` sur `is_member`/`has_role`.
- `organization_members` utilise `ON DELETE RESTRICT` vers `organizations` (aucun flux de suppression d'entreprise n'existe encore ; décision à prendre avec la politique de rétention, Q5).

## Mise en œuvre J7 (2026-11-06) — politiques du noyau
- **Politiques** (une par opération, `to authenticated`, USING + WITH CHECK, rôle lu uniquement via `private.has_role` / `private.is_member`) : `plans` (lecture pour tout utilisateur authentifié) ; `organizations` (select : membres actifs ; update : owner et admin) ; `organization_members` (select : sa ligne, owner/admin voient toute l'entreprise ; update et delete : owner sur toute ligne, admin jamais sur une ligne owner ni pour attribuer owner) ; `subscriptions` et `usage_counters` (select : owner et admin).
- **Aucun INSERT** possible via la Data API sur ces tables (création d'entreprise, adhésion, plans et compteurs passent par des fonctions serveur : J9, J10, J14) ; **GRANT par colonne** : `organizations` (name, timezone, locale, settings), `organization_members` (role, status) ; `slug`, `status`, `organization_id`, `user_id` ne sont modifiables que par le serveur.
- **Trigger `private.protect_last_owner`** : le dernier owner actif d'une entreprise ne peut être ni supprimé, ni rétrogradé, ni suspendu (verrou consultatif par entreprise contre les rétrogradations concurrentes) ; s'applique aussi à `service_role`. Conséquence : supprimer un utilisateur qui est le dernier owner échoue (le transfert de propriété d'abord).
- **Schema lint** (`supabase/tests/database/900_schema_lint.test.sql`, exécuté par `pnpm test:db` et en CI) : L1 `organization_id uuid not null` ; L2 index en tête de colonne ; L3 RLS activée ; L4 aucun privilège `anon` ; L5 chaque privilège `authenticated` couvert par une politique ; L6 politiques ciblant explicitement `authenticated` ; L7 aucune lecture de `user_metadata`/`app_metadata` ; L8 UPDATE avec WITH CHECK ; L9 `security definer` avec `search_path` ; L10 aucune `security definer` exposée dans `public` ; L11 `private` inaccessible à `anon`/PUBLIC. Exceptions explicites : `organizations` (racine) et `plans` (catalogue).
- **Harnais RLS** (`supabase/tests/rls`, `pnpm test:rls`) : Vitest qui appelle la vraie Data API (PostgREST) avec un JWT HS256 signé avec le secret de la pile **locale** pour chaque utilisateur du seed ; teste ensemble GRANT, RLS et triggers.
