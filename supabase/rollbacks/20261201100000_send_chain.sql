-- Retour arrière de 20261201100000_send_chain.sql (J31). ATTENTION : supprime les suppressions et les colonnes d'approbation / de tentative des messages
-- (les messages déjà `accepted` perdent leur approbateur). Les jobs `send_message` encore en file iront en dead_letter une fois le handler retiré : les
-- annuler avant. La garde de J30 ci-dessous est la copie exacte de celle de la migration 20261130100000.
drop function if exists public.message_release_claim(uuid, uuid);
drop function if exists public.message_mark_failed(uuid, uuid, text);
drop function if exists public.message_mark_accepted(uuid, uuid, text);
drop function if exists public.message_send_claim(uuid, uuid);
drop function if exists public.message_approve(uuid, uuid, text);
drop function if exists private.message_release_claim(uuid, uuid);
drop function if exists private.message_mark_failed(uuid, uuid, text);
drop function if exists private.message_mark_accepted(uuid, uuid, text);
drop function if exists private.message_send_claim(uuid, uuid);
drop function if exists private.message_approve(uuid, uuid, text);

drop table if exists public.suppressions;

-- garde de J30 (sans approbation ni machine d'états)
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
  return new;
end;
$$;

alter table public.messages
  drop constraint if exists messages_claim_outbound,
  drop constraint if exists messages_approved_purpose_valid,
  drop constraint if exists messages_approval_outbound,
  drop constraint if exists messages_approval_shape,
  drop constraint if exists messages_approved_recipient_valid;
alter table public.messages
  drop column if exists send_claimed_at,
  drop column if exists approved_recipient,
  drop column if exists approved_purpose,
  drop column if exists approved_at,
  drop column if exists approved_by;
