-- J9 — Création transactionnelle d'une organisation (ADR 005 §11, G-R7).
-- Sources : spec §2, §7, §10, §11 ; ADR 005 §4–§7, §11 ; ADR 006 (conventions) ; ADR 007 (G-R7) ; ADR 014.
-- Retour arrière : supabase/rollbacks/20261106140000_organizations_create.sql
--
-- Décisions validées par la responsable technique (J9) :
--  * organizations reçoit created_by et creation_key (idempotence de la création) ;
--  * PAS de pipeline par défaut au J9 (la table pipelines arrive au J19, qui étendra la fonction) ;
--  * le slug est généré côté SQL (nom normalisé ASCII + suffixe aléatoire), sans plafond par utilisateur ;
--  * abonnement d'essai : plan 'trial', statut 'trial', period_start = now(), period_end NULL
--    (aucune durée d'essai n'est définie dans la spec : rien n'est inventé ici).
--
-- Sécurité :
--  * private.create_organization est SECURITY DEFINER (elle écrit dans des tables sans INSERT
--    possible pour authenticated), search_path vide, noms qualifiés ; l'identité vient UNIQUEMENT
--    de auth.uid() (aucun paramètre « user id » : un client ne peut pas créer pour autrui) ;
--  * public.create_organization est un simple wrapper SECURITY INVOKER (L10 : aucune SECURITY
--    DEFINER dans public) exposé à la Data API pour le seul rôle authenticated ;
--  * aucune politique INSERT n'est ajoutée ; les GRANT par colonne de J7 sont inchangés, donc
--    created_by et creation_key ne sont modifiables par aucun client.

-- ---------------------------------------------------------------------------
-- Colonnes d'idempotence et de traçabilité
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column created_by uuid references auth.users (id) on delete set null,
  add column creation_key text;

alter table public.organizations
  add constraint organizations_creation_key_length check (
    creation_key is null or char_length(creation_key) between 8 and 128
  );

-- Une clé d'idempotence est unique PAR créateur (deux utilisateurs peuvent utiliser la même valeur).
create unique index organizations_created_by_creation_key_key
  on public.organizations (created_by, creation_key)
  where creation_key is not null;

comment on column public.organizations.created_by is
  'Utilisateur ayant créé l''entreprise (auth.uid() de private.create_organization). Écriture serveur uniquement.';
comment on column public.organizations.creation_key is
  'Clé d''idempotence fournie par le client (Idempotency-Key) ; unique par créateur. Écriture serveur uniquement.';

-- ---------------------------------------------------------------------------
-- private.create_organization : transaction unique organisation + owner + abonnement d'essai
-- ---------------------------------------------------------------------------
create function private.create_organization(
  p_name text,
  p_locale text,
  p_timezone text,
  p_creation_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_name text;
  v_existing public.organizations%rowtype;
  v_org_id uuid;
  v_base text;
  v_slug text;
  v_attempt integer := 0;
  v_constraint text;
  v_plan_id uuid;
begin
  -- Identité : uniquement le JWT vérifié par PostgREST (jamais un paramètre).
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Validation (les messages ne contiennent jamais la valeur saisie).
  v_name := btrim(p_name, E' \t\r\n');
  -- Nom : 1..120 caractères, au moins une lettre/un chiffre (Unicode, arabe inclus), aucun caractère
  -- de contrôle (C0 / DEL / C1), de format ou bidi invisible, ni séparateur de ligne/paragraphe.
  -- (U+0000 ne peut pas atteindre une valeur text : le rejet se fait en amont, avant cette fonction.)
  if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 120
     or v_name !~ '[[:alnum:]]'
     or v_name ~ '[\u0001-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\ufeff]' then
    raise exception 'validation_failed' using errcode = '22023', detail = 'name';
  end if;
  if p_locale is null or p_locale not in ('ar', 'en') then
    raise exception 'validation_failed' using errcode = '22023', detail = 'locale';
  end if;
  -- Fuseau : 'UTC' ou nom IANA région/ville (sensible à la casse), connu du moteur sous ce nom exact.
  if p_timezone is null
     or not (p_timezone = 'UTC' or p_timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$')
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception 'validation_failed' using errcode = '22023', detail = 'timezone';
  end if;
  if p_creation_key is not null
     and (char_length(p_creation_key) < 8 or char_length(p_creation_key) > 128) then
    raise exception 'validation_failed' using errcode = '22023', detail = 'creation_key';
  end if;

  -- Idempotence : même (utilisateur, clé) => même organisation, sans rien recréer.
  -- Le verrou consultatif sérialise deux requêtes simultanées portant la même clé.
  if p_creation_key is not null then
    perform pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_uid::text || ':' || p_creation_key, 0)
    );
    select o.* into v_existing
      from public.organizations o
     where o.created_by = v_uid and o.creation_key = p_creation_key;
    if found then
      if v_existing.name <> v_name
         or v_existing.locale <> p_locale
         or v_existing.timezone <> p_timezone then
        raise exception 'idempotency_conflict' using errcode = 'P0001';
      end if;
      return v_existing.id;
    end if;
  end if;

  -- Slug : nom normalisé ASCII (accents retirés), 'org' si aucune lettre/chiffre ASCII,
  -- suffixe aléatoire de 6 hexadécimaux ; nouvel essai si le slug existe déjà.
  v_base := lower(regexp_replace(normalize(v_name, NFD), '[\u0300-\u036f]', '', 'g'));
  v_base := btrim(regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'), '-');
  v_base := btrim(left(v_base, 40), '-');
  if v_base = '' then
    v_base := 'org';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    begin
      insert into public.organizations (name, slug, timezone, locale, created_by, creation_key)
      values (v_name, v_slug, p_timezone, p_locale, v_uid, p_creation_key)
      returning id into v_org_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'organizations_slug_key' or v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.organization_members (organization_id, user_id, role, status, invited_by)
  values (v_org_id, v_uid, 'company_owner', 'active', null);

  select p.id into v_plan_id from public.plans p where p.code = 'trial';
  if v_plan_id is null then
    raise exception 'trial_plan_missing' using errcode = 'XX000';
  end if;
  insert into public.subscriptions (organization_id, plan_id, status, period_start, period_end)
  values (v_org_id, v_plan_id, 'trial', now(), null);

  -- J19 : la création du pipeline par défaut sera ajoutée ici (aucun pipeline au J9).
  return v_org_id;
end;
$$;

revoke all on function private.create_organization(text, text, text, text) from public;
grant execute on function private.create_organization(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- public.create_organization : wrapper SECURITY INVOKER exposé à la Data API (POST /rpc)
-- ---------------------------------------------------------------------------
create function public.create_organization(
  p_name text,
  p_locale text default 'ar',
  p_timezone text default 'UTC',
  p_creation_key text default null
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.create_organization(p_name, p_locale, p_timezone, p_creation_key);
$$;

revoke all on function public.create_organization(text, text, text, text) from public;
revoke all on function public.create_organization(text, text, text, text) from anon;
revoke all on function public.create_organization(text, text, text, text) from service_role;
grant execute on function public.create_organization(text, text, text, text) to authenticated;
