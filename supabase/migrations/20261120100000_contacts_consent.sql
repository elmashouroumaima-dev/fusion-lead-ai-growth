-- J18 — Contacts et consentement (spec §7 et §9, §13-3 ; ADR 007 G-D3, G-D4 ; ADR 014).
-- Retour arrière : supabase/rollbacks/20261120100000_contacts_consent.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * enums `channel_type` (email, whatsapp ; extensible) et `consent_status` (unknown, granted, revoked) ;
--  * ÉCRITURE UNIQUEMENT PAR FONCTIONS (SECURITY DEFINER, identité = auth.uid()), comme les projets : aucun droit INSERT /
--    UPDATE / DELETE direct, même pour service_role ; le quota « contacts » du plan ne peut pas être contourné ;
--  * rôles : owner, admin et marketing lisent et écrivent ; sales_agent (« own », via ses leads) et analyst (PII) n'ont AUCUN
--    accès au J18 : l'accès « own » du commercial arrive avec les leads (J19) ; ré-autoriser le « ne plus contacter » est
--    réservé à owner et admin ;
--  * la normalisation (e-mail, E.164) est faite par le domaine (libphonenumber) ; la base re-contrôle la FORME et la
--    cohérence e-mail saisi / e-mail normalisé (`lower(btrim(...))`) ;
--  * unicité EN BASE (aucune course entre deux soumissions identiques ne crée deux contacts) : index uniques partiels sur
--    (organization_id, email_normalized), (organization_id, phone_e164) et (organization_id, external_source, external_id) ;
--    la fusion automatique n'existe pas (conflit e-mail / téléphone = refus côté service) ;
--  * `consent_events` = source de vérité ; `contacts.consent_status` est DÉRIVÉ (granted : au moins un consentement non
--    révoqué ; revoked : des consentements, tous révoqués ; unknown : aucun) ; historique append-only (seule la date de
--    révocation peut s'ajouter), aucune suppression ; un nouvel enregistrement identique à un consentement actif est sans effet ;
--  * aucune suppression de contact (preuves de consentement) : l'effacement à la demande viendra avec la conformité ;
--  * audit : identifiants, canal et finalité seulement ; jamais le nom, l'e-mail, le téléphone ni la preuve.

create type public.channel_type as enum ('email', 'whatsapp');
create type public.consent_status as enum ('unknown', 'granted', 'revoked');

-- ---------------------------------------------------------------------------
-- Validations (fonctions pures, search_path vide)
-- ---------------------------------------------------------------------------
-- Couple e-mail saisi / e-mail normalisé : les deux nuls ou les deux présents, normalisé = lower(btrim(saisi)), forme ASCII.
create function private.is_valid_contact_email(p_raw text, p_normalized text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_raw is null and p_normalized is null then true
    when p_raw is null or p_normalized is null then false
    else private.is_safe_text(p_raw, 1, 254)
      and p_raw ~ '^[\x20-\x7e]+$'
      and p_normalized = pg_catalog.lower(pg_catalog.btrim(p_raw))
      and char_length(p_normalized) <= 254
      and p_normalized ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      and char_length(pg_catalog.split_part(p_normalized, '@', 1)) <= 64
      and pg_catalog.split_part(p_normalized, '@', 1) !~ '^\.|\.$|\.\.'
  end;
$$;

-- Attributs libres : objet plat de 8 Ko au plus.
create function private.is_valid_contact_attributes(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_entry record;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'object'
     or pg_catalog.octet_length(p_value::text) > 8192 or private.jsonb_depth(p_value) > 1 then
    return false;
  end if;
  -- Clés et valeurs textuelles : aucun caractère de contrôle, de direction ni invisible (usurpation d'affichage et d'export).
  for v_entry in select e.key, e.value from pg_catalog.jsonb_each(p_value) as e loop
    if not private.is_safe_text(v_entry.key, 1, 60) then return false; end if;
    if pg_catalog.jsonb_typeof(v_entry.value) = 'string' and not private.is_safe_text(v_entry.value #>> '{}', 1, 500) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Preuve de consentement : objet de 4 Ko au plus, clés connues, valeurs textuelles, URL en https.
create function private.is_valid_consent_proof(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'object' or pg_catalog.octet_length(p_value::text) > 4096 then
    return false;
  end if;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_value) as k loop
    if not (v_key = any (array['consent_text', 'consent_version', 'ip', 'url'])) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p_value -> v_key) <> 'string' then
      return false;
    end if;
  end loop;
  if p_value ? 'consent_text' and not private.is_safe_text(p_value ->> 'consent_text', 1, 2000, true) then return false; end if;
  if p_value ? 'consent_version' and not private.is_safe_text(p_value ->> 'consent_version', 1, 50) then return false; end if;
  if p_value ? 'ip' and (p_value ->> 'ip') !~ '^[0-9a-fA-F:.]{2,45}$' then return false; end if;
  if p_value ? 'url' and not private.is_safe_https_url(p_value ->> 'url') then return false; end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text,
  email_raw text,
  email_normalized text,
  phone_e164 text,
  language text,
  country text,
  consent_status public.consent_status not null default 'unknown',
  do_not_contact boolean not null default false,
  external_source text,
  external_id text,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_org_id_key unique (organization_id, id),
  constraint contacts_name_valid check (name is null or private.is_safe_text(name, 1, 200)),
  constraint contacts_email_valid check (private.is_valid_contact_email(email_raw, email_normalized)),
  constraint contacts_phone_valid check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint contacts_identifier_required check (email_normalized is not null or phone_e164 is not null),
  constraint contacts_language_valid check (language is null or language ~ '^[a-z]{2}$'),
  constraint contacts_country_valid check (country is null or country ~ '^[A-Z]{2}$'),
  constraint contacts_external_pair check ((external_source is null) = (external_id is null)),
  constraint contacts_external_source_valid check (external_source is null or private.is_safe_text(external_source, 1, 50)),
  constraint contacts_external_id_valid check (external_id is null or private.is_safe_text(external_id, 1, 200)),
  constraint contacts_attributes_valid check (private.is_valid_contact_attributes(attributes))
);
create index contacts_org_created_idx on public.contacts (organization_id, created_at desc);
create unique index contacts_org_email_key on public.contacts (organization_id, email_normalized) where email_normalized is not null;
create unique index contacts_org_phone_key on public.contacts (organization_id, phone_e164) where phone_e164 is not null;
create unique index contacts_org_external_key on public.contacts (organization_id, external_source, external_id) where external_id is not null;
comment on table public.contacts is 'Contacts d''une entreprise (spec §7). Écriture par fonctions uniquement (quota « contacts »). Données personnelles : lecture réservée à owner, admin et marketing.';

create table public.consent_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_id uuid not null,
  channel public.channel_type not null,
  purpose text not null,
  source text not null,
  proof jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint consent_events_org_id_key unique (organization_id, id),
  constraint consent_events_contact_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete restrict,
  constraint consent_events_purpose_valid check (purpose ~ '^[a-z][a-z0-9_]{0,49}$'),
  constraint consent_events_source_valid check (source ~ '^[a-z][a-z0-9_]{0,49}$'),
  constraint consent_events_proof_valid check (private.is_valid_consent_proof(proof)),
  constraint consent_events_revoked_after_capture check (revoked_at is null or revoked_at >= captured_at)
);
create index consent_events_org_contact_idx on public.consent_events (organization_id, contact_id, channel);
comment on table public.consent_events is 'Historique des consentements (source de vérité ; append-only : seule la date de révocation s''ajoute). Spec §9, ADR 007 G-D4.';

-- ---------------------------------------------------------------------------
-- Triggers : updated_at, immutabilité, append-only
-- ---------------------------------------------------------------------------
create trigger contacts_set_updated_at before update on public.contacts
  for each row execute function private.set_updated_at();
create trigger contacts_org_immutable before update on public.contacts
  for each row execute function private.prevent_organization_id_change();
create trigger consent_events_org_immutable before update on public.consent_events
  for each row execute function private.prevent_organization_id_change();

create function private.consent_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'consent events are append-only' using errcode = 'check_violation';
  end if;
  -- Seule la date de révocation peut passer de NULL à une valeur.
  if new.id is distinct from old.id or new.contact_id is distinct from old.contact_id
     or new.channel is distinct from old.channel or new.purpose is distinct from old.purpose
     or new.source is distinct from old.source or new.proof is distinct from old.proof
     or new.captured_at is distinct from old.captured_at
     or old.revoked_at is not null then
    raise exception 'consent events are append-only' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger consent_events_append_only before update or delete on public.consent_events
  for each row execute function private.consent_events_guard();

-- ---------------------------------------------------------------------------
-- Audit (identifiants, canal, finalité ; jamais d'identité de contact ni de preuve)
-- ---------------------------------------------------------------------------
create function private.audit_contacts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'contact.created', 'contact', new.id, null, '{}'::jsonb);
    return null;
  end if;

  if new.do_not_contact is distinct from old.do_not_contact then
    perform private.audit_write(
      new.organization_id, 'contact.do_not_contact_changed', 'contact', new.id,
      pg_catalog.jsonb_build_object('do_not_contact', old.do_not_contact),
      pg_catalog.jsonb_build_object('do_not_contact', new.do_not_contact));
  end if;

  if new.name is distinct from old.name then v_changed := pg_catalog.array_append(v_changed, 'name'::text); end if;
  if new.email_normalized is distinct from old.email_normalized or new.email_raw is distinct from old.email_raw then
    v_changed := pg_catalog.array_append(v_changed, 'email'::text);
  end if;
  if new.phone_e164 is distinct from old.phone_e164 then v_changed := pg_catalog.array_append(v_changed, 'phone'::text); end if;
  if new.language is distinct from old.language then v_changed := pg_catalog.array_append(v_changed, 'language'::text); end if;
  if new.country is distinct from old.country then v_changed := pg_catalog.array_append(v_changed, 'country'::text); end if;
  if new.external_source is distinct from old.external_source or new.external_id is distinct from old.external_id then
    v_changed := pg_catalog.array_append(v_changed, 'external'::text);
  end if;
  if new.attributes is distinct from old.attributes then v_changed := pg_catalog.array_append(v_changed, 'attributes'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(
      new.organization_id, 'contact.updated', 'contact', new.id, null, pg_catalog.jsonb_build_object('changed', v_changed));
  end if;
  return null;
end;
$$;

create function private.audit_consent_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(
      new.organization_id, 'consent.recorded', 'consent_event', new.id, null,
      pg_catalog.jsonb_build_object('contact_id', new.contact_id, 'channel', new.channel, 'purpose', new.purpose, 'source', new.source));
  elsif new.revoked_at is not null and old.revoked_at is null then
    perform private.audit_write(
      new.organization_id, 'consent.revoked', 'consent_event', new.id, null,
      pg_catalog.jsonb_build_object('contact_id', new.contact_id, 'channel', new.channel, 'purpose', new.purpose));
  end if;
  return null;
end;
$$;

create trigger audit_contacts after insert or update on public.contacts
  for each row execute function private.audit_contacts();
create trigger audit_consent_events after insert or update on public.consent_events
  for each row execute function private.audit_consent_events();

-- ---------------------------------------------------------------------------
-- RLS : lecture owner / admin / marketing ; aucune écriture directe
-- ---------------------------------------------------------------------------
alter table public.contacts enable row level security;
alter table public.consent_events enable row level security;

grant select on table public.contacts to authenticated;
grant select on table public.consent_events to authenticated;
revoke insert, update, delete, truncate on table public.contacts from service_role;
revoke insert, update, delete, truncate on table public.consent_events from service_role;

create policy contacts_select on public.contacts
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]));

create policy consent_events_select on public.consent_events
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Quota « contacts » : nombre de contacts de l'entreprise (remplace la version du J16)
-- ---------------------------------------------------------------------------
create or replace function private.current_stock_usage(p_org uuid, p_metric text)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_metric = 'users' then
    return (select count(*) from public.organization_members m where m.organization_id = p_org and m.status = 'active')
         + (select count(*) from public.invitations i
             where i.organization_id = p_org and i.accepted_at is null and i.revoked_at is null and i.expires_at > now());
  end if;
  if p_metric = 'projects' then
    return (select count(*) from public.projects p where p.organization_id = p_org and p.status = 'active');
  end if;
  if p_metric = 'contacts' then
    return (select count(*) from public.contacts c where c.organization_id = p_org);
  end if;
  -- integrations : table créée par son module (J28).
  return 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fonctions d'écriture (SECURITY DEFINER ; identité = auth.uid())
-- Codes d'erreur : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 (ou 23514 contrainte) · not_found PT404 ·
-- doublon 23505 · quota_exceeded P0001 (detail = contacts) · subscription_inactive P0001.
-- ---------------------------------------------------------------------------
create function private.assert_contact_manager(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or not private.has_role(p_org, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- Recalcule le statut dérivé d'un contact (appelée sous le verrou de sa ligne).
create function private.refresh_consent_status(p_org uuid, p_contact uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.contacts c
     set consent_status = case
           when exists (select 1 from public.consent_events e
                         where e.organization_id = p_org and e.contact_id = p_contact and e.revoked_at is null) then 'granted'::public.consent_status
           when exists (select 1 from public.consent_events e
                         where e.organization_id = p_org and e.contact_id = p_contact) then 'revoked'::public.consent_status
           else 'unknown'::public.consent_status
         end
   where c.id = p_contact and c.organization_id = p_org;
$$;

create function private.create_contact(
  p_org uuid, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text, p_language text, p_country text,
  p_external_source text, p_external_id text, p_attributes jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform private.assert_contact_manager(p_org);
  -- Quota « contacts » sous verrou consultatif ; les contraintes de la table valident ensuite chaque champ.
  perform private.assert_within_limit(p_org, 'contacts', 1);
  insert into public.contacts (
    id, organization_id, name, email_raw, email_normalized, phone_e164, language, country, external_source, external_id, attributes)
  values (
    v_id, p_org, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country, p_external_source, p_external_id,
    coalesce(p_attributes, '{}'::jsonb));
  return v_id;
end;
$$;

create function private.update_contact(
  p_org uuid, p_id uuid, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text, p_language text,
  p_country text, p_external_source text, p_external_id text, p_attributes jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.contacts;
  v_email_changed boolean;
  v_phone_changed boolean;
begin
  perform private.assert_contact_manager(p_org);
  if p_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_old from public.contacts c where c.id = p_id and c.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  v_email_changed := p_email_normalized is distinct from v_old.email_normalized;
  v_phone_changed := p_phone_e164 is distinct from v_old.phone_e164;
  -- Revue sécurité : sur un contact « ne plus contacter », changer d'identifiant libérerait l'ancien e-mail ou téléphone pour un
  -- nouveau contact sans restriction ; seuls owner et admin peuvent alors modifier l'identité (e-mail, téléphone, externe).
  if v_old.do_not_contact
     and (v_email_changed or v_phone_changed
          or p_external_source is distinct from v_old.external_source or p_external_id is distinct from v_old.external_id)
     and not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.contacts
     set name = p_name, email_raw = p_email_raw, email_normalized = p_email_normalized, phone_e164 = p_phone_e164,
         language = p_language, country = p_country, external_source = p_external_source, external_id = p_external_id,
         attributes = coalesce(p_attributes, '{}'::jsonb)
   where id = p_id and organization_id = p_org;
  -- Un consentement vaut pour UNE adresse : si l'identifiant du canal change, les consentements actifs de ce canal sont révoqués.
  if v_email_changed or v_phone_changed then
    update public.consent_events e set revoked_at = now()
     where e.organization_id = p_org and e.contact_id = p_id and e.revoked_at is null
       and ((v_email_changed and e.channel = 'email') or (v_phone_changed and e.channel = 'whatsapp'));
    perform private.refresh_consent_status(p_org, p_id);
  end if;
end;
$$;

-- Enregistre un consentement. Un consentement déjà actif pour le même canal et la même finalité : sans effet (renvoie son id).
create function private.record_consent(
  p_org uuid, p_contact uuid, p_channel public.channel_type, p_purpose text, p_source text, p_proof jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_contact public.contacts;
begin
  perform private.assert_contact_manager(p_org);
  if p_contact is null or p_channel is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_contact from public.contacts c where c.id = p_contact and c.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- Un consentement e-mail exige une adresse, un consentement WhatsApp un numéro (revue sécurité).
  if (p_channel = 'email' and v_contact.email_normalized is null) or (p_channel = 'whatsapp' and v_contact.phone_e164 is null) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select e.id into v_id from public.consent_events e
   where e.organization_id = p_org and e.contact_id = p_contact and e.channel = p_channel
     and e.purpose = p_purpose and e.revoked_at is null;
  if found then
    return v_id;
  end if;

  -- Plafond technique : l'historique est append-only (impossible à purger), sa croissance est bornée par contact.
  if (select count(*) from public.consent_events e where e.organization_id = p_org and e.contact_id = p_contact) >= 50 then
    raise exception 'too_many_consents' using errcode = 'P0001';
  end if;

  insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof)
  values (p_org, p_contact, p_channel, p_purpose, p_source, coalesce(p_proof, '{}'::jsonb))
  returning id into v_id;
  perform private.refresh_consent_status(p_org, p_contact);
  return v_id;
end;
$$;

-- Révoque les consentements actifs d'un canal (et d'une finalité si précisée) ; peut aussi bloquer tout envoi futur.
-- Renvoie le nombre de consentements révoqués. Effet immédiat ; la reprise des envois en attente est faite par le worker
-- au moment de l'envoi (contrôle final, spec §9.3).
create function private.revoke_consent(
  p_org uuid, p_contact uuid, p_channel public.channel_type, p_purpose text, p_do_not_contact boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.assert_contact_manager(p_org);
  if p_contact is null or p_channel is null or (p_purpose is not null and p_purpose !~ '^[a-z][a-z0-9_]{0,49}$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.contacts c where c.id = p_contact and c.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  update public.consent_events e set revoked_at = now()
   where e.organization_id = p_org and e.contact_id = p_contact and e.channel = p_channel and e.revoked_at is null
     and (p_purpose is null or e.purpose = p_purpose);
  get diagnostics v_count = row_count;

  if coalesce(p_do_not_contact, false) then
    update public.contacts set do_not_contact = true where id = p_contact and organization_id = p_org;
  end if;
  perform private.refresh_consent_status(p_org, p_contact);
  return v_count;
end;
$$;

-- « Ne plus contacter » : tout gestionnaire peut le poser ; seuls owner et admin peuvent le retirer.
create function private.set_do_not_contact(p_org uuid, p_contact uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_contact_manager(p_org);
  if p_contact is null or p_value is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if not p_value and not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform 1 from public.contacts c where c.id = p_contact and c.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.contacts set do_not_contact = p_value where id = p_contact and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits sur les fonctions privées puis enveloppes publiques (SECURITY INVOKER) : surface PostgREST
-- ---------------------------------------------------------------------------
revoke all on function private.is_valid_contact_email(text, text) from public, anon, authenticated, service_role;
revoke all on function private.is_valid_contact_attributes(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.is_valid_consent_proof(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.consent_events_guard() from public, anon, authenticated, service_role;
revoke all on function private.audit_contacts() from public, anon, authenticated, service_role;
revoke all on function private.audit_consent_events() from public, anon, authenticated, service_role;
revoke all on function private.assert_contact_manager(uuid) from public, anon, authenticated, service_role;
revoke all on function private.refresh_consent_status(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.update_contact(uuid, uuid, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.record_consent(uuid, uuid, public.channel_type, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.revoke_consent(uuid, uuid, public.channel_type, text, boolean) from public, anon, authenticated, service_role;
revoke all on function private.set_do_not_contact(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function private.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function private.update_contact(uuid, uuid, text, text, text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function private.record_consent(uuid, uuid, public.channel_type, text, text, jsonb) to authenticated;
grant execute on function private.revoke_consent(uuid, uuid, public.channel_type, text, boolean) to authenticated;
grant execute on function private.set_do_not_contact(uuid, uuid, boolean) to authenticated;

create function public.create_contact(
  p_org uuid, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text, p_language text, p_country text,
  p_external_source text, p_external_id text, p_attributes jsonb
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_contact(p_org, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country, p_external_source, p_external_id, p_attributes); $$;

create function public.update_contact(
  p_org uuid, p_id uuid, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text, p_language text,
  p_country text, p_external_source text, p_external_id text, p_attributes jsonb
)
returns void language sql security invoker set search_path = ''
as $$ select private.update_contact(p_org, p_id, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country, p_external_source, p_external_id, p_attributes); $$;

create function public.record_consent(
  p_org uuid, p_contact uuid, p_channel public.channel_type, p_purpose text, p_source text, p_proof jsonb
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.record_consent(p_org, p_contact, p_channel, p_purpose, p_source, p_proof); $$;

create function public.revoke_consent(
  p_org uuid, p_contact uuid, p_channel public.channel_type, p_purpose text, p_do_not_contact boolean
)
returns integer language sql security invoker set search_path = ''
as $$ select private.revoke_consent(p_org, p_contact, p_channel, p_purpose, p_do_not_contact); $$;

create function public.set_do_not_contact(p_org uuid, p_contact uuid, p_value boolean)
returns void language sql security invoker set search_path = ''
as $$ select private.set_do_not_contact(p_org, p_contact, p_value); $$;

revoke all on function public.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb) from public, anon, service_role;
revoke all on function public.update_contact(uuid, uuid, text, text, text, text, text, text, text, text, jsonb) from public, anon, service_role;
revoke all on function public.record_consent(uuid, uuid, public.channel_type, text, text, jsonb) from public, anon, service_role;
revoke all on function public.revoke_consent(uuid, uuid, public.channel_type, text, boolean) from public, anon, service_role;
revoke all on function public.set_do_not_contact(uuid, uuid, boolean) from public, anon, service_role;
grant execute on function public.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.update_contact(uuid, uuid, text, text, text, text, text, text, text, text, jsonb) to authenticated;
grant execute on function public.record_consent(uuid, uuid, public.channel_type, text, text, jsonb) to authenticated;
grant execute on function public.revoke_consent(uuid, uuid, public.channel_type, text, boolean) to authenticated;
grant execute on function public.set_do_not_contact(uuid, uuid, boolean) to authenticated;
