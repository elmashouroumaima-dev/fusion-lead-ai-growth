-- Durcissement J38 : la finalité « reply » est RÉSERVÉE à la réponse (`conversation_reply`).
-- Avant : `message_approve` (owner et admin) acceptait n'importe quelle finalité, `reply` comprise ; un message promotionnel approuvé « reply » était alors couvert par le
-- consentement conversationnel de 30 jours (un message entrant du contact) sans consentement marketing. Maintenant `message_approve` refuse `reply` (`purpose_reserved`,
-- code 22023) ; `conversation_reply` (le composeur) la pose toujours, avec l'adresse figée, et le worker revalide l'auteur et le consentement conversationnel.
-- Seule la fonction `private.message_approve` change (version WhatsApp du J36 + ce refus). Aucune donnée n'est touchée.
-- Retour arrière : supabase/rollbacks/20261212100000_reply_purpose_reserved.sql

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
  -- (durcissement J38) « reply » est RÉSERVÉE au composeur (`conversation_reply`) : une réponse est couverte par le consentement conversationnel (un message
  -- entrant du contact dans CE fil depuis 30 jours), pas un message promotionnel. Aucun autre chemin ne peut poser cette finalité.
  if p_purpose = 'reply' then
    raise exception 'purpose_reserved' using errcode = '22023';
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
