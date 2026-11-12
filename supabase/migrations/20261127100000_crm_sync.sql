-- J25 — Adaptateur CRM : intégrations (version minimale), mapping de champs et synchro des contacts (spec §6, §9.1 étapes 5–6 ; ADR 007 E8).
-- Retour arrière : supabase/rollbacks/20261127100000_crm_sync.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * `integrations` est créée ICI en version minimale (`provider`, `status`, `external_account_id`, `last_sync_at`, `last_error`), car
--    `crm_field_mappings` (ADR 007) en dépend ; la colonne `secret_ref` et la gestion des secrets arrivent avec le J28. Écart assumé avec
--    l'ADR 007 : unicité par ENTREPRISE (et non globale) puisque les fournisseurs « csv » et « internal » n'ont pas de compte externe ;
--  * `crm_field_mappings` : champ interne <-> champ externe, `source_of_truth` (internal | external), `direction` (pull | push | both) ;
--    liste blanche des champs internes (aucune écriture libre) ; `external_id` obligatoire ; owner et admin, écriture par fonctions ;
--  * synchro de CONTACTS seulement au J25 : créer, rattacher (par e-mail ou téléphone, seulement un contact SANS identifiant externe) ou
--    mettre à jour (nom, langue, pays) ; l'identité n'est jamais écrasée ; un contact « ne plus contacter » n'est jamais modifié ;
--    AUCUN consentement n'est créé ni modifié ; unicité `(entreprise, external_source, external_id)` (G-D3) ;
--  * pas de table d'historique : le job `crm_sync` (file, G-D2) porte l'état et le rejeu ; `integrations.last_sync_at` / `last_error`
--    portent le résultat visible ; `last_sync_at` = DÉBUT de la dernière synchro réussie (côté fournisseur : une modification faite
--    pendant la synchro n'est jamais manquée) et `last_sync_finished_at` = FIN (côté interne : les écritures de la synchro elle-même ne
--    comptent pas comme des modifications humaines, donc pas de faux conflit à la synchro suivante) ;
--  * revue sécurité : l'identifiant externe est propre à CHAQUE intégration (`external_source` = `csv:<id de l'intégration>`), le lot de
--    fichier est « consommé » (statut `synced`, hors plafond des lots en cours, non importable une seconde fois), l'abonnement est
--    vérifié au démarrage, à la mise à jour et à l'enregistrement du mapping ;
--  * les fonctions du worker sont réservées à service_role et reçoivent l'entreprise de la LIGNE du job ; audit : identifiants, noms
--    de champs et compteurs, jamais de valeur.

-- Lot d'import CONSOMMÉ par une synchro : statut `synced` (ni importable ensuite, ni compté parmi les lots en cours).
alter table public.import_batches drop constraint import_batches_status_valid;
alter table public.import_batches add constraint import_batches_status_valid check (status in ('uploaded', 'queued', 'running', 'done', 'failed', 'cancelled', 'synced'));
alter table public.import_batches drop constraint import_batches_confirmed_valid;
alter table public.import_batches add constraint import_batches_confirmed_valid check (status in ('uploaded', 'cancelled', 'synced') or mapping is not null);

-- ---------------------------------------------------------------------------
-- integrations (minimale)
-- ---------------------------------------------------------------------------
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  provider text not null,
  status text not null default 'active',
  external_account_id text not null,
  last_sync_at timestamptz,
  last_sync_finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integrations_org_id_key unique (organization_id, id),
  constraint integrations_org_account_key unique (organization_id, provider, external_account_id),
  constraint integrations_provider_valid check (provider in ('csv', 'internal')),
  constraint integrations_status_valid check (status in ('active', 'disabled')),
  constraint integrations_account_valid check (external_account_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  constraint integrations_error_valid check (last_error is null or last_error in ('file_missing', 'file_malformed', 'mapping_invalid', 'failed'))
);
create index integrations_org_idx on public.integrations (organization_id, created_at desc);
comment on table public.integrations is 'Intégrations de l''entreprise (J25, version minimale ; secrets au J28). Écriture par fonctions uniquement.';
create trigger integrations_set_updated_at before update on public.integrations for each row execute function private.set_updated_at();
create trigger integrations_org_immutable before update on public.integrations for each row execute function private.prevent_organization_id_change();

create function private.audit_integrations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'integration.created', 'integration', new.id, null, pg_catalog.jsonb_build_object('provider', new.provider));
  end if;
  return null;
end;
$$;
create trigger audit_integrations after insert on public.integrations for each row execute function private.audit_integrations();

alter table public.integrations enable row level security;
revoke all on table public.integrations from authenticated;
grant select on table public.integrations to authenticated;
revoke insert, update, delete, truncate on table public.integrations from service_role;
create policy integrations_select on public.integrations
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- crm_field_mappings
-- ---------------------------------------------------------------------------
create table public.crm_field_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  integration_id uuid not null,
  entity text not null default 'contact',
  internal_field text not null,
  external_field text not null,
  source_of_truth text not null,
  direction text not null,
  created_at timestamptz not null default now(),
  constraint crm_field_mappings_org_id_key unique (organization_id, id),
  constraint crm_field_mappings_integration_fkey foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete cascade,
  constraint crm_field_mappings_internal_key unique (integration_id, entity, internal_field),
  constraint crm_field_mappings_external_key unique (integration_id, entity, external_field),
  constraint crm_field_mappings_entity_valid check (entity = 'contact'),
  constraint crm_field_mappings_internal_valid check (internal_field in ('external_id', 'external_updated_at', 'email', 'phone', 'name', 'language', 'country')),
  constraint crm_field_mappings_external_valid check (private.is_safe_text(external_field, 1, 100) and external_field = pg_catalog.btrim(external_field)),
  constraint crm_field_mappings_sot_valid check (source_of_truth in ('internal', 'external')),
  constraint crm_field_mappings_direction_valid check (direction in ('pull', 'push', 'both')),
  constraint crm_field_mappings_technical_pull check (internal_field not in ('external_id', 'external_updated_at') or direction = 'pull')
);
create index crm_field_mappings_integration_idx on public.crm_field_mappings (organization_id, integration_id);
comment on table public.crm_field_mappings is 'Mapping de champs d''une intégration (J25, ADR 007 E8). Écriture par fonctions uniquement.';

alter table public.crm_field_mappings enable row level security;
revoke all on table public.crm_field_mappings from authenticated;
grant select on table public.crm_field_mappings to authenticated;
revoke insert, update, delete, truncate on table public.crm_field_mappings from service_role;
create policy crm_field_mappings_select on public.crm_field_mappings
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Gestion (owner / admin)
-- ---------------------------------------------------------------------------
create function private.create_integration(p_org uuid, p_provider text, p_account text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_project_manager(p_org);
  if p_provider is null or p_provider not in ('csv', 'internal') or p_account is null or p_account !~ '^[A-Za-z0-9._-]{1,100}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  perform 1 from public.organizations o where o.id = p_org for update;
  perform private.assert_within_limit(p_org, 'integrations', 1);
  if (select count(*) from public.integrations i where i.organization_id = p_org) >= 20 then
    raise exception 'too_many_integrations' using errcode = 'P0001';
  end if;
  begin
    insert into public.integrations (organization_id, provider, external_account_id) values (p_org, p_provider, p_account) returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- Remplace TOUT le mapping d'une intégration (2 à 20 entrées, external_id obligatoire) ; les contraintes de la table valident chaque ligne.
create function private.save_crm_mappings(p_org uuid, p_integration uuid, p_mappings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_key text;
begin
  perform private.assert_project_manager(p_org);
  perform private.assert_subscription_active(p_org);
  if p_integration is null or p_mappings is null or pg_catalog.jsonb_typeof(p_mappings) <> 'array'
     or pg_catalog.jsonb_array_length(p_mappings) not between 2 and 20 or pg_catalog.pg_column_size(p_mappings) > 8192 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i where i.id = p_integration and i.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  for v_entry in select e from pg_catalog.jsonb_array_elements(p_mappings) as e loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object' then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
    for v_key in select k from pg_catalog.jsonb_object_keys(v_entry) as k loop
      if v_key <> all (array['entity', 'internal_field', 'external_field', 'source_of_truth', 'direction']) then
        raise exception 'validation_failed' using errcode = '22023';
      end if;
    end loop;
  end loop;
  if not exists (select 1 from pg_catalog.jsonb_array_elements(p_mappings) as e where e ->> 'internal_field' = 'external_id') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  delete from public.crm_field_mappings m where m.integration_id = p_integration and m.organization_id = p_org;
  begin
    insert into public.crm_field_mappings (organization_id, integration_id, entity, internal_field, external_field, source_of_truth, direction)
    select p_org, p_integration, coalesce(e ->> 'entity', 'contact'), e ->> 'internal_field', e ->> 'external_field', e ->> 'source_of_truth', e ->> 'direction'
      from pg_catalog.jsonb_array_elements(p_mappings) as e;
  exception when unique_violation or check_violation or not_null_violation then
    raise exception 'validation_failed' using errcode = '22023';
  end;
  perform private.audit_write(p_org, 'crm_mapping.saved', 'integration', p_integration, null,
    pg_catalog.jsonb_build_object('fields', pg_catalog.jsonb_array_length(p_mappings)));
end;
$$;

-- Demande une synchro : un fichier CSV DÉJÀ envoyé (assistant d'import, J23) est la source ; une seule synchro à la fois par intégration.
create function private.request_crm_sync(p_org uuid, p_integration uuid, p_batch uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_job uuid;
begin
  perform private.assert_project_manager(p_org);
  if p_integration is null or p_batch is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  select i.provider into v_provider from public.integrations i where i.id = p_integration and i.organization_id = p_org and i.status = 'active' for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_provider <> 'csv' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.crm_field_mappings m where m.integration_id = p_integration and m.organization_id = p_org and m.internal_field = 'external_id') then
    raise exception 'mapping_missing' using errcode = 'P0001';
  end if;
  perform 1 from public.import_batches b where b.id = p_batch and b.organization_id = p_org and b.status = 'uploaded';
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.jobs j where j.organization_id = p_org and j.kind = 'crm_sync' and j.payload ->> 'integration_id' = p_integration::text
              and j.status in ('queued', 'running')) then
    raise exception 'sync_in_progress' using errcode = 'P0001';
  end if;
  v_job := private.enqueue_job(p_org, 'crm_sync', pg_catalog.jsonb_build_object('integration_id', p_integration, 'batch_id', p_batch),
    'crm_sync:' || p_integration::text || ':' || p_batch::text);
  return v_job;
end;
$$;

-- Rejoue la dernière synchro en échec définitif (même fichier, même job : rejeu sans doublon grâce à l'identifiant externe).
create function private.retry_crm_sync(p_org uuid, p_integration uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job uuid;
begin
  perform private.assert_project_manager(p_org);
  if p_integration is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  perform 1 from public.integrations i where i.id = p_integration and i.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select j.id into v_job from public.jobs j
   where j.organization_id = p_org and j.kind = 'crm_sync' and j.payload ->> 'integration_id' = p_integration::text
   order by j.created_at desc, j.id desc limit 1;
  if v_job is null then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return private.replay_dead_letter(p_org, v_job);
end;
$$;

-- État visible : never | queued | running | ok | failed (dernier job) + dernière synchro réussie et dernière erreur (code).
create function private.crm_sync_status(p_org uuid, p_integration uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_int public.integrations;
  v_job public.jobs;
begin
  perform private.assert_project_manager(p_org);
  select * into v_int from public.integrations i where i.id = p_integration and i.organization_id = p_org;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select * into v_job from public.jobs j
   where j.organization_id = p_org and j.kind = 'crm_sync' and j.payload ->> 'integration_id' = p_integration::text
   order by j.created_at desc, j.id desc limit 1;
  return pg_catalog.jsonb_build_object(
    'status', case when v_job.id is null then 'never' when v_job.status = 'queued' then 'queued' when v_job.status = 'running' then 'running'
                   when v_job.status = 'succeeded' then 'ok' when v_job.status = 'dead_letter' then 'failed' else 'never' end,
    'job_id', v_job.id,
    'last_sync_at', v_int.last_sync_at,
    'last_error', v_int.last_error);
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker (service_role) : l'entreprise est celle de la ligne du job
-- ---------------------------------------------------------------------------
create function private.crm_sync_start(p_org uuid, p_integration uuid, p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_int public.integrations;
  v_path text;
begin
  if p_org is null or p_integration is null or p_batch is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  select * into v_int from public.integrations i where i.id = p_integration and i.organization_id = p_org;
  if not found or v_int.status <> 'active' then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  -- lot DÉJÀ consommé par cette synchro (rejeu d'un job terminé avant d'avoir été clos) : rien à refaire
  if exists (select 1 from public.import_batches b where b.id = p_batch and b.organization_id = p_org and b.status = 'synced') then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  select b.file_path into v_path from public.import_batches b where b.id = p_batch and b.organization_id = p_org and b.status = 'uploaded';
  if v_path is null then
    return pg_catalog.jsonb_build_object('status', 'file_missing');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'running', 'path', v_path, 'provider', v_int.provider, 'source', v_int.provider || ':' || v_int.id::text,
    'last_sync_at', v_int.last_sync_at, 'last_sync_finished_at', v_int.last_sync_finished_at, 'started_at', pg_catalog.now(),
    'mappings', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entity', m.entity, 'internal_field', m.internal_field,
                  'external_field', m.external_field, 'source_of_truth', m.source_of_truth, 'direction', m.direction) order by m.internal_field), '[]'::jsonb)
                   from public.crm_field_mappings m where m.integration_id = p_integration and m.organization_id = p_org));
end;
$$;

-- Contact déjà rattaché à cet identifiant externe, sinon contact RATTACHABLE (même e-mail ou téléphone, sans identifiant externe).
create function private.crm_sync_find(p_org uuid, p_provider text, p_external_id text, p_email_normalized text, p_phone_e164 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_linked boolean := true;
begin
  select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.external_source = p_provider and c.external_id = p_external_id;
  if not found then
    v_linked := false;
    if p_email_normalized is not null then
      select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.email_normalized = p_email_normalized;
    end if;
    if v_contact.id is null and p_phone_e164 is not null then
      select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.phone_e164 = p_phone_e164;
    end if;
    if v_contact.id is null then
      return null;
    end if;
    -- identité déjà liée à un AUTRE enregistrement externe : jamais rattaché
    if v_contact.external_id is not null then
      return pg_catalog.jsonb_build_object('status', 'identity_taken');
    end if;
  end if;
  return pg_catalog.jsonb_build_object('status', 'found', 'linked', v_linked, 'id', v_contact.id, 'name', v_contact.name, 'language', v_contact.language,
    'country', v_contact.country, 'updated_at', v_contact.updated_at, 'do_not_contact', v_contact.do_not_contact);
end;
$$;

create function private.crm_sync_create(
  p_org uuid, p_provider text, p_external_id text, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text, p_language text, p_country text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_subscription_active(p_org);
  if p_provider is null or p_provider !~ '^(csv|internal):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_external_id is null or not private.is_safe_text(p_external_id, 1, 200)
     or (p_email_normalized is null and p_phone_e164 is null) or not private.is_valid_contact_email(p_email_raw, p_email_normalized)
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$')
     or (p_name is not null and not private.is_safe_text(p_name, 1, 200))
     or (p_language is not null and p_language !~ '^[a-z]{2}$') or (p_country is not null and p_country !~ '^[A-Z]{2}$') then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  begin
    perform private.assert_within_limit(p_org, 'contacts', 1);
  exception when sqlstate 'P0001' then
    if sqlerrm = 'quota_exceeded' then
      return pg_catalog.jsonb_build_object('status', 'quota_exceeded');
    end if;
    raise;
  end;
  begin
    insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164, language, country, external_source, external_id)
    values (p_org, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country, p_provider, p_external_id)
    returning id into v_id;
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('status', 'exists');
  end;
  return pg_catalog.jsonb_build_object('status', 'created', 'id', v_id);
end;
$$;

-- Met à jour nom, langue, pays d'un contact (jamais l'identité, jamais un contact « ne plus contacter ») et le RATTACHE s'il n'a pas
-- d'identifiant externe.
create function private.crm_sync_update(p_org uuid, p_contact uuid, p_provider text, p_external_id text, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_key text;
begin
  if p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object' or p_provider is null or p_provider !~ '^(csv|internal):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  for v_key in select k from pg_catalog.jsonb_object_keys(p_fields) as k loop
    if v_key <> all (array['name', 'language', 'country']) then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
  end loop;
  select * into v_contact from public.contacts c where c.id = p_contact and c.organization_id = p_org for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  if v_contact.do_not_contact then
    return pg_catalog.jsonb_build_object('status', 'do_not_contact');
  end if;
  if v_contact.external_id is not null and (v_contact.external_source is distinct from p_provider or v_contact.external_id is distinct from p_external_id) then
    return pg_catalog.jsonb_build_object('status', 'identity_taken');
  end if;
  begin
    update public.contacts
       set name = case when p_fields ? 'name' then p_fields ->> 'name' else name end,
           language = case when p_fields ? 'language' then p_fields ->> 'language' else language end,
           country = case when p_fields ? 'country' then p_fields ->> 'country' else country end,
           external_source = coalesce(external_source, p_provider),
           external_id = coalesce(external_id, p_external_id)
     where id = p_contact and organization_id = p_org;
  exception when check_violation or unique_violation then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end;
  return pg_catalog.jsonb_build_object('status', 'updated');
end;
$$;

-- Conflits résolus par la source de vérité : noms de champs et gagnant seulement (jamais de valeur).
create function private.crm_sync_audit_conflict(p_org uuid, p_integration uuid, p_contact uuid, p_conflicts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c jsonb;
begin
  if p_conflicts is null or pg_catalog.jsonb_typeof(p_conflicts) <> 'array' or pg_catalog.jsonb_array_length(p_conflicts) not between 1 and 5 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i where i.id = p_integration and i.organization_id = p_org;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  for v_c in select e from pg_catalog.jsonb_array_elements(p_conflicts) as e loop
    if (v_c ->> 'field') is null or (v_c ->> 'field') <> all (array['name', 'language', 'country']) or (v_c ->> 'winner') is null or (v_c ->> 'winner') <> all (array['internal', 'external']) then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
  end loop;
  perform private.audit_write(p_org, 'crm_sync.conflict', 'contact', p_contact, null,
    pg_catalog.jsonb_build_object('integration_id', p_integration, 'conflicts', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('field', e ->> 'field', 'winner', e ->> 'winner')) from pg_catalog.jsonb_array_elements(p_conflicts) as e)));
end;
$$;

create function private.crm_sync_finish(p_org uuid, p_integration uuid, p_batch uuid, p_started_at timestamptz, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_started_at is null or p_started_at > pg_catalog.now() + interval '1 minute' or p_counts is null or pg_catalog.jsonb_typeof(p_counts) <> 'object' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_counts) as k loop
    if v_key <> all (array['created', 'updated', 'linked', 'unchanged', 'skipped', 'rejected', 'conflicts']) or (p_counts ->> v_key) !~ '^[0-9]{1,6}$' then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
  end loop;
  update public.integrations
     set last_sync_at = greatest(coalesce(last_sync_at, p_started_at), p_started_at), last_sync_finished_at = pg_catalog.now(), last_error = null
   where id = p_integration and organization_id = p_org;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- le lot de fichier est CONSOMMÉ : plus importable ni synchronisable, libère un des 10 emplacements de lots en cours
  update public.import_batches set status = 'synced', finished_at = pg_catalog.now() where id = p_batch and organization_id = p_org and status = 'uploaded';
  perform private.audit_write(p_org, 'crm_sync.completed', 'integration', p_integration, null, p_counts);
end;
$$;

create function private.crm_sync_fail(p_org uuid, p_integration uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code is null or p_code not in ('file_missing', 'file_malformed', 'mapping_invalid', 'failed') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.integrations set last_error = p_code where id = p_integration and organization_id = p_org;
  if found then
    perform private.audit_write(p_org, 'crm_sync.failed', 'integration', p_integration, null, pg_catalog.jsonb_build_object('error', p_code));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits puis enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.audit_integrations() from public, anon, authenticated, service_role;
revoke all on function private.create_integration(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.save_crm_mappings(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.request_crm_sync(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.retry_crm_sync(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_status(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_start(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_find(uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_create(uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_update(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_audit_conflict(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.crm_sync_fail(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.create_integration(uuid, text, text) to authenticated;
grant execute on function private.save_crm_mappings(uuid, uuid, jsonb) to authenticated;
grant execute on function private.request_crm_sync(uuid, uuid, uuid) to authenticated;
grant execute on function private.retry_crm_sync(uuid, uuid) to authenticated;
grant execute on function private.crm_sync_status(uuid, uuid) to authenticated;
grant execute on function private.crm_sync_start(uuid, uuid, uuid) to service_role;
grant execute on function private.crm_sync_find(uuid, text, text, text, text) to service_role;
grant execute on function private.crm_sync_create(uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function private.crm_sync_update(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function private.crm_sync_audit_conflict(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function private.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb) to service_role;
grant execute on function private.crm_sync_fail(uuid, uuid, text) to service_role;

create function public.create_integration(p_org uuid, p_provider text, p_account text)
returns uuid language sql security invoker set search_path = '' as $$ select private.create_integration(p_org, p_provider, p_account); $$;
create function public.save_crm_mappings(p_org uuid, p_integration uuid, p_mappings jsonb)
returns void language sql security invoker set search_path = '' as $$ select private.save_crm_mappings(p_org, p_integration, p_mappings); $$;
create function public.request_crm_sync(p_org uuid, p_integration uuid, p_batch uuid)
returns uuid language sql security invoker set search_path = '' as $$ select private.request_crm_sync(p_org, p_integration, p_batch); $$;
create function public.retry_crm_sync(p_org uuid, p_integration uuid)
returns boolean language sql security invoker set search_path = '' as $$ select private.retry_crm_sync(p_org, p_integration); $$;
create function public.crm_sync_status(p_org uuid, p_integration uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$ select private.crm_sync_status(p_org, p_integration); $$;
create function public.crm_sync_start(p_org uuid, p_integration uuid, p_batch uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.crm_sync_start(p_org, p_integration, p_batch); $$;
create function public.crm_sync_find(p_org uuid, p_provider text, p_external_id text, p_email_normalized text, p_phone_e164 text)
returns jsonb language sql stable security invoker set search_path = '' as $$ select private.crm_sync_find(p_org, p_provider, p_external_id, p_email_normalized, p_phone_e164); $$;
create function public.crm_sync_create(
  p_org uuid, p_provider text, p_external_id text, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text, p_language text, p_country text
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.crm_sync_create(p_org, p_provider, p_external_id, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country); $$;
create function public.crm_sync_update(p_org uuid, p_contact uuid, p_provider text, p_external_id text, p_fields jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.crm_sync_update(p_org, p_contact, p_provider, p_external_id, p_fields); $$;
create function public.crm_sync_audit_conflict(p_org uuid, p_integration uuid, p_contact uuid, p_conflicts jsonb)
returns void language sql security invoker set search_path = '' as $$ select private.crm_sync_audit_conflict(p_org, p_integration, p_contact, p_conflicts); $$;
create function public.crm_sync_finish(p_org uuid, p_integration uuid, p_batch uuid, p_started_at timestamptz, p_counts jsonb)
returns void language sql security invoker set search_path = '' as $$ select private.crm_sync_finish(p_org, p_integration, p_batch, p_started_at, p_counts); $$;
create function public.crm_sync_fail(p_org uuid, p_integration uuid, p_code text)
returns void language sql security invoker set search_path = '' as $$ select private.crm_sync_fail(p_org, p_integration, p_code); $$;

revoke all on function public.create_integration(uuid, text, text) from public, anon, service_role;
revoke all on function public.save_crm_mappings(uuid, uuid, jsonb) from public, anon, service_role;
revoke all on function public.request_crm_sync(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.retry_crm_sync(uuid, uuid) from public, anon, service_role;
revoke all on function public.crm_sync_status(uuid, uuid) from public, anon, service_role;
revoke all on function public.crm_sync_start(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.crm_sync_find(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.crm_sync_create(uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.crm_sync_update(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.crm_sync_audit_conflict(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.crm_sync_fail(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_integration(uuid, text, text) to authenticated;
grant execute on function public.save_crm_mappings(uuid, uuid, jsonb) to authenticated;
grant execute on function public.request_crm_sync(uuid, uuid, uuid) to authenticated;
grant execute on function public.retry_crm_sync(uuid, uuid) to authenticated;
grant execute on function public.crm_sync_status(uuid, uuid) to authenticated;
grant execute on function public.crm_sync_start(uuid, uuid, uuid) to service_role;
grant execute on function public.crm_sync_find(uuid, text, text, text, text) to service_role;
grant execute on function public.crm_sync_create(uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.crm_sync_update(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.crm_sync_audit_conflict(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb) to service_role;
grant execute on function public.crm_sync_fail(uuid, uuid, text) to service_role;
