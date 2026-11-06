-- Retour arrière de 20261106130935_core_rls_policies.sql
-- À exécuter AVANT les retours arrière des migrations précédentes.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.
-- Après ce retour arrière, la RLS reste activée sans politique : refus total (état du J6).

drop trigger if exists protect_last_owner on public.organization_members;
drop function if exists private.protect_last_owner();

drop policy if exists usage_counters_select on public.usage_counters;
drop policy if exists subscriptions_select on public.subscriptions;
drop policy if exists organization_members_delete on public.organization_members;
drop policy if exists organization_members_update on public.organization_members;
drop policy if exists organization_members_select on public.organization_members;
drop policy if exists organizations_update on public.organizations;
drop policy if exists organizations_select on public.organizations;
drop policy if exists plans_select on public.plans;

revoke delete on table public.organization_members from authenticated;
revoke update (role, status) on table public.organization_members from authenticated;
revoke update (name, timezone, locale, settings) on table public.organizations from authenticated;
revoke select on table public.usage_counters, public.subscriptions, public.organization_members,
  public.organizations, public.plans from authenticated;
