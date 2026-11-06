-- J6 — Noyau tenant : enums, tables, contraintes, triggers.
-- Sources : spec §2, §7, §7.2, §10 ; ADR 005 (multi-tenancy), ADR 007 (modèle de données), ADR 014.
-- Retour arrière : supabase/rollbacks/20261106120613_core_tenant_schema.sql
-- Les fonctions d'aide RLS, l'activation de la RLS et le verrouillage des GRANT sont dans la
-- migration suivante (20261106120616_core_private_helpers_and_lockdown.sql) ; les politiques RLS
-- arrivent au J7.

-- ---------------------------------------------------------------------------
-- Schéma privé : non exposé à la Data API (api.schemas = public, graphql_public).
-- ---------------------------------------------------------------------------
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
-- Rôles d'organisation (spec §2). Le Platform Admin n'en fait PAS partie : ce n'est pas un
-- membre d'organisation (ADR 005 §10) ; il vivra dans private.platform_admins (J14).
create type public.app_role as enum (
  'company_owner',
  'company_admin',
  'marketing_manager',
  'sales_agent',
  'analyst'
);

create type public.member_status as enum ('invited', 'active', 'suspended', 'removed');
create type public.org_status as enum ('active', 'suspended', 'closed');
-- spec §10 : trial, active, past_due, suspended, cancelled
create type public.subscription_status as enum (
  'trial',
  'active',
  'past_due',
  'suspended',
  'cancelled'
);

-- ---------------------------------------------------------------------------
-- Fonctions de trigger (schéma privé)
-- ---------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ADR 005 §3 : un enregistrement ne change jamais d'entreprise par un UPDATE direct (spec §2).
create function private.prevent_organization_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable (table %)', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- plans : catalogue global (hors tenant). ADR 007 E10 / G-D1.
-- ---------------------------------------------------------------------------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  -- Limites par plan (spec §10 : utilisateurs, projets, contacts, messages/mois, runs IA,
  -- intégrations). La spec ne donne aucune valeur : elles sont définies au J14.
  limits jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_code_key unique (code),
  constraint plans_code_format check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint plans_name_not_blank check (length(btrim(name)) > 0),
  constraint plans_limits_is_object check (jsonb_typeof(limits) = 'object')
);
comment on table public.plans is 'Catalogue des plans SaaS (global, non tenant). Limites définies au J14.';

-- Plan initial utilisé à la création d'une entreprise (J9). Aucune limite inventée ici.
insert into public.plans (code, name) values ('trial', 'Trial');

-- ---------------------------------------------------------------------------
-- organizations : racine du tenant (pas de colonne organization_id).
-- plan_id supprimé (E10) : subscriptions est la source unique du plan.
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  status public.org_status not null default 'active',
  timezone text not null default 'UTC', -- nom IANA, validé par la couche service (zod)
  locale text not null default 'ar',
  -- ADR 007 G-D8 : marque, consentement par défaut, heures ouvrées, approval_policy, send_paused…
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_key unique (slug),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  constraint organizations_name_not_blank check (length(btrim(name)) > 0),
  constraint organizations_locale_check check (locale in ('ar', 'en')),
  constraint organizations_settings_is_object check (jsonb_typeof(settings) = 'object')
);
comment on table public.organizations is 'Entreprise (tenant). Racine : pas de organization_id.';

-- ---------------------------------------------------------------------------
-- organization_members : source du rôle (jamais user_metadata, ADR 005 §5).
-- ---------------------------------------------------------------------------
create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  status public.member_status not null default 'active',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- spec §7 : clé composite unique ; cible des FK composites (ADR 005 §2)
  constraint organization_members_org_user_key unique (organization_id, user_id),
  constraint organization_members_org_id_key unique (organization_id, id)
);
-- Index de recherche par utilisateur (is_member / has_role, mesure R13 au J15).
create index organization_members_user_org_idx
  on public.organization_members (user_id, organization_id);
comment on table public.organization_members is 'Adhésions : unique source du rôle (ADR 005 §5).';

-- ---------------------------------------------------------------------------
-- subscriptions : source unique du plan (E10). Une ligne par entreprise au MVP.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  plan_id uuid not null references public.plans (id) on delete restrict,
  status public.subscription_status not null default 'trial',
  period_start timestamptz,
  period_end timestamptz,
  limits_override jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users (id) on delete set null,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_org_key unique (organization_id),
  constraint subscriptions_org_id_key unique (organization_id, id),
  constraint subscriptions_period_order check (
    period_start is null or period_end is null or period_end > period_start
  ),
  constraint subscriptions_limits_override_is_object check (
    jsonb_typeof(limits_override) = 'object'
  )
);
create index subscriptions_plan_idx on public.subscriptions (plan_id);
comment on table public.subscriptions is 'Plan et statut SaaS (activation manuelle par le Platform Admin au MVP, spec §10).';

-- ---------------------------------------------------------------------------
-- usage_counters : consommation par entreprise, métrique et période (E6).
-- ---------------------------------------------------------------------------
create table public.usage_counters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  metric text not null,
  period_start date not null,
  value bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint usage_counters_org_metric_period_key unique (organization_id, metric, period_start),
  constraint usage_counters_org_id_key unique (organization_id, id),
  constraint usage_counters_value_non_negative check (value >= 0),
  constraint usage_counters_metric_format check (metric ~ '^[a-z][a-z0-9_]{1,63}$')
);
comment on table public.usage_counters is 'Compteurs d''usage par entreprise/métrique/période. Incrément atomique par fonction (J14).';

-- ---------------------------------------------------------------------------
-- Triggers : updated_at partout, anti-transfert d'organisation sur les tables tenant.
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.plans
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.organization_members
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.subscriptions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.usage_counters
  for each row execute function private.set_updated_at();

create trigger prevent_organization_id_change
  before update of organization_id on public.organization_members
  for each row execute function private.prevent_organization_id_change();
create trigger prevent_organization_id_change
  before update of organization_id on public.subscriptions
  for each row execute function private.prevent_organization_id_change();
create trigger prevent_organization_id_change
  before update of organization_id on public.usage_counters
  for each row execute function private.prevent_organization_id_change();
