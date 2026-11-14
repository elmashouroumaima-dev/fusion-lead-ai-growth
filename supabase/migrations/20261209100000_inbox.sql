-- J37 — Boîte de réception unifiée : liste des conversations (`search_conversations`), plan J37, spec §5.5 et §9.3, ADR 005 (décision 13),
-- ADR 007 (E4), ADR 014 (lignes « Conversations »), ADR 013 (polling).
-- Retour arrière : supabase/rollbacks/20261209100000_inbox.sql
--
-- Pourquoi une fonction : la liste a besoin, en une lecture, du NOM du contact, du TYPE du canal et d'un APERÇU du dernier message.
-- Le commercial ne lit ni `channels` (owner et admin seulement, ADR 014) ni les contacts sans lead : une jointure sous sa RLS
-- ne donnerait rien. La fonction est donc SECURITY DEFINER, mais elle **réapplique exactement les droits de lecture des
-- conversations** (`private.can_read_conversation` : owner et admin toutes les conversations de l'entreprise, le commercial
-- SES conversations ; marketing et analyste aucune) et n'expose que : identifiants, nom / e-mail / téléphone du contact, type du canal,
-- état, responsable, aperçu tronqué (140 caractères, espaces réduits) du dernier message, jamais le corps entier, jamais l'identifiant
-- du fournisseur ni la clé d'envoi.
--  * saisie échappée (`private.like_escape`, J24) : une saisie n'est jamais un motif ; recherche de téléphone par chiffres ;
--  * pagination côté serveur : `p_limit` de 1 à 100, `p_offset` ≥ 0 ; le total est renvoyé avec chaque ligne ;
--  * `p_conversation` : une seule conversation (en-tête du fil), mêmes droits de lecture ;
--  * l'entreprise est TOUJOURS celle passée par le serveur à partir du contexte vérifié ; sans adhésion adéquate : aucune ligne.

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
