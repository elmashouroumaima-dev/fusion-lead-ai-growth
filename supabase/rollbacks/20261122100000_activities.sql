-- Retour arrière de 20261122100000_activities.sql
-- ATTENTION : supprime TOUTE la chronologie des leads (notes, appels, tâches, journal des changements). Exporter avant si besoin.

drop function if exists public.complete_task(uuid, uuid, boolean);
drop function if exists public.update_task(uuid, uuid, jsonb, timestamptz, uuid);
drop function if exists public.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid);

drop function if exists private.lock_activity_for_write(uuid, uuid);

drop trigger if exists log_deal_activities on public.deals;
drop trigger if exists log_lead_activities on public.leads;
drop table if exists public.activities;

drop function if exists private.complete_task(uuid, uuid, boolean);
drop function if exists private.update_task(uuid, uuid, jsonb, timestamptz, uuid);
drop function if exists private.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid);
drop function if exists private.resolve_task_owner(uuid, uuid, uuid);
drop function if exists private.audit_activities();
drop function if exists private.log_deal_activities();
drop function if exists private.log_lead_activities();
drop function if exists private.activities_guard();
drop function if exists private.is_valid_activity_metadata(public.activity_type, jsonb);

drop type if exists public.activity_type;
