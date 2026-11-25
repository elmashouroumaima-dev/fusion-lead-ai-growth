-- S-12 (revue de sécurité de la Phase 3, 2026-11-24) : « le secret de webhook est différent du jeton d'envoi » n'était contrôlé que dans l'application (lecture puis écriture :
-- deux requêtes simultanées pouvaient passer toutes les deux) et la contrainte SQL `integrations_webhook_secret_distinct` compare deux identifiants de lignes toujours différents.
-- Un secret de webhook circule chez le fournisseur : s'il valait le jeton d'envoi, sa divulgation permettrait d'envoyer.
--  * `private.secrets.fingerprint` : empreinte HMAC-SHA256 du secret (clé dérivée de la clé maître, calculée par le serveur : la base ne voit jamais le secret) ; 64 caractères hexadécimaux.
--  * `create_provider_integration`, `set_integration_secret`, `set_integration_webhook_secret` : paramètre `p_fingerprint` (par défaut nul) enregistré avec le secret.
--  * déclencheur `integrations_secrets_distinct` : refuse (22023) d'enregistrer, dans la MÊME transaction et sous le verrou de la ligne, un jeton d'envoi et un secret de webhook de
--    même empreinte : atomique, quel que soit l'ordre ou la simultanéité des écritures. Les secrets sans empreinte (écrits avant cette migration) ne sont pas comparés par la base ;
--    la garde de l'application (comparaison des textes clairs) reste en place et l'empreinte est enregistrée à la prochaine écriture.
-- Les anciennes signatures sont supprimées ; les appels existants sans empreinte continuent de marcher (valeur par défaut).
-- Retour arrière : supabase/rollbacks/20261225100000_s12_secret_distinct_atomic.sql

alter table private.secrets add column fingerprint text;
alter table private.secrets add constraint secrets_fingerprint_format check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$');

drop function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text);
drop function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text);
drop function public.set_integration_secret(uuid, uuid, uuid, text, text, integer);
drop function private.set_integration_secret(uuid, uuid, uuid, text, text, integer);
drop function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer);
drop function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer);

create function private.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer,
  p_gateway text default 'meta', p_fingerprint text default null
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
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version, fingerprint)
    values (p_secret_id, 'integration', p_org, p_ciphertext, p_nonce, p_key_version, p_fingerprint);
    insert into public.integrations (organization_id, provider, status, external_account_id, scopes, secret_ref, gateway)
    values (p_org, p_provider, 'pending', p_account, v_scopes, p_secret_id, p_gateway)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

create function private.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer, p_fingerprint text default null)
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
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version, fingerprint)
    values (p_secret_id, 'integration', p_org, p_ciphertext, p_nonce, p_key_version, p_fingerprint);
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

create function private.set_integration_webhook_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer, p_fingerprint text default null)
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
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version, fingerprint)
    values (p_secret_id, 'integration_webhook', p_org, p_ciphertext, p_nonce, p_key_version, p_fingerprint);
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

-- enveloppes publiques (SECURITY INVOKER) et droits d'origine : authenticated seulement (le rôle est revérifié dans la fonction)
create function public.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer,
  p_gateway text default 'meta', p_fingerprint text default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_provider_integration(p_org, p_provider, p_account, p_scopes, p_secret_id, p_ciphertext, p_nonce, p_key_version, p_gateway, p_fingerprint); $$;
create function public.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer, p_fingerprint text default null)
returns void language sql security invoker set search_path = ''
as $$ select private.set_integration_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version, p_fingerprint); $$;
create function public.set_integration_webhook_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer, p_fingerprint text default null)
returns void language sql security invoker set search_path = ''
as $$ select private.set_integration_webhook_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version, p_fingerprint); $$;

revoke all on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function private.set_integration_secret(uuid, uuid, uuid, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text, text) to authenticated;
grant execute on function private.set_integration_secret(uuid, uuid, uuid, text, text, integer, text) to authenticated;
grant execute on function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer, text) to authenticated;
revoke all on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text, text) from public, anon, service_role;
revoke all on function public.set_integration_secret(uuid, uuid, uuid, text, text, integer, text) from public, anon, service_role;
revoke all on function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer, text) from public, anon, service_role;
grant execute on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text, text) to authenticated;
grant execute on function public.set_integration_secret(uuid, uuid, uuid, text, text, integer, text) to authenticated;
grant execute on function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer, text) to authenticated;

-- le garde-fou : jeton d'envoi et secret de webhook de MÊME empreinte refusés, dans la transaction qui écrit, sous le verrou de la ligne
create function private.integrations_secrets_distinct()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.secret_ref is not null and new.webhook_secret_ref is not null and exists (
       select 1 from private.secrets a join private.secrets b on a.fingerprint = b.fingerprint
        where a.id = new.secret_ref and b.id = new.webhook_secret_ref and a.fingerprint is not null) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.integrations_secrets_distinct() from public, anon, authenticated, service_role;
create trigger integrations_secrets_distinct
  before insert or update of secret_ref, webhook_secret_ref on public.integrations
  for each row execute function private.integrations_secrets_distinct();
