-- Retour arrière de 20261213100000_channels_activation.sql
-- Remet `create_channel` (canal toujours « pending ») et `integration_set_validation` (canaux inchangés) dans leur version d'origine. Les canaux déjà « active » le restent.

` restent uniques par entreprise ;
--  * `channels` (ADR 007 E4) : `type`, `integration_id` (clé étrangère composite), `sender_identity`, `status`, `project_scope`, `send_paused` ;
--  * audit : ids et noms de champs seulement, jamais de secret, de chiffré ni d'identité d'expéditeur ;
--  * (revue adverse) une intégration déconnectée se RECONNECTE en remplaçant son jeton (statut `pending`, canaux `pending` mais en pause) :
--    le compte reste attaché à son entreprise, aucune voie sans issue ; `get_integration_secret` ne sert que les statuts pending, active, error ;
--    l'identité d'un canal a un format imposé (e-mail ou E.164) ; la PREUVE de propriété de l'expéditeur viendra de la validation par le
--    fournisseur (J31 e-mail, J34 WhatsApp) : un canal ne passe à `active` qu'à ce moment-là.

-- ---------------------------------------------------------------------------
-- private.secrets : unicité (organization_id, id) pour la clé étrangère composite
-- ---------------------------------------------------------------------------
alter table private.secrets add constraint secrets_org_id_key unique (organization_id, id);

-- ---------------------------------------------------------------------------
-- integrations : portée, référence du secret
-- ---------------------------------------------------------------------------
create function private.is_valid_scopes(p_scopes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_scopes is not null
    and coalesce(pg_catalog.cardinality(p_scopes), 0) <= 50
    and not exists (select 1 from pg_catalog.unnest(p_scopes) as s where s is null or s !~ '^[A-Za-z0-9._:/-]{1,100}$')
    and (select pg_catalog.count(distinct s) from pg_catalog.unnest(p_scopes) as s) = coalesce(pg_catalog.cardinality(p_scopes), 0);
$$;

alter table public.integrations
  add column scopes text[] not null default '{}',
  add column secret_ref 

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
  perform private.audit_write(p_org, case when p_ok then 'integration.validated' else 'integration.validation_failed' end, 'integration', p_integration, null,
    case when p_ok then pg_catalog.jsonb_build_object('provider', v_row.provider, 'actor', p_actor)
         else pg_catalog.jsonb_build_object('provider', v_row.provider, 'code', p_code, 'actor', p_actor) end);
  return v_status;
end;
$$;
