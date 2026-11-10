-- Retour arrière de 20261130100000_conversations_messages.sql (J30). ATTENTION : supprime toutes les conversations et tous les messages.
drop function if exists public.message_record(uuid, uuid, text, text, text, text, timestamptz);
drop function if exists public.conversation_get_or_create(uuid, uuid, uuid);
drop function if exists public.set_conversation_state(uuid, uuid, text);
drop function if exists public.assign_conversation(uuid, uuid, uuid);
drop function if exists private.message_record(uuid, uuid, text, text, text, text, timestamptz);
drop function if exists private.conversation_get_or_create(uuid, uuid, uuid);
drop function if exists private.set_conversation_state(uuid, uuid, text);
drop function if exists private.assign_conversation(uuid, uuid, uuid);
drop function if exists private.lock_conversation_for_write(uuid, uuid);

drop trigger if exists release_conversation_assignments on public.organization_members;
drop trigger if exists release_conversation_assignments_role on public.organization_members;
drop trigger if exists release_conversation_assignments_delete on public.organization_members;
drop function if exists private.release_conversation_assignments();
drop function if exists private.release_conversations_of(uuid, uuid);

drop table if exists public.messages;
drop table if exists public.conversations;
drop function if exists private.can_read_conversation(uuid, uuid);
drop function if exists private.messages_guard();
drop function if exists private.conversations_guard();
drop function if exists private.audit_conversations();
