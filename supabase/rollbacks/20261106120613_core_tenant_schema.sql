-- Retour arrière de 20261106120613_core_tenant_schema.sql (DESTRUCTIF : supprime les données
-- des tables du noyau). À exécuter APRÈS le retour arrière de 20261106120616_*.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.

drop table if exists public.usage_counters;
drop table if exists public.subscriptions;
drop table if exists public.organization_members;
drop table if exists public.organizations;
drop table if exists public.plans;

drop function if exists private.prevent_organization_id_change();
drop function if exists private.set_updated_at();

drop type if exists public.subscription_status;
drop type if exists public.org_status;
drop type if exists public.member_status;
drop type if exists public.app_role;

-- Échoue (volontairement) si le schéma contient encore d'autres objets.
drop schema if exists private;
