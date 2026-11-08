-- J21 — Capture publique de leads : clés de formulaire et `capture_lead` (spec §9.1, §13-3 ; ADR 007 `form_keys`, G-D3).
-- Retour arrière : supabase/rollbacks/20261123100000_form_keys_capture.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * `form_keys` (ADR 007) : par projet, clé GÉNÉRÉE PAR LA BASE, jamais stockée en clair (empreinte SHA-256) ; la clé claire n'est
--    renvoyée qu'à la création ; `key_prefix` (8 caractères, non secret) permet de la reconnaître dans une liste (petit écart
--    avec l'ADR 007) ; origines autorisées : 1 à 10 origines https exactes (aucun joker, aucune IP, aucun hôte interne) ;
--    5 clés actives au plus par projet ; une clé ne se supprime pas, elle se révoque ;
--  * gérée par owner et admin ; lecture : owner et admin, SANS la colonne `key_hash` ;
--  * `capture_lead` (réservée à service_role : le site public ne passe que par la route, qui limite le débit) retrouve
--    l'entreprise et le projet PAR LA CLÉ, vérifie l'origine, puis, dans UNE transaction : contact (déduplication),
--    lead, consentement, job d'assignation ; l'entreprise ne vient jamais du corps de la requête ;
--  * déduplication : contact retrouvé par e-mail, sinon par téléphone ; conflit (e-mail d'un contact, téléphone d'un autre) :
--    rattachement au contact de l'e-mail, sans toucher au téléphone ; aucune fusion de données ; même contact et même projet :
--    le lead encore OUVERT est réutilisé (nouveau lead seulement si l'ancien est gagné ou perdu) ; la ligne du contact est
--    verrouillée, donc deux soumissions simultanées donnent un contact et un lead ;
--  * clé invalide, inactive, origine refusée, projet archivé : UNE seule erreur (`form_key_invalid`), aucun oracle ;
--  * consentement enregistré seulement s'il vise l'adresse stockée sur le contact (jamais attaché à une autre adresse) ;
--  * job `lead.assign` enregistré à la création d'un lead (traitement au J22) ;
--  * audit : acteur « système » ; identifiants et noms de champs seulement.

-- ---------------------------------------------------------------------------
-- Validation des origines
-- ---------------------------------------------------------------------------
create function private.is_valid_form_origins(p_origins text[])
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_origin text;
begin
  if p_origins is null or pg_catalog.cardinality(p_origins) not between 1 and 10 then
    return false;
  end if;
  foreach v_origin in array p_origins loop
    -- origine = schéma + hôte (+ port) : minuscules, sans chemin, valide selon la règle des URL https du projet
    if v_origin is null or v_origin <> pg_catalog.lower(v_origin) or v_origin !~ '^https://[^/?#]+$'
       or not private.is_safe_https_url(v_origin || '/') then
      return false;
    end if;
  end loop;
  return (select pg_catalog.count(distinct o) from pg_catalog.unnest(p_origins) as o) = pg_catalog.cardinality(p_origins);
end;
$$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.form_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  project_id uuid not null,
  key_hash text not null,
  key_prefix text not null,
  allowed_origins text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint form_keys_org_id_key unique (organization_id, id),
  constraint form_keys_hash_key unique (key_hash),
  constraint form_keys_project_fkey foreign key (organization_id, project_id)
    references public.projects (organization_id, id) on delete restrict,
  constraint form_keys_hash_valid check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint form_keys_prefix_valid check (key_prefix ~ '^flk_[0-9a-f]{4}$'),
  constraint form_keys_origins_valid check (private.is_valid_form_origins(allowed_origins))
);
create index form_keys_org_project_idx on public.form_keys (organization_id, project_id);
comment on table public.form_keys is 'Clés des formulaires publics (ADR 007). Clé claire jamais stockée : empreinte SHA-256. Écriture par fonctions uniquement.';

create trigger form_keys_set_updated_at before update on public.form_keys for each row execute function private.set_updated_at();
create trigger form_keys_org_immutable before update on public.form_keys for each row execute function private.prevent_organization_id_change();

create function private.form_keys_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id or new.key_hash is distinct from old.key_hash or new.key_prefix is distinct from old.key_prefix then
    raise exception 'form key project and secret are immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger form_keys_immutable before update on public.form_keys for each row execute function private.form_keys_immutable();

-- Audit : identifiants, préfixe (non secret) et noms de champs ; jamais l'empreinte ni la clé.
create function private.audit_form_keys()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'form_key.created', 'form_key', new.id, null,
      pg_catalog.jsonb_build_object('project_id', new.project_id, 'key_prefix', new.key_prefix));
    return null;
  end if;
  if new.active is distinct from old.active then
    perform private.audit_write(new.organization_id, case when new.active then 'form_key.activated' else 'form_key.revoked' end,
      'form_key', new.id, pg_catalog.jsonb_build_object('active', old.active), pg_catalog.jsonb_build_object('active', new.active));
  end if;
  if new.allowed_origins is distinct from old.allowed_origins then
    perform private.audit_write(new.organization_id, 'form_key.updated', 'form_key', new.id, null,
      pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('allowed_origins')));
  end if;
  return null;
end;
$$;
create trigger audit_form_keys after insert or update on public.form_keys for each row execute function private.audit_form_keys();

-- ---------------------------------------------------------------------------
-- RLS : lecture owner / admin, SANS key_hash ; aucune écriture directe
-- ---------------------------------------------------------------------------
alter table public.form_keys enable row level security;
revoke all on table public.form_keys from authenticated;
grant select (id, organization_id, project_id, key_prefix, allowed_origins, active, created_at, updated_at) on table public.form_keys to authenticated;
revoke insert, update, delete, truncate on table public.form_keys from service_role;

create policy form_keys_select on public.form_keys
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Gestion des clés (owner / admin)
-- ---------------------------------------------------------------------------
-- Crée une clé : renvoie la clé CLAIRE une seule fois ({ id, key, key_prefix }).
create function private.create_form_key(p_org uuid, p_project uuid, p_origins text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.project_status;
  v_raw text;
  v_key text;
  v_id uuid := gen_random_uuid();
begin
  perform private.assert_project_manager(p_org);
  if p_project is null or not private.is_valid_form_origins(p_origins) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  select p.status into v_status from public.projects p where p.id = p_project and p.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  if (select count(*) from public.form_keys k where k.organization_id = p_org and k.project_id = p_project and k.active) >= 5 then
    raise exception 'too_many_form_keys' using errcode = 'P0001';
  end if;
  -- 64 caractères hexadécimaux = deux UUID v4 aléatoires (≈ 244 bits) ; seule l'empreinte est conservée.
  v_raw := pg_catalog.replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_key := 'flk_' || v_raw;
  insert into public.form_keys (id, organization_id, project_id, key_hash, key_prefix, allowed_origins)
  values (v_id, p_org, p_project,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_key, 'UTF8')), 'hex'),
          pg_catalog.substr(v_key, 1, 8), p_origins);
  return pg_catalog.jsonb_build_object('id', v_id, 'key', v_key, 'key_prefix', pg_catalog.substr(v_key, 1, 8));
end;
$$;

create function private.set_form_key_active(p_org uuid, p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key public.form_keys;
begin
  perform private.assert_project_manager(p_org);
  if p_id is null or p_active is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_key from public.form_keys k where k.id = p_id and k.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if p_active and not v_key.active then
    perform 1 from public.projects p where p.id = v_key.project_id and p.organization_id = p_org for update;
    if (select count(*) from public.form_keys k where k.organization_id = p_org and k.project_id = v_key.project_id and k.active) >= 5 then
      raise exception 'too_many_form_keys' using errcode = 'P0001';
    end if;
  end if;
  update public.form_keys set active = p_active where id = p_id and organization_id = p_org;
end;
$$;

create function private.set_form_key_origins(p_org uuid, p_id uuid, p_origins text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_manager(p_org);
  if p_id is null or not private.is_valid_form_origins(p_origins) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.form_keys k where k.id = p_id and k.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.form_keys set allowed_origins = p_origins where id = p_id and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Capture publique (service_role seulement : appelée par la route, qui limite le débit)
-- ---------------------------------------------------------------------------
-- Origine autorisée pour AU MOINS une clé active d'un projet actif (préflight CORS) ; ne révèle rien d'autre.
create function private.form_origin_allowed(p_origin text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_origin is not null and exists (
    select 1 from public.form_keys k
      join public.projects p on p.organization_id = k.organization_id and p.id = k.project_id
     where k.active and p.status = 'active' and p_origin = any (k.allowed_origins)
  );
$$;

-- Clé active d'un projet actif ET origine de cette clé, sans rien écrire (la route n'ouvre un seau de débit par clé que pour une clé
-- qui existe, et n'envoie les en-têtes CORS qu'à l'origine de CETTE clé).
create function private.form_key_origin_ok(p_key_hash text, p_origin text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_key_hash is not null and p_origin is not null and exists (
    select 1 from public.form_keys k
      join public.projects p on p.organization_id = k.organization_id and p.id = k.project_id
     where k.key_hash = p_key_hash and k.active and p.status = 'active' and p_origin = any (k.allowed_origins)
  );
$$;

create function private.capture_lead(
  p_key_hash text, p_origin text, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text,
  p_language text, p_country text, p_utm jsonb, p_consent jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key public.form_keys;
  v_org uuid;
  v_project uuid;
  v_contact public.contacts;
  v_contact_created boolean := false;
  v_lead uuid;
  v_lead_created boolean := false;
  v_stage uuid;
  v_pipeline uuid;
  v_channel text;
  v_purpose text;
  v_proof jsonb;
  v_consent_recorded boolean := false;
begin
  -- 1. La clé donne l'entreprise et le projet ; clé inconnue / inactive, origine refusée, projet archivé : une seule erreur.
  select k.* into v_key from public.form_keys k
    join public.projects p on p.organization_id = k.organization_id and p.id = k.project_id
   where p_key_hash is not null and k.key_hash = p_key_hash and k.active and p.status = 'active'
     and p_origin is not null and p_origin = any (k.allowed_origins);
  if not found then
    raise exception 'form_key_invalid' using errcode = 'P0001';
  end if;
  v_org := v_key.organization_id;
  v_project := v_key.project_id;

  if (p_email_normalized is null and p_phone_e164 is null)
     or not private.is_valid_contact_email(p_email_raw, p_email_normalized)
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$')
     or (p_name is not null and not private.is_safe_text(p_name, 1, 200))
     or (p_language is not null and p_language !~ '^[a-z]{2}$')
     or (p_country is not null and p_country !~ '^[A-Z]{2}$')
     or not private.is_valid_lead_utm(coalesce(p_utm, '{}'::jsonb)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(v_org);

  -- 2. Contact : e-mail d'abord, puis téléphone ; création sous quota si aucun ne correspond.
  if p_email_normalized is not null then
    select c.* into v_contact from public.contacts c where c.organization_id = v_org and c.email_normalized = p_email_normalized;
  end if;
  if v_contact.id is null and p_phone_e164 is not null then
    select c.* into v_contact from public.contacts c where c.organization_id = v_org and c.phone_e164 = p_phone_e164;
  end if;
  if v_contact.id is null then
    perform private.assert_within_limit(v_org, 'contacts', 1);
    begin
      insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164, language, country)
      values (v_org, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country)
      returning * into v_contact;
      v_contact_created := true;
    exception when unique_violation then
      -- soumission simultanée identique : on reprend le contact gagnant
      if p_email_normalized is not null then
        select c.* into v_contact from public.contacts c where c.organization_id = v_org and c.email_normalized = p_email_normalized;
      end if;
      if v_contact.id is null and p_phone_e164 is not null then
        select c.* into v_contact from public.contacts c where c.organization_id = v_org and c.phone_e164 = p_phone_e164;
      end if;
      if v_contact.id is null then
        raise exception 'form_capture_failed' using errcode = 'P0001';
      end if;
    end;
  end if;
  -- Verrou de la ligne du contact : sérialise le lead et le consentement des soumissions simultanées.
  select c.* into v_contact from public.contacts c where c.id = v_contact.id and c.organization_id = v_org for update;
  -- Revue sécurité : un contact « ne plus contacter » ne reçoit ni nouveau lead, ni job d'assignation, ni consentement par la
  -- capture publique (n'importe qui connaissant son adresse pourrait sinon le réactiver) ; la soumission est acceptée sans effet.
  if v_contact.do_not_contact then
    return pg_catalog.jsonb_build_object('contact_created', v_contact_created, 'lead_created', false, 'consent_recorded', false);
  end if;

  -- 3. Lead : on réutilise le lead encore OUVERT du même contact et du même projet.
  select l.id into v_lead
    from public.leads l
    join public.pipeline_stages s on s.organization_id = l.organization_id and s.id = l.stage_id
   where l.organization_id = v_org and l.contact_id = v_contact.id and l.project_id = v_project and s.kind in ('open', 'unassigned')
   order by l.created_at, l.id limit 1;
  if v_lead is null then
    if (select count(*) from public.leads l where l.organization_id = v_org and l.contact_id = v_contact.id) >= 50 then
      raise exception 'too_many_leads' using errcode = 'P0001';
    end if;
    select p.id into v_pipeline from public.pipelines p where p.organization_id = v_org and p.is_default;
    v_stage := private.first_stage_of_kind(v_org, v_pipeline, 'unassigned'::public.stage_kind);
    if v_stage is null then
      raise exception 'pipeline_incomplete' using errcode = 'P0001';
    end if;
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id, utm)
    values (v_org, v_contact.id, v_project, 'web_form', v_stage, coalesce(p_utm, '{}'::jsonb))
    returning id into v_lead;
    v_lead_created := true;
    -- Assignation : traitée par le worker (J22) ; en cas d'échec le lead reste dans la file « non assignés ».
    perform private.enqueue_job(v_org, 'lead.assign', pg_catalog.jsonb_build_object('lead_id', v_lead), 'lead.assign:' || v_lead::text);
  end if;

  -- 4. Consentement : texte, version, IP et page, seulement pour l'adresse stockée sur le contact.
  if p_consent is not null then
    if pg_catalog.jsonb_typeof(p_consent) <> 'object' then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
    v_channel := p_consent ->> 'channel';
    v_purpose := coalesce(p_consent ->> 'purpose', 'marketing');
    v_proof := coalesce(p_consent -> 'proof', '{}'::jsonb);
    if v_channel is null or v_channel not in ('email', 'whatsapp') or v_purpose not in ('marketing', 'newsletter')
       or not private.is_valid_consent_proof(v_proof) then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
    if ((v_channel = 'email' and p_email_normalized is not null and v_contact.email_normalized = p_email_normalized)
        or (v_channel = 'whatsapp' and p_phone_e164 is not null and v_contact.phone_e164 = p_phone_e164))
       and not exists (select 1 from public.consent_events e
                        where e.organization_id = v_org and e.contact_id = v_contact.id and e.channel = v_channel::public.channel_type
                          and e.purpose = v_purpose and e.revoked_at is null)
       -- Revue sécurité : jamais de re-consentement par la voie publique après une révocation sur ce canal (adresse non vérifiée).
       and not exists (select 1 from public.consent_events e
                        where e.organization_id = v_org and e.contact_id = v_contact.id and e.channel = v_channel::public.channel_type
                          and e.revoked_at is not null)
       and (select count(*) from public.consent_events e where e.organization_id = v_org and e.contact_id = v_contact.id) < 50 then
      insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof)
      values (v_org, v_contact.id, v_channel::public.channel_type, v_purpose, 'web_form', v_proof);
      perform private.refresh_consent_status(v_org, v_contact.id);
      v_consent_recorded := true;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('contact_created', v_contact_created, 'lead_created', v_lead_created, 'consent_recorded', v_consent_recorded);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits puis enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.is_valid_form_origins(text[]) from public, anon, authenticated, service_role;
revoke all on function private.form_keys_immutable() from public, anon, authenticated, service_role;
revoke all on function private.audit_form_keys() from public, anon, authenticated, service_role;
revoke all on function private.create_form_key(uuid, uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function private.set_form_key_active(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.set_form_key_origins(uuid, uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function private.form_origin_allowed(text) from public, anon, authenticated, service_role;
revoke all on function private.form_key_origin_ok(text, text) from public, anon, authenticated, service_role;
revoke all on function private.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.create_form_key(uuid, uuid, text[]) to authenticated;
grant execute on function private.set_form_key_active(uuid, uuid, boolean) to authenticated;
grant execute on function private.set_form_key_origins(uuid, uuid, text[]) to authenticated;
grant execute on function private.form_origin_allowed(text) to service_role;
grant execute on function private.form_key_origin_ok(text, text) to service_role;
grant execute on function private.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb) to service_role;

create function public.create_form_key(p_org uuid, p_project uuid, p_origins text[])
returns jsonb language sql security invoker set search_path = '' as $$ select private.create_form_key(p_org, p_project, p_origins); $$;
create function public.set_form_key_active(p_org uuid, p_id uuid, p_active boolean)
returns void language sql security invoker set search_path = '' as $$ select private.set_form_key_active(p_org, p_id, p_active); $$;
create function public.set_form_key_origins(p_org uuid, p_id uuid, p_origins text[])
returns void language sql security invoker set search_path = '' as $$ select private.set_form_key_origins(p_org, p_id, p_origins); $$;
create function public.form_origin_allowed(p_origin text)
returns boolean language sql security invoker set search_path = '' as $$ select private.form_origin_allowed(p_origin); $$;
create function public.form_key_origin_ok(p_key_hash text, p_origin text)
returns boolean language sql security invoker set search_path = '' as $$ select private.form_key_origin_ok(p_key_hash, p_origin); $$;
create function public.capture_lead(
  p_key_hash text, p_origin text, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text,
  p_language text, p_country text, p_utm jsonb, p_consent jsonb
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.capture_lead(p_key_hash, p_origin, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country, p_utm, p_consent); $$;

revoke all on function public.create_form_key(uuid, uuid, text[]) from public, anon, service_role;
revoke all on function public.set_form_key_active(uuid, uuid, boolean) from public, anon, service_role;
revoke all on function public.set_form_key_origins(uuid, uuid, text[]) from public, anon, service_role;
revoke all on function public.form_origin_allowed(text) from public, anon, authenticated;
revoke all on function public.form_key_origin_ok(text, text) from public, anon, authenticated;
revoke all on function public.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_form_key(uuid, uuid, text[]) to authenticated;
grant execute on function public.set_form_key_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.set_form_key_origins(uuid, uuid, text[]) to authenticated;
grant execute on function public.form_origin_allowed(text) to service_role;
grant execute on function public.form_key_origin_ok(text, text) to service_role;
grant execute on function public.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb) to service_role;
