-- Retour arrière de 20261219100000_email_gateway_resend.sql : les intégrations Resend n'ont plus de sens sans la valeur ; elles sont supprimées
-- avec leurs canaux et leurs secrets (à ne faire qu'en connaissance de cause, jamais sur une base qui contient de vraies données).
delete from public.channels where integration_id in (select id from public.integrations where gateway = 'resend');
delete from private.secrets where id in (select secret_ref from public.integrations where gateway = 'resend')
   or id in (select webhook_secret_ref from public.integrations where gateway = 'resend');
set session_replication_role = replica;
delete from public.integrations where gateway = 'resend';
set session_replication_role = origin;

alter table public.integrations drop constraint integrations_gateway_provider_match;
alter table public.integrations drop constraint integrations_gateway_valid;
alter table public.integrations add constraint integrations_gateway_valid check (gateway in ('meta', 'kapso'));
alter table public.integrations add constraint integrations_gateway_whatsapp_only check (gateway = 'meta' or provider = 'whatsapp');

create or replace function private.create_provider_integration(
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
     or p_gateway is null or p_gateway not in ('meta', 'kapso') or (p_gateway = 'kapso' and p_provider <> 'whatsapp')
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
