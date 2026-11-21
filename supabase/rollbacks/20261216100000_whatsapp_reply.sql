-- Retour arrière de 20261216100000_whatsapp_reply.sql : `conversation_reply` redevient réservée à l'e-mail (version de 20261210100000).
create or replace function private.conversation_reply(p_org uuid, p_conversation uuid, p_body text, p_idempotency_key text)
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
