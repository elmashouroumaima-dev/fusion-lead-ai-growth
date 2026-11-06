-- Retour arrière de 20261106120616_core_private_helpers_and_lockdown.sql
-- À exécuter AVANT le retour arrière de 20261106120613_core_tenant_schema.sql.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.

-- Défauts du schéma public : retour à l'état Supabase d'origine (tables exposées par défaut).
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated;
alter default privileges for role postgres in schema private
  grant execute on functions to public;

-- GRANT des tables du noyau : retour à l'état d'origine.
grant all on table public.plans, public.organizations, public.organization_members,
  public.subscriptions, public.usage_counters to anon, authenticated;

alter table public.plans disable row level security;
alter table public.organizations disable row level security;
alter table public.organization_members disable row level security;
alter table public.subscriptions disable row level security;
alter table public.usage_counters disable row level security;

drop function if exists private.has_role(uuid, public.app_role[]);
drop function if exists private.is_member(uuid);
grant execute on function private.set_updated_at() to public;
grant execute on function private.prevent_organization_id_change() to public;
revoke usage on schema private from authenticated, service_role;
