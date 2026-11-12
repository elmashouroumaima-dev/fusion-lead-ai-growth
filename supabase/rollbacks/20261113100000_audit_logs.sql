-- Retour arrière de 20261113100000_audit_logs.sql
-- À exécuter AVANT les retours arrière des migrations précédentes.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.
-- ATTENTION : SUPPRIME DÉFINITIVEMENT le journal d'audit (table audit_logs). À n'exécuter qu'en
-- développement, ou après export validé du journal en production. DROP TABLE n'est pas bloqué par les
-- triggers d'immuabilité (réservé au propriétaire de la table).

drop trigger if exists audit_invitations on public.invitations;
drop trigger if exists audit_organization_members on public.organization_members;
drop trigger if exists audit_organizations on public.organizations;

drop function if exists private.audit_invitations();
drop function if exists private.audit_organization_members();
drop function if exists private.audit_organizations();
drop function if exists private.audit_write(uuid, text, text, uuid, jsonb, jsonb);
drop function if exists private.mask_email(text);
drop function if exists private.audit_redact(jsonb);
drop function if exists private.audit_redact_value(jsonb, integer, text);

drop table if exists public.audit_logs;
drop function if exists private.audit_logs_immutable();
