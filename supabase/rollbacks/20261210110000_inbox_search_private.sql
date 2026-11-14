-- Retour arrière de 20261210110000_inbox_search_private.sql
-- Remet `search_conversations` en SECURITY DEFINER dans `public` (comme J37 ; le lint L10 échoue de nouveau). Aucune donnée n'est touchée.

drop function public.search_conversations(uuid, text, text, uuid, boolean, text, integer, integer, uuid);
drop function private.search_conversations(uuid, text, text, uuid, boolean, text, integer, integer, uuid);

create function public.search_conversations(
  p_org uuid,
  p_state text default null,
  p_channel text default null,
  p_assignee uuid default null,
  p_unassigned boolean default false,
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_conversation uuid default null
)
returns table (
  id uuid,
  contact_id uuid,
  channel_id uuid,
  assignee_id uuid,
  state text,
  last_message_at timestamptz,
  contact_name text,
  contact_email text,
  contact_phone text,
  channel_type public.channel_type,
  last_direction text,
  last_status text,
  last_preview text,
  last_truncated boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
  v_like text;
  v_digits text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 or p_offset > 1000000
     or (p_state is not null and p_state not in ('open', 'pending', 'closed', 'to_triage'))
     or (p_channel is not null and p_channel not in ('email', 'whatsapp'))
     or pg_catalog.length(v_query) > 100 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_like := case when v_query = '' then null else '%' || private.like_escape(v_query) || '%' end;
  v_digits := pg_catalog.ltrim(pg_catalog.regexp_replace(v_query, '[^0-9]', '', 'g'), '0');
  if pg_catalog.length(v_digits) < 3 then
    v_digits := null;
  end if;

  return query
  select c.id, c.contact_id, c.channel_id, c.assignee_id, c.state::text, c.last_message_at,
         k.name, k.email_raw, k.phone_e164, ch.type,
         lm.direction, lm.status, lm.preview, lm.truncated,
         pg_catalog.count(*) over ()
    from public.conversations c
    join public.contacts k on k.organization_id = c.organization_id and k.id = c.contact_id
    join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id
    left join lateral (
      select m.direction, m.status,
             pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.left(m.body, 600), '\s+', ' ', 'g'), 140) as preview,
             pg_catalog.length(m.body) > 140 as truncated
        from public.messages m
       where m.organization_id = c.organization_id and m.conversation_id = c.id
       order by m.created_at desc, m.id
       limit 1
    ) lm on true
   where c.organization_id = p_org
     and private.can_read_conversation(c.organization_id, c.id)
     and (p_conversation is null or c.id = p_conversation)
     and (p_state is null or c.state::text = p_state)
     and (p_channel is null or ch.type::text = p_channel)
     and (p_assignee is null or c.assignee_id = p_assignee)
     and (not p_unassigned or c.assignee_id is null)
     and (v_like is null
          or pg_catalog.lower(k.name) like v_like escape '\'
          or k.email_normalized like v_like escape '\'
          or (v_digits is not null and k.phone_e164 like '%' || v_digits || '%'))
   order by c.last_message_at desc nulls last, c.id
   limit p_limit offset p_offset;
end;
$$;

revoke all on function public.search_conversations(uuid, text, text, uuid, boolean, text, integer, integer, uuid) from public, anon, service_role;
grant execute on function public.search_conversations(uuid, text, text, uuid, boolean, text, integer, integer, uuid) to authenticated;
