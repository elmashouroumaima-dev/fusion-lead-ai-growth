-- Retour arrière de 20261210100000_replies_lock.sql
-- Supprime les fonctions de réponse et de verrou et rétablit `message_send_claim` dans sa version du J31 (approbateur owner ou admin
-- seulement, consentement enregistré exigé pour toute finalité). Les messages déjà approuvés avec la finalité « reply » par un commercial
-- ne passeraient plus la chaîne d'envoi (ils échouent en `approval_invalid` ou `no_consent`) ; les entrées d'audit sont conservées.
-- ⚠ Si la migration WhatsApp (J36) est appliquée, rétablir à la place SA version de `message_send_claim` (non couverte ici).

drop function if exists public.conversation_reply(uuid, uuid, text, text);
drop function if exists public.conversation_lock_acquire(uuid, uuid);
drop function if exists public.conversation_lock_status(uuid, uuid);
drop function if exists public.conversation_lock_release(uuid, uuid);
drop function if exists public.conversation_take_over(uuid, uuid);
drop function if exists public.conversation_ai_claim(uuid, uuid);
drop function if exists public.conversation_ai_release(uuid, uuid);
drop function if exists private.conversation_reply(uuid, uuid, text, text);
drop function if exists private.conversation_lock_acquire(uuid, uuid);
drop function if exists private.conversation_lock_status(uuid, uuid);
drop function if exists private.conversation_lock_release(uuid, uuid);
drop function if exists private.conversation_take_over(uuid, uuid);
drop function if exists private.conversation_ai_claim(uuid, uuid);
drop function if exists private.conversation_ai_release(uuid, uuid);
drop function if exists private.can_reply_conversation(uuid, uuid);

-- Version J31 de message_send_claim (copie de supabase/migrations/20261201100000_send_chain.sql) :
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
  select i.status into v_integration_status from public.integrations i where i.organization_id = p_org and i.id = v_channel.integration_id;
  select coalesce((o.settings ->> 'send_paused') = 'true', false), o.status into v_org_paused, v_org_status from public.organizations o where o.id = p_org;
  select sub.status into v_sub_status from public.subscriptions sub where sub.organization_id = p_org;
  -- l'approbation est revalidée : l'approbateur doit être, MAINTENANT, owner ou admin actif de l'entreprise
  v_approver_ok := v_m.approved_by is not null and exists (
    select 1 from public.organization_members om
     where om.organization_id = p_org and om.user_id = v_m.approved_by and om.status = 'active' and om.role in ('company_owner', 'company_admin')
  );
  v_consent := v_m.approved_purpose is not null and exists (
    select 1 from public.consent_events ce
     where ce.organization_id = p_org and ce.contact_id = v_contact.id and ce.channel = v_channel.type
       and ce.purpose = v_m.approved_purpose and ce.revoked_at is null
  );
  v_suppressed := v_contact.email_normalized is not null and exists (
    select 1 from public.suppressions s
     where s.organization_id = p_org and s.channel = v_channel.type and s.value_normalized = v_contact.email_normalized
  );
  -- compteur de débit sérialisé par canal (deux workers ne lisent pas le même nombre), limité aux envois réels ou en cours
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('send-rate:' || v_m.channel_id::text, 0));
  select pg_catalog.count(*)::integer into v_recent from public.messages x
   where x.organization_id = p_org and x.channel_id = v_m.channel_id and x.direction = 'outbound'
     and ((x.status in ('accepted', 'sent', 'delivered', 'read') and x.sent_at > pg_catalog.now() - interval '1 hour')
          or (x.status = 'queued' and x.send_claimed_at > pg_catalog.now() - interval '1 hour'));
  update public.messages set send_claimed_at = pg_catalog.now() where organization_id = p_org and id = p_message;
  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'message', pg_catalog.jsonb_build_object(
      'body', v_m.body, 'approved', v_m.approved_by is not null, 'purpose', v_m.approved_purpose,
      'approver_valid', v_approver_ok,
      'approval_age_seconds', case when v_m.approved_at is null then null else pg_catalog.floor(extract(epoch from pg_catalog.now() - v_m.approved_at))::bigint end,
      'recipient_unchanged', v_m.approved_recipient is not null and v_m.approved_recipient = v_contact.email_normalized
    ),
    'organization_active', v_org_status = 'active' and v_sub_status is not null and v_sub_status not in ('suspended', 'cancelled'),
    'contact', pg_catalog.jsonb_build_object('email', v_contact.email_normalized, 'do_not_contact', v_contact.do_not_contact),
    'channel', pg_catalog.jsonb_build_object(
      'type', v_channel.type, 'status', v_channel.status, 'send_paused', v_channel.send_paused,
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;
