-- J14 — Plans, quotas et administrateurs de la plateforme (ADR 007 G-D1 / E6 / G-R4, ADR 005 §10, spec §10).
-- Retour arrière : supabase/rollbacks/20261116100000_plans_quotas.sql
--
-- Décisions (mini-plan validé le 2026-11-07) :
--  * private.platform_admins : administrateurs de la PLATEFORME (pas des membres d'organisation). Aucun droit
--    d'API ; géré uniquement par SQL (opérations). Identité = auth.uid(), jamais user_metadata ;
--  * limites par plan (jsonb, clés connues, entiers >= 0) : trial / starter / growth (VALEURS PROVISOIRES : la spec
--    n'en donne aucune, à valider par la responsable technique) ; une clé absente = pas de limite pour cette
--    métrique ; subscriptions.limits_override (même forme) l'emporte sur le plan ;
--  * métriques « flux » mensuelles (messages_per_month, ai_runs) : compteur atomique dans usage_counters ;
--    métriques « stock » (users, projects, contacts, integrations) : usage = lignes existantes (users = membres
--    actifs + invitations en attente ; les autres tables n'existent pas encore, usage = 0 jusqu'à leur module) ;
--  * private.assert_within_limit : un seul point de contrôle ; dépassement -> exception `quota_exceeded`
--    (P0001, detail = métrique) ; abonnement suspendu ou annulé -> `subscription_inactive` ;
--  * création d'invitation : contrôle de la limite `users` (même transaction que l'invitation) ;
--  * écriture des abonnements : uniquement par admin_set_subscription (administrateur de la plateforme), auditée
--    (subscription.changed) ; lecture de l'usage : owner/admin de l'organisation (get_org_usage) ;
--  * consommation des métriques de flux par le serveur / le worker : consume_quota (service_role seul).

-- ---------------------------------------------------------------------------
-- Administrateurs de la plateforme
-- ---------------------------------------------------------------------------
create table private.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table private.platform_admins is
  'Administrateurs de la plateforme (ADR 005 §10). Gérée uniquement par SQL ; aucun droit d''API.';
revoke all on table private.platform_admins from public, anon, authenticated, service_role;

create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.platform_admins a where a.user_id = (select auth.uid()));
$$;

-- ---------------------------------------------------------------------------
-- Limites : forme, plans, valeurs provisoires
-- ---------------------------------------------------------------------------
create function private.is_valid_plan_limits(p_limits jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_keys constant text[] := array['users', 'projects', 'contacts', 'messages_per_month', 'ai_runs', 'integrations'];
  v_entry record;
begin
  if p_limits is null or jsonb_typeof(p_limits) <> 'object' then
    return false;
  end if;
  for v_entry in select * from jsonb_each(p_limits) loop
    if not (v_entry.key = any (c_keys))
       or jsonb_typeof(v_entry.value) <> 'number'
       or (v_entry.value #>> '{}') !~ '^[0-9]{1,12}$' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

alter table public.plans
  add constraint plans_limits_valid check (private.is_valid_plan_limits(limits));
alter table public.subscriptions
  add constraint subscriptions_limits_override_valid check (private.is_valid_plan_limits(limits_override));

-- VALEURS PROVISOIRES (à valider) : users, projects, contacts, messages_per_month, ai_runs, integrations.
update public.plans set limits = '{"users": 3, "projects": 1, "contacts": 500, "messages_per_month": 200, "ai_runs": 50, "integrations": 2}'::jsonb
 where code = 'trial';
insert into public.plans (code, name, limits) values
  ('starter', 'Starter', '{"users": 5, "projects": 3, "contacts": 5000, "messages_per_month": 2000, "ai_runs": 200, "integrations": 3}'::jsonb),
  ('growth', 'Growth', '{"users": 15, "projects": 10, "contacts": 50000, "messages_per_month": 20000, "ai_runs": 2000, "integrations": 6}'::jsonb)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Usage et contrôle des quotas
-- ---------------------------------------------------------------------------
-- Usage « stock » courant d'une métrique (0 tant que le module concerné n'existe pas).
create function private.current_stock_usage(p_org uuid, p_metric text)
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
  -- projects, contacts, integrations : tables créées par leurs modules (J16 et suivants).
  return 0;
end;
$$;

-- Limite effective (plan puis surcharge) ; NULL = aucune limite pour cette métrique.
create function private.effective_limit(p_org uuid, p_metric text)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  select coalesce(s.limits_override -> p_metric, p.limits -> p_metric)
    into v_value
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
   where s.organization_id = p_org;
  if v_value is null then
    return null;
  end if;
  return (v_value #>> '{}')::bigint;
end;
$$;

create function private.quota_period_start()
returns date
language sql
stable
set search_path = ''
as $$
  select (date_trunc('month', now() at time zone 'utc'))::date;
$$;

-- Contrôle (et, pour une métrique de flux, consommation atomique). Renvoie {metric, used, limit, remaining, near_limit}.
create function private.assert_within_limit(p_org uuid, p_metric text, p_amount integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_flow constant text[] := array['messages_per_month', 'ai_runs'];
  c_stock constant text[] := array['users', 'projects', 'contacts', 'integrations'];
  v_status public.subscription_status;
  v_limit bigint;
  v_used bigint;
  v_period date;
begin
  if p_org is null or p_metric is null or not (p_metric = any (c_flow) or p_metric = any (c_stock))
     or p_amount is null or p_amount < 1 or p_amount > 1000000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select s.status into v_status from public.subscriptions s where s.organization_id = p_org;
  if v_status is null or v_status in ('suspended', 'cancelled') then
    raise exception 'subscription_inactive' using errcode = 'P0001';
  end if;

  v_limit := private.effective_limit(p_org, p_metric);

  if p_metric = any (c_flow) then
    v_period := private.quota_period_start();
    insert into public.usage_counters (organization_id, metric, period_start, value)
    values (p_org, p_metric, v_period, 0)
    on conflict (organization_id, metric, period_start) do nothing;
    -- Un seul UPDATE conditionnel : atomique, jamais de dépassement même sous concurrence.
    update public.usage_counters c
       set value = c.value + p_amount
     where c.organization_id = p_org and c.metric = p_metric and c.period_start = v_period
       and (v_limit is null or c.value + p_amount <= v_limit)
    returning c.value into v_used;
    if v_used is null then
      raise exception 'quota_exceeded' using errcode = 'P0001', detail = p_metric;
    end if;
  else
    -- Stock : sérialise les contrôles concurrents d'une même organisation et métrique.
    perform pg_advisory_xact_lock(pg_catalog.hashtextextended('quota:' || p_org::text || ':' || p_metric, 0));
    v_used := private.current_stock_usage(p_org, p_metric);
    if v_limit is not null and v_used + p_amount > v_limit then
      raise exception 'quota_exceeded' using errcode = 'P0001', detail = p_metric;
    end if;
  end if;

  return jsonb_build_object(
    'metric', p_metric,
    'used', v_used,
    'limit', v_limit,
    'remaining', case when v_limit is null then null else greatest(v_limit - v_used, 0) end,
    'near_limit', v_limit is not null and v_limit > 0 and (v_used * 100) >= (v_limit * 80)
  );
end;
$$;

-- Usage courant de l'organisation (sans consommation), pour l'alerte avant seuil.
create function private.usage_rows(p_org uuid)
returns table (metric text, used bigint, "limit" bigint, near_limit boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_metric text;
  v_used bigint;
  v_limit bigint;
begin
  foreach v_metric in array array['users', 'projects', 'contacts', 'integrations', 'messages_per_month', 'ai_runs'] loop
    if v_metric in ('messages_per_month', 'ai_runs') then
      select coalesce((select c.value from public.usage_counters c
                        where c.organization_id = p_org and c.metric = v_metric and c.period_start = private.quota_period_start()), 0)
        into v_used;
    else
      v_used := private.current_stock_usage(p_org, v_metric);
    end if;
    v_limit := private.effective_limit(p_org, v_metric);
    metric := v_metric;
    used := v_used;
    "limit" := v_limit;
    near_limit := v_limit is not null and v_limit > 0 and (v_used * 100) >= (v_limit * 80);
    return next;
  end loop;
end;
$$;

-- Lecture par owner/admin actif de l'organisation.
create function private.get_org_usage(p_org uuid)
returns table (metric text, used bigint, "limit" bigint, near_limit boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select * from private.usage_rows(p_org);
end;
$$;

-- Consommation par le serveur ou le worker (service_role) : métriques de flux ou contrôle d'une métrique de stock.
create function private.consume_quota(p_org uuid, p_metric text, p_amount integer default 1)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.assert_within_limit(p_org, p_metric, p_amount);
$$;

-- ---------------------------------------------------------------------------
-- Administration de la plateforme
-- ---------------------------------------------------------------------------
create function private.admin_list_organizations(p_limit integer default 50, p_offset integer default 0)
returns table (
  organization_id uuid, name text, slug text, org_status public.org_status, plan_code text,
  sub_status public.subscription_status, period_end timestamptz, limits_override jsonb,
  members integer, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Données d'administration seulement : aucune donnée de contact ni de contenu d'une organisation.
  return query
    select o.id, o.name, o.slug, o.status, p.code, s.status, s.period_end, s.limits_override,
           (select count(*)::integer from public.organization_members m where m.organization_id = o.id and m.status = 'active'),
           o.created_at
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
      left join public.plans p on p.id = s.plan_id
     order by o.created_at desc, o.id
     limit p_limit offset p_offset;
end;
$$;

create function private.admin_set_subscription(
  p_org uuid,
  p_plan_code text,
  p_status public.subscription_status,
  p_limits_override jsonb,
  p_reason text,
  p_period_end timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_plan_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_org is null or p_status is null or p_reason is null
     or char_length(btrim(p_reason)) not between 3 and 200
     or p_reason ~ '[[:cntrl:]\u200b-\u200f\u202a-\u202e\u2066-\u2069]'
     or not private.is_valid_plan_limits(coalesce(p_limits_override, '{}'::jsonb))
     or (p_period_end is not null and p_period_end <= now()) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select pl.id into v_plan_id from public.plans pl where pl.code = p_plan_code and pl.active;
  if v_plan_id is null or not exists (select 1 from public.subscriptions s where s.organization_id = p_org) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  update public.subscriptions s
     set plan_id = v_plan_id,
         status = p_status,
         limits_override = coalesce(p_limits_override, '{}'::jsonb),
         decided_by = v_uid,
         decision_reason = btrim(p_reason),
         period_start = case when p_status = 'active' then coalesce(s.period_start, now()) else s.period_start end,
         period_end = p_period_end
   where s.organization_id = p_org;
end;
$$;

-- Audit des changements d'abonnement (acteur = administrateur de la plateforme).
create function private.audit_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_plan text;
  v_new_plan text;
begin
  select p.code into v_old_plan from public.plans p where p.id = old.plan_id;
  select p.code into v_new_plan from public.plans p where p.id = new.plan_id;
  if v_old_plan is not distinct from v_new_plan and new.status is not distinct from old.status
     and new.limits_override is not distinct from old.limits_override and new.period_end is not distinct from old.period_end
     and new.period_start is not distinct from old.period_start
     and new.decision_reason is not distinct from old.decision_reason and new.decided_by is not distinct from old.decided_by then
    return null;
  end if;
  perform private.audit_write(
    new.organization_id, 'subscription.changed', 'subscription', new.id,
    pg_catalog.jsonb_build_object('plan', v_old_plan, 'status', old.status, 'limits_override', old.limits_override,
                                  'period_start', old.period_start, 'period_end', old.period_end, 'reason', old.decision_reason),
    pg_catalog.jsonb_build_object('plan', v_new_plan, 'status', new.status, 'limits_override', new.limits_override,
                                  'period_start', new.period_start, 'period_end', new.period_end, 'reason', new.decision_reason));
  return null;
end;
$$;
create trigger audit_subscriptions
  after update on public.subscriptions
  for each row execute function private.audit_subscriptions();
alter table public.subscriptions enable always trigger audit_subscriptions;

-- ---------------------------------------------------------------------------
-- Réactivation d'un membre (retiré, suspendu ou invité -> actif) par UPDATE direct : même limite `users`.
-- Si une invitation en attente existe pour la même adresse (chemin accept_invitation), la place est déjà réservée
-- par cette invitation (contrôlée à sa création) : pas de double comptage.
-- ---------------------------------------------------------------------------
create function private.enforce_member_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
      from public.invitations i
      join auth.users u on lower(btrim(u.email)) = i.email_normalized
     where u.id = new.user_id
       and i.organization_id = new.organization_id
       and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    return new;
  end if;
  perform private.assert_within_limit(new.organization_id, 'users', 1);
  return new;
end;
$$;
create trigger enforce_member_quota
  before update of status on public.organization_members
  for each row
  when (new.status = 'active' and old.status is distinct from 'active')
  execute function private.enforce_member_quota();

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------
-- Les plans et les abonnements ne sont écrits que par les fonctions ci-dessus (SECURITY DEFINER) : aucun droit d'écriture
-- direct, y compris pour service_role. usage_counters garde l'écriture service_role (ADR 007 E6 ; utilisée par le harnais de test).
revoke insert, update, delete, truncate on public.plans, public.subscriptions from service_role;
revoke all on function private.enforce_member_quota() from public, anon, authenticated, service_role;
revoke all on function private.is_platform_admin() from public, anon, authenticated, service_role;
revoke all on function private.is_valid_plan_limits(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.current_stock_usage(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.effective_limit(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.quota_period_start() from public, anon, authenticated, service_role;
revoke all on function private.assert_within_limit(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.usage_rows(uuid) from public, anon, authenticated, service_role;
revoke all on function private.get_org_usage(uuid) from public, anon, authenticated, service_role;
revoke all on function private.consume_quota(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.admin_list_organizations(integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.admin_set_subscription(uuid, text, public.subscription_status, jsonb, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.audit_subscriptions() from public, anon, authenticated, service_role;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.get_org_usage(uuid) to authenticated;
grant execute on function private.consume_quota(uuid, text, integer) to service_role;
grant execute on function private.admin_list_organizations(integer, integer) to authenticated;
grant execute on function private.admin_set_subscription(uuid, text, public.subscription_status, jsonb, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
create function public.is_platform_admin()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.is_platform_admin(); $$;

create function public.get_org_usage(p_org uuid)
returns table (metric text, used bigint, "limit" bigint, near_limit boolean)
language sql stable security invoker set search_path = ''
as $$ select * from private.get_org_usage(p_org); $$;

create function public.consume_quota(p_org uuid, p_metric text, p_amount integer default 1)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.consume_quota(p_org, p_metric, p_amount); $$;

create function public.admin_list_organizations(p_limit integer default 50, p_offset integer default 0)
returns table (
  organization_id uuid, name text, slug text, org_status public.org_status, plan_code text,
  sub_status public.subscription_status, period_end timestamptz, limits_override jsonb,
  members integer, created_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$ select * from private.admin_list_organizations(p_limit, p_offset); $$;

create function public.admin_set_subscription(
  p_org uuid, p_plan_code text, p_status public.subscription_status, p_limits_override jsonb, p_reason text,
  p_period_end timestamptz default null
)
returns void language sql security invoker set search_path = ''
as $$ select private.admin_set_subscription(p_org, p_plan_code, p_status, p_limits_override, p_reason, p_period_end); $$;

revoke all on function public.is_platform_admin() from public, anon, service_role;
revoke all on function public.get_org_usage(uuid) from public, anon, service_role;
revoke all on function public.consume_quota(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_list_organizations(integer, integer) from public, anon, service_role;
revoke all on function public.admin_set_subscription(uuid, text, public.subscription_status, jsonb, text, timestamptz) from public, anon, service_role;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.get_org_usage(uuid) to authenticated;
grant execute on function public.consume_quota(uuid, text, integer) to service_role;
grant execute on function public.admin_list_organizations(integer, integer) to authenticated;
grant execute on function public.admin_set_subscription(uuid, text, public.subscription_status, jsonb, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Invitations : contrôle de la limite `users` dans la même transaction
-- (reprise de private.create_invitation du J10 + un appel à assert_within_limit après la révocation de l'ancienne
-- invitation en attente, avant l'insertion)
-- ---------------------------------------------------------------------------
create or replace function private.create_invitation(
  p_org uuid,
  p_email text,
  p_role public.app_role,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Durée de validité d'une invitation (décision J10) : 7 jours.
  c_validity constant interval := interval '7 days';
  v_uid uuid;
  v_caller_role public.app_role;
  v_raw text;
  v_email text;
  v_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Autorisation d'abord (aucune validation n'est révélée à un non-habilité).
  if p_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select m.role into v_caller_role
    from public.organization_members m
   where m.organization_id = p_org and m.user_id = v_uid and m.status = 'active';
  if v_caller_role is null or v_caller_role not in ('company_owner', 'company_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- ADR 014 : un admin ne peut jamais attribuer company_owner.
  if p_role = 'company_owner' and v_caller_role <> 'company_owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Validation (les messages ne contiennent jamais la valeur saisie).
  -- E-mail : ASCII imprimable sans espace UNIQUEMENT (ni bidi, ni largeur nulle, ni contrôle, ni
  -- non-ASCII). Le contrôle porte sur la saisie AVANT lower() : certains caractères non ASCII
  -- (ex. U+212A, signe Kelvin) se transforment en ASCII par lower() et passeraient sinon.
  v_raw := btrim(p_email);
  v_email := lower(v_raw);
  if p_role is null
     or v_raw is null
     or char_length(v_raw) > 254
     or v_raw !~ '^[!-~]+$'
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'validation_failed' using errcode = '22023', detail = 'email';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'validation_failed' using errcode = '22023', detail = 'token_hash';
  end if;

  -- Sérialise les invitations simultanées pour la même adresse dans la même entreprise.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text || ':' || v_email, 0));

  if exists (
    select 1
      from public.organization_members m
      join auth.users u on u.id = m.user_id
     where m.organization_id = p_org
       and m.status = 'active'
       and lower(btrim(u.email)) = v_email
  ) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;

  -- Ré-invitation : l'invitation en attente précédente est révoquée (son jeton cesse de fonctionner).
  update public.invitations i
     set revoked_at = now()
   where i.organization_id = p_org
     and i.email_normalized = v_email
     and i.accepted_at is null
     and i.revoked_at is null;

  -- J14 : limite du plan (membres actifs + invitations en attente) ; échec = `quota_exceeded`, tout est annulé.
  perform private.assert_within_limit(p_org, 'users', 1);

  insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
  values (p_org, v_email, p_role, p_token_hash, now() + c_validity, v_uid)
  returning id into v_id;

  -- J11 : l'écriture au journal d'audit (sans e-mail ni jeton) sera ajoutée ici.
  return v_id;
end;
$$;
