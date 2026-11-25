-- Retour arrière de 20261225100000_s12_secret_distinct_atomic.sql : supprime le déclencheur, restaure les trois fonctions (sans empreinte) et retire la colonne.
drop trigger if exists integrations_secrets_distinct on public.integrations;
drop function if exists private.integrations_secrets_distinct();
drop function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text, text);
drop function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text, text);
drop function public.set_integration_secret(uuid, uuid, uuid, text, text, integer, text);
drop function private.set_integration_secret(uuid, uuid, uuid, text, text, integer, text);
drop function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer, text);
drop function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer, text);

create function private.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer,
  p_gateway text default 'meta'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_scopes text[] := coalesce(p_scopes, '{}');
begin
  perform private.assert_project_manager(p_org);
  if p_provider is null or p_provider not in ('email', 'whatsapp') or p_account is null or p_account !~ '^[A-Za-z0-9._-]{1,100}$'
     or p_gateway is null or p_gateway not in ('meta', 'kapso', 'resend')
     or (p_gateway = 'kapso' and p_provider <> 'whatsapp') or (p_gateway = 'resend' and p_provider <> 'email')
     or not private.is_valid_scopes(v_scopes) or p_secret_id is null or p_ciphertext is null or p_nonce is null or p_key_version is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  perform 1 from public.organizations o where o.id = p_org for update;
  perform private.assert_within_limit(p_org, 'integrations', 1);
  if (select count(*) from public.integrations i where i.organization_id = p_org) >= 20 then
    raise exception 'too_many_integrations' using errcode = 'P0001';
  end if;
  begin
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'integration', p_org, p_ciphertext, p_nonce, p_key_version);
    insert into public.integrations (organization_id, provider, status, external_account_id, scopes, secret_ref, gateway)
    values (p_org, p_provider, 'pending', p_account, v_scopes, p_secret_id, p_gateway)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

create function private.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
begin
  perform private.assert_project_manager(p_org);
  if p_secret_id is null or p_ciphertext is null or p_nonce is null or p_key_version is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider not in ('email', 'whatsapp') then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  begin
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'integration', p_org, p_ciphertext, p_nonce, p_key_version);
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  -- S-08 : un nouveau jeton n'a JAMAIS été essayé auprès du fournisseur : l'intégration repasse en `pending` (sauf désactivée) et ses canaux actifs aussi, jusqu'à une
  -- nouvelle validation réussie (`integration_set_validation`). Avant, une intégration `active` le restait avec un jeton faux (faute de frappe, jeton d'un autre compte).
  update public.integrations
     set secret_ref = p_secret_id,
         status = case when status in ('error', 'disconnected', 'active') then 'pending' else status end,
         last_error = null
   where organization_id = p_org and id = p_integration;
  -- reconnexion : les canaux redeviennent `pending` mais RESTENT en pause (le propriétaire les relance après validation)
  if v_row.status = 'disconnected' then
    update public.channels set status = 'pending' where organization_id = p_org and integration_id = p_integration and status = 'disconnected';
  end if;
  -- rotation d'une intégration active : ses canaux actifs attendent la nouvelle validation (rien ne part avec un jeton non vérifié)
  if v_row.status = 'active' then
    update public.channels set status = 'pending' where organization_id = p_org and integration_id = p_integration and status = 'active';
  end if;
  if v_row.secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.secret_ref;
  end if;
  perform private.audit_write(p_org, case when v_row.status = 'disconnected' then 'integration.reconnected' when v_row.secret_ref is null then 'integration.secret_set' else 'integration.secret_rotated' end, 'integration', p_integration, null,
    pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

create function private.set_integration_webhook_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
begin
  perform private.assert_project_manager(p_org);
  if p_secret_id is null or p_ciphertext is null or p_nonce is null or p_key_version is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider not in ('email', 'whatsapp') or v_row.status = 'disconnected' then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  begin
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'integration_webhook', p_org, p_ciphertext, p_nonce, p_key_version);
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  update public.integrations set webhook_secret_ref = p_secret_id where organization_id = p_org and id = p_integration;
  if v_row.webhook_secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.webhook_secret_ref;
  end if;
  perform private.audit_write(p_org, case when v_row.webhook_secret_ref is null then 'integration.webhook_secret_set' else 'integration.webhook_secret_rotated' end,
    'integration', p_integration, null, pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

create function public.create_provider_integration(p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer, p_gateway text default 'meta')
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_provider_integration(p_org, p_provider, p_account, p_scopes, p_secret_id, p_ciphertext, p_nonce, p_key_version, p_gateway); $$;
create function public.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void language sql security invoker set search_path = ''
as $$ select private.set_integration_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version); $$;
create function public.set_integration_webhook_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void language sql security invoker set search_path = ''
as $$ select private.set_integration_webhook_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version); $$;
revoke all on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function private.set_integration_secret(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) to authenticated;
grant execute on function private.set_integration_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
grant execute on function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
revoke all on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) from public, anon, service_role;
revoke all on function public.set_integration_secret(uuid, uuid, uuid, text, text, integer) from public, anon, service_role;
revoke all on function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) from public, anon, service_role;
grant execute on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) to authenticated;
grant execute on function public.set_integration_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
alter table private.secrets drop constraint if exists secrets_fingerprint_format;
alter table private.secrets drop column if exists fingerprint;
