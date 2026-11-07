-- J11 — Couche service : idempotence des mutations et limitation de débit (ADR 006, ADR 007 G-D9,
-- ADR 005 §5–§8, menace B8).
-- Sources : spec §6, §13 ; ADR 006 (Idempotency-Key, erreurs normalisées) ; ADR 007 (idempotency_keys,
-- rate_limit_buckets).
-- Retour arrière : supabase/rollbacks/20261112100000_service_layer.sql
--
-- Décisions validées par la responsable technique (J11) :
--  * durée de vie d'une clé d'idempotence = 24 h (constante c_ttl dans idempotency_begin) ;
--  * une ligne 'in_progress' de plus de 5 minutes est considérée comme abandonnée (constante
--    c_stuck_after) : un nouvel essai la remplace ;
--  * limitation de débit = seau à jetons en base, écrit UNIQUEMENT par service_role depuis le serveur ;
--    les capacités et recharges (mutation 30 / 0,5 s^-1 ; sensible 10 / 1/6 s^-1) vivent dans l'application ;
--  * une clé porte un attempt_id (uuid) renouvelé à chaque prise en charge : seul l'essai courant peut
--    conclure (idempotency_complete) ou abandonner (idempotency_abandon) la ligne ; un essai tardif, dont la
--    ligne a été reprise après 5 minutes, ne peut plus toucher la ligne du nouvel essai ;
--  * quota : un acteur ne détient jamais plus de 200 lignes non expirées par entreprise (sinon
--    P0001 'quota_exceeded') ; réponse stockée plafonnée à 16384 octets ;
--  * purge : idempotency_purge / rate_limit_purge (service_role SEUL). La planification (tâche périodique)
--    arrive avec le worker (J13) ; en attendant, procédure manuelle dans le runbook ;
--  * rate_limit_buckets.organization_id est NULLABLE (ADR 007 : seaux globaux par fournisseur, plus tard),
--    avec CHECK (organization_id non nul OU provider non nul) ; exception documentée du schema lint.
--
-- Sécurité (même schéma que J9/J10) :
--  * idempotency_keys : RLS activée, AUCUNE politique, AUCUN droit pour anon / authenticated / service_role ;
--    accessible uniquement par les fonctions private.idempotency_* (SECURITY DEFINER, search_path vide,
--    identité UNIQUEMENT via auth.uid(), appelant = membre ACTIF de l'entreprise) ;
--  * wrappers public.* SECURITY INVOKER ; EXECUTE retiré de PUBLIC / anon / service_role, accordé à
--    authenticated seul ;
--  * rate_limit_buckets : RLS activée, AUCUNE politique, AUCUN droit pour anon / authenticated ;
--    service_role : select, insert, update, delete exactement ; public.rate_limit_take est SECURITY INVOKER
--    (L10), exécutable par service_role SEUL ;
--  * aucune donnée personnelle : bucket_key est OPAQUE (ex. « sensitive:<uuid utilisateur> »), jamais un
--    e-mail, un nom ou une adresse IP en clair ; les réponses stockées ne contiennent jamais de secret
--    (la couche applicative n'y met que {"replayed":true} quand la réponse est sensible).

-- ---------------------------------------------------------------------------
-- Table idempotency_keys
-- ---------------------------------------------------------------------------
create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  key text not null,
  actor_id uuid not null,
  request_hash text not null,
  -- Identifiant de l'essai courant ; renouvelé à chaque prise en charge d'une ligne expirée ou bloquée.
  attempt_id uuid not null default gen_random_uuid(),
  state text not null,
  status_code integer,
  response jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idempotency_keys_org_key_key unique (organization_id, key),
  constraint idempotency_keys_org_id_key unique (organization_id, id),
  constraint idempotency_keys_key_format check (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint idempotency_keys_request_hash_format check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_keys_state_check check (state in ('in_progress', 'completed')),
  constraint idempotency_keys_status_code_range check (status_code is null or status_code between 100 and 599),
  constraint idempotency_keys_response_size check (response is null or octet_length(response::text) <= 16384),
  constraint idempotency_keys_state_consistent check (
    (state = 'in_progress' and status_code is null and response is null)
    or (state = 'completed' and status_code is not null and response is not null)
  )
);
comment on table public.idempotency_keys is
  'Clés d''idempotence (ADR 007). Accessible uniquement via private.idempotency_* ; aucune politique ni droit direct. Ne stocke jamais de secret.';

create index idempotency_keys_org_created_idx on public.idempotency_keys (organization_id, created_at desc);
create index idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);
-- Comptage du quota par (entreprise, acteur) des lignes non expirées.
create index idempotency_keys_org_actor_expires_idx on public.idempotency_keys (organization_id, actor_id, expires_at);

create trigger set_updated_at before update on public.idempotency_keys
  for each row execute function private.set_updated_at();
create trigger prevent_organization_id_change
  before update of organization_id on public.idempotency_keys
  for each row execute function private.prevent_organization_id_change();

alter table public.idempotency_keys enable row level security;
revoke all on table public.idempotency_keys from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Table rate_limit_buckets (G-D9)
-- ---------------------------------------------------------------------------
create table public.rate_limit_buckets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  provider text,
  bucket_key text not null,
  tokens double precision not null,
  refilled_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_limit_buckets_scope check (organization_id is not null or provider is not null),
  constraint rate_limit_buckets_bucket_key_format check (
    char_length(bucket_key) between 1 and 200 and bucket_key ~ '^[A-Za-z0-9:_.-]+$'
  ),
  constraint rate_limit_buckets_provider_format check (
    provider is null or (char_length(provider) between 1 and 64 and provider ~ '^[A-Za-z0-9_.-]+$')
  ),
  constraint rate_limit_buckets_tokens_nonneg check (tokens >= 0)
);
comment on table public.rate_limit_buckets is
  'Seaux à jetons (G-D9). organization_id NULL = seau global par fournisseur. Écriture service_role uniquement. bucket_key doit être OPAQUE : jamais d''e-mail, de nom ni d''IP en clair.';
comment on column public.rate_limit_buckets.bucket_key is
  'Clé opaque (portée + identifiant uuid). Ne jamais y mettre de donnée personnelle.';

create unique index rate_limit_buckets_scope_key
  on public.rate_limit_buckets (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(provider, ''),
    bucket_key
  );
create index rate_limit_buckets_org_idx on public.rate_limit_buckets (organization_id);

create trigger set_updated_at before update on public.rate_limit_buckets
  for each row execute function private.set_updated_at();
create trigger prevent_organization_id_change
  before update of organization_id on public.rate_limit_buckets
  for each row execute function private.prevent_organization_id_change();

alter table public.rate_limit_buckets enable row level security;
revoke all on table public.rate_limit_buckets from anon, authenticated, service_role;
grant select, insert, update, delete on table public.rate_limit_buckets to service_role;

-- ---------------------------------------------------------------------------
-- private.idempotency_begin
-- ---------------------------------------------------------------------------
create function private.idempotency_begin(p_org uuid, p_key text, p_request_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Durée de vie d'une clé (décision J11) : 24 h.
  c_ttl constant interval := interval '24 hours';
  -- Une ligne 'in_progress' plus ancienne que cela est abandonnée (décision J11) : 5 minutes.
  c_stuck_after constant interval := interval '5 minutes';
  -- Quota (décision J11) : au plus 200 lignes non expirées par (entreprise, acteur).
  c_quota constant integer := 200;
  v_uid uuid;
  v_row public.idempotency_keys%rowtype;
  v_attempt uuid := gen_random_uuid();
  v_live integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Autorisation d'abord : membre ACTIF de l'entreprise, sinon rien n'est révélé.
  if p_org is null or not private.is_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,128}$'
     or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  -- Sérialisation de begin par (entreprise, clé) : le verrou consultatif de transaction (libéré au COMMIT)
  -- ne sérialise QUE les appels à begin. L'exclusion mutuelle des gestionnaires (handlers) ne vient pas
  -- de ce verrou mais de la ligne 'in_progress' : le second begin la voit et répond 'in_progress'.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_key, 0));

  select k.* into v_row
    from public.idempotency_keys k
   where k.organization_id = p_org and k.key = p_key
   for update;

  if not found then
    -- Quota : refus AVANT d'ajouter une ligne (la 201e ligne vivante de l'acteur est refusée).
    -- Le comptage + l'insertion sont sérialisés par (entreprise, acteur) : sans ce verrou, des begin
    -- concurrents avec des clés DIFFÉRENTES lisent tous le même comptage et dépassent le quota.
    -- Ordre des verrous (anti-interblocage) : 1. verrou (entreprise, clé), 2. verrou (entreprise, acteur).
    -- Un appel ne prend jamais un verrou de clé après un verrou d'acteur, et le détenteur du verrou d'acteur
    -- n'attend aucun autre verrou consultatif : pas de cycle d'attente possible. Libérés au COMMIT.
    -- READ COMMITTED : le count suivant voit les lignes validées par le détenteur précédent.
    perform pg_advisory_xact_lock(hashtextextended('idem-quota:' || p_org::text || ':' || v_uid::text, 0));
    select count(*) into v_live from public.idempotency_keys k
     where k.organization_id = p_org and k.actor_id = v_uid and k.expires_at > now();
    if v_live >= c_quota then
      raise exception 'quota_exceeded' using errcode = 'P0001';
    end if;
    insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, attempt_id, state, expires_at)
    values (p_org, p_key, v_uid, p_request_hash, v_attempt, 'in_progress', now() + c_ttl);
    return jsonb_build_object('state', 'new', 'attempt_id', v_attempt);
  end if;

  -- Ligne expirée, ou 'in_progress' abandonnée : remplacée par un nouvel essai (nouvel attempt_id : l'essai
  -- précédent, s'il se réveille, ne pourra plus ni conclure ni abandonner cette ligne).
  if v_row.expires_at <= now()
     or (v_row.state = 'in_progress' and v_row.created_at <= now() - c_stuck_after) then
    -- La ligne reprise n'est pas comptée deux fois (elle est exclue du comptage).
    -- Même verrou (entreprise, acteur) et même ordre que la branche 'new' : clé d'abord, acteur ensuite.
    perform pg_advisory_xact_lock(hashtextextended('idem-quota:' || p_org::text || ':' || v_uid::text, 0));
    select count(*) into v_live from public.idempotency_keys k
     where k.organization_id = p_org and k.actor_id = v_uid and k.expires_at > now() and k.id <> v_row.id;
    if v_live >= c_quota then
      raise exception 'quota_exceeded' using errcode = 'P0001';
    end if;
    update public.idempotency_keys
       set actor_id = v_uid, request_hash = p_request_hash, attempt_id = v_attempt, state = 'in_progress',
           status_code = null, response = null, expires_at = now() + c_ttl, created_at = now()
     where id = v_row.id;
    return jsonb_build_object('state', 'new', 'attempt_id', v_attempt);
  end if;

  -- Même clé, autre contenu ou autre acteur : conflit (rien n'est rejoué, rien ne fuit).
  if v_row.request_hash <> p_request_hash or v_row.actor_id <> v_uid then
    return jsonb_build_object('state', 'conflict');
  end if;

  if v_row.state = 'completed' then
    return jsonb_build_object('state', 'replay', 'status_code', v_row.status_code, 'response', v_row.response);
  end if;

  return jsonb_build_object('state', 'in_progress');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.idempotency_complete
-- ---------------------------------------------------------------------------
create function private.idempotency_complete(
  p_org uuid,
  p_key text,
  p_attempt_id uuid,
  p_status_code integer,
  p_response jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.idempotency_keys%rowtype;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or not private.is_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,128}$'
     or p_attempt_id is null
     or p_status_code is null or p_status_code not between 100 and 599
     or p_response is null or octet_length(p_response::text) > 16384 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select k.* into v_row
    from public.idempotency_keys k
   where k.organization_id = p_org and k.key = p_key
   for update;

  -- Seul l'acteur d'origine, seulement une ligne encore 'in_progress', et seulement l'essai COURANT
  -- (attempt_id) : un essai tardif dont la ligne a été reprise reçoit invalid_state.
  if not found or v_row.actor_id <> v_uid or v_row.state <> 'in_progress'
     or v_row.attempt_id <> p_attempt_id then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;

  update public.idempotency_keys
     set state = 'completed', status_code = p_status_code, response = p_response
   where id = v_row.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.idempotency_abandon : supprime la ligne 'in_progress' de l'acteur (un nouvel essai pourra rejouer)
-- ---------------------------------------------------------------------------
create function private.idempotency_abandon(p_org uuid, p_key text, p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or not private.is_member(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,128}$' or p_attempt_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  -- Sans effet (silencieux) si l'essai n'est plus le courant : on ne supprime jamais la ligne d'un autre essai.
  delete from public.idempotency_keys k
   where k.organization_id = p_org and k.key = p_key
     and k.actor_id = v_uid and k.state = 'in_progress' and k.attempt_id = p_attempt_id;
end;
$$;

revoke all on function private.idempotency_begin(uuid, text, text) from public, anon, service_role;
revoke all on function private.idempotency_complete(uuid, text, uuid, integer, jsonb) from public, anon, service_role;
revoke all on function private.idempotency_abandon(uuid, text, uuid) from public, anon, service_role;
grant execute on function private.idempotency_begin(uuid, text, text) to authenticated;
grant execute on function private.idempotency_complete(uuid, text, uuid, integer, jsonb) to authenticated;
grant execute on function private.idempotency_abandon(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Wrappers SECURITY INVOKER exposés à la Data API
-- ---------------------------------------------------------------------------
create function public.idempotency_begin(p_org uuid, p_key text, p_request_hash text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.idempotency_begin(p_org, p_key, p_request_hash);
$$;

create function public.idempotency_complete(p_org uuid, p_key text, p_attempt_id uuid, p_status_code integer, p_response jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.idempotency_complete(p_org, p_key, p_attempt_id, p_status_code, p_response);
$$;

create function public.idempotency_abandon(p_org uuid, p_key text, p_attempt_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.idempotency_abandon(p_org, p_key, p_attempt_id);
$$;

revoke all on function public.idempotency_begin(uuid, text, text) from public, anon, service_role;
revoke all on function public.idempotency_complete(uuid, text, uuid, integer, jsonb) from public, anon, service_role;
revoke all on function public.idempotency_abandon(uuid, text, uuid) from public, anon, service_role;
grant execute on function public.idempotency_begin(uuid, text, text) to authenticated;
grant execute on function public.idempotency_complete(uuid, text, uuid, integer, jsonb) to authenticated;
grant execute on function public.idempotency_abandon(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.rate_limit_take : seau à jetons atomique (SECURITY INVOKER, service_role SEUL)
-- ---------------------------------------------------------------------------
-- Retour : {"allowed": bool, "remaining": nombre, "retry_after_seconds": entier}.
-- retry_after_seconds = 0 si autorisé ; sinon ceil(temps nécessaire pour atteindre p_cost), au moins 1,
-- plafonné à 86400 (une recharge nulle ne rend jamais le seau disponible : 86400 est renvoyé).
-- Atomicité : INSERT ... ON CONFLICT DO NOTHING puis SELECT ... FOR UPDATE (verrou de ligne) ; les appels
-- concurrents sur le même seau sont donc sérialisés, jamais de jeton dépensé deux fois.
create function public.rate_limit_take(
  p_org uuid,
  p_provider text,
  p_bucket_key text,
  p_capacity integer,
  p_refill_per_second double precision,
  p_cost integer default 1
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_epsilon constant double precision := 1e-9;
  c_max_retry constant integer := 86400;
  v_row public.rate_limit_buckets%rowtype;
  v_elapsed double precision;
  v_tokens double precision;
  v_allowed boolean;
  v_retry integer := 0;
begin
  if p_bucket_key is null or char_length(p_bucket_key) not between 1 and 200
     or p_bucket_key !~ '^[A-Za-z0-9:_.-]+$'
     or (p_org is null and p_provider is null)
     or (p_provider is not null and (char_length(p_provider) not between 1 and 64 or p_provider !~ '^[A-Za-z0-9_.-]+$'))
     or p_capacity is null or p_capacity not between 1 and 10000
     or p_refill_per_second is null or p_refill_per_second <> p_refill_per_second
     or p_refill_per_second not between 0 and 1000
     or p_cost is null or p_cost not between 1 and p_capacity then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  insert into public.rate_limit_buckets (organization_id, provider, bucket_key, tokens, refilled_at)
  values (p_org, p_provider, p_bucket_key, p_capacity, now())
  on conflict (
    (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(provider, '')),
    bucket_key
  ) do nothing;

  select b.* into v_row
    from public.rate_limit_buckets b
   where coalesce(b.organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_org, '00000000-0000-0000-0000-000000000000'::uuid)
     and coalesce(b.provider, '') = coalesce(p_provider, '')
     and b.bucket_key = p_bucket_key
   for update;

  v_elapsed := greatest(0, extract(epoch from (now() - v_row.refilled_at)));
  v_tokens := least(p_capacity::double precision, v_row.tokens + v_elapsed * p_refill_per_second);

  if v_tokens + c_epsilon >= p_cost then
    v_allowed := true;
    v_tokens := greatest(0, v_tokens - p_cost);
  else
    v_allowed := false;
    if p_refill_per_second > 0 then
      v_retry := least(c_max_retry, greatest(1, ceil((p_cost - v_tokens) / p_refill_per_second - c_epsilon)::integer));
    else
      v_retry := c_max_retry;
    end if;
  end if;

  update public.rate_limit_buckets
     set tokens = v_tokens, refilled_at = greatest(v_row.refilled_at, now())
   where id = v_row.id;

  return jsonb_build_object('allowed', v_allowed, 'remaining', v_tokens, 'retry_after_seconds', v_retry);
end;
$$;

revoke all on function public.rate_limit_take(uuid, text, text, integer, double precision, integer)
  from public, anon, authenticated;
grant execute on function public.rate_limit_take(uuid, text, text, integer, double precision, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Purges (service_role SEUL) : idempotency_purge et rate_limit_purge
-- ---------------------------------------------------------------------------
-- La planification périodique de ces deux purges (tâche récurrente) arrive avec le worker (J13) ; en
-- attendant, elles se lancent à la main (voir le runbook). Chaque appel est borné et idempotent.

-- Supprime au plus p_batch lignes : expirées depuis plus d'1 h, ou 'in_progress' créées il y a plus d'1 h
-- (essais définitivement abandonnés). Retourne le nombre de lignes supprimées ; appeler en boucle tant que
-- le résultat vaut p_batch. Les lignes verrouillées par une autre transaction sont sautées.
create function private.idempotency_purge(p_batch integer default 1000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_batch is null or p_batch not between 1 and 10000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  with doomed as (
    select k.id
      from public.idempotency_keys k
     where k.expires_at < now() - interval '1 hour'
        or (k.state = 'in_progress' and k.created_at < now() - interval '1 hour')
     order by k.expires_at
     limit p_batch
       for update skip locked
  )
  delete from public.idempotency_keys k
   using doomed
   where k.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Supprime les seaux inactifs depuis plus de p_idle_days jours (refilled_at est avancé à chaque appel de
-- rate_limit_take). Un seau supprimé repart plein à l'appel suivant : sans conséquence métier.
create function private.rate_limit_purge(p_idle_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_idle_days is null or p_idle_days not between 1 and 365 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  delete from public.rate_limit_buckets b
   where b.refilled_at < now() - make_interval(days => p_idle_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.idempotency_purge(integer) from public, anon, authenticated;
revoke all on function private.rate_limit_purge(integer) from public, anon, authenticated;
grant execute on function private.idempotency_purge(integer) to service_role;
grant execute on function private.rate_limit_purge(integer) to service_role;

create function public.idempotency_purge(p_batch integer default 1000)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private.idempotency_purge(p_batch);
$$;

create function public.rate_limit_purge(p_idle_days integer default 7)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private.rate_limit_purge(p_idle_days);
$$;

revoke all on function public.idempotency_purge(integer) from public, anon, authenticated;
revoke all on function public.rate_limit_purge(integer) from public, anon, authenticated;
grant execute on function public.idempotency_purge(integer) to service_role;
grant execute on function public.rate_limit_purge(integer) to service_role;
