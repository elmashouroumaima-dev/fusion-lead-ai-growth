-- Retour arrière de 20261129100000_webhook_events.sql (J29). ATTENTION : supprime tous les événements webhook enregistrés.
drop function if exists public.webhook_finish(uuid, uuid, text, text);
drop function if exists public.webhook_start(uuid, uuid);
drop function if exists public.webhook_record_rejection(uuid, uuid, text);
drop function if exists public.webhook_record(uuid, uuid, text, text, jsonb);
drop function if exists public.webhook_resolve_integration(text, text);
drop function if exists private.webhook_finish(uuid, uuid, text, text);
drop function if exists private.webhook_start(uuid, uuid);
drop function if exists private.webhook_record_rejection(uuid, uuid, text);
drop function if exists private.webhook_record(uuid, uuid, text, text, jsonb);
drop function if exists private.webhook_resolve_integration(text, text);
delete from public.jobs where kind = 'process_webhook';
drop table if exists public.webhook_events;
