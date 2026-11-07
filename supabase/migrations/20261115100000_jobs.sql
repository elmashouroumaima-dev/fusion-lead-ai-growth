-- J13 — Jobs et worker (ADR 003, ADR 007 `jobs`, spec §6 et §10).
-- Retour arrière : supabase/rollbacks/20261115100000_jobs.sql
--
-- File de jobs dans Postgres. Le worker (apps/worker) utilise `service_role` UNIQUEMENT par les fonctions
-- ci-dessous ; aucune table n'est accessible directement en écriture (ni lecture pour service_role).
--  * table jobs : organization_id NOT NULL + index + RLS ; lecture owner/admin de l'organisation (page
--    Exploitation) ; aucun droit d'écriture pour anon / authenticated / service_role ;
--  * fonctions private.* SECURITY DEFINER (search_path vide), enveloppes public.* SECURITY INVOKER, EXECUTE pour
--    service_role SEUL (jamais authenticated : un utilisateur ne crée ni ne réclame de job) ;
--  * claim : SELECT ... FOR UPDATE SKIP LOCKED (deux workers ne prennent jamais le même job), bail (lease) avec
--    battement de coeur (heartbeat) ; les baux expirés sont repris à chaque claim ;
--  * retry : backoff exponentiel avec jitter (10 s x 2^(essai-1), plafonné à 1 h, facteur 0,5 à 1) ; après
--    max_attempts, ou erreur non reprenable : dead_letter ;
--  * idempotence : unique (organization_id, idempotency_key) ; un doublon est REFUSÉ (23505 'duplicate_job') ;
--  * payload : jamais de secret, jeton ni corps de message (les jobs référencent des lignes) : refusé si
--    private.audit_redact le modifie (clé sensible, chaîne > 200 caractères, profondeur > 16) ;
--  * last_error : code ou nom d'erreur seulement (alphabet [A-Za-z0-9_.:-], tronqué à 200 caractères ; tout autre
--    caractère, y compris bidi et zéro-largeur, devient « _ ») ;
--  * audit (J12) : job.dead_lettered, job.replayed et job.cancelled sont écrits dans audit_logs.

create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at timestamptz not null default now(),
  lease_until timestamptz,
  locked_by text,
  idempotency_key text not null,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_org_idempotency_key unique (organization_id, idempotency_key),
  constraint jobs_kind_format check (kind ~ '^[a-z0-9_.]{1,64}$'),
  constraint jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint jobs_payload_size check (octet_length(payload::text) <= 16384),
  constraint jobs_attempts_range check (attempts >= 0),
  constraint jobs_max_attempts_range check (max_attempts between 1 and 20),
  constraint jobs_locked_by_format check (locked_by is null or locked_by ~ '^[A-Za-z0-9._:-]{1,128}$'),
  constraint jobs_idempotency_key_format check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  constraint jobs_last_error_size check (last_error is null or char_length(last_error) <= 200),
  constraint jobs_running_has_lease check (status <> 'running' or (lease_until is not null and locked_by is not null))
);
comment on table public.jobs is
  'File de jobs (ADR 003). Écriture uniquement par les fonctions du worker (service_role). Jamais de secret ni de corps de message.';

create index jobs_claim_idx on public.jobs (next_run_at, id) where status = 'queued';
create index jobs_lease_idx on public.jobs (lease_until) where status = 'running';
create index jobs_org_status_idx on public.jobs (organization_id, status, created_at desc);

create trigger set_updated_at before update on public.jobs
  for each row execute function private.set_updated_at();
create trigger prevent_organization_id_change
  before update of organization_id on public.jobs
  for each row execute function private.prevent_organization_id_change();

alter table public.jobs enable row level security;
revoke all on table public.jobs from anon, authenticated, service_role;
grant select on table public.jobs to authenticated;

create policy jobs_select on public.jobs
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- private.job_clean_error : last_error sans donnée sensible (code/nom seulement, court, sans contrôle)
-- ---------------------------------------------------------------------------
create function private.job_clean_error(p_error text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_error is null then null
    else left(regexp_replace(p_error, '[^A-Za-z0-9_.:-]', '_', 'g'), 200)
  end;
$$;

-- ---------------------------------------------------------------------------
-- private.enqueue_job
-- ---------------------------------------------------------------------------
create function private.enqueue_job(
  p_org uuid,
  p_kind text,
  p_payload jsonb,
  p_idempotency_key text,
  p_run_at timestamptz default null,
  p_max_attempts integer default 5
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'validation_failed' using errcode = '22023', detail = 'organization';
  end if;
  if p_kind is null or p_kind !~ '^[a-z0-9_.]{1,64}$'
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,200}$'
     or p_max_attempts is null or p_max_attempts not between 1 and 20
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 16384 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Aucun secret : la charge utile doit rester identique après caviardage (clé sensible, chaîne longue, profondeur).
  if private.audit_redact(p_payload) is distinct from p_payload then
    raise exception 'validation_failed' using errcode = '22023', detail = 'payload';
  end if;

  begin
    insert into public.jobs (organization_id, kind, payload, idempotency_key, next_run_at, max_attempts)
    values (p_org, p_kind, p_payload, p_idempotency_key, coalesce(p_run_at, now()), p_max_attempts)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'duplicate_job' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.requeue_expired_leases : reprend les jobs dont le bail a expiré (worker mort)
--   essais épuisés -> dead_letter ; sinon -> queued avec backoff
-- ---------------------------------------------------------------------------
create function private.requeue_expired_leases()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job record;
  v_count integer := 0;
begin
  for v_job in
    select j.id, j.organization_id, j.attempts, j.max_attempts
      from public.jobs j
     where j.status = 'running' and j.lease_until < now()
     order by j.lease_until, j.id
       for update skip locked
     limit 100
  loop
    if v_job.attempts >= v_job.max_attempts then
      update public.jobs
         set status = 'dead_letter', lease_until = null, locked_by = null, finished_at = now(),
             last_error = 'lease_expired'
       where id = v_job.id;
      perform private.audit_write(v_job.organization_id, 'job.dead_lettered', 'job', v_job.id,
        jsonb_build_object('status', 'running', 'attempts', v_job.attempts),
        jsonb_build_object('status', 'dead_letter', 'attempts', v_job.attempts, 'reason', 'lease_expired'));
    else
      update public.jobs
         set status = 'queued', lease_until = null, locked_by = null,
             next_run_at = now() + make_interval(secs => least(10 * power(2, v_job.attempts - 1), 3600) * (0.5 + random() * 0.5)),
             last_error = 'lease_expired'
       where id = v_job.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.claim_jobs
-- ---------------------------------------------------------------------------
create function private.claim_jobs(p_worker text, p_limit integer default 1, p_lease_seconds integer default 60)
returns table (
  id uuid,
  organization_id uuid,
  kind text,
  payload jsonb,
  attempts integer,
  max_attempts integer,
  idempotency_key text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9._:-]{1,128}$'
     or p_limit is null or p_limit not between 1 and 50
     or p_lease_seconds is null or p_lease_seconds not between 5 and 3600 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  perform private.requeue_expired_leases();

  return query
  with picked as (
    select j.id
      from public.jobs j
     where j.status = 'queued' and j.next_run_at <= now()
     order by j.next_run_at, j.id
       for update skip locked
     limit p_limit
  )
  update public.jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(j.started_at, now())
    from picked
   where j.id = picked.id
  returning j.id, j.organization_id, j.kind, j.payload, j.attempts, j.max_attempts, j.idempotency_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.heartbeat_job / complete_job / fail_job : réservés au worker qui détient le bail
-- ---------------------------------------------------------------------------
create function private.heartbeat_job(p_job uuid, p_worker text, p_lease_seconds integer default 60)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if p_lease_seconds is null or p_lease_seconds not between 5 and 3600 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.jobs
     set lease_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_job and status = 'running' and locked_by = p_worker and lease_until >= now();
  get diagnostics v_found = row_count;
  return v_found;
end;
$$;

create function private.complete_job(p_job uuid, p_worker text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  update public.jobs
     set status = 'succeeded', lease_until = null, locked_by = null, finished_at = now(), last_error = null
   where id = p_job and status = 'running' and locked_by = p_worker;
  get diagnostics v_found = row_count;
  return v_found;
end;
$$;

-- Retour : 'queued' (nouvel essai planifié), 'dead_letter', ou NULL si l'appelant ne détient pas le bail.
create function private.fail_job(p_job uuid, p_worker text, p_error text default null, p_retryable boolean default true)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_error text;
begin
  select * into v_job from public.jobs j
   where j.id = p_job and j.status = 'running' and j.locked_by = p_worker
     for update;
  if not found then
    return null;
  end if;
  v_error := private.job_clean_error(p_error);

  if not coalesce(p_retryable, true) or v_job.attempts >= v_job.max_attempts then
    update public.jobs
       set status = 'dead_letter', lease_until = null, locked_by = null, finished_at = now(), last_error = v_error
     where id = v_job.id;
    perform private.audit_write(v_job.organization_id, 'job.dead_lettered', 'job', v_job.id,
      jsonb_build_object('status', 'running', 'attempts', v_job.attempts),
      jsonb_build_object('status', 'dead_letter', 'attempts', v_job.attempts, 'retryable', coalesce(p_retryable, true)));
    return 'dead_letter';
  end if;

  update public.jobs
     set status = 'queued', lease_until = null, locked_by = null, last_error = v_error,
         next_run_at = now() + make_interval(secs => least(10 * power(2, v_job.attempts - 1), 3600) * (0.5 + random() * 0.5))
   where id = v_job.id;
  return 'queued';
end;
$$;

-- ---------------------------------------------------------------------------
-- private.cancel_job (jobs en attente seulement) / private.replay_dead_letter : audités
-- ---------------------------------------------------------------------------
create function private.cancel_job(p_org uuid, p_job uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  update public.jobs
     set status = 'cancelled', finished_at = now()
   where id = p_job and organization_id = p_org and status = 'queued';
  get diagnostics v_found = row_count;
  if v_found then
    perform private.audit_write(p_org, 'job.cancelled', 'job', p_job,
      jsonb_build_object('status', 'queued'), jsonb_build_object('status', 'cancelled'));
  end if;
  return v_found;
end;
$$;

create function private.replay_dead_letter(p_org uuid, p_job uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  update public.jobs
     set status = 'queued', attempts = 0, next_run_at = now(), lease_until = null, locked_by = null,
         last_error = null, finished_at = null
   where id = p_job and organization_id = p_org and status = 'dead_letter';
  get diagnostics v_found = row_count;
  if v_found then
    perform private.audit_write(p_org, 'job.replayed', 'job', p_job,
      jsonb_build_object('status', 'dead_letter'), jsonb_build_object('status', 'queued'));
  end if;
  return v_found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits : service_role SEUL
-- ---------------------------------------------------------------------------
revoke all on function private.job_clean_error(text) from public, anon, authenticated, service_role;
revoke all on function private.enqueue_job(uuid, text, jsonb, text, timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function private.requeue_expired_leases() from public, anon, authenticated, service_role;
revoke all on function private.claim_jobs(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.heartbeat_job(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.complete_job(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.fail_job(uuid, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function private.cancel_job(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.replay_dead_letter(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.enqueue_job(uuid, text, jsonb, text, timestamptz, integer) to service_role;
grant execute on function private.claim_jobs(text, integer, integer) to service_role;
grant execute on function private.heartbeat_job(uuid, text, integer) to service_role;
grant execute on function private.complete_job(uuid, text) to service_role;
grant execute on function private.fail_job(uuid, text, text, boolean) to service_role;
grant execute on function private.cancel_job(uuid, uuid) to service_role;
grant execute on function private.replay_dead_letter(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
create function public.enqueue_job(
  p_org uuid, p_kind text, p_payload jsonb, p_idempotency_key text, p_run_at timestamptz default null, p_max_attempts integer default 5
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.enqueue_job(p_org, p_kind, p_payload, p_idempotency_key, p_run_at, p_max_attempts); $$;

create function public.claim_jobs(p_worker text, p_limit integer default 1, p_lease_seconds integer default 60)
returns table (id uuid, organization_id uuid, kind text, payload jsonb, attempts integer, max_attempts integer, idempotency_key text)
language sql security invoker set search_path = ''
as $$ select * from private.claim_jobs(p_worker, p_limit, p_lease_seconds); $$;

create function public.heartbeat_job(p_job uuid, p_worker text, p_lease_seconds integer default 60)
returns boolean language sql security invoker set search_path = ''
as $$ select private.heartbeat_job(p_job, p_worker, p_lease_seconds); $$;

create function public.complete_job(p_job uuid, p_worker text)
returns boolean language sql security invoker set search_path = ''
as $$ select private.complete_job(p_job, p_worker); $$;

create function public.fail_job(p_job uuid, p_worker text, p_error text default null, p_retryable boolean default true)
returns text language sql security invoker set search_path = ''
as $$ select private.fail_job(p_job, p_worker, p_error, p_retryable); $$;

create function public.cancel_job(p_org uuid, p_job uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select private.cancel_job(p_org, p_job); $$;

create function public.replay_dead_letter(p_org uuid, p_job uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select private.replay_dead_letter(p_org, p_job); $$;

revoke all on function public.enqueue_job(uuid, text, jsonb, text, timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function public.claim_jobs(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_job(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_job(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.fail_job(uuid, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.cancel_job(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.replay_dead_letter(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_job(uuid, text, jsonb, text, timestamptz, integer) to service_role;
grant execute on function public.claim_jobs(text, integer, integer) to service_role;
grant execute on function public.heartbeat_job(uuid, text, integer) to service_role;
grant execute on function public.complete_job(uuid, text) to service_role;
grant execute on function public.fail_job(uuid, text, text, boolean) to service_role;
grant execute on function public.cancel_job(uuid, uuid) to service_role;
grant execute on function public.replay_dead_letter(uuid, uuid) to service_role;
