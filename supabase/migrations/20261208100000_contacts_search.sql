-- J30b — Écran contacts et consentement : recherche paginée des contacts (`search_contacts`) (plan J30b, spec §5.3 et §7, ADR 014).
-- Retour arrière : supabase/rollbacks/20261208100000_contacts_search.sql
--
-- Décisions :
--  * SECURITY INVOKER : la RLS de `contacts` s'applique à l'APPELANT (owner, admin, marketing ; le commercial ne voit que les contacts
--    de ses leads, l'analyste rien) ; le filtre d'entreprise est explicite en plus ;
--  * la recherche porte sur le nom, l'e-mail et le téléphone ; les caractères spéciaux sont ÉCHAPPÉS (`private.like_escape`, J24) :
--    une saisie n'est jamais un motif ; les index trigrammes de J24 servent la recherche ;
--  * pagination côté serveur (`p_limit` de 1 à 200, `p_offset` ≥ 0) ; le total est renvoyé avec chaque ligne ;
--  * aucune donnée de contact n'est écrite ailleurs : pas d'audit pour une simple lecture.

create function public.search_contacts(
  p_org uuid,
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  organization_id uuid,
  name text,
  email_raw text,
  email_normalized text,
  phone_e164 text,
  language text,
  country text,
  consent_status public.consent_status,
  do_not_contact boolean,
  external_source text,
  external_id text,
  attributes jsonb,
  created_at timestamptz,
  updated_at timestamptz,
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
  if p_org is null or p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 or p_offset > 1000000
     or pg_catalog.length(v_query) > 100 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_like := case when v_query = '' then null else '%' || private.like_escape(v_query) || '%' end;
  -- recherche par numéro : seulement les chiffres, sans les zéros de tête, au moins 3 chiffres (comme `search_leads`)
  v_digits := pg_catalog.ltrim(pg_catalog.regexp_replace(v_query, '[^0-9]', '', 'g'), '0');
  if pg_catalog.length(v_digits) < 3 then
    v_digits := null;
  end if;

  return query
  select c.id, c.organization_id, c.name, c.email_raw, c.email_normalized, c.phone_e164, c.language, c.country, c.consent_status,
         c.do_not_contact, c.external_source, c.external_id, c.attributes, c.created_at, c.updated_at,
         pg_catalog.count(*) over ()
    from public.contacts c
   where c.organization_id = p_org
     and (v_like is null
          or pg_catalog.lower(c.name) like v_like escape '\'
          or c.email_normalized like v_like escape '\'
          or (v_digits is not null and c.phone_e164 like '%' || v_digits || '%'))
   order by c.created_at desc, c.id
   limit p_limit offset p_offset;
end;
$$;

revoke all on function public.search_contacts(uuid, text, integer, integer) from public, anon, service_role;
grant execute on function public.search_contacts(uuid, text, integer, integer) to authenticated;
