-- J7 — Politiques RLS du noyau tenant, GRANT explicites (par colonne) et protection du dernier owner.
-- Sources : spec §2, §7.2, §11, §13-1, §13-2 ; ADR 005 §4–§6 ; ADR 007 ; ADR 014 (matrice RBAC).
-- Retour arrière : supabase/rollbacks/20261106130935_core_rls_policies.sql
--
-- Principes :
--  * une politique par opération (select / update / delete), `to authenticated`, USING + WITH CHECK ;
--  * le rôle est lu dans organization_members via private.has_role / private.is_member
--    (jamais user_metadata) ;
--  * aucun INSERT direct sur organization_members, organizations, subscriptions, usage_counters, plans :
--    ces écritures passent par des fonctions serveur (J9 création d'entreprise, J10 invitations,
--    J14 plans/quotas) exécutées avec service_role ;
--  * GRANT minimal : lecture + mises à jour limitées à des colonnes ; slug, status et clés ne sont
--    modifiables que par le serveur.

-- ---------------------------------------------------------------------------
-- GRANT explicites pour authenticated (anon n'a rien)
-- ---------------------------------------------------------------------------
grant select on table public.plans to authenticated;
grant select on table public.organizations to authenticated;
grant select on table public.organization_members to authenticated;
grant select on table public.subscriptions to authenticated;
grant select on table public.usage_counters to authenticated;

grant update (name, timezone, locale, settings) on table public.organizations to authenticated;
grant update (role, status) on table public.organization_members to authenticated;
grant delete on table public.organization_members to authenticated;

-- ---------------------------------------------------------------------------
-- plans : catalogue global lisible par tout utilisateur authentifié
-- ---------------------------------------------------------------------------
create policy plans_select on public.plans
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- organizations : visible par ses membres actifs ; modifiable par owner et admin
-- ---------------------------------------------------------------------------
create policy organizations_select on public.organizations
  for select to authenticated
  using (private.is_member(id));

create policy organizations_update on public.organizations
  for update to authenticated
  using (private.has_role(id, array['company_owner', 'company_admin']::public.app_role[]))
  with check (private.has_role(id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- organization_members
--   select : sa propre ligne ; owner et admin voient toutes les adhésions de leur entreprise
--   update / delete : owner (toutes lignes) ; admin (jamais une ligne owner, jamais attribuer owner)
-- ---------------------------------------------------------------------------
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[])
  );

create policy organization_members_update on public.organization_members
  for update to authenticated
  using (
    private.has_role(organization_id, array['company_owner']::public.app_role[])
    or (
      private.has_role(organization_id, array['company_admin']::public.app_role[])
      and role <> 'company_owner'
    )
  )
  with check (
    private.has_role(organization_id, array['company_owner']::public.app_role[])
    or (
      private.has_role(organization_id, array['company_admin']::public.app_role[])
      and role <> 'company_owner'
    )
  );

create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (
    private.has_role(organization_id, array['company_owner']::public.app_role[])
    or (
      private.has_role(organization_id, array['company_admin']::public.app_role[])
      and role <> 'company_owner'
    )
  );

-- ---------------------------------------------------------------------------
-- subscriptions et usage_counters : lecture owner/admin ; écriture serveur uniquement
-- ---------------------------------------------------------------------------
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

create policy usage_counters_select on public.usage_counters
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Protection du dernier owner actif (ADR 007) : ni suppression, ni rétrogradation, ni suspension.
-- security definer : doit voir toutes les adhésions de l'entreprise malgré la RLS de l'appelant.
-- S'applique aussi à service_role (un transfert de propriété passe par un second owner).
-- ---------------------------------------------------------------------------
create function private.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_active_owner boolean := old.role = 'company_owner' and old.status = 'active';
  stays_active_owner boolean := tg_op = 'UPDATE'
    and new.role = 'company_owner' and new.status = 'active';
begin
  if was_active_owner and not stays_active_owner then
    -- Sérialise les opérations concurrentes sur la même entreprise (deux owners qui se
    -- rétrogradent en même temps ne doivent pas laisser l'entreprise sans owner).
    perform pg_advisory_xact_lock(hashtextextended(old.organization_id::text, 0));
    if not exists (
      select 1
      from public.organization_members m
      where m.organization_id = old.organization_id
        and m.id <> old.id
        and m.role = 'company_owner'
        and m.status = 'active'
    ) then
      raise exception 'cannot remove, demote or suspend the last active company_owner (organization %)',
        old.organization_id
        using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.protect_last_owner() from public;

create trigger protect_last_owner
  before update or delete on public.organization_members
  for each row execute function private.protect_last_owner();
