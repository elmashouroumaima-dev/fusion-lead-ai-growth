-- J23 — Import CSV de leads : lots d'import, rapport par ligne, bucket privé `imports` et fonctions réservées au worker (spec §9.1, plan J23).
-- Retour arrière : supabase/rollbacks/20261125100000_imports.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * tables `import_batches` et `import_rows` et bucket privé `imports` : AJOUTS à l'ADR 007 (addendum J23), absents de la spec ;
--  * envoi, aperçu, confirmation et annulation : owner et admin (comme les clés de formulaire) ; le fichier est envoyé avec les droits
--    de l'UTILISATEUR (politiques Storage), au chemin `{entreprise}/{lot}.csv` ; le lot est enregistré ensuite par `create_import_batch`,
--    qui vérifie le chemin, l'existence de l'objet, le projet actif et l'abonnement ;
--  * RIEN n'est écrit dans les contacts avant `confirm_import` ; la confirmation crée un job `import_csv` {batch_id} (charge utile
--    sans donnée de contact) ;
--  * le worker (service_role, entreprise de la LIGNE DU JOB) lit le fichier ligne par ligne et appelle `import_row` : même dédup que la
--    capture publique (e-mail d'abord, puis téléphone, sans fusion de données), lead « non assigné » source `csv_import` + job
--    `lead.assign`, contact « ne plus contacter » ignoré, quota « contacts » respecté ;
--  * AUCUN consentement n'est créé par un import (un fichier ne prouve rien) : statut « inconnu » ;
--  * rejeu : chaque ligne est enregistrée une seule fois (`import_rows`, clé lot + ligne) ; un job rejoué reprend sans doublon ;
--  * rapport (`import_rows`) : numéro de ligne, résultat et motif (codes), JAMAIS de donnée de contact ; audit : identifiants et compteurs.

-- ---------------------------------------------------------------------------
-- Bucket privé `imports` : CSV, 10 Mo
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, 10485760, array['text/csv', 'text/plain'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Chemin : {entreprise}/{lot}.csv (deux UUID).
create function private.import_path_ok(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name is not null
     and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$';
$$;

-- Lecture, écriture et suppression : owner ou admin actif de l'entreprise du chemin.
create function private.can_manage_import_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.import_path_ok(p_name) then
    return false;
  end if;
  return private.has_role(pg_catalog.split_part(p_name, '/', 1)::uuid, array['company_owner', 'company_admin']::public.app_role[]);
end;
$$;

revoke all on function private.import_path_ok(text) from public, anon, authenticated, service_role;
revoke all on function private.can_manage_import_path(text) from public, anon, authenticated, service_role;
grant execute on function private.import_path_ok(text) to authenticated;
grant execute on function private.can_manage_import_path(text) to authenticated;

create policy imports_select on storage.objects
  for select to authenticated
  using (bucket_id = 'imports' and private.can_manage_import_path(name));
create policy imports_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imports' and private.can_manage_import_path(name));
create policy imports_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'imports' and private.can_manage_import_path(name));

-- ---------------------------------------------------------------------------
-- Mapping des colonnes : objet { name | email | phone | language | country : rang 0..49 }, e-mail ou téléphone, rangs distincts
-- ---------------------------------------------------------------------------
create function private.is_valid_import_mapping(p_mapping jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_entry record;
  v_seen integer[] := '{}';
begin
  if p_mapping is null or pg_catalog.jsonb_typeof(p_mapping) <> 'object' or pg_catalog.pg_column_size(p_mapping) > 512 then
    return false;
  end if;
  if not (p_mapping ? 'email' or p_mapping ? 'phone') then
    return false;
  end if;
  for v_entry in select key, value from pg_catalog.jsonb_each(p_mapping) loop
    if v_entry.key <> all (array['name', 'email', 'phone', 'language', 'country']) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(v_entry.value) <> 'number' or (v_entry.value #>> '{}') !~ '^[0-9]{1,2}$'
       or (v_entry.value #>> '{}')::integer > 49 or (v_entry.value #>> '{}')::integer = any (v_seen) then
      return false;
    end if;
    v_seen := pg_catalog.array_append(v_seen, (v_entry.value #>> '{}')::integer);
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- import_batches
-- ---------------------------------------------------------------------------
create table public.import_batches (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  project_id uuid not null,
  created_by uuid,
  status text not null default 'uploaded',
  file_path text not null,
  file_size integer not null,
  mapping jsonb,
  default_country text,
  row_count integer,
  created_count integer not null default 0,
  matched_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint import_batches_org_id_key unique (organization_id, id),
  constraint import_batches_path_key unique (file_path),
  constraint import_batches_project_fkey foreign key (organization_id, project_id)
    references public.projects (organization_id, id) on delete restrict,
  constraint import_batches_status_valid check (status in ('uploaded', 'queued', 'running', 'done', 'failed', 'cancelled')),
  constraint import_batches_path_valid check (private.import_path_ok(file_path) and file_path = organization_id::text || '/' || id::text || '.csv'),
  constraint import_batches_size_valid check (file_size between 1 and 10485760),
  constraint import_batches_mapping_valid check (mapping is null or private.is_valid_import_mapping(mapping)),
  constraint import_batches_country_valid check (default_country is null or default_country ~ '^[A-Z]{2}$'),
  constraint import_batches_rows_valid check (row_count is null or row_count between 0 and 10000),
  constraint import_batches_counts_valid check (created_count >= 0 and matched_count >= 0 and skipped_count >= 0 and error_count >= 0),
  constraint import_batches_error_code_valid check (
    error_code is null or error_code in ('file_missing', 'file_malformed', 'too_many_rows', 'subscription_inactive', 'project_archived', 'failed')),
  constraint import_batches_confirmed_valid check (status in ('uploaded', 'cancelled') or mapping is not null)
);
create index import_batches_org_idx on public.import_batches (organization_id, created_at desc);
create index import_batches_org_status_idx on public.import_batches (organization_id, status);
comment on table public.import_batches is 'Lots d''import CSV (J23). Écriture par fonctions uniquement ; aucune donnée de contact.';

create trigger import_batches_set_updated_at before update on public.import_batches for each row execute function private.set_updated_at();
create trigger import_batches_org_immutable before update on public.import_batches for each row execute function private.prevent_organization_id_change();

create function private.import_batches_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id or new.file_path is distinct from old.file_path or new.file_size is distinct from old.file_size
     or new.created_by is distinct from old.created_by then
    raise exception 'import batch project and file are immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger import_batches_immutable before update on public.import_batches for each row execute function private.import_batches_immutable();

create function private.audit_import_batches()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'import.uploaded', 'import_batch', new.id, null,
      pg_catalog.jsonb_build_object('project_id', new.project_id, 'file_size', new.file_size));
    return null;
  end if;
  if new.status is distinct from old.status then
    perform private.audit_write(new.organization_id, 'import.' || case new.status when 'done' then 'completed' else new.status end, 'import_batch', new.id,
      pg_catalog.jsonb_build_object('status', old.status),
      pg_catalog.jsonb_build_object('status', new.status, 'created', new.created_count, 'matched', new.matched_count,
        'skipped', new.skipped_count, 'errors', new.error_count, 'error_code', new.error_code));
  end if;
  return null;
end;
$$;
create trigger audit_import_batches after insert or update on public.import_batches for each row execute function private.audit_import_batches();

alter table public.import_batches enable row level security;
revoke all on table public.import_batches from authenticated;
-- le chemin du fichier et le mapping ne sont pas nécessaires à l'affichage : seuls les compteurs et l'état sont lisibles
grant select (id, organization_id, project_id, status, file_size, row_count, created_count, matched_count, skipped_count, error_count,
  error_code, created_at, updated_at, started_at, finished_at) on table public.import_batches to authenticated;
revoke insert, update, delete, truncate on table public.import_batches from service_role;
create policy import_batches_select on public.import_batches
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- import_rows : rapport par ligne (codes seulement)
-- ---------------------------------------------------------------------------
create table public.import_rows (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  batch_id uuid not null,
  row_no integer not null,
  outcome text not null,
  reason text,
  lead_created boolean not null default false,
  contact_id uuid,
  created_at timestamptz not null default now(),
  primary key (batch_id, row_no),
  constraint import_rows_batch_fkey foreign key (organization_id, batch_id)
    references public.import_batches (organization_id, id) on delete cascade,
  constraint import_rows_contact_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete restrict,
  constraint import_rows_row_valid check (row_no between 1 and 10001),
  constraint import_rows_outcome_valid check (outcome in ('created', 'matched', 'skipped', 'error')),
  constraint import_rows_reason_valid check (
    reason is null or reason in ('no_identifier', 'invalid_email', 'invalid_phone', 'invalid_name', 'invalid_language', 'invalid_country',
      'duplicate_in_file', 'do_not_contact', 'quota_exceeded', 'too_many_leads', 'failed')),
  constraint import_rows_error_has_reason check (outcome <> 'error' or reason is not null)
);
create index import_rows_org_batch_idx on public.import_rows (organization_id, batch_id, row_no);
create index import_rows_contact_idx on public.import_rows (organization_id, contact_id) where contact_id is not null;
comment on table public.import_rows is 'Rapport d''un import CSV (J23) : numéro de ligne, résultat, motif. Jamais de donnée de contact.';

alter table public.import_rows enable row level security;
revoke all on table public.import_rows from authenticated;
grant select (organization_id, batch_id, row_no, outcome, reason, lead_created, created_at) on table public.import_rows to authenticated;
revoke insert, update, delete, truncate on table public.import_rows from service_role;
create policy import_rows_select on public.import_rows
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Gestion d'un lot (owner / admin)
-- ---------------------------------------------------------------------------
-- Enregistre un fichier DÉJÀ envoyé au chemin {entreprise}/{lot}.csv ; l'identifiant du lot est celui du chemin.
create function private.create_import_batch(p_org uuid, p_project uuid, p_path text, p_size integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status public.project_status;
begin
  perform private.assert_project_manager(p_org);
  if p_project is null or p_size is null or p_size not between 1 and 10485760 or not private.import_path_ok(p_path)
     or pg_catalog.split_part(p_path, '/', 1) <> p_org::text then
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
  perform 1 from storage.objects o where o.bucket_id = 'imports' and o.name = p_path;
  if not found then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Plafonds techniques : 10 lots en cours et 500 lots par période de 90 jours par entreprise (revue sécurité : plus de plafond définitif).
  if (select count(*) from public.import_batches b where b.organization_id = p_org and b.status in ('uploaded', 'queued', 'running')) >= 10
     or (select count(*) from public.import_batches b where b.organization_id = p_org and b.created_at > now() - interval '90 days') >= 500 then
    raise exception 'too_many_imports' using errcode = 'P0001';
  end if;
  v_id := pg_catalog.split_part(pg_catalog.split_part(p_path, '/', 2), '.', 1)::uuid;
  begin
    insert into public.import_batches (id, organization_id, project_id, created_by, file_path, file_size)
    values (v_id, p_org, p_project, auth.uid(), p_path, p_size);
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- Lecture SEULE : parmi les e-mails et téléphones proposés (1000 au plus de chaque), ceux qui sont déjà des contacts de l'entreprise.
create function private.import_dedup_check(p_org uuid, p_emails text[], p_phones text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_emails text[];
  v_phones text[];
begin
  perform private.assert_project_manager(p_org);
  if pg_catalog.cardinality(coalesce(p_emails, '{}'::text[])) > 1000 or pg_catalog.cardinality(coalesce(p_phones, '{}'::text[])) > 1000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(c.email_normalized), '{}'::text[]) into v_emails
    from public.contacts c where c.organization_id = p_org and c.email_normalized = any (coalesce(p_emails, '{}'::text[]));
  select coalesce(pg_catalog.array_agg(c.phone_e164), '{}'::text[]) into v_phones
    from public.contacts c where c.organization_id = p_org and c.phone_e164 = any (coalesce(p_phones, '{}'::text[]));
  return pg_catalog.jsonb_build_object('emails', pg_catalog.to_jsonb(v_emails), 'phones', pg_catalog.to_jsonb(v_phones));
end;
$$;

-- Confirmation : enregistre le mapping et enfile le job ; seul un lot « envoyé » peut être confirmé (une seule fois).
create function private.confirm_import(p_org uuid, p_batch uuid, p_mapping jsonb, p_default_country text, p_rows integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  perform private.assert_project_manager(p_org);
  if p_batch is null or not private.is_valid_import_mapping(p_mapping)
     or (p_default_country is not null and p_default_country !~ '^[A-Z]{2}$') or p_rows is null or p_rows not between 0 and 10000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_batch from public.import_batches b where b.id = p_batch and b.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_batch.status <> 'uploaded' then
    raise exception 'import_not_pending' using errcode = 'P0001';
  end if;
  perform private.assert_subscription_active(p_org);
  -- Revue sécurité : un projet archivé est en lecture seule, y compris pour un lot envoyé avant son archivage.
  perform 1 from public.projects p where p.id = v_batch.project_id and p.organization_id = p_org and p.status = 'active' for share;
  if not found then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  update public.import_batches set status = 'queued', mapping = p_mapping, default_country = p_default_country, row_count = p_rows
   where id = p_batch and organization_id = p_org;
  perform private.enqueue_job(p_org, 'import_csv', pg_catalog.jsonb_build_object('batch_id', p_batch), 'import_csv:' || p_batch::text);
end;
$$;

create function private.cancel_import(p_org uuid, p_batch uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  perform private.assert_project_manager(p_org);
  if p_batch is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_batch from public.import_batches b where b.id = p_batch and b.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- Revue sécurité : un lot « running » dont le job est en échec définitif (worker mort) ne reste pas bloqué : il peut être annulé.
  if v_batch.status not in ('uploaded', 'queued')
     and not (v_batch.status = 'running' and exists (
       select 1 from public.jobs j where j.organization_id = p_org and j.kind = 'import_csv' and j.payload ->> 'batch_id' = p_batch::text
          and j.status = 'dead_letter')) then
    raise exception 'import_not_pending' using errcode = 'P0001';
  end if;
  update public.import_batches set status = 'cancelled', finished_at = now() where id = p_batch and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker (service_role) : l'entreprise est celle de la ligne du job
-- ---------------------------------------------------------------------------
-- Démarre (ou reprend) un lot confirmé ; renvoie ce qu'il faut pour lire le fichier, ou l'état qui dispense de travailler.
create function private.import_start(p_org uuid, p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  if p_org is null or p_batch is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_batch from public.import_batches b where b.id = p_batch and b.organization_id = p_org for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  if v_batch.status not in ('queued', 'running') then
    return pg_catalog.jsonb_build_object('status', v_batch.status);
  end if;
  perform 1 from public.projects p where p.id = v_batch.project_id and p.organization_id = p_org and p.status = 'active';
  if not found then
    update public.import_batches set status = 'failed', error_code = 'project_archived', finished_at = now() where id = p_batch and organization_id = p_org;
    return pg_catalog.jsonb_build_object('status', 'failed');
  end if;
  if v_batch.status = 'queued' then
    update public.import_batches set status = 'running', started_at = coalesce(started_at, now()) where id = p_batch and organization_id = p_org;
  end if;
  return pg_catalog.jsonb_build_object('status', 'running', 'path', v_batch.file_path, 'mapping', v_batch.mapping,
    'default_country', v_batch.default_country, 'project_id', v_batch.project_id);
end;
$$;

-- Une ligne : même dédup que la capture publique ; enregistrée UNE fois (rejeu : renvoie le résultat déjà enregistré).
create function private.import_row(
  p_org uuid, p_batch uuid, p_row integer, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text,
  p_language text, p_country text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
  v_done public.import_rows;
  v_contact public.contacts;
  v_contact_created boolean := false;
  v_lead uuid;
  v_lead_created boolean := false;
  v_stage uuid;
  v_pipeline uuid;
  v_outcome text;
  v_reason text;
begin
  select * into v_batch from public.import_batches b where b.id = p_batch and b.organization_id = p_org;
  if not found or v_batch.status <> 'running' then
    raise exception 'import_not_running' using errcode = 'P0001';
  end if;
  if p_row is null or p_row not between 1 and 10001 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_done from public.import_rows r where r.batch_id = p_batch and r.row_no = p_row;
  if found then
    return pg_catalog.jsonb_build_object('outcome', v_done.outcome, 'reason', v_done.reason, 'lead_created', v_done.lead_created);
  end if;
  perform private.assert_subscription_active(p_org);
  perform 1 from public.projects p where p.id = v_batch.project_id and p.organization_id = p_org and p.status = 'active';
  if not found then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;

  if (p_email_normalized is null and p_phone_e164 is null)
     or not private.is_valid_contact_email(p_email_raw, p_email_normalized)
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$')
     or (p_name is not null and not private.is_safe_text(p_name, 1, 200))
     or (p_language is not null and p_language !~ '^[a-z]{2}$')
     or (p_country is not null and p_country !~ '^[A-Z]{2}$') then
    insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason) values (p_org, p_batch, p_row, 'error', 'failed');
    return pg_catalog.jsonb_build_object('outcome', 'error', 'reason', 'failed', 'lead_created', false);
  end if;

  -- Contact : e-mail d'abord, puis téléphone ; création sous quota si aucun ne correspond (le quota plein n'arrête pas le lot).
  if p_email_normalized is not null then
    select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.email_normalized = p_email_normalized;
  end if;
  if v_contact.id is null and p_phone_e164 is not null then
    select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.phone_e164 = p_phone_e164;
  end if;
  if v_contact.id is null then
    begin
      perform private.assert_within_limit(p_org, 'contacts', 1);
    exception when sqlstate 'P0001' then
      if sqlerrm = 'quota_exceeded' then
        insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason) values (p_org, p_batch, p_row, 'error', 'quota_exceeded');
        return pg_catalog.jsonb_build_object('outcome', 'error', 'reason', 'quota_exceeded', 'lead_created', false);
      end if;
      raise;
    end;
    begin
      insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164, language, country)
      values (p_org, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country)
      returning * into v_contact;
      v_contact_created := true;
    exception when unique_violation then
      if p_email_normalized is not null then
        select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.email_normalized = p_email_normalized;
      end if;
      if v_contact.id is null and p_phone_e164 is not null then
        select c.* into v_contact from public.contacts c where c.organization_id = p_org and c.phone_e164 = p_phone_e164;
      end if;
      if v_contact.id is null then
        insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason) values (p_org, p_batch, p_row, 'error', 'failed');
        return pg_catalog.jsonb_build_object('outcome', 'error', 'reason', 'failed', 'lead_created', false);
      end if;
    end;
  end if;
  select c.* into v_contact from public.contacts c where c.id = v_contact.id and c.organization_id = p_org for update;

  -- Un contact « ne plus contacter » ne reçoit pas de lead.
  if v_contact.do_not_contact then
    insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason, contact_id)
    values (p_org, p_batch, p_row, 'skipped', 'do_not_contact', v_contact.id);
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'reason', 'do_not_contact', 'lead_created', false);
  end if;

  -- Lead : on réutilise le lead encore OUVERT du même contact et du même projet.
  select l.id into v_lead
    from public.leads l
    join public.pipeline_stages s on s.organization_id = l.organization_id and s.id = l.stage_id
   where l.organization_id = p_org and l.contact_id = v_contact.id and l.project_id = v_batch.project_id and s.kind in ('open', 'unassigned')
   order by l.created_at, l.id limit 1;
  if v_lead is null then
    if (select count(*) from public.leads l where l.organization_id = p_org and l.contact_id = v_contact.id) >= 50 then
      insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason, contact_id)
      values (p_org, p_batch, p_row, 'error', 'too_many_leads', v_contact.id);
      return pg_catalog.jsonb_build_object('outcome', 'error', 'reason', 'too_many_leads', 'lead_created', false);
    end if;
    select p.id into v_pipeline from public.pipelines p where p.organization_id = p_org and p.is_default;
    v_stage := private.first_stage_of_kind(p_org, v_pipeline, 'unassigned'::public.stage_kind);
    if v_stage is null then
      raise exception 'pipeline_incomplete' using errcode = 'P0001';
    end if;
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id)
    values (p_org, v_contact.id, v_batch.project_id, 'csv_import', v_stage)
    returning id into v_lead;
    v_lead_created := true;
    -- Revue sécurité (voisin bruyant) : les jobs d'assignation d'un gros import sont ÉTALÉS (50 lignes par seconde) pour ne pas
    -- retarder les jobs des autres entreprises.
    perform private.enqueue_job(p_org, 'lead.assign', pg_catalog.jsonb_build_object('lead_id', v_lead), 'lead.assign:' || v_lead::text,
      now() + pg_catalog.make_interval(secs => p_row / 50));
  end if;

  v_outcome := case when v_contact_created then 'created' else 'matched' end;
  -- Même contact déjà rencontré plus haut dans CE fichier : doublon dans le fichier.
  if not v_contact_created and exists (select 1 from public.import_rows r where r.batch_id = p_batch and r.contact_id = v_contact.id) then
    v_reason := 'duplicate_in_file';
  end if;
  insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason, lead_created, contact_id)
  values (p_org, p_batch, p_row, v_outcome, v_reason, v_lead_created, v_contact.id);
  return pg_catalog.jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'lead_created', v_lead_created);
end;
$$;

-- Ligne refusée par la validation du worker (code seulement ; la valeur n'est jamais transmise).
create function private.import_record_error(p_org uuid, p_batch uuid, p_row integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.import_batches b where b.id = p_batch and b.organization_id = p_org and b.status = 'running';
  if not found then
    raise exception 'import_not_running' using errcode = 'P0001';
  end if;
  if p_row is null or p_row not between 1 and 10001
     or p_reason is null or p_reason not in ('no_identifier', 'invalid_email', 'invalid_phone', 'invalid_name', 'invalid_language', 'invalid_country') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  insert into public.import_rows (organization_id, batch_id, row_no, outcome, reason) values (p_org, p_batch, p_row, 'error', p_reason)
  on conflict (batch_id, row_no) do nothing;
end;
$$;

create function private.import_finish(p_org uuid, p_batch uuid, p_rows integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch from public.import_batches b where b.id = p_batch and b.organization_id = p_org for update;
  if not found or v_batch.status <> 'running' then
    return;
  end if;
  if p_rows is null or p_rows not between 0 and 10000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.import_batches b
     set status = 'done', finished_at = now(), row_count = p_rows,
         created_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'created'),
         matched_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'matched'),
         skipped_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'skipped'),
         error_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'error')
   where b.id = p_batch and b.organization_id = p_org;
end;
$$;

create function private.import_fail(p_org uuid, p_batch uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code is null or p_code not in ('file_missing', 'file_malformed', 'too_many_rows', 'subscription_inactive', 'project_archived', 'failed') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.import_batches b
     set status = 'failed', error_code = p_code, finished_at = now(),
         created_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'created'),
         matched_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'matched'),
         skipped_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'skipped'),
         error_count = (select count(*) from public.import_rows r where r.batch_id = p_batch and r.outcome = 'error')
   where b.id = p_batch and b.organization_id = p_org and b.status in ('queued', 'running');
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits puis enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.is_valid_import_mapping(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.import_batches_immutable() from public, anon, authenticated, service_role;
revoke all on function private.audit_import_batches() from public, anon, authenticated, service_role;
revoke all on function private.create_import_batch(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.import_dedup_check(uuid, text[], text[]) from public, anon, authenticated, service_role;
revoke all on function private.confirm_import(uuid, uuid, jsonb, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.cancel_import(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.import_start(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.import_row(uuid, uuid, integer, text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.import_record_error(uuid, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function private.import_finish(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.import_fail(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.create_import_batch(uuid, uuid, text, integer) to authenticated;
grant execute on function private.import_dedup_check(uuid, text[], text[]) to authenticated;
grant execute on function private.confirm_import(uuid, uuid, jsonb, text, integer) to authenticated;
grant execute on function private.cancel_import(uuid, uuid) to authenticated;
grant execute on function private.import_start(uuid, uuid) to service_role;
grant execute on function private.import_row(uuid, uuid, integer, text, text, text, text, text, text) to service_role;
grant execute on function private.import_record_error(uuid, uuid, integer, text) to service_role;
grant execute on function private.import_finish(uuid, uuid, integer) to service_role;
grant execute on function private.import_fail(uuid, uuid, text) to service_role;

create function public.create_import_batch(p_org uuid, p_project uuid, p_path text, p_size integer)
returns uuid language sql security invoker set search_path = '' as $$ select private.create_import_batch(p_org, p_project, p_path, p_size); $$;
create function public.import_dedup_check(p_org uuid, p_emails text[], p_phones text[])
returns jsonb language sql security invoker set search_path = '' as $$ select private.import_dedup_check(p_org, p_emails, p_phones); $$;
create function public.confirm_import(p_org uuid, p_batch uuid, p_mapping jsonb, p_default_country text, p_rows integer)
returns void language sql security invoker set search_path = '' as $$ select private.confirm_import(p_org, p_batch, p_mapping, p_default_country, p_rows); $$;
create function public.cancel_import(p_org uuid, p_batch uuid)
returns void language sql security invoker set search_path = '' as $$ select private.cancel_import(p_org, p_batch); $$;
create function public.import_start(p_org uuid, p_batch uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.import_start(p_org, p_batch); $$;
create function public.import_row(
  p_org uuid, p_batch uuid, p_row integer, p_name text, p_email_raw text, p_email_normalized text, p_phone_e164 text,
  p_language text, p_country text
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.import_row(p_org, p_batch, p_row, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country); $$;
create function public.import_record_error(p_org uuid, p_batch uuid, p_row integer, p_reason text)
returns void language sql security invoker set search_path = '' as $$ select private.import_record_error(p_org, p_batch, p_row, p_reason); $$;
create function public.import_finish(p_org uuid, p_batch uuid, p_rows integer)
returns void language sql security invoker set search_path = '' as $$ select private.import_finish(p_org, p_batch, p_rows); $$;
create function public.import_fail(p_org uuid, p_batch uuid, p_code text)
returns void language sql security invoker set search_path = '' as $$ select private.import_fail(p_org, p_batch, p_code); $$;

revoke all on function public.create_import_batch(uuid, uuid, text, integer) from public, anon, service_role;
revoke all on function public.import_dedup_check(uuid, text[], text[]) from public, anon, service_role;
revoke all on function public.confirm_import(uuid, uuid, jsonb, text, integer) from public, anon, service_role;
revoke all on function public.cancel_import(uuid, uuid) from public, anon, service_role;
revoke all on function public.import_start(uuid, uuid) from public, anon, authenticated;
revoke all on function public.import_row(uuid, uuid, integer, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.import_record_error(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.import_finish(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.import_fail(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_import_batch(uuid, uuid, text, integer) to authenticated;
grant execute on function public.import_dedup_check(uuid, text[], text[]) to authenticated;
grant execute on function public.confirm_import(uuid, uuid, jsonb, text, integer) to authenticated;
grant execute on function public.cancel_import(uuid, uuid) to authenticated;
grant execute on function public.import_start(uuid, uuid) to service_role;
grant execute on function public.import_row(uuid, uuid, integer, text, text, text, text, text, text) to service_role;
grant execute on function public.import_record_error(uuid, uuid, integer, text) to service_role;
grant execute on function public.import_finish(uuid, uuid, integer) to service_role;
grant execute on function public.import_fail(uuid, uuid, text) to service_role;
