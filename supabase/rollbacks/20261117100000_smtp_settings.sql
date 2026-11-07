-- Retour arrière de 20261117100000_smtp_settings.sql
-- ATTENTION : supprime la configuration SMTP et tous les secrets chiffrés (private.secrets) ; exporter avant si besoin.

drop function if exists public.get_smtp_delivery();
drop function if exists public.get_smtp_settings();
drop function if exists public.reset_smtp_settings();
drop function if exists public.set_smtp_settings(jsonb, uuid, text, text, integer);
drop function if exists private.get_smtp_delivery();
drop function if exists private.get_smtp_settings();
drop function if exists private.reset_smtp_settings();
drop function if exists private.set_smtp_settings(jsonb, uuid, text, text, integer);
drop function if exists private.is_valid_smtp_settings(jsonb);

delete from public.platform_config where key = 'smtp.settings';
alter table public.platform_config drop constraint platform_config_key_allowed;
alter table public.platform_config
  add constraint platform_config_key_allowed check (key in ('appearance.palette', 'appearance.logo'));

drop table if exists private.secrets;
