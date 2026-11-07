-- Retour arrière de 20261106140000_organizations_create.sql
-- À exécuter AVANT les retours arrière des migrations précédentes.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.
-- ATTENTION : la suppression des colonnes created_by / creation_key perd la traçabilité du créateur
-- et l'idempotence des créations déjà effectuées (les organisations elles-mêmes sont conservées).

drop function if exists public.create_organization(text, text, text, text);
drop function if exists private.create_organization(text, text, text, text);

drop index if exists public.organizations_created_by_creation_key_key;
alter table public.organizations drop constraint if exists organizations_creation_key_length;
alter table public.organizations drop column if exists creation_key;
alter table public.organizations drop column if exists created_by;
