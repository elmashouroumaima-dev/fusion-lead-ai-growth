-- Retour arrière de 20261212100000_reply_purpose_reserved.sql
-- Remet `private.message_approve` dans sa version J36 (WhatsApp) : la finalité « reply » redevient acceptée par message_approve. Aucune donnée n'est touchée.

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
  select case when ch.type = 'whatsapp' then ct.phone_e164 else ct.email_normalized end into v_email
    from public.conversations c join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
    join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id
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
