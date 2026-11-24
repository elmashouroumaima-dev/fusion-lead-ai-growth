-- Retour arrière de 20261220100000_integration_account_per_org.sql : rétablit l'index unique GLOBAL et la résolution à un seul résultat.
-- ATTENTION : la création de l'index échoue si deux entreprises déclarent le même compte (cas devenu possible) ; supprimer ou déconnecter d'abord les doublons :
--   select provider, external_account_id, count(*) from public.integrations where provider in ('email', 'whatsapp') group by 1, 2 having count(*) > 1;
drop function public.webhook_resolve_candidates(text, text, text);
drop function private.webhook_resolve_candidates(text, text, text);

create unique index integrations_provider_account_global on public.integrations (provider, external_account_id) where provider in ('email', 'whatsapp');

create function private.webhook_resolve_integration(p_provider text, p_account text, p_gateway text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('organization_id', i.organization_id, 'integration_id', i.id)
    from public.integrations i
   where i.provider = p_provider
     and i.external_account_id = p_account
     and i.provider in ('email', 'whatsapp')
     and (p_gateway is null or i.gateway = p_gateway)
     and i.status in ('pending', 'active', 'error');
$$;
create function public.webhook_resolve_integration(p_provider text, p_account text, p_gateway text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.webhook_resolve_integration(p_provider, p_account, p_gateway); $$;
revoke all on function private.webhook_resolve_integration(text, text, text) from public, anon, authenticated, service_role;
grant execute on function private.webhook_resolve_integration(text, text, text) to service_role;
revoke all on function public.webhook_resolve_integration(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.webhook_resolve_integration(text, text, text) to service_role;
