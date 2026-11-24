-- S-03 (revue de sécurité de la Phase 3, 2026-11-24) : le formulaire public enregistre un consentement SANS vérifier que l'auteur possède l'adresse ou le numéro
-- (la spec §9.1 exige d'enregistrer le consentement dans la transaction de capture, et §9.2 / §85 interdisent tout envoi externe automatique : pas d'e-mail de
-- confirmation automatique). Un tiers connaissant la clé (publique) du formulaire pouvait donc donner un consentement marketing « actif » pour l'adresse d'un autre.
-- Désormais un consentement dont la source est `web_form` n'est EFFECTIF pour l'envoi que s'il est PROUVÉ :
--   * par un message ENTRANT du contact sur ce canal, postérieur à la saisie (l'expéditeur est authentifié par le fournisseur : DMARC / SPF / DKIM pour l'e-mail,
--     numéro vérifié par WhatsApp), ou
--   * par un consentement enregistré par un humain habilité (« Enregistrer un consentement », source manuelle), qui est effectif tel quel.
-- Les autres sources (manuelle, import, API) sont effectives comme avant. Les réponses (finalité `reply`) ne dépendent pas de cette règle (consentement conversationnel).
--   * `private.consent_is_effective(org, contact, canal, finalité)` : la règle, en un seul endroit (à réutiliser par les segments de campagne, J43) ;
--   * `message_send_claim` : version de 20261221100000 avec ce seul changement (le consentement « actif » passe par cette fonction).
-- La capture publique et l'écran des consentements sont inchangés : le consentement reste enregistré (preuve du texte, de la version, de l'adresse IP).
-- Retour arrière : supabase/rollbacks/20261222100000_s03_form_consent_needs_proof.sql

create function private.consent_is_effective(p_org uuid, p_contact uuid, p_channel public.channel_type, p_purpose text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.consent_events ce
     where ce.organization_id = p_org and ce.contact_id = p_contact and ce.channel = p_channel
       and ce.purpose = p_purpose and ce.revoked_at is null
       and (
         ce.source <> 'web_form'
         -- consentement du formulaire public : prouvé par un message entrant du contact sur ce canal, postérieur à la saisie
         or exists (
           select 1
             from public.messages im
             join public.conversations cv on cv.organization_id = im.organization_id and cv.id = im.conversation_id
             join public.channels ch on ch.organization_id = im.organization_id and ch.id = im.channel_id
            where im.organization_id = p_org and cv.contact_id = p_contact and im.direction = 'inbound'
              and ch.type = p_channel and im.received_at >= ce.captured_at
         )
         -- ou par un consentement humain (hors formulaire) actif pour la même finalité
         or exists (
           select 1 from public.consent_events hu
            where hu.organization_id = p_org and hu.contact_id = p_contact and hu.channel = p_channel
              and hu.purpose = p_purpose and hu.revoked_at is null and hu.source <> 'web_form'
         )
       )
  );
$$;
revoke all on function private.consent_is_effective(uuid, uuid, public.channel_type, text) from public, anon, authenticated, service_role;

create or replace function private.message_send_claim(p_org uuid, p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_conv public.conversations;
  v_contact public.contacts;
  v_channel public.channels;
  v_integration_status text;
  v_org_paused boolean;
  v_consent boolean;
  v_suppressed boolean;
  v_recent integer;
  v_org_status public.org_status;
  v_sub_status public.subscription_status;
  v_approver_ok boolean;
  v_recipient text;
  v_window boolean;
  v_tpl public.message_templates;
  v_account text;
  v_gateway text;
begin
  select * into v_m from public.messages m where m.organization_id = p_org and m.id = p_message for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  if v_m.direction <> 'outbound' or v_m.status <> 'queued' then
    return pg_catalog.jsonb_build_object('status', 'not_queued');
  end if;
  if v_m.send_claimed_at is not null then
    return pg_catalog.jsonb_build_object('status', case when v_m.send_claimed_at > pg_catalog.now() - interval '5 minutes' then 'in_progress' else 'ambiguous' end);
  end if;
  select * into v_conv from public.conversations c where c.organization_id = p_org and c.id = v_m.conversation_id;
  select * into v_contact from public.contacts ct where ct.organization_id = p_org and ct.id = v_conv.contact_id;
  select * into v_channel from public.channels ch where ch.organization_id = p_org and ch.id = v_m.channel_id;
  select i.status, i.external_account_id, i.gateway into v_integration_status, v_account, v_gateway from public.integrations i where i.organization_id = p_org and i.id = v_channel.integration_id;
  v_recipient := case when v_channel.type = 'whatsapp' then v_contact.phone_e164 else v_contact.email_normalized end;
  -- fenêtre de conversation WhatsApp : ouverte si le contact a écrit il y a moins de 24 heures dans ce fil
  v_window := exists (select 1 from public.messages x where x.organization_id = p_org and x.conversation_id = v_m.conversation_id and x.direction = 'inbound' and x.received_at > pg_catalog.now() - interval '24 hours');
  if v_m.template_id is not null then
    select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = v_m.template_id;
  end if;
  select coalesce((o.settings ->> 'send_paused') = 'true', false), o.status into v_org_paused, v_org_status from public.organizations o where o.id = p_org;
  select sub.status into v_sub_status from public.subscriptions sub where sub.organization_id = p_org;
  -- l'approbation est revalidée : l'approbateur doit être, MAINTENANT, owner ou admin actif de l'entreprise
  -- (J38) ... ou, pour une RÉPONSE (finalité « reply »), le commercial qui l'a approuvée en l'envoyant, tant qu'il est encore le responsable du fil
  v_approver_ok := v_m.approved_by is not null and exists (
    select 1 from public.organization_members om
     where om.organization_id = p_org and om.user_id = v_m.approved_by and om.status = 'active'
       and (om.role in ('company_owner', 'company_admin')
            or (om.role = 'sales_agent' and v_m.approved_purpose = 'reply' and v_conv.assignee_id = v_m.approved_by))
  );
  -- (J38) une RÉPONSE (finalité « reply ») est couverte par un message entrant du contact dans CE fil depuis 7 jours au plus (échange
  -- à son initiative) ; ne plus contacter, suppression, entreprise et canal en pause restent contrôlés plus bas. Toute autre finalité
  -- exige toujours un consentement actif enregistré.
  v_consent := v_m.approved_purpose is not null and (
    -- S-03 : un consentement saisi par le formulaire public (adresse non vérifiée) ne compte qu'une fois PROUVÉ (voir private.consent_is_effective)
    private.consent_is_effective(p_org, v_contact.id, v_channel.type, v_m.approved_purpose)
    or (v_m.approved_purpose = 'reply' and exists (
      select 1 from public.messages im
       where im.organization_id = p_org and im.conversation_id = v_m.conversation_id and im.direction = 'inbound'
         and im.received_at >= pg_catalog.now() - interval '7 days'
         -- S-04 : une RÉVOCATION postérieure à ce message entrant, sans aucun consentement actif restant sur ce canal, retire la couverture conversationnelle
         -- (le contact qui écrit « arrêtez » puis dont on révoque le consentement ne doit pas recevoir de réponse le lendemain)
         and not (
           exists (
             select 1 from public.consent_events rv
              where rv.organization_id = p_org and rv.contact_id = v_contact.id and rv.channel = v_channel.type
                and rv.revoked_at is not null and rv.revoked_at > im.received_at
           )
           and not exists (
             select 1 from public.consent_events act
              where act.organization_id = p_org and act.contact_id = v_contact.id and act.channel = v_channel.type and act.revoked_at is null
           )
         )
    ))
  );
  v_suppressed := v_recipient is not null and exists (
    select 1 from public.suppressions s
     where s.organization_id = p_org and s.channel = v_channel.type and s.value_normalized = v_recipient
  );
  -- compteur de débit sérialisé par canal (deux workers ne lisent pas le même nombre), limité aux envois réels ou en cours
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('send-rate:' || p_org::text || ':' || v_channel.type::text, 0));
  select pg_catalog.count(*)::integer into v_recent from public.messages x
   join public.channels xc on xc.organization_id = x.organization_id and xc.id = x.channel_id
   where x.organization_id = p_org and xc.type = v_channel.type and x.direction = 'outbound'
     and ((x.status in ('accepted', 'sent', 'delivered', 'read') and x.sent_at > pg_catalog.now() - interval '1 hour')
          or (x.status = 'queued' and x.send_claimed_at > pg_catalog.now() - interval '1 hour'));
  update public.messages set send_claimed_at = pg_catalog.now() where organization_id = p_org and id = p_message;
  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'message', pg_catalog.jsonb_build_object(
      'body', v_m.body, 'approved', v_m.approved_by is not null, 'purpose', v_m.approved_purpose,
      'approver_valid', v_approver_ok,
      'approval_age_seconds', case when v_m.approved_at is null then null else pg_catalog.floor(extract(epoch from pg_catalog.now() - v_m.approved_at))::bigint end,
      'recipient_unchanged', v_m.approved_recipient is not null and v_m.approved_recipient = v_recipient
    ),
    'organization_active', v_org_status = 'active' and v_sub_status is not null and v_sub_status not in ('suspended', 'cancelled'),
    'contact', pg_catalog.jsonb_build_object('email', v_contact.email_normalized, 'phone', v_contact.phone_e164, 'do_not_contact', v_contact.do_not_contact),
    'window_open', v_window,
    'template', case when v_tpl.id is null then null else pg_catalog.jsonb_build_object(
      'status', case when exists (select 1 from public.message_templates nv where nv.organization_id = p_org and nv.channel_id = v_tpl.channel_id and nv.name = v_tpl.name and nv.language = v_tpl.language and nv.version > v_tpl.version) then 'superseded' else v_tpl.status end, 'text', v_m.template_text, 'name', v_tpl.name, 'language', v_tpl.language, 'category', v_tpl.category, 'version', v_tpl.version, 'variables', coalesce(v_m.template_variables, '[]'::jsonb)) end,
    'channel', pg_catalog.jsonb_build_object(
      'type', v_channel.type, 'status', v_channel.status, 'send_paused', v_channel.send_paused,
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status, 'account', v_account, 'gateway', v_gateway
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;
