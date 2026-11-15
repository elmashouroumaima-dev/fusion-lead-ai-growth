-- J39 : exploitation des envois (plan J39, spec §6, menace F6).
--  * Débit par (fournisseur, entreprise) : `message_send_claim` compte les envois de l'heure sur TOUS les canaux du même type de
--    l'entreprise (avant : par canal). Le reste de la fonction est identique à la version fusionnée 20261210120000.
--  * Arrêt d'urgence : `set_send_emergency_stop` (owner / admin / marketing manager, ADR 014 ligne 9) pose ou lève `organizations.settings.send_paused`, audité.
--  * Dead letters : lecture par la RLS existante (owner / admin) ; `operator_replay_dead_letter` rejoue avec l'acteur HUMAIN vérifié
--    (comble la limite « p_actor » de l'ADR 003 pour l'interface).
--  * Alertes d'échec : `notifications.kind` accepte `send.failed` ; un déclencheur crée une alerte pour chaque owner / admin actif
--    quand un job d'envoi passe en dead letter (identifiants seulement, aucune donnée de contact ni corps de message).
-- Retour arrière : supabase/rollbacks/20261211100000_send_operations.sql

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
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status, 'account', v_account
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Arrêt d'urgence par entreprise (le canal se met déjà en pause par update_channel)
-- ---------------------------------------------------------------------------
create function private.set_send_emergency_stop(p_org uuid, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
begin
  if p_paused is null or not private.has_role(p_org, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce((o.settings ->> 'send_paused') = 'true', false) into v_before
    from public.organizations o where o.id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.organizations
     set settings = pg_catalog.jsonb_set(settings, '{send_paused}', pg_catalog.to_jsonb(p_paused), true)
   where id = p_org;
  perform private.audit_write(p_org, 'send.emergency_stop', 'organization', p_org,
    pg_catalog.jsonb_build_object('send_paused', v_before), pg_catalog.jsonb_build_object('send_paused', p_paused));
end;
$$;

create function public.set_send_emergency_stop(p_org uuid, p_paused boolean)
returns void language sql security invoker set search_path = ''
as $$ select private.set_send_emergency_stop(p_org, p_paused); $$;

-- ---------------------------------------------------------------------------
-- Rejeu d'une dead letter par un humain (acteur vérifié = auth.uid(), pris par audit_write)
-- ---------------------------------------------------------------------------
create function private.operator_replay_dead_letter(p_org uuid, p_job uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.replay_dead_letter(p_org, p_job);
end;
$$;

create function public.operator_replay_dead_letter(p_org uuid, p_job uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select private.operator_replay_dead_letter(p_org, p_job); $$;

-- ---------------------------------------------------------------------------
-- Alerte d'échec d'envoi
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_kind_valid;
alter table public.notifications add constraint notifications_kind_valid check (kind in ('lead.unassigned', 'send.failed'));

create function private.notify_send_dead_letter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'dead_letter' and old.status is distinct from 'dead_letter' and new.kind = 'send_message' then
    insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key)
    select new.organization_id, m.user_id, 'send.failed',
           pg_catalog.jsonb_build_object('job_id', new.id, 'job_kind', new.kind),
           'send.failed:' || new.id::text || ':' || m.user_id::text
      from public.organization_members m
     where m.organization_id = new.organization_id and m.status = 'active' and m.role in ('company_owner', 'company_admin')
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger notify_send_dead_letter after update of status on public.jobs
  for each row execute function private.notify_send_dead_letter();

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------
revoke all on function private.set_send_emergency_stop(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.operator_replay_dead_letter(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.notify_send_dead_letter() from public, anon, authenticated, service_role;
revoke all on function public.set_send_emergency_stop(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.operator_replay_dead_letter(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_send_emergency_stop(uuid, boolean) to authenticated;
grant execute on function public.operator_replay_dead_letter(uuid, uuid) to authenticated;
grant execute on function private.set_send_emergency_stop(uuid, boolean) to authenticated;
grant execute on function private.operator_replay_dead_letter(uuid, uuid) to authenticated;
