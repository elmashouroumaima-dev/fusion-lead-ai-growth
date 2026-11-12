-- Retour arrière de 20261128100000_integrations_secrets.sql (J28).
-- ATTENTION : supprime les canaux et les secrets d'intégration (les intégrations `email` et `whatsapp` sont supprimées avec leurs secrets).

drop function if exists public.update_channel(uuid, uuid, uuid[], boolean);
drop function if exists public.create_channel(uuid, uuid, public.channel_type, text, uuid[]);
drop function if exists public.get_integration_secret(uuid, uuid);
drop function if exists public.disconnect_integration(uuid, uuid);
drop function if exists public.set_integration_secret(uuid, uuid, uuid, text, text, integer);
drop function if exists public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer);

drop function if exists private.update_channel(uuid, uuid, uuid[], boolean);
drop function if exists private.create_channel(uuid, uuid, public.channel_type, text, uuid[]);
drop function if exists private.assert_projects_in_org(uuid, uuid[]);
drop function if exists private.get_integration_secret(uuid, uuid);
drop function if exists private.disconnect_integration(uuid, uuid);
drop function if exists private.set_integration_secret(uuid, uuid, uuid, text, text, integer);
drop function if exists private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer);

drop table if exists public.channels;
drop function if exists private.audit_channels();

-- supprime les intégrations à secret (et leurs secrets), puis restaure l'ancien schéma minimal
update public.integrations set secret_ref = null where secret_ref is not null;
delete from private.secrets where purpose = 'integration';
delete from public.integrations where provider in ('email', 'whatsapp');

revoke select on table public.integrations from authenticated;
drop index if exists public.integrations_secret_idx;
drop index if exists public.integrations_provider_account_global;
alter table public.integrations drop constraint integrations_status_valid;
alter table public.integrations drop constraint integrations_provider_valid;
update public.integrations set status = 'active' where status not in ('active', 'disabled');
alter table public.integrations add constraint integrations_provider_valid check (provider in ('csv', 'internal'));
alter table public.integrations add constraint integrations_status_valid check (status in ('active', 'disabled'));
alter table public.integrations
  drop constraint integrations_secret_only_providers,
  drop constraint integrations_secret_fkey,
  drop constraint integrations_scopes_valid,
  drop column has_secret,
  drop column secret_ref,
  drop column scopes;
grant select on table public.integrations to authenticated;

drop function if exists private.is_valid_scopes(text[]);
alter table private.secrets drop constraint secrets_org_id_key;
