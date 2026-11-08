-- Retour arrière de 20261120100000_contacts_consent.sql
-- ATTENTION : supprime TOUS les contacts et l'historique de consentement (preuves comprises). Exporter avant si nécessaire.

drop function if exists public.set_do_not_contact(uuid, uuid, boolean);
drop function if exists public.revoke_consent(uuid, uuid, public.channel_type, text, boolean);
drop function if exists public.record_consent(uuid, uuid, public.channel_type, text, text, jsonb);
drop function if exists public.update_contact(uuid, uuid, text, text, text, text, text, text, text, text, jsonb);
drop function if exists public.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb);

drop function if exists private.set_do_not_contact(uuid, uuid, boolean);
drop function if exists private.revoke_consent(uuid, uuid, public.channel_type, text, boolean);
drop function if exists private.record_consent(uuid, uuid, public.channel_type, text, text, jsonb);
drop function if exists private.update_contact(uuid, uuid, text, text, text, text, text, text, text, text, jsonb);
drop function if exists private.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb);
drop function if exists private.refresh_consent_status(uuid, uuid);
drop function if exists private.assert_contact_manager(uuid);

drop table if exists public.consent_events;
drop table if exists public.contacts;

drop function if exists private.audit_consent_events();
drop function if exists private.audit_contacts();
drop function if exists private.consent_events_guard();
drop function if exists private.is_valid_consent_proof(jsonb);
drop function if exists private.is_valid_contact_attributes(jsonb);
drop function if exists private.is_valid_contact_email(text, text);

drop type if exists public.consent_status;
drop type if exists public.channel_type;

-- Quota « contacts » : retrouve le comportement du J16 (0) en relançant le corps de private.current_stock_usage de
-- 20261118100000_projects_products.sql (create or replace).
