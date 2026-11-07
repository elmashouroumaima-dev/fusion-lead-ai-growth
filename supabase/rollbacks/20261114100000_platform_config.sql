-- Retour arrière de 20261114100000_platform_config.sql
-- Procédure : psql -f <ce fichier>, puis supprimer la ligne correspondante de
-- supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.
-- ATTENTION : supprime la palette globale ; exporter avant si besoin.

drop function if exists public.reset_platform_config(text);
drop function if exists public.set_platform_config(text, jsonb);
drop function if exists public.can_manage_platform_config();
drop function if exists public.get_platform_config(text);
drop function if exists private.reset_platform_config(text);
drop function if exists private.set_platform_config(text, jsonb);
drop function if exists private.is_valid_palette(jsonb);
drop function if exists private.can_manage_platform_config();
drop function if exists private.get_platform_config(text);
drop table if exists public.platform_config;
