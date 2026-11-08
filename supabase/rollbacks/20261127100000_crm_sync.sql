-- Retour arrière de 20261127100000_crm_sync.sql
-- ATTENTION : supprime TOUTES les intégrations et TOUS les mappings de champs (la synchro CRM cesse de fonctionner). Les contacts créés ou
-- mis à jour par une synchro sont conservés (avec leur `external_source` / `external_id`). Les jobs `crm_sync` en attente échoueront
-- (type inconnu du worker précédent).

drop function if exists public.crm_sync_fail(uuid, uuid, text);
drop function if exists public.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb);
drop function if exists public.crm_sync_audit_conflict(uuid, uuid, uuid, jsonb);
drop function if exists public.crm_sync_update(uuid, uuid, text, text, jsonb);
drop function if exists public.crm_sync_create(uuid, text, text, text, text, text, text, text, text);
drop function if exists public.crm_sync_find(uuid, text, text, text, text);
drop function if exists public.crm_sync_start(uuid, uuid, uuid);
drop function if exists public.crm_sync_status(uuid, uuid);
drop function if exists public.retry_crm_sync(uuid, uuid);
drop function if exists public.request_crm_sync(uuid, uuid, uuid);
drop function if exists public.save_crm_mappings(uuid, uuid, jsonb);
drop function if exists public.create_integration(uuid, text, text);

drop function if exists private.crm_sync_fail(uuid, uuid, text);
drop function if exists private.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb);
drop function if exists private.crm_sync_audit_conflict(uuid, uuid, uuid, jsonb);
drop function if exists private.crm_sync_update(uuid, uuid, text, text, jsonb);
drop function if exists private.crm_sync_create(uuid, text, text, text, text, text, text, text, text);
drop function if exists private.crm_sync_find(uuid, text, text, text, text);
drop function if exists private.crm_sync_start(uuid, uuid, uuid);
drop function if exists private.crm_sync_status(uuid, uuid);
drop function if exists private.retry_crm_sync(uuid, uuid);
drop function if exists private.request_crm_sync(uuid, uuid, uuid);
drop function if exists private.save_crm_mappings(uuid, uuid, jsonb);
drop function if exists private.create_integration(uuid, text, text);

-- les lots consommés par une synchro (statut `synced`) redeviennent « annulés » avant de retirer le statut
update public.import_batches set status = 'cancelled' where status = 'synced';
alter table public.import_batches drop constraint import_batches_status_valid;
alter table public.import_batches add constraint import_batches_status_valid check (status in ('uploaded', 'queued', 'running', 'done', 'failed', 'cancelled'));
alter table public.import_batches drop constraint import_batches_confirmed_valid;
alter table public.import_batches add constraint import_batches_confirmed_valid check (status in ('uploaded', 'cancelled') or mapping is not null);

drop table if exists public.crm_field_mappings;
drop table if exists public.integrations;
drop function if exists private.audit_integrations();
