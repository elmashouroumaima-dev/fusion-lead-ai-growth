-- Retour arrière de 20261214100000_platform_config_admin_only.sql.
-- ATTENTION : rétablit le risque assumé de l'ADR 016 d'origine (tout owner / admin d'organisation modifie la
-- palette et le logo de toute la plateforme). À n'utiliser qu'avant l'ouverture à de vrais clients.

create or replace function private.can_manage_platform_config()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members m
     where m.user_id = (select auth.uid())
       and m.status = 'active'
       and m.role in ('company_owner', 'company_admin')
  );
$$;

comment on function private.can_manage_platform_config() is null;
