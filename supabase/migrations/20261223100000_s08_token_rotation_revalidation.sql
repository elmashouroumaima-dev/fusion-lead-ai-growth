-- S-08 (revue de sécurité de la Phase 3, 2026-11-24) : rotation d'un jeton et validation.
--  * `set_integration_secret` : remplacer le jeton d'une intégration `active` la laissait `active` (et ses canaux `active`) alors que le nouveau jeton n'avait jamais été
--    essayé auprès du fournisseur (faute de frappe, jeton d'un autre compte : l'envoi partait avec un jeton faux, ADR 007 E4 violée). Désormais l'intégration repasse en
--    `pending` et ses canaux actifs aussi ; la validation (« Vérifier la connexion ») les réactive. Une intégration désactivée reste désactivée.
--  * `integration_set_validation` : nouveau paramètre `p_secret_id` (le secret réellement essayé, renvoyé par `get_integration_secret`). Si le secret courant n'est plus
--    celui-là (rotation pendant l'appel au fournisseur), `stale_validation` : un ancien jeton valide ne peut plus activer un nouveau jeton jamais testé.
--    Signature élargie (l'ancienne est supprimée ; les appels à cinq arguments marchent encore grâce à la valeur par défaut, sans contrôle).
-- Retour arrière : supabase/rollbacks/20261223100000_s08_token_rotation_revalidation.sql

create or replace function private.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
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

drop function public.integration_set_validation(uuid, uuid, boolean, text, uuid);
drop function private.integration_set_validation(uuid, uuid, boolean, text, uuid);
create function private.integration_set_validation(p_org uuid, p_integration uuid, p_ok boolean, p_code text, p_actor uuid, p_secret_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
  v_status text;
begin
  if p_org is null or p_integration is null or p_ok is null or p_actor is null
     or (p_ok and p_code is not null)
     or (not p_ok and (p_code is null or p_code not in ('provider_auth', 'provider_account', 'provider_unavailable', 'provider_unreadable'))) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.status not in ('pending', 'active', 'error') or v_row.secret_ref is null then
    raise exception 'integration_not_validatable' using errcode = 'P0001';
  end if;
  -- S-08 : le résultat n'est valable que pour le secret qui a été ESSAYÉ auprès du fournisseur. Si le jeton a été remplacé pendant l'appel (jusqu'à 10 s), ce
  -- résultat ne dit rien du nouveau jeton : refus `stale_validation` (rien n'est écrit) et le serveur revalide. `p_secret_id` est obligatoire pour l'application
  -- (valeur nulle réservée aux appels d'essai de la base).
  if p_secret_id is not null and v_row.secret_ref is distinct from p_secret_id then
    raise exception 'stale_validation' using errcode = 'P0001';
  end if;
  -- WhatsApp : sans le secret de l'app, tous les événements reçus seraient refusés : on n'affiche pas « vérifié » pour une intégration qui ne recevra rien
  if p_ok and v_row.provider = 'whatsapp' and v_row.webhook_secret_ref is null then
    raise exception 'integration_not_validatable' using errcode = 'P0001';
  end if;
  v_status := case when p_ok then 'active' else 'error' end;
  update public.integrations set status = v_status, last_error = case when p_ok then null else p_code end
   where organization_id = p_org and id = p_integration;
  -- activation des canaux (ADR 007 E4) : une validation réussie active les canaux « pending » de cette intégration (la pause n'est pas touchée : après une
  -- reconnexion, ils restent en pause jusqu'à ce que le propriétaire les relance) ; un échec remet les canaux actifs « pending » (rien ne part tant que le
  -- fournisseur n'a pas de nouveau validé). Les canaux « disconnected » ne changent pas.
  if p_ok then
    update public.channels set status = 'active' where organization_id = p_org and integration_id = p_integration and status = 'pending';
  else
    update public.channels set status = 'pending' where organization_id = p_org and integration_id = p_integration and status = 'active';
  end if;
  perform private.audit_write(p_org, case when p_ok then 'integration.validated' else 'integration.validation_failed' end, 'integration', p_integration, null,
    case when p_ok then pg_catalog.jsonb_build_object('provider', v_row.provider, 'actor', p_actor)
         else pg_catalog.jsonb_build_object('provider', v_row.provider, 'code', p_code, 'actor', p_actor) end);
  return v_status;
end;
$$;
revoke all on function private.integration_set_validation(uuid, uuid, boolean, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.integration_set_validation(uuid, uuid, boolean, text, uuid, uuid) to service_role;
create function public.integration_set_validation(p_org uuid, p_integration uuid, p_ok boolean, p_code text, p_actor uuid, p_secret_id uuid default null)
returns text language sql security invoker set search_path = ''
as $$ select private.integration_set_validation(p_org, p_integration, p_ok, p_code, p_actor, p_secret_id); $$;
revoke all on function public.integration_set_validation(uuid, uuid, boolean, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.integration_set_validation(uuid, uuid, boolean, text, uuid, uuid) to service_role;
