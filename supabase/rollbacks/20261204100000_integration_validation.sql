-- Retour arrière de 20261204100000_integration_validation.sql (J34). Les statuts déjà écrits restent.
begin;
drop function if exists public.integration_set_validation(uuid, uuid, boolean, text, uuid);
drop function if exists private.integration_set_validation(uuid, uuid, boolean, text, uuid);
update public.integrations set last_error = 'failed' where last_error in ('provider_auth', 'provider_account', 'provider_unavailable', 'provider_unreadable');
alter table public.integrations drop constraint integrations_error_valid;
alter table public.integrations add constraint integrations_error_valid check (last_error is null or last_error in ('file_missing', 'file_malformed', 'mapping_invalid', 'failed'));
commit;
