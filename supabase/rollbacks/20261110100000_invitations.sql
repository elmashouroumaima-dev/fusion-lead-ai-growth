-- Retour arrière de 20261110100000_invitations.sql
-- À exécuter AVANT les retours arrière des migrations précédentes.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.
-- ATTENTION : la suppression de la table perd toutes les invitations (en attente ou historiques) ;
-- les adhésions créées par acceptation sont conservées (organization_members n'est pas modifiée).

drop function if exists public.transfer_ownership(uuid, uuid);
drop function if exists public.accept_invitation(text);
drop function if exists public.revoke_invitation(uuid, uuid);
drop function if exists public.create_invitation(uuid, text, public.app_role, text);

drop function if exists private.transfer_ownership(uuid, uuid);
drop function if exists private.accept_invitation(text);
drop function if exists private.revoke_invitation(uuid, uuid);
drop function if exists private.create_invitation(uuid, text, public.app_role, text);

drop table if exists public.invitations;
