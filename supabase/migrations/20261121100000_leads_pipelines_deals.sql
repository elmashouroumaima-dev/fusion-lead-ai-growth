-- J19 — Pipelines, leads et deals (spec §7 et §9.1 ; ADR 007 E1, G-D3 ; ADR 014).
-- Retour arrière : supabase/rollbacks/20261121100000_leads_pipelines_deals.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * enum `stage_kind` (open, won, lost, unassigned) ; `pipelines` + `pipeline_stages` par entreprise (E1) ; un pipeline par
--    défaut par entreprise ; UNE étape système `unassigned` par pipeline (file « non assignés », spec §9.1) ;
--  * étapes par défaut créées dans la langue de l'entreprise (fr, en, ar) : Non assigné, Nouveau, Qualifié, Proposition
--    (ouvertes), Gagné, Perdu ; nouvelles entreprises (déclencheur) et entreprises existantes (rattrapage) ;
--  * ÉCRITURE UNIQUEMENT PAR FONCTIONS (SECURITY DEFINER, identité = auth.uid()), comme projets et contacts : aucun droit
--    INSERT / UPDATE / DELETE direct, même pour service_role ;
--  * rôles (ADR 014) : pipelines et étapes = owner / admin ; création d'un lead = owner / admin / marketing ; modification,
--    changement d'étape, deals = owner / admin et commercial sur SES leads (`assignee_id = auth.uid()`) ; assignation =
--    owner / admin ; lecture : owner / admin / marketing partout, commercial sur ses leads, analyste aucun accès aux leads
--    et deals ; pipelines et étapes lisibles par tous les membres ;
--  * un responsable est un membre ACTIF owner, admin ou sales_agent ; un lead dans l'étape `unassigned` n'a pas de
--    responsable (imposé par déclencheur) ; l'assignation sort le lead de l'étape `unassigned` (première étape ouverte) ;
--    un membre suspendu ou retiré libère ses leads (retour à l'étape `unassigned` s'ils étaient ouverts) ;
--  * `leads.campaign_id` : colonne SANS clé étrangère jusqu'au J42 (la table `campaigns` n'existe pas encore) ;
--  * pas d'unicité (contact, projet) : décidée au J21 avec la capture publique (la course s'y joue) ;
--  * un lead ou un deal d'un projet archivé est en lecture seule ; un lead ne change ni de contact ni de projet ;
--  * deals : `won_at` / `lost_at` exclusifs et cohérents avec le genre de l'étape (contrainte + déclencheur) ; un deal reste
--    dans le pipeline de son lead ; `value` numeric(14,2) ≥ 0, `currency` ISO 4217 (3 lettres) ;
--  * contacts (promesse du J18) : le commercial lit les contacts de SES leads et peut révoquer un consentement / poser
--    « ne plus contacter » sur eux ;
--  * audit : identifiants, genres d'étape, noms de champs ; jamais la valeur d'un deal, ni le score, ni les UTM.

create type public.stage_kind as enum ('open', 'won', 'lost', 'unassigned');

-- ---------------------------------------------------------------------------
-- Validations (fonctions pures, search_path vide)
-- ---------------------------------------------------------------------------
create function private.is_valid_lead_utm(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_entry record;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'object' or pg_catalog.octet_length(p_value::text) > 2048 then
    return false;
  end if;
  for v_entry in select e.key, e.value from pg_catalog.jsonb_each(p_value) as e loop
    if not (v_entry.key = any (array['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing_page_id']))
       or pg_catalog.jsonb_typeof(v_entry.value) <> 'string'
       or not private.is_safe_text(v_entry.value #>> '{}', 1, 200) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function private.is_valid_score_reason(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and pg_catalog.jsonb_typeof(p_value) = 'object'
     and pg_catalog.octet_length(p_value::text) <= 4096
     and private.jsonb_depth(p_value) <= 3;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipelines_org_id_key unique (organization_id, id),
  constraint pipelines_org_name_key unique (organization_id, name),
  constraint pipelines_name_valid check (private.is_safe_text(name, 1, 100))
);
create unique index pipelines_one_default_key on public.pipelines (organization_id) where is_default;

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  pipeline_id uuid not null,
  name text not null,
  position integer not null,
  kind public.stage_kind not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_stages_org_id_key unique (organization_id, id),
  constraint pipeline_stages_pipeline_fkey foreign key (organization_id, pipeline_id)
    references public.pipelines (organization_id, id) on delete restrict,
  constraint pipeline_stages_name_key unique (organization_id, pipeline_id, name),
  constraint pipeline_stages_name_valid check (private.is_safe_text(name, 1, 100)),
  constraint pipeline_stages_position_valid check (position between 0 and 1000000)
);
create index pipeline_stages_org_pipeline_idx on public.pipeline_stages (organization_id, pipeline_id, position);
create unique index pipeline_stages_one_unassigned_key on public.pipeline_stages (organization_id, pipeline_id) where kind = 'unassigned';

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_id uuid not null,
  project_id uuid not null,
  source text not null,
  stage_id uuid not null,
  score integer,
  score_reason jsonb not null default '{}'::jsonb,
  assignee_id uuid,
  campaign_id uuid,
  utm jsonb not null default '{}'::jsonb,
  external_source text,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_org_id_key unique (organization_id, id),
  constraint leads_contact_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete restrict,
  constraint leads_project_fkey foreign key (organization_id, project_id)
    references public.projects (organization_id, id) on delete restrict,
  constraint leads_stage_fkey foreign key (organization_id, stage_id)
    references public.pipeline_stages (organization_id, id) on delete restrict,
  -- responsable = membre de la MÊME entreprise ; si l'adhésion est supprimée, seul assignee_id passe à NULL
  constraint leads_assignee_fkey foreign key (organization_id, assignee_id)
    references public.organization_members (organization_id, user_id) on delete set null (assignee_id),
  constraint leads_source_valid check (source ~ '^[a-z][a-z0-9_]{0,49}$'),
  constraint leads_score_valid check (score is null or score between 0 and 100),
  constraint leads_score_reason_valid check (private.is_valid_score_reason(score_reason)),
  constraint leads_utm_valid check (private.is_valid_lead_utm(utm)),
  constraint leads_external_pair check ((external_source is null) = (external_id is null)),
  constraint leads_external_source_valid check (external_source is null or private.is_safe_text(external_source, 1, 50)),
  constraint leads_external_id_valid check (external_id is null or private.is_safe_text(external_id, 1, 200))
);
create index leads_org_stage_idx on public.leads (organization_id, stage_id);
create index leads_org_assignee_idx on public.leads (organization_id, assignee_id);
create index leads_org_project_idx on public.leads (organization_id, project_id);
create index leads_org_contact_idx on public.leads (organization_id, contact_id);
create unique index leads_org_external_key on public.leads (organization_id, external_source, external_id) where external_id is not null;

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null,
  stage_id uuid not null,
  value numeric(14, 2) not null,
  currency text not null,
  expected_close_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  external_source text,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_org_id_key unique (organization_id, id),
  constraint deals_lead_fkey foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete restrict,
  constraint deals_stage_fkey foreign key (organization_id, stage_id)
    references public.pipeline_stages (organization_id, id) on delete restrict,
  constraint deals_value_valid check (value >= 0 and value <> 'NaN'::numeric),
  constraint deals_expected_close_valid check (expected_close_at is null or (expected_close_at > timestamptz '2000-01-01' and expected_close_at < timestamptz '2100-01-01')),
  constraint deals_currency_valid check (currency ~ '^[A-Z]{3}$'),
  constraint deals_won_lost_exclusive check (not (won_at is not null and lost_at is not null)),
  constraint deals_external_pair check ((external_source is null) = (external_id is null)),
  constraint deals_external_source_valid check (external_source is null or private.is_safe_text(external_source, 1, 50)),
  constraint deals_external_id_valid check (external_id is null or private.is_safe_text(external_id, 1, 200))
);
create index deals_org_lead_idx on public.deals (organization_id, lead_id);
create index deals_org_stage_idx on public.deals (organization_id, stage_id);
create unique index deals_org_external_key on public.deals (organization_id, external_source, external_id) where external_id is not null;

-- ---------------------------------------------------------------------------
-- Triggers : updated_at, immutabilité, cohérence étapes / responsable / dates
-- ---------------------------------------------------------------------------
create trigger pipelines_set_updated_at before update on public.pipelines for each row execute function private.set_updated_at();
create trigger pipelines_org_immutable before update on public.pipelines for each row execute function private.prevent_organization_id_change();
create trigger pipeline_stages_set_updated_at before update on public.pipeline_stages for each row execute function private.set_updated_at();
create trigger pipeline_stages_org_immutable before update on public.pipeline_stages for each row execute function private.prevent_organization_id_change();
create trigger leads_set_updated_at before update on public.leads for each row execute function private.set_updated_at();
create trigger leads_org_immutable before update on public.leads for each row execute function private.prevent_organization_id_change();
create trigger deals_set_updated_at before update on public.deals for each row execute function private.set_updated_at();
create trigger deals_org_immutable before update on public.deals for each row execute function private.prevent_organization_id_change();

create function private.pipeline_stages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.kind = 'unassigned' then
      raise exception 'the unassigned stage is a system stage' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if new.kind is distinct from old.kind or new.pipeline_id is distinct from old.pipeline_id then
    raise exception 'stage kind and pipeline are immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger pipeline_stages_guard before update or delete on public.pipeline_stages
  for each row execute function private.pipeline_stages_guard();

-- Lead : contact et projet immuables ; l'étape `unassigned` exclut tout responsable.
create function private.leads_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.stage_kind;
begin
  if tg_op = 'UPDATE' and (new.contact_id is distinct from old.contact_id or new.project_id is distinct from old.project_id) then
    raise exception 'lead contact and project are immutable' using errcode = 'check_violation';
  end if;
  select s.kind into v_kind from public.pipeline_stages s where s.organization_id = new.organization_id and s.id = new.stage_id;
  if v_kind = 'unassigned' and new.assignee_id is not null then
    raise exception 'a lead in the unassigned stage has no assignee' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger leads_guard before insert or update on public.leads for each row execute function private.leads_guard();

-- Deal : lead immuable ; jamais dans l'étape système ; dates gagné / perdu cohérentes avec le genre de l'étape.
create function private.deals_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.stage_kind;
begin
  if tg_op = 'UPDATE' and new.lead_id is distinct from old.lead_id then
    raise exception 'deal lead is immutable' using errcode = 'check_violation';
  end if;
  select s.kind into v_kind from public.pipeline_stages s where s.organization_id = new.organization_id and s.id = new.stage_id;
  if v_kind is null or v_kind = 'unassigned'
     or (v_kind = 'won' and (new.won_at is null or new.lost_at is not null))
     or (v_kind = 'lost' and (new.lost_at is null or new.won_at is not null))
     or (v_kind = 'open' and (new.won_at is not null or new.lost_at is not null)) then
    raise exception 'deal dates do not match the stage kind' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger deals_guard before insert or update on public.deals for each row execute function private.deals_guard();

-- ---------------------------------------------------------------------------
-- Étapes par défaut (langue de l'entreprise) : pipeline par défaut des nouvelles entreprises + rattrapage des existantes
-- ---------------------------------------------------------------------------
create function private.seed_pipeline_stages(p_org uuid, p_pipeline uuid, p_locale text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_names text[];
begin
  v_names := case p_locale
    when 'ar' then array['غير مسند', 'جديد', 'مؤهل', 'عرض', 'مكسوب', 'خسارة']
    when 'en' then array['Unassigned', 'New', 'Qualified', 'Proposal', 'Won', 'Lost']
    else array['Non assigné', 'Nouveau', 'Qualifié', 'Proposition', 'Gagné', 'Perdu']
  end;
  insert into public.pipeline_stages (organization_id, pipeline_id, name, position, kind) values
    (p_org, p_pipeline, v_names[1], 0, 'unassigned'),
    (p_org, p_pipeline, v_names[2], 10, 'open'),
    (p_org, p_pipeline, v_names[3], 20, 'open'),
    (p_org, p_pipeline, v_names[4], 30, 'open'),
    (p_org, p_pipeline, v_names[5], 40, 'won'),
    (p_org, p_pipeline, v_names[6], 50, 'lost');
end;
$$;

create function private.seed_default_pipeline(p_org uuid, p_locale text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline uuid := gen_random_uuid();
begin
  -- Création système (déclencheur d'entreprise) : les déclencheurs d'audit imbriqués ne journalisent pas.
  insert into public.pipelines (id, organization_id, name, is_default)
  values (v_pipeline, p_org, case p_locale when 'ar' then 'مسار المبيعات' when 'en' then 'Sales pipeline' else 'Pipeline commercial' end, true);
  perform private.seed_pipeline_stages(p_org, v_pipeline, p_locale);
end;
$$;

create function private.organizations_seed_pipeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_pipeline(new.id, new.locale);
  return null;
end;
$$;
create trigger organizations_seed_pipeline after insert on public.organizations
  for each row execute function private.organizations_seed_pipeline();

-- Rattrapage : entreprises existantes sans pipeline.
do $backfill$
declare
  v_org record;
begin
  for v_org in select o.id, o.locale from public.organizations o
                where not exists (select 1 from public.pipelines p where p.organization_id = o.id) loop
    perform private.seed_default_pipeline(v_org.id, v_org.locale);
  end loop;
end
$backfill$;

-- Un membre suspendu ou retiré libère ses leads (retour à l'étape « non assignés » s'ils étaient ouverts).
create function private.release_leads_of(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.leads l
     set assignee_id = null,
         stage_id = case when s.kind = 'open'
                         then coalesce((select u.id from public.pipeline_stages u
                                         where u.organization_id = l.organization_id and u.pipeline_id = s.pipeline_id and u.kind = 'unassigned'), l.stage_id)
                         else l.stage_id end
    from public.pipeline_stages s
   where s.organization_id = l.organization_id and s.id = l.stage_id
     and l.organization_id = p_org and l.assignee_id = p_user;
end;
$$;

create function private.release_lead_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.release_leads_of(old.organization_id, old.user_id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return null;
end;
$$;
-- Suspension ou retrait (statut), rétrogradation vers un rôle sans portefeuille (marketing, analyste) et suppression de la ligne :
-- dans tous les cas les leads du membre sont libérés (la suppression AVANT la clé étrangère « set null », qui laisserait le lead ouvert).
create trigger release_lead_assignments
  after update of status on public.organization_members
  for each row
  when (old.status = 'active' and new.status is distinct from 'active')
  execute function private.release_lead_assignments();
create trigger release_lead_assignments_role
  after update of role on public.organization_members
  for each row
  when (old.role in ('company_owner', 'company_admin', 'sales_agent') and new.role not in ('company_owner', 'company_admin', 'sales_agent'))
  execute function private.release_lead_assignments();
create trigger release_lead_assignments_delete
  before delete on public.organization_members
  for each row
  execute function private.release_lead_assignments();

-- ---------------------------------------------------------------------------
-- Audit : identifiants, genres d'étape, noms de champs (jamais valeur, score ni UTM)
-- ---------------------------------------------------------------------------
create function private.audit_pipelines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'pipeline.created', 'pipeline', new.id, null,
      pg_catalog.jsonb_build_object('name', new.name, 'is_default', new.is_default));
    return null;
  end if;
  if new.name is distinct from old.name then
    perform private.audit_write(new.organization_id, 'pipeline.renamed', 'pipeline', new.id,
      pg_catalog.jsonb_build_object('name', old.name), pg_catalog.jsonb_build_object('name', new.name));
  end if;
  if new.is_default is distinct from old.is_default then
    perform private.audit_write(new.organization_id, 'pipeline.default_changed', 'pipeline', new.id,
      pg_catalog.jsonb_build_object('is_default', old.is_default), pg_catalog.jsonb_build_object('is_default', new.is_default));
  end if;
  return null;
end;
$$;

create function private.audit_pipeline_stages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'stage.created', 'pipeline_stage', new.id, null,
      pg_catalog.jsonb_build_object('pipeline_id', new.pipeline_id, 'kind', new.kind));
    return null;
  elsif tg_op = 'DELETE' then
    perform private.audit_write(old.organization_id, 'stage.deleted', 'pipeline_stage', old.id,
      pg_catalog.jsonb_build_object('pipeline_id', old.pipeline_id, 'kind', old.kind), null);
    return null;
  end if;
  if new.name is distinct from old.name then v_changed := pg_catalog.array_append(v_changed, 'name'::text); end if;
  if new.position is distinct from old.position then v_changed := pg_catalog.array_append(v_changed, 'position'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(new.organization_id, 'stage.updated', 'pipeline_stage', new.id, null,
      pg_catalog.jsonb_build_object('pipeline_id', new.pipeline_id, 'changed', v_changed));
  end if;
  return null;
end;
$$;

create function private.audit_leads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'lead.created', 'lead', new.id, null,
      pg_catalog.jsonb_build_object('project_id', new.project_id, 'contact_id', new.contact_id, 'stage_id', new.stage_id, 'assignee_id', new.assignee_id));
    return null;
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    perform private.audit_write(new.organization_id, 'lead.assigned', 'lead', new.id,
      pg_catalog.jsonb_build_object('assignee_id', old.assignee_id), pg_catalog.jsonb_build_object('assignee_id', new.assignee_id));
  end if;
  if new.stage_id is distinct from old.stage_id then
    perform private.audit_write(new.organization_id, 'lead.stage_changed', 'lead', new.id,
      pg_catalog.jsonb_build_object('stage_id', old.stage_id), pg_catalog.jsonb_build_object('stage_id', new.stage_id));
  end if;
  if new.source is distinct from old.source then v_changed := pg_catalog.array_append(v_changed, 'source'::text); end if;
  if new.score is distinct from old.score then v_changed := pg_catalog.array_append(v_changed, 'score'::text); end if;
  if new.score_reason is distinct from old.score_reason then v_changed := pg_catalog.array_append(v_changed, 'score_reason'::text); end if;
  if new.utm is distinct from old.utm then v_changed := pg_catalog.array_append(v_changed, 'utm'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(new.organization_id, 'lead.updated', 'lead', new.id, null, pg_catalog.jsonb_build_object('changed', v_changed));
  end if;
  return null;
end;
$$;

create function private.audit_deals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'deal.created', 'deal', new.id, null,
      pg_catalog.jsonb_build_object('lead_id', new.lead_id, 'stage_id', new.stage_id, 'currency', new.currency));
    return null;
  end if;
  if new.stage_id is distinct from old.stage_id then
    perform private.audit_write(new.organization_id, 'deal.stage_changed', 'deal', new.id,
      pg_catalog.jsonb_build_object('stage_id', old.stage_id), pg_catalog.jsonb_build_object('stage_id', new.stage_id));
  end if;
  if new.won_at is not null and old.won_at is null then
    perform private.audit_write(new.organization_id, 'deal.won', 'deal', new.id, null, pg_catalog.jsonb_build_object('lead_id', new.lead_id));
  end if;
  if new.lost_at is not null and old.lost_at is null then
    perform private.audit_write(new.organization_id, 'deal.lost', 'deal', new.id, null, pg_catalog.jsonb_build_object('lead_id', new.lead_id));
  end if;
  if new.value is distinct from old.value then v_changed := pg_catalog.array_append(v_changed, 'value'::text); end if;
  if new.currency is distinct from old.currency then v_changed := pg_catalog.array_append(v_changed, 'currency'::text); end if;
  if new.expected_close_at is distinct from old.expected_close_at then v_changed := pg_catalog.array_append(v_changed, 'expected_close_at'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(new.organization_id, 'deal.updated', 'deal', new.id, null, pg_catalog.jsonb_build_object('changed', v_changed));
  end if;
  return null;
end;
$$;

create trigger audit_pipelines after insert or update on public.pipelines for each row execute function private.audit_pipelines();
create trigger audit_pipeline_stages after insert or update or delete on public.pipeline_stages for each row execute function private.audit_pipeline_stages();
create trigger audit_leads after insert or update on public.leads for each row execute function private.audit_leads();
create trigger audit_deals after insert or update on public.deals for each row execute function private.audit_deals();

-- ---------------------------------------------------------------------------
-- RLS : lecture par rôle ; aucune écriture directe
-- ---------------------------------------------------------------------------
alter table public.pipelines enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.leads enable row level security;
alter table public.deals enable row level security;

grant select on table public.pipelines to authenticated;
grant select on table public.pipeline_stages to authenticated;
grant select on table public.leads to authenticated;
grant select on table public.deals to authenticated;
revoke insert, update, delete, truncate on table public.pipelines from service_role;
revoke insert, update, delete, truncate on table public.pipeline_stages from service_role;
revoke insert, update, delete, truncate on table public.leads from service_role;
revoke insert, update, delete, truncate on table public.deals from service_role;

create policy pipelines_select on public.pipelines for select to authenticated using (private.is_member(organization_id));
create policy pipeline_stages_select on public.pipeline_stages for select to authenticated using (private.is_member(organization_id));

create policy leads_select on public.leads
  for select to authenticated
  using (
    private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[])
    or (private.has_role(organization_id, array['sales_agent']::public.app_role[]) and assignee_id = auth.uid())
  );

create policy deals_select on public.deals
  for select to authenticated
  using (
    private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[])
    or (private.has_role(organization_id, array['sales_agent']::public.app_role[])
        and exists (select 1 from public.leads l
                     where l.organization_id = deals.organization_id and l.id = deals.lead_id and l.assignee_id = auth.uid()))
  );

-- Contacts et consentements : le commercial lit ceux de SES leads (promesse du J18).
drop policy contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated
  using (
    private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[])
    or (private.has_role(organization_id, array['sales_agent']::public.app_role[])
        and exists (select 1 from public.leads l
                     where l.organization_id = contacts.organization_id and l.contact_id = contacts.id and l.assignee_id = auth.uid()))
  );
drop policy consent_events_select on public.consent_events;
create policy consent_events_select on public.consent_events
  for select to authenticated
  using (
    private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[])
    or (private.has_role(organization_id, array['sales_agent']::public.app_role[])
        and exists (select 1 from public.leads l
                     where l.organization_id = consent_events.organization_id and l.contact_id = consent_events.contact_id and l.assignee_id = auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Aides communes aux fonctions d'écriture
-- Codes d'erreur : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 (ou 23514 contrainte) · not_found PT404 ·
-- doublon 23505 · P0001 : project_archived, assignee_invalid, pipeline_incomplete, stage_in_use, system_stage, last_open_stage,
-- too_many_pipelines, too_many_stages, too_many_files…
-- ---------------------------------------------------------------------------
-- Responsable possible : membre ACTIF owner, admin ou sales_agent de l'entreprise.
create function private.assert_assignable(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Verrou partagé sur la ligne du membre : une suspension concurrente attend la fin de l'assignation et libère ensuite le lead.
  perform 1 from public.organization_members m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active'
     and m.role in ('company_owner', 'company_admin', 'sales_agent')
   for share;
  if not found then
    raise exception 'assignee_invalid' using errcode = 'P0001';
  end if;
end;
$$;

-- Abonnement actif exigé pour créer pipelines, leads et deals (comme contacts et projets) ; plafonds techniques ci-dessous.
create function private.assert_subscription_active(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status public.subscription_status;
begin
  select s.status into v_status from public.subscriptions s where s.organization_id = p_org;
  if v_status is null or v_status in ('suspended', 'cancelled') then
    raise exception 'subscription_inactive' using errcode = 'P0001';
  end if;
end;
$$;

-- Verrouille un lead pour écriture. Owner / admin : tous les leads ; commercial : SES leads (un autre lead lui est « introuvable,
-- comme la RLS) ; marketing, analyste et non-membre : interdit. Projet archivé : lecture seule.
create function private.lock_lead_for_write(p_org uuid, p_lead uuid)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead public.leads;
  v_status public.project_status;
  v_manager boolean;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_manager := p_org is not null and private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]);
  if not v_manager and not (p_org is not null and private.has_role(p_org, array['sales_agent']::public.app_role[])) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lead is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_lead from public.leads l where l.id = p_lead and l.organization_id = p_org for update;
  if not found or (not v_manager and v_lead.assignee_id is distinct from auth.uid()) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select p.status into v_status from public.projects p where p.id = v_lead.project_id and p.organization_id = p_org;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  return v_lead;
end;
$$;

-- Première étape d'un genre donné dans le pipeline d'une étape (ordre d'affichage), ou NULL.
create function private.first_stage_of_kind(p_org uuid, p_pipeline uuid, p_kind public.stage_kind)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.pipeline_stages s
   where s.organization_id = p_org and s.pipeline_id = p_pipeline and s.kind = p_kind
   order by s.position, s.id limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Pipelines et étapes (owner / admin)
-- ---------------------------------------------------------------------------
create function private.create_pipeline(p_org uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_locale text;
begin
  perform private.assert_project_manager(p_org);
  if not private.is_safe_text(p_name, 1, 100) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  -- Verrou de l'entreprise : plafond technique de 20 pipelines, courses sérialisées.
  select o.locale into v_locale from public.organizations o where o.id = p_org for update;
  if (select count(*) from public.pipelines p where p.organization_id = p_org) >= 20 then
    raise exception 'too_many_pipelines' using errcode = 'P0001';
  end if;
  insert into public.pipelines (id, organization_id, name, is_default) values (v_id, p_org, p_name, false);
  perform private.seed_pipeline_stages(p_org, v_id, v_locale);
  return v_id;
end;
$$;

create function private.rename_pipeline(p_org uuid, p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_manager(p_org);
  if p_id is null or not private.is_safe_text(p_name, 1, 100) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.pipelines p where p.id = p_id and p.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.pipelines set name = p_name where id = p_id and organization_id = p_org;
end;
$$;

create function private.set_default_pipeline(p_org uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_manager(p_org);
  if p_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.pipelines p where p.organization_id = p_org for update;
  if not exists (select 1 from public.pipelines p where p.id = p_id and p.organization_id = p_org) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.pipelines set is_default = false where organization_id = p_org and is_default and id <> p_id;
  update public.pipelines set is_default = true where id = p_id and organization_id = p_org and not is_default;
end;
$$;

create function private.create_stage(p_org uuid, p_pipeline uuid, p_name text, p_kind public.stage_kind, p_position integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_position integer;
begin
  perform private.assert_project_manager(p_org);
  if p_pipeline is null or p_kind is null or p_kind = 'unassigned' or not private.is_safe_text(p_name, 1, 100)
     or (p_position is not null and p_position not between 0 and 1000000) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.pipelines p where p.id = p_pipeline and p.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if (select count(*) from public.pipeline_stages s where s.organization_id = p_org and s.pipeline_id = p_pipeline) >= 30 then
    raise exception 'too_many_stages' using errcode = 'P0001';
  end if;
  v_position := coalesce(p_position,
    least((select coalesce(max(s.position), -10) + 10 from public.pipeline_stages s where s.organization_id = p_org and s.pipeline_id = p_pipeline), 1000000));
  insert into public.pipeline_stages (id, organization_id, pipeline_id, name, position, kind) values (v_id, p_org, p_pipeline, p_name, v_position, p_kind);
  return v_id;
end;
$$;

create function private.update_stage(p_org uuid, p_id uuid, p_name text, p_position integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_project_manager(p_org);
  if p_id is null or p_position is null or p_position not between 0 and 1000000 or not private.is_safe_text(p_name, 1, 100) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.pipeline_stages s where s.id = p_id and s.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.pipeline_stages set name = p_name, position = p_position where id = p_id and organization_id = p_org;
end;
$$;

create function private.delete_stage(p_org uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.pipeline_stages;
begin
  perform private.assert_project_manager(p_org);
  if p_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_stage from public.pipeline_stages s where s.id = p_id and s.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_stage.kind = 'unassigned' then
    raise exception 'system_stage' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.leads l where l.organization_id = p_org and l.stage_id = p_id)
     or exists (select 1 from public.deals d where d.organization_id = p_org and d.stage_id = p_id) then
    raise exception 'stage_in_use' using errcode = 'P0001';
  end if;
  -- Un pipeline garde au moins une étape ouverte (sinon aucun lead ne peut être assigné).
  if v_stage.kind = 'open' and (select count(*) from public.pipeline_stages s
        where s.organization_id = p_org and s.pipeline_id = v_stage.pipeline_id and s.kind = 'open') <= 1 then
    raise exception 'last_open_stage' using errcode = 'P0001';
  end if;
  delete from public.pipeline_stages where id = p_id and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create function private.create_lead(
  p_org uuid, p_contact uuid, p_project uuid, p_source text, p_assignee uuid, p_score integer, p_score_reason jsonb,
  p_utm jsonb, p_external_source text, p_external_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_status public.project_status;
  v_pipeline uuid;
  v_stage uuid;
begin
  perform private.assert_contact_manager(p_org);
  if p_contact is null or p_project is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Choisir le responsable à la création = assigner : owner et admin seulement (ADR 014 : le marketing voit les leads non assignés).
  if p_assignee is not null and not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.assert_subscription_active(p_org);
  select p.status into v_status from public.projects p where p.id = p_project and p.organization_id = p_org for share;
  if not found or not exists (select 1 from public.contacts c where c.id = p_contact and c.organization_id = p_org) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  if p_assignee is not null then
    perform private.assert_assignable(p_org, p_assignee);
  end if;
  -- Plafond technique (hors plan) : 50 leads par contact.
  if (select count(*) from public.leads l where l.organization_id = p_org and l.contact_id = p_contact) >= 50 then
    raise exception 'too_many_leads' using errcode = 'P0001';
  end if;
  select p.id into v_pipeline from public.pipelines p where p.organization_id = p_org and p.is_default;
  v_stage := private.first_stage_of_kind(p_org, v_pipeline, case when p_assignee is null then 'unassigned'::public.stage_kind else 'open'::public.stage_kind end);
  if v_stage is null then
    raise exception 'pipeline_incomplete' using errcode = 'P0001';
  end if;
  insert into public.leads (
    id, organization_id, contact_id, project_id, source, stage_id, score, score_reason, assignee_id, utm, external_source, external_id)
  values (
    v_id, p_org, p_contact, p_project, p_source, v_stage, p_score, coalesce(p_score_reason, '{}'::jsonb), p_assignee,
    coalesce(p_utm, '{}'::jsonb), p_external_source, p_external_id);
  return v_id;
end;
$$;

create function private.update_lead(p_org uuid, p_id uuid, p_source text, p_score integer, p_score_reason jsonb, p_utm jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_lead_for_write(p_org, p_id);
  update public.leads
     set source = p_source, score = p_score, score_reason = coalesce(p_score_reason, '{}'::jsonb), utm = coalesce(p_utm, '{}'::jsonb)
   where id = p_id and organization_id = p_org;
end;
$$;

create function private.assign_lead(p_org uuid, p_id uuid, p_assignee uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead public.leads;
  v_stage public.pipeline_stages;
  v_target uuid;
begin
  perform private.assert_project_manager(p_org);
  v_lead := private.lock_lead_for_write(p_org, p_id);
  select * into v_stage from public.pipeline_stages s where s.organization_id = p_org and s.id = v_lead.stage_id;
  v_target := v_lead.stage_id;
  if p_assignee is not null then
    perform private.assert_assignable(p_org, p_assignee);
    if v_stage.kind = 'unassigned' then
      v_target := private.first_stage_of_kind(p_org, v_stage.pipeline_id, 'open');
    end if;
  elsif v_stage.kind = 'open' then
    v_target := coalesce(private.first_stage_of_kind(p_org, v_stage.pipeline_id, 'unassigned'), v_lead.stage_id);
  end if;
  if v_target is null then
    raise exception 'pipeline_incomplete' using errcode = 'P0001';
  end if;
  update public.leads set assignee_id = p_assignee, stage_id = v_target where id = p_id and organization_id = p_org;
end;
$$;

create function private.move_lead_stage(p_org uuid, p_id uuid, p_stage uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead public.leads;
  v_pipeline uuid;
  v_target uuid;
begin
  v_lead := private.lock_lead_for_write(p_org, p_id);
  select s.pipeline_id into v_target from public.pipeline_stages s where s.id = p_stage and s.organization_id = p_org;
  if p_stage is null or not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- Un lead reste dans son pipeline (ses deals y restent aussi).
  select s.pipeline_id into v_pipeline from public.pipeline_stages s where s.id = v_lead.stage_id and s.organization_id = p_org;
  if v_target is distinct from v_pipeline then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.leads set stage_id = p_stage where id = p_id and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Deals (owner / admin, commercial sur ses leads)
-- ---------------------------------------------------------------------------
create function private.create_deal(
  p_org uuid, p_lead uuid, p_stage uuid, p_value numeric, p_currency text, p_expected_close_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_lead public.leads;
  v_pipeline uuid;
  v_stage uuid;
  v_kind public.stage_kind;
begin
  v_lead := private.lock_lead_for_write(p_org, p_lead);
  perform private.assert_subscription_active(p_org);
  if p_value is null or p_value = 'NaN'::numeric then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Plafond technique (hors plan) : 50 deals par lead.
  if (select count(*) from public.deals d where d.organization_id = p_org and d.lead_id = p_lead) >= 50 then
    raise exception 'too_many_deals' using errcode = 'P0001';
  end if;
  select s.pipeline_id into v_pipeline from public.pipeline_stages s where s.organization_id = p_org and s.id = v_lead.stage_id;
  v_stage := coalesce(p_stage, private.first_stage_of_kind(p_org, v_pipeline, 'open'));
  select s.kind into v_kind from public.pipeline_stages s
   where s.organization_id = p_org and s.id = v_stage and s.pipeline_id = v_pipeline;
  if v_kind is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  insert into public.deals (id, organization_id, lead_id, stage_id, value, currency, expected_close_at, won_at, lost_at)
  values (v_id, p_org, p_lead, v_stage, p_value, p_currency, p_expected_close_at,
          case when v_kind = 'won' then now() end, case when v_kind = 'lost' then now() end);
  return v_id;
end;
$$;

-- Verrouille un deal puis son lead (mêmes règles que pour le lead).
create function private.lock_deal_for_write(p_org uuid, p_deal uuid)
returns public.deals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.deals;
  v_lead uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_deal is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select d.lead_id into v_lead from public.deals d where d.id = p_deal and d.organization_id = p_org;
  if not found then
    -- rôle insuffisant : forbidden avant not_found
    perform private.lock_lead_for_write(p_org, gen_random_uuid());
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform private.lock_lead_for_write(p_org, v_lead);
  select * into v_deal from public.deals d where d.id = p_deal and d.organization_id = p_org for update;
  return v_deal;
end;
$$;

create function private.update_deal(p_org uuid, p_id uuid, p_value numeric, p_currency text, p_expected_close_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_deal_for_write(p_org, p_id);
  if p_value is null or p_value = 'NaN'::numeric then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.deals set value = p_value, currency = p_currency, expected_close_at = p_expected_close_at
   where id = p_id and organization_id = p_org;
end;
$$;

create function private.move_deal_stage(p_org uuid, p_id uuid, p_stage uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.deals;
  v_lead public.leads;
  v_pipeline uuid;
  v_kind public.stage_kind;
begin
  v_deal := private.lock_deal_for_write(p_org, p_id);
  select * into v_lead from public.leads l where l.id = v_deal.lead_id and l.organization_id = p_org;
  select s.pipeline_id into v_pipeline from public.pipeline_stages s where s.organization_id = p_org and s.id = v_lead.stage_id;
  select s.kind into v_kind from public.pipeline_stages s
   where s.organization_id = p_org and s.id = p_stage and s.pipeline_id = v_pipeline;
  if v_kind is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.deals
     set stage_id = p_stage,
         won_at = case when v_kind = 'won' then coalesce(v_deal.won_at, now()) end,
         lost_at = case when v_kind = 'lost' then coalesce(v_deal.lost_at, now()) end
   where id = p_id and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contacts : le commercial peut révoquer le consentement / poser « ne plus contacter » sur les contacts de SES leads
-- ---------------------------------------------------------------------------
create function private.assert_contact_revoker(p_org uuid, p_contact uuid)
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
  if p_org is not null and private.has_role(p_org, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]) then
    return;
  end if;
  if p_org is not null and private.has_role(p_org, array['sales_agent']::public.app_role[])
     and exists (select 1 from public.leads l where l.organization_id = p_org and l.contact_id = p_contact and l.assignee_id = auth.uid()) then
    return;
  end if;
  raise exception 'forbidden' using errcode = '42501';
end;
$$;

create or replace function private.revoke_consent(
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
  perform private.assert_contact_revoker(p_org, p_contact);
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

create or replace function private.set_do_not_contact(p_org uuid, p_contact uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_contact_revoker(p_org, p_contact);
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
revoke all on function private.is_valid_lead_utm(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.is_valid_score_reason(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.pipeline_stages_guard() from public, anon, authenticated, service_role;
revoke all on function private.leads_guard() from public, anon, authenticated, service_role;
revoke all on function private.deals_guard() from public, anon, authenticated, service_role;
revoke all on function private.seed_pipeline_stages(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.seed_default_pipeline(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.organizations_seed_pipeline() from public, anon, authenticated, service_role;
revoke all on function private.release_lead_assignments() from public, anon, authenticated, service_role;
revoke all on function private.audit_pipelines() from public, anon, authenticated, service_role;
revoke all on function private.audit_pipeline_stages() from public, anon, authenticated, service_role;
revoke all on function private.audit_leads() from public, anon, authenticated, service_role;
revoke all on function private.audit_deals() from public, anon, authenticated, service_role;
revoke all on function private.assert_assignable(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.assert_subscription_active(uuid) from public, anon, authenticated, service_role;
revoke all on function private.release_leads_of(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_lead_for_write(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_deal_for_write(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.first_stage_of_kind(uuid, uuid, public.stage_kind) from public, anon, authenticated, service_role;
revoke all on function private.assert_contact_revoker(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_pipeline(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.rename_pipeline(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.set_default_pipeline(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_stage(uuid, uuid, text, public.stage_kind, integer) from public, anon, authenticated, service_role;
revoke all on function private.update_stage(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.delete_stage(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function private.update_lead(uuid, uuid, text, integer, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.assign_lead(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.move_lead_stage(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_deal(uuid, uuid, uuid, numeric, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.update_deal(uuid, uuid, numeric, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.move_deal_stage(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.create_pipeline(uuid, text) to authenticated;
grant execute on function private.rename_pipeline(uuid, uuid, text) to authenticated;
grant execute on function private.set_default_pipeline(uuid, uuid) to authenticated;
grant execute on function private.create_stage(uuid, uuid, text, public.stage_kind, integer) to authenticated;
grant execute on function private.update_stage(uuid, uuid, text, integer) to authenticated;
grant execute on function private.delete_stage(uuid, uuid) to authenticated;
grant execute on function private.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text) to authenticated;
grant execute on function private.update_lead(uuid, uuid, text, integer, jsonb, jsonb) to authenticated;
grant execute on function private.assign_lead(uuid, uuid, uuid) to authenticated;
grant execute on function private.move_lead_stage(uuid, uuid, uuid) to authenticated;
grant execute on function private.create_deal(uuid, uuid, uuid, numeric, text, timestamptz) to authenticated;
grant execute on function private.update_deal(uuid, uuid, numeric, text, timestamptz) to authenticated;
grant execute on function private.move_deal_stage(uuid, uuid, uuid) to authenticated;

create function public.create_pipeline(p_org uuid, p_name text)
returns uuid language sql security invoker set search_path = '' as $$ select private.create_pipeline(p_org, p_name); $$;
create function public.rename_pipeline(p_org uuid, p_id uuid, p_name text)
returns void language sql security invoker set search_path = '' as $$ select private.rename_pipeline(p_org, p_id, p_name); $$;
create function public.set_default_pipeline(p_org uuid, p_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.set_default_pipeline(p_org, p_id); $$;
create function public.create_stage(p_org uuid, p_pipeline uuid, p_name text, p_kind public.stage_kind, p_position integer)
returns uuid language sql security invoker set search_path = '' as $$ select private.create_stage(p_org, p_pipeline, p_name, p_kind, p_position); $$;
create function public.update_stage(p_org uuid, p_id uuid, p_name text, p_position integer)
returns void language sql security invoker set search_path = '' as $$ select private.update_stage(p_org, p_id, p_name, p_position); $$;
create function public.delete_stage(p_org uuid, p_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.delete_stage(p_org, p_id); $$;
create function public.create_lead(
  p_org uuid, p_contact uuid, p_project uuid, p_source text, p_assignee uuid, p_score integer, p_score_reason jsonb,
  p_utm jsonb, p_external_source text, p_external_id text
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_lead(p_org, p_contact, p_project, p_source, p_assignee, p_score, p_score_reason, p_utm, p_external_source, p_external_id); $$;
create function public.update_lead(p_org uuid, p_id uuid, p_source text, p_score integer, p_score_reason jsonb, p_utm jsonb)
returns void language sql security invoker set search_path = '' as $$ select private.update_lead(p_org, p_id, p_source, p_score, p_score_reason, p_utm); $$;
create function public.assign_lead(p_org uuid, p_id uuid, p_assignee uuid)
returns void language sql security invoker set search_path = '' as $$ select private.assign_lead(p_org, p_id, p_assignee); $$;
create function public.move_lead_stage(p_org uuid, p_id uuid, p_stage uuid)
returns void language sql security invoker set search_path = '' as $$ select private.move_lead_stage(p_org, p_id, p_stage); $$;
create function public.create_deal(p_org uuid, p_lead uuid, p_stage uuid, p_value numeric, p_currency text, p_expected_close_at timestamptz)
returns uuid language sql security invoker set search_path = '' as $$ select private.create_deal(p_org, p_lead, p_stage, p_value, p_currency, p_expected_close_at); $$;
create function public.update_deal(p_org uuid, p_id uuid, p_value numeric, p_currency text, p_expected_close_at timestamptz)
returns void language sql security invoker set search_path = '' as $$ select private.update_deal(p_org, p_id, p_value, p_currency, p_expected_close_at); $$;
create function public.move_deal_stage(p_org uuid, p_id uuid, p_stage uuid)
returns void language sql security invoker set search_path = '' as $$ select private.move_deal_stage(p_org, p_id, p_stage); $$;

revoke all on function public.create_pipeline(uuid, text) from public, anon, service_role;
revoke all on function public.rename_pipeline(uuid, uuid, text) from public, anon, service_role;
revoke all on function public.set_default_pipeline(uuid, uuid) from public, anon, service_role;
revoke all on function public.create_stage(uuid, uuid, text, public.stage_kind, integer) from public, anon, service_role;
revoke all on function public.update_stage(uuid, uuid, text, integer) from public, anon, service_role;
revoke all on function public.delete_stage(uuid, uuid) from public, anon, service_role;
revoke all on function public.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text) from public, anon, service_role;
revoke all on function public.update_lead(uuid, uuid, text, integer, jsonb, jsonb) from public, anon, service_role;
revoke all on function public.assign_lead(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.move_lead_stage(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.create_deal(uuid, uuid, uuid, numeric, text, timestamptz) from public, anon, service_role;
revoke all on function public.update_deal(uuid, uuid, numeric, text, timestamptz) from public, anon, service_role;
revoke all on function public.move_deal_stage(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.create_pipeline(uuid, text) to authenticated;
grant execute on function public.rename_pipeline(uuid, uuid, text) to authenticated;
grant execute on function public.set_default_pipeline(uuid, uuid) to authenticated;
grant execute on function public.create_stage(uuid, uuid, text, public.stage_kind, integer) to authenticated;
grant execute on function public.update_stage(uuid, uuid, text, integer) to authenticated;
grant execute on function public.delete_stage(uuid, uuid) to authenticated;
grant execute on function public.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text) to authenticated;
grant execute on function public.update_lead(uuid, uuid, text, integer, jsonb, jsonb) to authenticated;
grant execute on function public.assign_lead(uuid, uuid, uuid) to authenticated;
grant execute on function public.move_lead_stage(uuid, uuid, uuid) to authenticated;
grant execute on function public.create_deal(uuid, uuid, uuid, numeric, text, timestamptz) to authenticated;
grant execute on function public.update_deal(uuid, uuid, numeric, text, timestamptz) to authenticated;
grant execute on function public.move_deal_stage(uuid, uuid, uuid) to authenticated;
