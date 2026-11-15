-- Retour arrière de 20261211100000_send_operations.sql
-- Supprime les fonctions et le déclencheur d'exploitation, remet le débit PAR CANAL (version 20261210120000) et la contrainte de
-- notifications d'origine. Les alertes `send.failed` déjà créées sont supprimées (la contrainte ne les accepte plus).
-- L'état `send_paused` de l'entreprise n'est pas touché.

drop trigger if exists notify_send_dead_letter on public.jobs;
drop function if exists private.notify_send_dead_letter();
drop function if exists public.set_send_emergency_stop(uuid, boolean);
drop function if exists public.operator_replay_dead_letter(uuid, uuid);
drop function if exists private.set_send_emergency_stop(uuid, boolean);
drop function if exists private.operator_replay_dead_letter(uuid, uuid);
delete from public.notifications where kind = 'send.failed';
alter table public.notifications drop constraint notifications_kind_valid;
alter table public.notifications add constraint notifications_kind_valid check (kind in ('lead.unassigned'));

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
  select i.status, i.external_account_id into v_integration_status, v_account from public.integrations i where i.organization_id = p_org and i.id = v_channel.integration_id;
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
  -- (J38) une RÉPONSE (finalité « reply ») est couverte par un message entrant du contact dans CE fil depuis 30 jours au plus (échange
  -- à son initiative) ; ne plus contacter, suppression, entreprise et canal en pause restent contrôlés plus bas. Toute autre finalité
  -- exige toujours un consentement actif enregistré.
  v_consent := v_m.approved_purpose is not null and (
    exists (
      select 1 from public.consent_events ce
       where ce.organization_id = p_org and ce.contact_id = v_contact.id and ce.channel = v_channel.type
         and ce.purpose = v_m.approved_purpose and ce.revoked_at is null
    )
    or (v_m.approved_purpose = 'reply' and exists (
      select 1 from public.messages im
       where im.organization_id = p_org and im.conversation_id = v_m.conversation_id and im.direction = 'inbound'
         and im.received_at >= pg_catalog.now() - interval '30 days'
    ))
  );
  v_suppressed := v_recipient is not null and exists (
    select 1 from public.suppressions s
     where s.organization_id = p_org and s.channel = v_channel.type and s.value_normalized = v_recipient
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
      'recipient_unchanged', v_m.approved_recipient is not null and v_m.approved_recipient = v_recipient
    ),
    'organization_active', v_org_status = 'active' and v_sub_status is not null and v_sub_status not in ('suspended', 'cancelled'),
    'contact', pg_catalog.jsonb_build_object('email', v_contact.email_normalized, 'phone', v_contact.phone_e164, 'do_not_contact', v_contact.do_not_contact),
    'window_open', v_window,
    'template', case when v_tpl.id is null then null else pg_catalog.jsonb_build_object(
      'status', case when exists (select 1 from public.message_templates nv where nv.organization_id = p_org and nv.channel_id = v_tpl.channel_id and nv.name = v_tpl.name and nv.language = v_tpl.language and nv.version > v_tpl.version) then 'superseded' else v_tpl.status end, 'text', v_m.template_text, 'name', v_tpl.name, 'language', v_tpl.language, 'category', v_tpl.category, 'version', v_tpl.version, 'variables', coalesce(v_m.template_variables, '[]'::jsonb)) end,
    'channel', pg_catalog.jsonb_build_object(
      'type', v_channel.type, 'status', v_channel.status, 'send_paused', v_channel.send_paused,
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status, 'account', v_account
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;
