-- Retour arrière de 20261126100000_crm_search_export.sql
-- Supprime la recherche de leads et l'audit des exports (les écrans de J24 cessent de fonctionner). Les entrées d'audit
-- `export.created` déjà écrites sont conservées (journal immuable).

drop function if exists public.log_export(uuid, text, integer, jsonb);
drop function if exists public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer);
drop function if exists private.log_export(uuid, text, integer, jsonb);
drop function if exists private.like_escape(text);

drop index if exists public.leads_org_created_idx;
drop index if exists public.contacts_phone_trgm_idx;
drop index if exists public.contacts_email_trgm_idx;
drop index if exists public.contacts_name_trgm_idx;
-- L'extension `pg_trgm` est laissée en place (d'autres index pourraient l'utiliser) : `drop extension pg_trgm` si elle est inutile.
