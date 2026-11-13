-- Retour arrière de 20261203100000_unsubscribe.sql (J33). Les données écrites (suppressions « unsubscribe », consentements révoqués) restent.
begin;
drop function if exists public.unsubscribe_apply(uuid, uuid);
drop function if exists private.unsubscribe_apply(uuid, uuid);
commit;
