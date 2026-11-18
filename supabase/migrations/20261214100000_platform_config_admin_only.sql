-- Réglages de thème (palette) et de logo réservés aux administrateurs de la plateforme (ADR 016, condition levée).
-- Avant : private.can_manage_platform_config() était vrai pour tout owner / admin actif d'une organisation, donc le
-- client d'une organisation pouvait modifier la palette et le logo de TOUTE la plateforme.
-- Maintenant : vrai seulement pour un administrateur de la plateforme (private.platform_admins, d'après auth.uid(),
-- jamais user_metadata ni l'appartenance à une organisation).
-- Seule cette fonction change : private.set_platform_config et private.reset_platform_config l'appellent déjà en
-- premier (avant toute validation), donc la garde de la base suit ; les wrappers publics, leurs droits (EXECUTE
-- authenticated) et les erreurs (42501 forbidden, 22023 validation_failed) sont inchangés. Aucune donnée n'est touchée.
-- Retour arrière : supabase/rollbacks/20261214100000_platform_config_admin_only.sql

create or replace function private.can_manage_platform_config()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin();
$$;

comment on function private.can_manage_platform_config() is
  'Peut modifier / réinitialiser la palette et le logo globaux : administrateur de la plateforme seulement (ADR 016).';
