-- Désinscription WhatsApp annoncée par Kapso (événement `whatsapp.contact.marketing_preference_changed`, ADR 017) : le contact a arrêté les messages
-- marketing chez WhatsApp. Décision de la responsable technique (2026-11-21) : « stopped » = désinscription COMPLÈTE, comme un mot d'arrêt tapé par le contact
-- (consentements WhatsApp révoqués, numéro supprimé, envois en file annulés ; `do_not_contact` inchangé).
--  * `whatsapp_marketing_preference_apply(p_org, p_integration, p_from, p_status)` (service_role seulement) : `stopped` applique `whatsapp_opt_out` au contact du
--    numéro (ou la seule suppression du numéro s'il n'y a pas de contact) ; `resumed` NE RÉACTIVE RIEN (aucun consentement sans preuve : le réabonnement reste
--    une action humaine auditée) et renvoie `ignored`. Rejouable sans effet (même résultat qu'un STOP répété).
-- Retour arrière : supabase/rollbacks/20261217100000_whatsapp_marketing_optout.sql

create function private.whatsapp_marketing_preference_apply(p_org uuid, p_integration uuid, p_from text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  if p_org is null or p_integration is null or p_from is null or p_from !~ '^\+[0-9]{5,20}$' or p_status is null or p_status not in ('stopped', 'resumed') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'whatsapp' and i.status in ('pending', 'active', 'error');
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if p_status = 'resumed' then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'resumed_not_applied');
  end if;
  select ct.id into v_contact from public.contacts ct where ct.organization_id = p_org and ct.phone_e164 = p_from;
  if v_contact is null then
    perform private.whatsapp_opt_out_phone(p_org, p_from);
    return pg_catalog.jsonb_build_object('outcome', 'applied', 'reason', 'no_contact');
  end if;
  perform private.whatsapp_opt_out(p_org, v_contact, null, p_from, null);
  return pg_catalog.jsonb_build_object('outcome', 'applied');
end;
$$;

create function public.whatsapp_marketing_preference_apply(p_org uuid, p_integration uuid, p_from text, p_status text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.whatsapp_marketing_preference_apply(p_org, p_integration, p_from, p_status); $$;

revoke all on function private.whatsapp_marketing_preference_apply(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.whatsapp_marketing_preference_apply(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function private.whatsapp_marketing_preference_apply(uuid, uuid, text, text) to service_role;
grant execute on function public.whatsapp_marketing_preference_apply(uuid, uuid, text, text) to service_role;
