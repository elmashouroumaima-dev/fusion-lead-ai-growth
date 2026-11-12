-- J24 — UI CRM : recherche de leads (`search_leads`) et audit des exports (`log_export`) (plan J24, spec §5.3 et §11, ADR 014).
-- Retour arrière : supabase/rollbacks/20261126100000_crm_search_export.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * `search_leads` est SECURITY INVOKER : la RLS de `leads`, `contacts` et `pipeline_stages` s'applique à l'APPELANT (owner, admin et
--    marketing voient tous les leads, le commercial les siens, l'analyste rien) ; le filtre d'entreprise est explicite en plus ;
--  * la recherche porte sur le nom, l'e-mail et le téléphone du contact ; les caractères spéciaux (`%`, `_`, `\`) sont ÉCHAPPÉS (une
--    saisie n'est jamais un motif) ; index trigrammes (`pg_trgm`) pour que la recherche reste rapide ;
--  * pagination côté serveur : `p_limit` de 1 à 10 000 (l'export), `p_offset` ≥ 0 ; le total est renvoyé avec chaque ligne ;
--  * `log_export` (owner et admin, ADR 014) écrit l'audit `export.created` : nombre de lignes et NOMS des filtres, jamais de valeur ni
--    de donnée de contact.

create extension if not exists pg_trgm with schema extensions;

-- Index trigrammes sur les champs recherchés (le téléphone et l'e-mail sont déjà normalisés en base).
create index contacts_name_trgm_idx on public.contacts using gin (lower(name) extensions.gin_trgm_ops);
create index contacts_email_trgm_idx on public.contacts using gin (email_normalized extensions.gin_trgm_ops);
create index contacts_phone_trgm_idx on public.contacts using gin (phone_e164 extensions.gin_trgm_ops);
create index leads_org_created_idx on public.leads (organization_id, created_at desc, id);

-- Échappe un texte saisi pour un LIKE : `\`, `%` et `_` perdent leur sens spécial.
create function private.like_escape(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_text, '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- ---------------------------------------------------------------------------
-- search_leads : liste filtrée, recherchée et paginée (RLS de l'appelant)
-- ---------------------------------------------------------------------------
create function public.search_leads(
  p_org uuid,
  p_project uuid default null,
  p_stage uuid default null,
  p_source text default null,
  p_assignee uuid default null,
  p_unassigned boolean default false,
  p_query text default null,
  p_sort text default 'created_desc',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  contact_id uuid,
  project_id uuid,
  source text,
  stage_id uuid,
  stage_name text,
  stage_kind public.stage_kind,
  assignee_id uuid,
  score integer,
  created_at timestamptz,
  updated_at timestamptz,
  contact_name text,
  contact_email text,
  contact_phone text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
  v_like text;
  v_digits text;
begin
  if p_org is null or p_limit is null or p_limit not between 1 and 10000 or p_offset is null or p_offset < 0 or p_offset > 1000000
     or p_sort is null or p_sort not in ('created_desc', 'created_asc', 'updated_desc', 'name_asc')
     or (p_source is not null and p_source !~ '^[a-z][a-z0-9_]{0,49}$')
     or pg_catalog.length(v_query) > 100 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_like := case when v_query = '' then null else '%' || private.like_escape(v_query) || '%' end;
  -- recherche par numéro : seulement les chiffres (« 06 12-34 » -> « 061234 »), SANS les zéros de tête (le numéro national « 06… » se
  -- retrouve dans « +2126… » ; « 00212… » aussi), au moins 3 chiffres
  v_digits := pg_catalog.ltrim(pg_catalog.regexp_replace(v_query, '[^0-9]', '', 'g'), '0');
  if pg_catalog.length(v_digits) < 3 then
    v_digits := null;
  end if;

  return query
  select l.id, l.contact_id, l.project_id, l.source, l.stage_id, s.name, s.kind, l.assignee_id, l.score, l.created_at, l.updated_at,
         c.name, c.email_raw, c.phone_e164,
         pg_catalog.count(*) over ()
    from public.leads l
    join public.contacts c on c.organization_id = l.organization_id and c.id = l.contact_id
    join public.pipeline_stages s on s.organization_id = l.organization_id and s.id = l.stage_id
   where l.organization_id = p_org
     and (p_project is null or l.project_id = p_project)
     and (p_stage is null or l.stage_id = p_stage)
     and (p_source is null or l.source = p_source)
     and (p_assignee is null or l.assignee_id = p_assignee)
     and (not p_unassigned or (s.kind = 'unassigned' and l.assignee_id is null))
     and (v_like is null
          or pg_catalog.lower(c.name) like v_like escape '\'
          or c.email_normalized like v_like escape '\'
          or (v_digits is not null and c.phone_e164 like '%' || v_digits || '%'))
   order by
     case when p_sort = 'created_desc' then l.created_at end desc,
     case when p_sort = 'created_asc' then l.created_at end asc,
     case when p_sort = 'updated_desc' then l.updated_at end desc,
     case when p_sort = 'name_asc' then pg_catalog.lower(c.name) end asc nulls last,
     l.id
   limit p_limit offset p_offset;
end;
$$;

-- ---------------------------------------------------------------------------
-- log_export : audit d'un export (owner et admin seulement)
-- ---------------------------------------------------------------------------
create function private.log_export(p_org uuid, p_kind text, p_count integer, p_filters jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_name text;
begin
  perform private.assert_project_manager(p_org);
  if p_kind is null or p_kind not in ('leads') or p_count is null or p_count not between 0 and 10000
     or p_filters is null or pg_catalog.jsonb_typeof(p_filters) <> 'object' or pg_catalog.pg_column_size(p_filters) > 1024 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- seuls les NOMS de filtres sont conservés (jamais leur valeur : une recherche peut contenir une adresse ou un téléphone)
  for v_name in select k from pg_catalog.jsonb_object_keys(p_filters) as k loop
    if v_name <> all (array['project', 'stage', 'source', 'assignee', 'unassigned', 'query', 'sort']) then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
  end loop;
  perform private.audit_write(p_org, 'export.created', 'export', v_id, null,
    pg_catalog.jsonb_build_object('kind', p_kind, 'rows', p_count, 'filters', (select coalesce(pg_catalog.jsonb_agg(k order by k), '[]'::jsonb) from pg_catalog.jsonb_object_keys(p_filters) as k)));
  return v_id;
end;
$$;

revoke all on function private.like_escape(text) from public, anon, authenticated, service_role;
revoke all on function private.log_export(uuid, text, integer, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.like_escape(text) to authenticated;
grant execute on function private.log_export(uuid, text, integer, jsonb) to authenticated;

create function public.log_export(p_org uuid, p_kind text, p_count integer, p_filters jsonb)
returns uuid language sql security invoker set search_path = '' as $$ select private.log_export(p_org, p_kind, p_count, p_filters); $$;

revoke all on function public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer) from public, anon, service_role;
revoke all on function public.log_export(uuid, text, integer, jsonb) from public, anon, service_role;
grant execute on function public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer) to authenticated;
grant execute on function public.log_export(uuid, text, integer, jsonb) to authenticated;
