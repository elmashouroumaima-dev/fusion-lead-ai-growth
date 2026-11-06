-- J6 — Fonctions d'aide RLS (schéma private), RLS activée (refus total) et verrouillage des GRANT.
-- Sources : spec §7.2, §11 ; ADR 005 §4, §6.
-- Retour arrière : supabase/rollbacks/20261106120616_core_private_helpers_and_lockdown.sql
-- Les POLITIQUES RLS arrivent au J7 : d'ici là, RLS activée sans politique = aucun accès pour
-- anon/authenticated (service_role contourne la RLS côté serveur, conformément à ADR 005 §8).

-- ---------------------------------------------------------------------------
-- Fonctions d'aide RLS : security definer, search_path vide, noms qualifiés.
-- Elles lisent organization_members sans déclencher la RLS (pas de boucle de politiques).
-- ---------------------------------------------------------------------------
create function private.is_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create function private.has_role(org uuid, roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any (roles)
  );
$$;

-- ---------------------------------------------------------------------------
-- Droits sur le schéma privé : jamais anon ; authenticated en a besoin pour évaluer les politiques.
-- Le schéma n'est pas dans api.schemas : ces fonctions ne sont pas appelables via /rpc.
-- ---------------------------------------------------------------------------
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

revoke all on function private.is_member(uuid) from public;
revoke all on function private.has_role(uuid, public.app_role[]) from public;
revoke all on function private.set_updated_at() from public;
revoke all on function private.prevent_organization_id_change() from public;
grant execute on function private.is_member(uuid) to authenticated, service_role;
grant execute on function private.has_role(uuid, public.app_role[]) to authenticated, service_role;

-- Les futures fonctions du schéma private ne sont pas exécutables par PUBLIC par défaut.
alter default privileges for role postgres in schema private
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- RLS : activée sur toutes les tables du noyau (refus total tant qu'aucune politique n'existe).
-- ---------------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_counters enable row level security;

-- ---------------------------------------------------------------------------
-- GRANT minimal (ADR 005 §6) : aucun droit direct pour anon/authenticated tant que le J7
-- n'a pas accordé explicitement les privilèges nécessaires, table par table.
-- ---------------------------------------------------------------------------
revoke all on table public.plans from anon, authenticated;
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.organization_members from anon, authenticated;
revoke all on table public.subscriptions from anon, authenticated;
revoke all on table public.usage_counters from anon, authenticated;

-- Équivalent de « Automatically expose new tables = désactivé » : les futures tables du schéma
-- public ne sont pas exposées par défaut ; chaque migration accorde explicitement ses privilèges.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
