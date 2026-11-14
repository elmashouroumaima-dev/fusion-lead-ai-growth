-- J38 — Réponses depuis la boîte de réception et verrou humain / IA : plan J38, spec §8 (`POST /api/conversations/:id/replies`), §9.3 (« pas de
-- réponse IA et de réponse humaine en même temps »), §5.7 (approbation humaine avant tout envoi externe), ADR 007 (E4), ADR 014 (ligne 18 :
-- répondre = owner et admin sur toute conversation, le commercial sur les siennes), menaces B3 et C3.
-- Retour arrière : supabase/rollbacks/20261210100000_replies_lock.sql
--
-- Décisions (mini-plan validé le 2026-11-14, option B) :
--  * Une RÉPONSE est créée ET approuvée dans la même transaction par la personne qui la rédige et clique sur « Envoyer » (envoyer = approbation
--    humaine de CE message précis) : `conversation_reply` écrit le message sortant `queued`, pose l'approbation (finalité `reply`, adresse du
--    contact figée) et met le job `send_message` en file. L'envoi reste fait par le worker, jamais dans la requête.
--  * Qui peut répondre : owner et admin sur toute conversation de l'entreprise, le commercial sur SES conversations (assignee = lui) ; marketing et
--    analyste jamais (`42501`) ; un fil d'autrui ou d'une autre entreprise est « introuvable » (`PT404`) pour un commercial.
--  * La chaîne de contrôles du worker (`message_send_claim`, J31) est ADAPTÉE, pas contournée :
--      - l'approbateur revalidé à l'envoi est owner ou admin actif, OU, pour une réponse (`reply`), un commercial actif encore responsable du fil ;
--      - le consentement d'une réponse est couvert par un message ENTRANT du contact dans ce fil depuis 30 jours au plus ; toute autre finalité exige
--        toujours un consentement actif ; `do_not_contact`, suppression, pauses, canal, entreprise, débit et péremption de l'approbation (72 h) restent
--        contrôlés comme avant.
--    ⚠ La version de `message_send_claim` de ce fichier part de celle de J31. La migration WhatsApp (J36, PR séparée) la reprend aussi : à la fusion,
--    il faut une SEULE version contenant les deux séries de changements.
--  * Verrou humain / IA : `conversations.handled_by` (`human` ou `ai_suggest`) et un bail humain (`lock_owner`, `lock_expires_at`, 5 minutes).
--    Une réponse humaine est refusée (`conversation_locked`) tant que l'IA tient le fil OU qu'un autre membre détient un bail non expiré ;
--    l'IA ne prend le fil (`conversation_ai_claim`, service_role, utilisée à partir de J47) que sans bail humain actif. Les deux verrous sont
--    pris sous `FOR UPDATE` de la conversation : jamais les deux en même temps.
--  * Canal : e-mail seulement (le worker n'envoie que de l'e-mail ; WhatsApp arrive avec J36) : `channel_unsupported` sinon.
--  * Audit : `message.approved` (finalité) ; `conversation.lock_changed` / `conversation.handler_changed` (identifiants). Jamais le corps.

-- ---------------------------------------------------------------------------
-- Droit de répondre (ADR 014 ligne 18) : owner / admin, ou commercial responsable du fil
-- ---------------------------------------------------------------------------
create function private.can_reply_conversation(p_org uuid, p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
     where c.organization_id = p_org and c.id = p_conversation
       and (private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[])
            or (private.has_role(p_org, array['sales_agent']::public.app_role[]) and c.assignee_id = auth.uid()))
  );
$$;

-- ---------------------------------------------------------------------------
-- Bail humain : prendre / rendre la rédaction d'une réponse (5 minutes, renouvelable)
-- Retour : { status: acquired | held_by_other | ai, expires_at? }. `held_by_other` ne dit JAMAIS qui tient le bail.
-- ---------------------------------------------------------------------------
create function private.conversation_lock_acquire(p_org uuid, p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_c public.conversations;
  v_expires timestamptz;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.has_role(p_org, array['company_owner', 'company_admin', 'sales_agent']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_c from public.conversations c where c.organization_id = p_org and c.id = p_conversation for update;
  if not found or not private.can_reply_conversation(p_org, p_conversation) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_c.handled_by <> 'human' then
    return pg_catalog.jsonb_build_object('status', 'ai');
  end if;
  if v_c.lock_owner is not null and v_c.lock_owner <> v_uid and v_c.lock_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'held_by_other');
  end if;
  v_expires := pg_catalog.now() + interval '5 minutes';
  update public.conversations set lock_owner = v_uid, lock_expires_at = v_expires where organization_id = p_org and id = p_conversation;
  if v_c.lock_owner is distinct from v_uid then
    perform private.audit_write(p_org, 'conversation.lock_changed', 'conversation', p_conversation, null, pg_catalog.jsonb_build_object('lock', 'acquired'));
  end if;
  return pg_catalog.jsonb_build_object('status', 'acquired', 'expires_at', v_expires);
end;
$$;

-- État du verrou pour l'écran (lecture seule, ne prend AUCUN bail) : qui tient le fil (humain ou IA) et si le bail est le mien, celui d'un autre ou libre.
create function private.conversation_lock_status(p_org uuid, p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_c public.conversations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.has_role(p_org, array['company_owner', 'company_admin', 'sales_agent']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_c from public.conversations c where c.organization_id = p_org and c.id = p_conversation;
  if not found or not private.can_reply_conversation(p_org, p_conversation) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return pg_catalog.jsonb_build_object(
    'handled_by', v_c.handled_by,
    'lock', case when v_c.lock_owner is null or v_c.lock_expires_at <= pg_catalog.now() then 'none' when v_c.lock_owner = v_uid then 'mine' else 'other' end
  );
end;
$$;

create function private.conversation_lock_release(p_org uuid, p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  -- on ne rend que SON bail (un bail d'autrui ou absent : sans effet, sans erreur)
  update public.conversations set lock_owner = null, lock_expires_at = null
   where organization_id = p_org and id = p_conversation and lock_owner = v_uid;
  if found then
    perform private.audit_write(p_org, 'conversation.lock_changed', 'conversation', p_conversation, null, pg_catalog.jsonb_build_object('lock', 'released'));
  end if;
end;
$$;

-- Reprendre la main sur un fil tenu par l'IA (owner, admin, commercial responsable) : l'IA ne répond plus, le bail humain est libre.
create function private.conversation_take_over(p_org uuid, p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_c public.conversations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.has_role(p_org, array['company_owner', 'company_admin', 'sales_agent']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_c from public.conversations c where c.organization_id = p_org and c.id = p_conversation for update;
  if not found or not private.can_reply_conversation(p_org, p_conversation) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_c.handled_by <> 'human' then
    update public.conversations set handled_by = 'human', lock_owner = null, lock_expires_at = null where organization_id = p_org and id = p_conversation;
    perform private.audit_write(p_org, 'conversation.handler_changed', 'conversation', p_conversation, null, pg_catalog.jsonb_build_object('handled_by', 'human'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Côté IA (service_role, utilisée à partir de J47) : prendre / rendre le fil. Refusé tant qu'un bail humain est actif.
-- ---------------------------------------------------------------------------
create function private.conversation_ai_claim(p_org uuid, p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.conversations;
begin
  select * into v_c from public.conversations c where c.organization_id = p_org and c.id = p_conversation for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_c.handled_by = 'ai_suggest' then
    return pg_catalog.jsonb_build_object('status', 'already');
  end if;
  if v_c.lock_owner is not null and v_c.lock_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'busy');
  end if;
  update public.conversations set handled_by = 'ai_suggest', lock_owner = null, lock_expires_at = null where organization_id = p_org and id = p_conversation;
  perform private.audit_write(p_org, 'conversation.handler_changed', 'conversation', p_conversation, null, pg_catalog.jsonb_build_object('handled_by', 'ai_suggest'));
  return pg_catalog.jsonb_build_object('status', 'claimed');
end;
$$;

create function private.conversation_ai_release(p_org uuid, p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations set handled_by = 'human' where organization_id = p_org and id = p_conversation and handled_by = 'ai_suggest';
  if found then
    perform private.audit_write(p_org, 'conversation.handler_changed', 'conversation', p_conversation, null, pg_catalog.jsonb_build_object('handled_by', 'human'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Réponse : message sortant + approbation de l'auteur + job d'envoi, dans UNE transaction
-- Retour : { message_id, duplicate }. Codes : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 · not_found PT404 ·
-- P0001 : conversation_locked, channel_unsupported, channel_inactive, message_not_approvable, idempotency_conflict, too_many_messages
-- ---------------------------------------------------------------------------
create function private.conversation_reply(p_org uuid, p_conversation uuid, p_body text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_c public.conversations;
  v_existing public.messages;
  v_channel_type public.channel_type;
  v_channel_status text;
  v_email text;
  v_rec jsonb;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.has_role(p_org, array['company_owner', 'company_admin', 'sales_agent']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- le texte est validé AVANT toute lecture (jamais recopié dans une erreur) : 1 à 10 000 caractères, sans caractère de contrôle ni de direction
  if p_body is null or not private.is_safe_text(p_body, 1, 10000, true) or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,200}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_c from public.conversations c where c.organization_id = p_org and c.id = p_conversation for update;
  if not found or not private.can_reply_conversation(p_org, p_conversation) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- rejeu de la même demande : le même message, jamais un second envoi ni une seconde approbation
  select * into v_existing from public.messages m where m.organization_id = p_org and m.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.conversation_id <> p_conversation or v_existing.direction <> 'outbound' or v_existing.body <> p_body then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('message_id', v_existing.id, 'duplicate', true);
  end if;
  -- verrou : ni l'IA, ni un autre membre en train de rédiger
  if v_c.handled_by <> 'human' or (v_c.lock_owner is not null and v_c.lock_owner <> v_uid and v_c.lock_expires_at > pg_catalog.now()) then
    raise exception 'conversation_locked' using errcode = 'P0001';
  end if;
  select ch.type, ch.status into v_channel_type, v_channel_status from public.channels ch where ch.organization_id = p_org and ch.id = v_c.channel_id;
  if v_channel_type is distinct from 'email' then
    raise exception 'channel_unsupported' using errcode = 'P0001';
  end if;
  if v_channel_status <> 'active' then
    raise exception 'channel_inactive' using errcode = 'P0001';
  end if;
  select ct.email_normalized into v_email from public.contacts ct where ct.organization_id = p_org and ct.id = v_c.contact_id;
  if v_email is null then
    raise exception 'message_not_approvable' using errcode = 'P0001';
  end if;
  v_rec := private.message_record(p_org, p_conversation, 'outbound', null, p_body, p_idempotency_key, null);
  v_id := (v_rec ->> 'message_id')::uuid;
  -- envoyer = approbation humaine de CE message (finalité « reply », adresse du contact figée) ; le worker revalide tout
  update public.messages set approved_by = v_uid, approved_at = pg_catalog.now(), approved_purpose = 'reply', approved_recipient = v_email
   where organization_id = p_org and id = v_id;
  perform private.audit_write(p_org, 'message.approved', 'message', v_id, null, pg_catalog.jsonb_build_object('purpose', 'reply'));
  perform private.enqueue_job(p_org, 'send_message', pg_catalog.jsonb_build_object('message_id', v_id), 'send-message:' || v_id::text, null, 5);
  -- l'envoi libère le bail de son auteur
  if v_c.lock_owner = v_uid then
    update public.conversations set lock_owner = null, lock_expires_at = null where organization_id = p_org and id = p_conversation;
  end if;
  return pg_catalog.jsonb_build_object('message_id', v_id, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Chaîne d'envoi du worker : approbateur et consentement d'une réponse (voir l'en-tête)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Droits et enveloppes publiques
-- ---------------------------------------------------------------------------
revoke all on function private.can_reply_conversation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_lock_acquire(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_lock_status(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_lock_release(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_take_over(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_ai_claim(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_ai_release(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.conversation_reply(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function private.can_reply_conversation(uuid, uuid) to authenticated;
grant execute on function private.conversation_lock_acquire(uuid, uuid) to authenticated;
grant execute on function private.conversation_lock_status(uuid, uuid) to authenticated;
grant execute on function private.conversation_lock_release(uuid, uuid) to authenticated;
grant execute on function private.conversation_take_over(uuid, uuid) to authenticated;
grant execute on function private.conversation_reply(uuid, uuid, text, text) to authenticated;
grant execute on function private.conversation_ai_claim(uuid, uuid) to service_role;
grant execute on function private.conversation_ai_release(uuid, uuid) to service_role;

create function public.conversation_lock_acquire(p_org uuid, p_conversation uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.conversation_lock_acquire(p_org, p_conversation); $$;
create function public.conversation_lock_status(p_org uuid, p_conversation uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.conversation_lock_status(p_org, p_conversation); $$;
create function public.conversation_lock_release(p_org uuid, p_conversation uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.conversation_lock_release(p_org, p_conversation); $$;
create function public.conversation_take_over(p_org uuid, p_conversation uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.conversation_take_over(p_org, p_conversation); $$;
create function public.conversation_reply(p_org uuid, p_conversation uuid, p_body text, p_idempotency_key text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.conversation_reply(p_org, p_conversation, p_body, p_idempotency_key); $$;
create function public.conversation_ai_claim(p_org uuid, p_conversation uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.conversation_ai_claim(p_org, p_conversation); $$;
create function public.conversation_ai_release(p_org uuid, p_conversation uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.conversation_ai_release(p_org, p_conversation); $$;

revoke all on function public.conversation_lock_acquire(uuid, uuid) from public, anon, service_role;
revoke all on function public.conversation_lock_status(uuid, uuid) from public, anon, service_role;
revoke all on function public.conversation_lock_release(uuid, uuid) from public, anon, service_role;
revoke all on function public.conversation_take_over(uuid, uuid) from public, anon, service_role;
revoke all on function public.conversation_reply(uuid, uuid, text, text) from public, anon, service_role;
revoke all on function public.conversation_ai_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.conversation_ai_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.conversation_lock_acquire(uuid, uuid) to authenticated;
grant execute on function public.conversation_lock_status(uuid, uuid) to authenticated;
grant execute on function public.conversation_lock_release(uuid, uuid) to authenticated;
grant execute on function public.conversation_take_over(uuid, uuid) to authenticated;
grant execute on function public.conversation_reply(uuid, uuid, text, text) to authenticated;
grant execute on function public.conversation_ai_claim(uuid, uuid) to service_role;
grant execute on function public.conversation_ai_release(uuid, uuid) to service_role;
