-- Activation des canaux (écran de canaux ; ADR 007 E4 : « un canal ne passe `active` qu'après la validation par le fournisseur »).
-- Avant : `create_channel` créait un canal « pending » et AUCUNE fonction ne le passait « active » (seuls les tests le faisaient en SQL) : un canal créé par l'application
-- ne pouvait pas envoyer (`channel_inactive`). Maintenant, un canal est « active » si et seulement si son intégration est « active » :
--  * `create_channel` : « active » sur une intégration déjà validée, « pending » sinon ;
--  * `integration_set_validation` (service_role seulement, inchangée par ailleurs) : réussite = canaux « pending » -> « active » ; échec = canaux « active » -> « pending ».
-- La pause (`send_paused`) n'est jamais touchée par la validation : une reconnexion remet les canaux en pause et seul le propriétaire les relance.
-- Aucun autre chemin vers « active » (ni `update_channel`, ni écriture directe). Seules ces deux fonctions changent ; aucune donnée n'est touchée.
-- Retour arrière : supabase/rollbacks/20261213100000_channels_activation.sql

create or replace function private.create_channel(p_org uuid, p_integration uuid, p_type public.channel_type, p_sender text, p_scope uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
  v_id uuid;
  v_scope uuid[] := coalesce(p_scope, '{}');
begin
  perform private.assert_project_manager(p_org);
  if p_type is null or not private.is_safe_text(p_sender, 1, 200) or p_sender <> pg_catalog.btrim(p_sender)
     or (p_type = 'email' and p_sender !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     or (p_type = 'whatsapp' and p_sender !~ '^\+[1-9][0-9]{6,14}$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_projects_in_org(p_org, v_scope);
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider::text is distinct from p_type::text or v_row.status = 'disconnected' then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  if (select count(*) from public.channels c where c.organization_id = p_org) >= 50 then
    raise exception 'too_many_channels' using errcode = 'P0001';
  end if;
  begin
    -- un canal est « active » si et seulement si son intégration l'est déjà (validée par le serveur) ; sinon « pending » jusqu'à la validation
    insert into public.channels (organization_id, type, integration_id, sender_identity, project_scope, status)
    values (p_org, p_type, p_integration, p_sender, v_scope, case when v_row.status = 'active' then 'active' else 'pending' end)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

create or replace function private.integration_set_validation(p_org uuid, p_integration uuid, p_ok boolean, p_code text, p_actor uuid)
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
