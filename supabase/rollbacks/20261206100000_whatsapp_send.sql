-- Retour arrière de 20261206100000_whatsapp_send.sql (J36). ATTENTION : supprime `message_templates` et les colonnes `messages.template_*` (les modèles et le texte rendu des messages sont perdus).
-- Les fonctions remplacées par le J36 sont recréées ICI dans leur version d'avant (J31 pour l'approbation et la réclamation, J35 pour la garde et les statuts) AVANT de supprimer les colonnes qu'elles lisent.
begin;
create or replace function private.messages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.conversation_id is distinct from old.conversation_id or new.channel_id is distinct from old.channel_id
     or new.direction is distinct from old.direction or new.body is distinct from old.body
     or (old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id) then
    raise exception 'message_immutable' using errcode = '23514';
  end if;
  if old.approved_by is not null
     and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
          or new.approved_purpose is distinct from old.approved_purpose or new.approved_recipient is distinct from old.approved_recipient) then
    raise exception 'message_approval_immutable' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'queued' and new.status in ('accepted', 'failed', 'cancelled'))
      or (old.status = 'accepted' and new.status in ('sent', 'delivered', 'read', 'failed', 'bounced'))
      or (old.status = 'sent' and new.status in ('delivered', 'read', 'failed', 'bounced'))
      or (old.status = 'delivered' and new.status in ('read', 'bounced'))
      -- le fournisseur a bien accepté un envoi dont la réponse s'était perdue (résultat inconnu) : seule sortie du statut « failed » côté envoi
      or (old.status = 'failed' and old.error_code = 'send_outcome_unknown' and new.status = 'accepted')
      -- J35 : échec annoncé par Meta, puis statut de livraison hors ordre
      or (old.status = 'failed' and old.error_code like 'wa\_%' and new.status in ('delivered', 'read'))
    ) then
      raise exception 'message_status_invalid' using errcode = '23514';
    end if;
    if new.status in ('accepted', 'sent', 'delivered', 'read') and new.approved_by is null then
      raise exception 'message_not_approved' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.message_approve(p_org uuid, p_message uuid, p_purpose text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.messages;
  v_email text;
begin
  perform private.assert_project_manager(p_org);
  if p_purpose is null or p_purpose !~ '^[a-z][a-z0-9_]{0,49}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.messages m where m.organization_id = p_org and m.id = p_message for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.direction <> 'outbound' or v_row.status <> 'queued' or v_row.approved_by is not null or v_row.send_claimed_at is not null then
    raise exception 'message_not_approvable' using errcode = 'P0001';
  end if;
  -- l'approbation couvre UNE adresse : celle du contact du fil à cet instant
  select ct.email_normalized into v_email
    from public.conversations c join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
   where c.organization_id = p_org and c.id = v_row.conversation_id;
  if v_email is null then
    raise exception 'message_not_approvable' using errcode = 'P0001';
  end if;
  update public.messages set approved_by = auth.uid(), approved_at = pg_catalog.now(), approved_purpose = p_purpose, approved_recipient = v_email
   where organization_id = p_org and id = p_message;
  perform private.audit_write(p_org, 'message.approved', 'message', p_message, null, pg_catalog.jsonb_build_object('purpose', p_purpose));
  -- l'envoi se fait par le worker, jamais dans la requête : le job naît avec l'approbation (même transaction, une clé par message)
  perform private.enqueue_job(p_org, 'send_message', pg_catalog.jsonb_build_object('message_id', p_message), 'send-message:' || p_message::text, null, 5);
end;
$$;

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

create or replace function private.whatsapp_status_apply(
  p_org uuid, p_integration uuid, p_provider_message_id text, p_status text, p_error_code integer, p_event_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_rank integer;
  v_current integer;
begin
  if p_org is null or p_integration is null
     or p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9._=+/-]{1,255}$'
     or p_status is null or p_status not in ('sent', 'delivered', 'read', 'failed')
     or (p_error_code is not null and p_error_code not between 0 and 999999) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'whatsapp' and i.status in ('pending', 'active', 'error');
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- le message est cherché dans l'entreprise ET l'intégration authentifiées, par l'identifiant de Meta
  select m.* into v_m
    from public.messages m
    join public.channels ch on ch.organization_id = m.organization_id and ch.id = m.channel_id
   where m.organization_id = p_org and ch.integration_id = p_integration and m.direction = 'outbound' and m.provider_message_id = p_provider_message_id
   limit 1
   for update of m;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'message_not_found');
  end if;
  if v_m.status not in ('accepted', 'sent', 'delivered', 'read', 'failed', 'bounced') then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'not_sent');
  end if;

  if p_status = 'failed' then
    if v_m.status in ('accepted', 'sent') then
      update public.messages set status = 'failed', error_code = 'wa_' || coalesce(p_error_code::text, '0')
       where organization_id = p_org and id = v_m.id;
      perform private.audit_write(p_org, 'message.failed', 'message', v_m.id, null, pg_catalog.jsonb_build_object('error_code', 'wa_' || coalesce(p_error_code::text, '0')));
      return pg_catalog.jsonb_build_object('outcome', 'applied');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', case when v_m.status = 'failed' then 'already_applied' else 'status_conflict' end);
  end if;

  v_rank := case p_status when 'sent' then 1 when 'delivered' then 2 else 3 end;
  -- Meta ne garantit pas l'ordre : un « failed » de Meta suivi d'un vrai « delivered » ou « read » est corrigé (jamais un échec posé par la chaîne d'envoi, `send_*`)
  if v_m.status = 'failed' and v_m.error_code like 'wa\_%' and v_rank >= 2 then
    update public.messages set status = p_status, error_code = null where organization_id = p_org and id = v_m.id;
    perform private.audit_write(p_org, 'message.' || p_status, 'message', v_m.id, null, null);
    return pg_catalog.jsonb_build_object('outcome', 'applied');
  end if;
  v_current := case v_m.status when 'accepted' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else -1 end;
  if v_current < 0 then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'status_conflict');
  end if;
  if v_rank <= v_current then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', case when v_rank = v_current then 'already_applied' else 'out_of_order' end);
  end if;
  update public.messages set status = p_status where organization_id = p_org and id = v_m.id;
  perform private.audit_write(p_org, 'message.' || p_status, 'message', v_m.id, null, null);
  return pg_catalog.jsonb_build_object('outcome', 'applied');
end;
$$;

drop function if exists public.message_templates_sync(uuid, uuid, jsonb);
drop function if exists public.message_attach_template(uuid, uuid, uuid, jsonb);
drop function if exists private.message_templates_sync(uuid, uuid, jsonb);
drop function if exists private.message_attach_template(uuid, uuid, uuid, jsonb);
alter table public.messages drop constraint if exists messages_template_outbound, drop constraint if exists messages_template_text_valid, drop constraint if exists messages_template_shape, drop constraint if exists messages_template_fkey;
alter table public.messages drop column if exists template_text, drop column if exists template_variables, drop column if exists template_id;
drop table if exists public.message_templates;
commit;
