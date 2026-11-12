-- Conversations et messages (J30, spec §7 et §9.3, ADR 005 décision 13, ADR 007 E4, ADR 014 lignes « Conversations », menaces B3 et C3).
-- Retour arrière : supabase/rollbacks/20261130100000_conversations_messages.sql
--
-- Décisions (mini-plan validé le 2026-11-10) :
--  * UN fil par (contact, canal) : `unique (organization_id, channel_id, contact_id)` ; un fil fermé se rouvre à l'arrivée d'un message entrant ;
--  * COHÉRENCE D'ENTREPRISE imposée par la base : un message référence sa conversation par la clé composite
--    `(organization_id, conversation_id, channel_id)` : il ne peut porter ni une autre entreprise, ni un autre canal que sa conversation
--    (ADR 005 décision 13) ; des déclencheurs rendent immuables l'organisation, la conversation, le canal, le sens et le corps ;
--  * `provider_message_id` unique par `(organization_id, channel_id)` (déduplication d'un message entrant rejoué) et `idempotency_key`
--    unique par entreprise (un envoi rejoué ne crée pas un second message) ;
--  * statuts de message : ceux de l'ADR 007 plus `received` (messages ENTRANTS seulement, écart documenté) ; listes fermées par CHECK ;
--  * lecture : owner et admin voient tout (dont la file `to_triage`), le commercial seulement les conversations qui lui sont assignées
--    (et leurs messages), marketing et analyste rien (ADR 014) ; aucune écriture directe, même service_role ;
--  * écriture : fonctions owner / admin (assigner), owner / admin / commercial sur les siennes (état), et fonctions service_role
--    (`conversation_get_or_create`, `message_record`, idempotentes) pour la réception (J32, J35) et l'envoi (J31, J38) ;
--  * le CORPS d'un message n'est jamais journalisé ni audité (identifiants et noms de champs seulement) ;
--  * un membre suspendu, retiré ou rétrogradé voit ses conversations libérées (assignation retirée, file `to_triage`), comme ses leads ;
--  * (revue adverse) un rejeu qui contredit le message existant (autre conversation ou autre corps) est un CONFLIT d'idempotence, jamais un
--    « duplicate » silencieux ; les entrées sont validées AVANT l'insertion (une violation de CHECK recopierait le corps du message dans le
--    DETAIL de l'erreur) ; état et responsable cohérents par CHECK (`to_triage` sans responsable, `open` et `pending` avec un responsable) ;
--    plafond de 10 000 messages par conversation ; horodatage d'un message limité à maintenant + 5 minutes ; aucun message sur un canal
--    déconnecté ; un message sortant naît `queued` SANS approbation : la chaîne de contrôle de l'envoi (J31) et l'approbation (J38, J44)
--    DOIVENT être exigées par le worker d'envoi avant tout appel au fournisseur ;
--  * colonnes différées (aucune table à référencer aujourd'hui) : `template_*` (J36), `campaign_id`, `segment_snapshot_id` (J42, J43),
--    `approved_by`, `approved_at` (J38, J44).

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_id uuid not null,
  channel_id uuid not null,
  assignee_id uuid,
  state text not null default 'to_triage',
  handled_by text not null default 'human',
  last_message_at timestamptz,
  lock_owner uuid,
  lock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_org_id_key unique (organization_id, id),
  constraint conversations_org_id_channel_key unique (organization_id, id, channel_id),
  constraint conversations_thread_key unique (organization_id, channel_id, contact_id),
  constraint conversations_contact_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete restrict,
  constraint conversations_channel_fkey foreign key (organization_id, channel_id)
    references public.channels (organization_id, id) on delete restrict,
  constraint conversations_assignee_fkey foreign key (organization_id, assignee_id)
    references public.organization_members (organization_id, user_id) on delete set null (assignee_id),
  constraint conversations_state_valid check (state in ('open', 'pending', 'closed', 'to_triage')),
  constraint conversations_handled_by_valid check (handled_by in ('human', 'ai_suggest')),
  constraint conversations_lock_valid check ((lock_owner is null) = (lock_expires_at is null)),
  constraint conversations_state_assignee check ((state <> 'to_triage' or assignee_id is null) and (state not in ('open', 'pending') or assignee_id is not null))
);
create index conversations_recent_idx on public.conversations (organization_id, last_message_at desc nulls last, id);
create index conversations_assignee_idx on public.conversations (organization_id, assignee_id, last_message_at desc nulls last, id);
create index conversations_state_idx on public.conversations (organization_id, state, last_message_at desc nulls last, id);
create index conversations_contact_idx on public.conversations (organization_id, contact_id);
comment on table public.conversations is 'Fils de discussion (un par contact et canal), J30. Écriture par fonctions uniquement.';
create trigger conversations_set_updated_at before update on public.conversations for each row execute function private.set_updated_at();
create trigger conversations_org_immutable before update on public.conversations for each row execute function private.prevent_organization_id_change();

-- Le contact et le canal d'un fil ne changent jamais (le fil est identifié par eux).
create function private.conversations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.contact_id is distinct from old.contact_id or new.channel_id is distinct from old.channel_id then
    raise exception 'conversation_identity_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger conversations_guard before update on public.conversations for each row execute function private.conversations_guard();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  conversation_id uuid not null,
  channel_id uuid not null,
  direction text not null,
  provider_message_id text,
  body text not null,
  status text not null,
  sent_at timestamptz,
  received_at timestamptz,
  error_code text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_org_id_key unique (organization_id, id),
  constraint messages_conversation_fkey foreign key (organization_id, conversation_id, channel_id)
    references public.conversations (organization_id, id, channel_id) on delete restrict,
  constraint messages_provider_key unique (organization_id, channel_id, provider_message_id),
  constraint messages_idempotency_key unique (organization_id, idempotency_key),
  constraint messages_direction_valid check (direction in ('inbound', 'outbound')),
  constraint messages_status_valid check (status in ('queued', 'accepted', 'sent', 'delivered', 'read', 'failed', 'bounced', 'cancelled', 'received')),
  constraint messages_direction_status check ((direction = 'inbound') = (status = 'received')),
  constraint messages_inbound_shape check (direction <> 'inbound' or (received_at is not null and provider_message_id is not null and sent_at is null)),
  constraint messages_outbound_shape check (direction <> 'outbound' or (received_at is null and idempotency_key is not null)),
  constraint messages_body_valid check (pg_catalog.char_length(body) between 1 and 100000),
  constraint messages_provider_id_valid check (provider_message_id is null or (pg_catalog.char_length(provider_message_id) between 1 and 998 and provider_message_id ~ '^[A-Za-z0-9._:=+/@<>$%-]+$')),
  constraint messages_idempotency_valid check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  constraint messages_error_code_valid check (error_code is null or error_code ~ '^[a-z0-9_]{1,40}$')
);
create index messages_conversation_idx on public.messages (organization_id, conversation_id, created_at desc, id);
comment on table public.messages is 'Messages (entrants et sortants), J30. Le corps n''est jamais journalisé. Écriture par fonctions uniquement.';
create trigger messages_set_updated_at before update on public.messages for each row execute function private.set_updated_at();
create trigger messages_org_immutable before update on public.messages for each row execute function private.prevent_organization_id_change();

-- Conversation, canal, sens et corps ne changent pas ; l'identifiant du fournisseur ne change plus une fois connu.
create function private.messages_guard()
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
create trigger messages_guard before update on public.messages for each row execute function private.messages_guard();

-- ---------------------------------------------------------------------------
-- Audit : identifiants et noms de champs, jamais le corps d'un message
-- ---------------------------------------------------------------------------
create function private.audit_conversations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'conversation.created', 'conversation', new.id, null,
      pg_catalog.jsonb_build_object('contact_id', new.contact_id, 'channel_id', new.channel_id));
    return null;
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    perform private.audit_write(new.organization_id, 'conversation.assigned', 'conversation', new.id,
      pg_catalog.jsonb_build_object('assignee_id', old.assignee_id), pg_catalog.jsonb_build_object('assignee_id', new.assignee_id));
  end if;
  if new.state is distinct from old.state then
    perform private.audit_write(new.organization_id, 'conversation.state_changed', 'conversation', new.id,
      pg_catalog.jsonb_build_object('state', old.state), pg_catalog.jsonb_build_object('state', new.state));
  end if;
  return null;
end;
$$;
create trigger audit_conversations after insert or update on public.conversations for each row execute function private.audit_conversations();

-- ---------------------------------------------------------------------------
-- RLS : lecture par rôle ; aucune écriture directe, même service_role
-- ---------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
revoke all on table public.conversations from authenticated;
revoke all on table public.messages from authenticated;
grant select on table public.conversations to authenticated;
grant select on table public.messages to authenticated;
revoke insert, update, delete, truncate on table public.conversations from service_role;
revoke insert, update, delete, truncate on table public.messages from service_role;

-- Les messages héritent des droits de leur conversation : une fonction DEFINER lit la conversation sans repasser par la RLS (pas de boucle).
create function private.can_read_conversation(p_org uuid, p_conversation uuid)
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

create policy conversations_select on public.conversations
  for select to authenticated
  using (
    private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[])
    or (private.has_role(organization_id, array['sales_agent']::public.app_role[]) and assignee_id = auth.uid())
  );
create policy messages_select on public.messages
  for select to authenticated
  using (private.can_read_conversation(organization_id, conversation_id));

-- ---------------------------------------------------------------------------
-- Libération des conversations d'un membre qui perd son rôle ou son accès (comme ses leads)
-- ---------------------------------------------------------------------------
create function private.release_conversations_of(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations c
     set assignee_id = null,
         state = case when c.state = 'closed' then c.state else 'to_triage' end
   where c.organization_id = p_org and c.assignee_id = p_user;
end;
$$;
create function private.release_conversation_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.release_conversations_of(old.organization_id, old.user_id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;
create trigger release_conversation_assignments
  after update of status on public.organization_members
  for each row
  when (old.status = 'active' and new.status is distinct from 'active')
  execute function private.release_conversation_assignments();
create trigger release_conversation_assignments_role
  after update of role on public.organization_members
  for each row
  when (old.role in ('company_owner', 'company_admin', 'sales_agent') and new.role not in ('company_owner', 'company_admin', 'sales_agent'))
  execute function private.release_conversation_assignments();
create trigger release_conversation_assignments_delete
  before delete on public.organization_members
  for each row
  execute function private.release_conversation_assignments();

-- ---------------------------------------------------------------------------
-- Services : assignation et état (utilisateur)
-- ---------------------------------------------------------------------------
create function private.lock_conversation_for_write(p_org uuid, p_conversation uuid)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.conversations;
  v_manager boolean;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_manager := p_org is not null and private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]);
  if not v_manager and not (p_org is not null and private.has_role(p_org, array['sales_agent']::public.app_role[])) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_conversation is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.conversations c where c.id = p_conversation and c.organization_id = p_org for update;
  if not found or (not v_manager and v_row.assignee_id is distinct from auth.uid()) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return v_row;
end;
$$;

-- Assigner (owner et admin) : le responsable doit être un membre assignable ; l'assigner sort la conversation de la file de tri, la désassigner l'y remet.
-- Ordre des verrous : le membre (assert_assignable, `for share`) PUIS la conversation, comme une suspension (membre puis conversations) : pas d'interblocage.
create function private.assign_conversation(p_org uuid, p_id uuid, p_assignee uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.conversations;
begin
  perform private.assert_project_manager(p_org);
  if p_assignee is not null then
    perform private.assert_assignable(p_org, p_assignee);
  end if;
  v_row := private.lock_conversation_for_write(p_org, p_id);
  update public.conversations
     set assignee_id = p_assignee,
         state = case when p_assignee is not null and v_row.state = 'to_triage' then 'open'
                      when p_assignee is null and v_row.state in ('open', 'pending') then 'to_triage'
                      else v_row.state end
   where organization_id = p_org and id = p_id;
end;
$$;

-- Changer l'état : owner et admin sur toute conversation, commercial sur les siennes ; `to_triage` n'a de sens que sans responsable,
-- `open` et `pending` exigent un responsable (le CHECK de la table l'impose aussi).
create function private.set_conversation_state(p_org uuid, p_id uuid, p_state text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.conversations;
begin
  if p_state is null or p_state not in ('open', 'pending', 'closed', 'to_triage') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_row := private.lock_conversation_for_write(p_org, p_id);
  if (p_state = 'to_triage' and v_row.assignee_id is not null) or (p_state in ('open', 'pending') and v_row.assignee_id is null) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.conversations set state = p_state where organization_id = p_org and id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Services : réception et envoi (service_role seulement, idempotents)
-- ---------------------------------------------------------------------------
create function private.conversation_get_or_create(p_org uuid, p_contact uuid, p_channel uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_org is null or p_contact is null or p_channel is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform 1 from public.channels ch where ch.organization_id = p_org and ch.id = p_channel and ch.status <> 'disconnected';
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  insert into public.conversations (organization_id, contact_id, channel_id)
  values (p_org, p_contact, p_channel)
  on conflict (organization_id, channel_id, contact_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return pg_catalog.jsonb_build_object('id', v_id, 'created', true);
  end if;
  select c.id into v_id from public.conversations c where c.organization_id = p_org and c.channel_id = p_channel and c.contact_id = p_contact;
  return pg_catalog.jsonb_build_object('id', v_id, 'created', false);
end;
$$;

-- Enregistre un message : ENTRANT (identifiant du fournisseur obligatoire, déduplication) ou SORTANT en file (clé d'idempotence obligatoire).
-- Un rejeu IDENTIQUE (même conversation, même corps) renvoie le message existant (`duplicate`) ; un rejeu qui le CONTREDIT (autre conversation ou autre
-- corps) est un conflit (`idempotency_conflict`). Les entrées sont validées AVANT l'insertion : une violation de CHECK recopierait le corps du message
-- dans le DETAIL de l'erreur. Met à jour `last_message_at` ; un message entrant rouvre un fil fermé.
create function private.message_record(
  p_org uuid, p_conversation uuid, p_direction text, p_provider_message_id text, p_body text, p_idempotency_key text, p_event_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations;
  v_existing public.messages;
  v_id uuid;
  v_at timestamptz := least(coalesce(p_event_at, pg_catalog.now()), pg_catalog.now() + interval '5 minutes');
begin
  if p_org is null or p_conversation is null or p_direction is null or p_direction not in ('inbound', 'outbound') or p_body is null
     or pg_catalog.char_length(p_body) not between 1 and 100000
     or (p_provider_message_id is not null and (pg_catalog.char_length(p_provider_message_id) not between 1 and 998 or p_provider_message_id !~ '^[A-Za-z0-9._:=+/@<>$%-]+$'))
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,200}$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if (p_direction = 'inbound' and p_provider_message_id is null) or (p_direction = 'outbound' and p_idempotency_key is null) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_conversation from public.conversations c where c.organization_id = p_org and c.id = p_conversation for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform 1 from public.channels ch where ch.organization_id = p_org and ch.id = v_conversation.channel_id and ch.status <> 'disconnected';
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if p_direction = 'inbound' then
    select * into v_existing from public.messages m
     where m.organization_id = p_org and m.channel_id = v_conversation.channel_id and m.provider_message_id = p_provider_message_id;
  else
    select * into v_existing from public.messages m where m.organization_id = p_org and m.idempotency_key = p_idempotency_key;
  end if;
  if found then
    if v_existing.conversation_id <> p_conversation or v_existing.direction <> p_direction or v_existing.body <> p_body then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('message_id', v_existing.id, 'duplicate', true);
  end if;
  if (select pg_catalog.count(*) from public.messages m where m.organization_id = p_org and m.conversation_id = p_conversation) >= 10000 then
    raise exception 'too_many_messages' using errcode = 'P0001';
  end if;
  if p_direction = 'inbound' then
    insert into public.messages (organization_id, conversation_id, channel_id, direction, provider_message_id, body, status, received_at)
    values (p_org, p_conversation, v_conversation.channel_id, 'inbound', p_provider_message_id, p_body, 'received', v_at)
    returning id into v_id;
  else
    insert into public.messages (organization_id, conversation_id, channel_id, direction, provider_message_id, body, status, idempotency_key)
    values (p_org, p_conversation, v_conversation.channel_id, 'outbound', p_provider_message_id, p_body, 'queued', p_idempotency_key)
    returning id into v_id;
  end if;
  update public.conversations
     set last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
         state = case when p_direction = 'inbound' and state = 'closed' then (case when assignee_id is null then 'to_triage' else 'open' end) else state end
   where organization_id = p_org and id = p_conversation;
  return pg_catalog.jsonb_build_object('message_id', v_id, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits et enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.conversations_guard() from public, anon, authenticated, service_role;
revoke all on function private.messages_guard() from public, anon, authenticated, service_role;
revoke all on function private.audit_conversations() from public, anon, authenticated, service_role;
revoke all on function private.can_read_conversation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.release_conversations_of(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.release_conversation_assignments() from public, anon, authenticated, service_role;
revoke all on function private.lock_conversation_for_write(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.assign_conversation(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.set_conversation_state(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.conversation_get_or_create(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.message_record(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
-- les politiques appellent can_read_conversation avec les droits de l'appelant
grant execute on function private.can_read_conversation(uuid, uuid) to authenticated;
grant execute on function private.assign_conversation(uuid, uuid, uuid) to authenticated;
grant execute on function private.set_conversation_state(uuid, uuid, text) to authenticated;
grant execute on function private.conversation_get_or_create(uuid, uuid, uuid) to service_role;
grant execute on function private.message_record(uuid, uuid, text, text, text, text, timestamptz) to service_role;

create function public.assign_conversation(p_org uuid, p_id uuid, p_assignee uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.assign_conversation(p_org, p_id, p_assignee); $$;
create function public.set_conversation_state(p_org uuid, p_id uuid, p_state text)
returns void language sql security invoker set search_path = ''
as $$ select private.set_conversation_state(p_org, p_id, p_state); $$;
create function public.conversation_get_or_create(p_org uuid, p_contact uuid, p_channel uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.conversation_get_or_create(p_org, p_contact, p_channel); $$;
create function public.message_record(p_org uuid, p_conversation uuid, p_direction text, p_provider_message_id text, p_body text, p_idempotency_key text, p_event_at timestamptz)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.message_record(p_org, p_conversation, p_direction, p_provider_message_id, p_body, p_idempotency_key, p_event_at); $$;

revoke all on function public.assign_conversation(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.set_conversation_state(uuid, uuid, text) from public, anon, service_role;
revoke all on function public.conversation_get_or_create(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.message_record(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.assign_conversation(uuid, uuid, uuid) to authenticated;
grant execute on function public.set_conversation_state(uuid, uuid, text) to authenticated;
grant execute on function public.conversation_get_or_create(uuid, uuid, uuid) to service_role;
grant execute on function public.message_record(uuid, uuid, text, text, text, text, timestamptz) to service_role;
