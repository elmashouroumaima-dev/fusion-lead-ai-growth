-- Retour arrière de 20261202100000_email_inbound.sql (J32). ATTENTION : supprime la file `inbound_unmatched` (e-mails entrants non rattachés) et les secrets de webhook
-- (les webhooks d'e-mail seront refusés tant qu'un secret n'est pas ré-enregistré). Les messages déjà rattachés et les suppressions ajoutées restent.
begin;
drop function if exists public.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean);
drop function if exists public.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz);
drop function if exists public.get_integration_webhook_secret(uuid, uuid);
drop function if exists public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer);
drop function if exists private.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean);
drop function if exists private.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz);
drop function if exists private.inbound_unmatched_add(uuid, uuid, uuid, text, text, text, text, text, timestamptz);
drop table if exists public.inbound_unmatched;

-- déconnexion de J28 (sans secret de webhook) : copie exacte de la migration 20261128100000
create or replace function private.disconnect_integration(p_org uuid, p_integration uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
begin
  perform private.assert_project_manager(p_org);
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider not in ('email', 'whatsapp') then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  if v_row.status = 'disconnected' then
    return;
  end if;
  update public.integrations set secret_ref = null, status = 'disconnected' where organization_id = p_org and id = p_integration;
  if v_row.secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.secret_ref;
  end if;
  update public.channels set status = 'disconnected', send_paused = true where organization_id = p_org and integration_id = p_integration;
  perform private.audit_write(p_org, 'integration.disconnected', 'integration', p_integration, null, pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

drop function if exists private.get_integration_webhook_secret(uuid, uuid);
drop function if exists private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer);

-- les secrets de webhook sont supprimés AVANT la colonne (clé étrangère)
create temporary table _webhook_secret_ids on commit drop as
  select organization_id, webhook_secret_ref as id from public.integrations where webhook_secret_ref is not null;
alter table public.integrations drop constraint if exists integrations_webhook_secret_distinct,
  drop constraint if exists integrations_webhook_secret_only_providers,
  drop constraint if exists integrations_webhook_secret_fkey;
drop index if exists public.integrations_webhook_secret_idx;
alter table public.integrations drop column if exists has_webhook_secret, drop column if exists webhook_secret_ref;
delete from private.secrets s using _webhook_secret_ids w where s.organization_id = w.organization_id and s.id = w.id;
commit;
