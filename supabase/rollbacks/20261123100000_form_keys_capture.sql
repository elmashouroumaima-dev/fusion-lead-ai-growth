-- Retour arrière de 20261123100000_form_keys_capture.sql
-- ATTENTION : supprime TOUTES les clés de formulaire (les formulaires publics cessent de fonctionner). Les leads, contacts et
-- consentements déjà créés par la capture sont conservés.

drop function if exists public.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb);
drop function if exists public.form_key_origin_ok(text, text);
drop function if exists public.form_origin_allowed(text);
drop function if exists public.set_form_key_origins(uuid, uuid, text[]);
drop function if exists public.set_form_key_active(uuid, uuid, boolean);
drop function if exists public.create_form_key(uuid, uuid, text[]);

drop function if exists private.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb);
drop function if exists private.form_key_origin_ok(text, text);
drop function if exists private.form_origin_allowed(text);
drop function if exists private.set_form_key_origins(uuid, uuid, text[]);
drop function if exists private.set_form_key_active(uuid, uuid, boolean);
drop function if exists private.create_form_key(uuid, uuid, text[]);

drop table if exists public.form_keys;

drop function if exists private.audit_form_keys();
drop function if exists private.form_keys_immutable();
drop function if exists private.is_valid_form_origins(text[]);
