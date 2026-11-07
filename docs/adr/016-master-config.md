# ADR 016 — Palette de couleurs globale de la plateforme (`platform_config`)

- Statut : **Proposé** (à valider par la responsable technique : nouvelle table absente de la spec, droit d'écriture global accordé aux owner/admin, lecture serveur par `service_role`)
- Date : 2026-11-07
- Sources : spec §6, §11 ; ADR 005 (isolation, §10 Platform Admin), ADR 007 (modèle de données), ADR 014 (RBAC), ADR 015 (kit UI).
- Historique : (1) `master_config`, palette par organisation : abandonnée avant tout commit, car la page de connexion ne connaît aucune organisation ; (2) palette globale éditée par un « administrateur de la plateforme » (table `platform_admins`) : abandonnée, car le rôle Platform Admin est prévu au J14 dans le schéma `private` (ADR 005 §10) et le propriétaire du produit veut que les owner/admin règlent les couleurs.

## Contexte
Le propriétaire veut choisir les couleurs de l'application et les retrouver partout, y compris sur la page de connexion, quel que soit le navigateur. Une palette par organisation est impossible avant la connexion : la palette est donc **globale**.

## Décision
1. **`public.platform_config`** (`key` PK, `value jsonb`, `updated_by`, horodatages). Donnée **globale, non tenant** : pas d'`organization_id` (exception documentée dans `900_schema_lint.test.sql`, comme `plans`). Liste blanche de clés (`appearance.palette`) et formes contraintes par `CHECK` (objet jsonb ≤ 16 Ko).
2. **Aucun droit direct** sur la table (anon, authenticated, service_role) ; RLS activée sans politique.
3. **Écriture** : `public.set_platform_config` / `reset_platform_config` (wrappers `SECURITY INVOKER` → `private.*` `SECURITY DEFINER`, `search_path` vide), réservées à tout **owner ou admin actif d'au moins une organisation** (`private.can_manage_platform_config()`, d'après `organization_members` et `auth.uid()`, jamais `user_metadata`). La base valide la forme (modes `light` / `dark`, jetons de la liste blanche, couleurs `#rrggbb` en minuscules) ; l'application (`packages/domain/src/theme`) ajoute le contraste WCAG AA (4,5:1) sur six paires texte/fond.
4. **Lecture** : `public.get_platform_config(p_key)`, exécutable par **`service_role` seulement**, appelée côté serveur par `apps/web/lib/service/platform-config.ts` (module de `lib/service/**`, seul emplacement autorisé pour `createAdminClient`). `anon` n'obtient aucun droit : les règles de lint L4 / L11 restent intactes. La valeur est re-validée (`paletteSchema`) avant d'être transformée en CSS.
5. **Rendu** : `paletteToCss` (hex uniquement) est injecté par le layout de locale dans toutes les pages (connexion, inscription, invitation, application). Aucune chaîne libre n'atteint le CSS.
6. Page `/settings/appearance` et lien « Paramétrage » : owner / admin (`can_manage_platform_config`), la base revérifiant à l'écriture.

## Conséquences et risques
- **Risque assumé** : la palette est unique pour toute la plateforme ; **l'owner ou l'admin de n'importe quelle organisation la modifie pour tous les clients**. À réévaluer avant l'ouverture à de vrais clients (remplacer par le Platform Admin du J14, ou par une palette par organisation après connexion).
- **Extension du périmètre de `service_role`** : `admin.ts` ne servait qu'à la limitation de débit ; il lit maintenant aussi une donnée globale non sensible (une palette). Aucune donnée d'organisation n'est lue. À valider.
- Lecture à chaque rendu (une requête RPC par page) : acceptable en développement ; un cache court est à prévoir si la charge l'exige.
- Les jetons non modifiables (`border`, `muted`, `input`, `destructive-text`) gardent leurs valeurs ; `card`, `popover` et la barre latérale suivent `background` / `foreground`. Le dégradé de marque des pages publiques reste fixe.
- Un appel direct à la fonction SQL par un owner/admin contourne la vérification de contraste (la base ne la connaît pas). Accepté.
- Journal d'audit : non branché (table non tenant ; organisation d'accueil des lignes à décider avec la PR J12).
- Retour arrière : `supabase/rollbacks/20261114100000_platform_config.sql` (supprime la palette).
