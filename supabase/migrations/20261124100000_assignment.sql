-- J22 — Assignation automatique des leads : règles, notifications in-app et `auto_assign_lead` (spec §9.1 étape 4 ; ADR 007 E8).
-- Retour arrière : supabase/rollbacks/20261124100000_assignment.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * `assignment_rules` (ADR 007) : stratégie `round_robin` ou `fixed`, membres éligibles (1 à 50 ; `fixed` = exactement 1),
--    curseur, `active` ; règle d'un PROJET prioritaire, sinon règle par défaut de l'entreprise (`project_id` nul) ; une seule règle
--    active par projet et une seule par défaut ; écriture owner / admin par fonctions, audit ;
--  * `notifications` (ADR 007) : alerte in-app ; une ligne par destinataire (owner et admin actifs) avec clé de déduplication,
--    donc un échec rejoué ne notifie pas deux fois ; lecture : le destinataire ; marquage « lu » par fonction ;
--  * `auto_assign_lead(org, lead)` (service_role : appelée par le worker avec l'entreprise de la LIGNE DU JOB) : relit et verrouille
--    le lead, n'agit que sur un lead ouvert encore non assigné (REJEU SANS DOUBLE ASSIGNATION), choisit un membre éligible encore
--    actif (round-robin atomique : la règle est verrouillée), sinon laisse le lead « non assigné » et notifie ;
--  * `flag_lead_unassigned` (service_role) : alerte posée par le worker après l'échec définitif du job ;
--  * audit : `assignment_rule.*`, `lead.auto_assigned` (identifiants seulement) ; jamais de donnée de contact.

-- ---------------------------------------------------------------------------
-- assignment_rules
-- ---------------------------------------------------------------------------
create table public.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  project_id uuid,
  strategy text not null,
  eligible_member_ids uuid[] not null,
  cursor integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assignment_rules_org_id_key unique (organization_id, id),
  constraint assignment_rules_project_fkey foreign key (organization_id, project_id)
    references public.projects (organization_id, id) on delete restrict,
  constraint assignment_rules_strategy_valid check (strategy in ('round_robin', 'fixed')),
  constraint assignment_rules_members_valid check (
    pg_catalog.cardinality(eligible_member_ids) between 1 and 50
    and (strategy <> 'fixed' or pg_catalog.cardinality(eligible_member_ids) = 1)
  ),
  constraint assignment_rules_cursor_valid check (cursor >= 0 and cursor < 50)
);
create index assignment_rules_org_project_idx on public.assignment_rules (organization_id, project_id);
create unique index assignment_rules_one_active_per_project on public.assignment_rules (organization_id, project_id)
  where active and project_id is not null;
create unique index assignment_rules_one_active_default on public.assignment_rules (organization_id)
  where active and project_id is null;
comment on table public.assignment_rules is 'Règles d''assignation automatique des leads (ADR 007 E8). Écriture par fonctions uniquement.';

create trigger assignment_rules_set_updated_at before update on public.assignment_rules for each row execute function private.set_updated_at();
create trigger assignment_rules_org_immutable before update on public.assignment_rules for each row execute function private.prevent_organization_id_change();

create function private.audit_assignment_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'assignment_rule.created', 'assignment_rule', new.id, null,
      pg_catalog.jsonb_build_object('project_id', new.project_id, 'strategy', new.strategy, 'members', pg_catalog.cardinality(new.eligible_member_ids)));
    return null;
  end if;
  if tg_op = 'DELETE' then
    perform private.audit_write(old.organization_id, 'assignment_rule.deleted', 'assignment_rule', old.id, pg_catalog.jsonb_build_object('project_id', old.project_id), null);
    return null;
  end if;
  if new.strategy is distinct from old.strategy then v_changed := pg_catalog.array_append(v_changed, 'strategy'); end if;
  if new.eligible_member_ids is distinct from old.eligible_member_ids then v_changed := pg_catalog.array_append(v_changed, 'eligible_member_ids'); end if;
  if new.active is distinct from old.active then v_changed := pg_catalog.array_append(v_changed, 'active'); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(new.organization_id, 'assignment_rule.updated', 'assignment_rule', new.id, null,
      pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_changed)));
  end if;
  return null;
end;
$$;
create trigger audit_assignment_rules after insert or update or delete on public.assignment_rules
  for each row execute function private.audit_assignment_rules();

alter table public.assignment_rules enable row level security;
revoke all on table public.assignment_rules from authenticated;
grant select on table public.assignment_rules to authenticated;
revoke insert, update, delete, truncate on table public.assignment_rules from service_role;
create policy assignment_rules_select on public.assignment_rules
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  recipient_id uuid,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_org_id_key unique (organization_id, id),
  constraint notifications_recipient_fkey foreign key (organization_id, recipient_id)
    references public.organization_members (organization_id, user_id) on delete cascade,
  constraint notifications_kind_valid check (kind in ('lead.unassigned')),
  constraint notifications_payload_valid check (pg_catalog.jsonb_typeof(payload) = 'object' and pg_catalog.pg_column_size(payload) <= 2048),
  constraint notifications_dedupe_valid check (dedupe_key is null or pg_catalog.length(dedupe_key) between 1 and 200)
);
create index notifications_recipient_idx on public.notifications (organization_id, recipient_id, created_at desc);
create unique index notifications_dedupe_key on public.notifications (organization_id, dedupe_key) where dedupe_key is not null;
comment on table public.notifications is 'Alertes in-app (ADR 007). Écriture par fonctions uniquement ; payload = identifiants, jamais de donnée de contact.';

create trigger notifications_org_immutable before update on public.notifications for each row execute function private.prevent_organization_id_change();

alter table public.notifications enable row level security;
revoke all on table public.notifications from authenticated;
grant select on table public.notifications to authenticated;
revoke insert, update, delete, truncate on table public.notifications from service_role;
-- Le destinataire seulement (un admin ne lit pas les alertes d'un autre : chacun a sa ligne).
create policy notifications_select on public.notifications
  for select to authenticated
  using (recipient_id = (select auth.uid()) and private.is_member(organization_id));

-- ---------------------------------------------------------------------------
-- Règles d'assignation (owner / admin)
-- ---------------------------------------------------------------------------
-- Membres : sans doublon, tous ASSIGNABLES (membre actif owner / admin / commercial) ; chaque ligne de membre est verrouillée.
create function private.assert_rule_members(p_org uuid, p_strategy text, p_members uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid;
begin
  if p_strategy is null or p_strategy not in ('round_robin', 'fixed') or p_members is null
     or pg_catalog.array_ndims(p_members) is distinct from 1
     or pg_catalog.cardinality(p_members) not between 1 and 50
     or (p_strategy = 'fixed' and pg_catalog.cardinality(p_members) <> 1)
     or pg_catalog.array_position(p_members, null) is not null
     or (select pg_catalog.count(distinct m) from pg_catalog.unnest(p_members) as m) <> pg_catalog.cardinality(p_members) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  foreach v_member in array p_members loop
    perform private.assert_assignable(p_org, v_member);
  end loop;
end;
$$;

create function private.create_assignment_rule(p_org uuid, p_project uuid, p_strategy text, p_members uuid[])
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
  perform private.assert_rule_members(p_org, p_strategy, p_members);
  perform private.assert_subscription_active(p_org);
  -- Revue sécurité : le plafond de règles est sérialisé par entreprise (et non par projet).
  perform 1 from public.organizations o where o.id = p_org for update;
  if p_project is not null then
    select p.status into v_status from public.projects p where p.id = p_project and p.organization_id = p_org for update;
    if not found then
      raise exception 'not_found' using errcode = 'PT404';
    end if;
    if v_status = 'archived' then
      raise exception 'project_archived' using errcode = 'P0001';
    end if;
  end if;
  if (select count(*) from public.assignment_rules r where r.organization_id = p_org) >= 50 then
    raise exception 'too_many_assignment_rules' using errcode = 'P0001';
  end if;
  begin
    insert into public.assignment_rules (organization_id, project_id, strategy, eligible_member_ids)
    values (p_org, p_project, p_strategy, p_members)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'assignment_rule_exists' using errcode = 'P0001';
  end;
  return v_id;
end;
$$;

-- Modifie la stratégie, les membres et l'état ; le curseur repart de zéro SEULEMENT si la stratégie ou les membres changent.
-- Réactiver une règle exige un abonnement actif (comme la création).
create function private.update_assignment_rule(p_org uuid, p_id uuid, p_strategy text, p_members uuid[], p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.assignment_rules;
begin
  perform private.assert_project_manager(p_org);
  perform private.assert_rule_members(p_org, p_strategy, p_members);
  if p_id is null or p_active is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if p_active then
    perform private.assert_subscription_active(p_org);
  end if;
  select * into v_rule from public.assignment_rules r where r.id = p_id and r.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  begin
    update public.assignment_rules set strategy = p_strategy, eligible_member_ids = p_members, active = p_active,
           cursor = case when strategy is distinct from p_strategy or eligible_member_ids is distinct from p_members then 0 else cursor end
     where id = p_id and organization_id = p_org;
  exception when unique_violation then
    raise exception 'assignment_rule_exists' using errcode = 'P0001';
  end;
end;
$$;

create function private.delete_assignment_rule(p_org uuid, p_id uuid)
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
  delete from public.assignment_rules r where r.id = p_id and r.organization_id = p_org;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Notifications : alerte « lead non assigné » aux owner et admin actifs (déduplication par lead et destinataire)
-- ---------------------------------------------------------------------------
create function private.notify_lead_unassigned(p_org uuid, p_lead uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Plafond technique : au-delà, les notifications DÉJÀ LUES les plus anciennes sont évincées (1000 à la fois) ; si aucune n'est lue,
  -- l'alerte n'est pas créée (le lead reste visible dans la file « non assignés »).
  if (select count(*) from public.notifications n where n.organization_id = p_org) >= 10000 then
    delete from public.notifications d where d.id in (
      select n.id from public.notifications n where n.organization_id = p_org and n.read_at is not null order by n.created_at, n.id limit 1000);
    if (select count(*) from public.notifications n where n.organization_id = p_org) >= 10000 then
      return 0;
    end if;
  end if;
  insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key)
  select p_org, m.user_id, 'lead.unassigned', pg_catalog.jsonb_build_object('lead_id', p_lead, 'reason', p_reason),
         'lead.unassigned:' || p_lead::text || ':' || m.user_id::text
    from public.organization_members m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('company_owner', 'company_admin')
  on conflict (organization_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function private.mark_notification_read(p_org uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or p_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.notifications n set read_at = coalesce(n.read_at, now())
   where n.id = p_id and n.organization_id = p_org and n.recipient_id = auth.uid() and private.is_member(p_org);
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assignation automatique (service_role : worker)
-- ---------------------------------------------------------------------------
-- Retour : { outcome: 'assigned' | 'unassigned' | 'skipped', reason?, assignee_id? }.
--  assigned   : membre choisi, lead déplacé dans la première étape ouverte ;
--  unassigned : aucune règle ou aucun membre éligible actif : le lead RESTE dans la file « non assignés » + alerte ;
--  skipped    : lead introuvable (dans CETTE entreprise), projet archivé, déjà assigné ou plus ouvert (rejeu) : aucun effet.
create function private.auto_assign_lead(p_org uuid, p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead public.leads;
  v_stage public.pipeline_stages;
  v_rule public.assignment_rules;
  v_status public.project_status;
  v_n integer;
  v_i integer;
  v_idx integer;
  v_candidate uuid;
  v_assignee uuid;
  v_open uuid;
begin
  if p_org is null or p_lead is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_lead from public.leads l where l.id = p_lead and l.organization_id = p_org for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'reason', 'not_found');
  end if;
  select * into v_stage from public.pipeline_stages s where s.organization_id = p_org and s.id = v_lead.stage_id;
  if v_lead.assignee_id is not null or v_stage.kind is distinct from 'unassigned'::public.stage_kind then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'reason', 'not_unassigned');
  end if;
  select p.status into v_status from public.projects p where p.id = v_lead.project_id and p.organization_id = p_org;
  if v_status = 'archived' then
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'reason', 'project_archived');
  end if;

  -- Règle : celle du projet d'abord, sinon celle de l'entreprise ; verrouillée (le curseur avance un lead à la fois).
  select r.* into v_rule from public.assignment_rules r
   where r.organization_id = p_org and r.active and r.project_id = v_lead.project_id for update;
  if not found then
    select r.* into v_rule from public.assignment_rules r
     where r.organization_id = p_org and r.active and r.project_id is null for update;
  end if;
  if not found then
    perform private.notify_lead_unassigned(p_org, p_lead, 'no_rule');
    return pg_catalog.jsonb_build_object('outcome', 'unassigned', 'reason', 'no_rule');
  end if;

  -- À partir du curseur, premier membre éligible ENCORE ACTIF (verrou partagé : une suspension simultanée attend).
  v_n := pg_catalog.cardinality(v_rule.eligible_member_ids);
  for v_i in 0 .. v_n - 1 loop
    v_idx := (v_rule.cursor + v_i) % v_n;
    v_candidate := v_rule.eligible_member_ids[v_idx + 1];
    perform 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = v_candidate and m.status = 'active'
       and m.role in ('company_owner', 'company_admin', 'sales_agent')
     for share;
    if found then
      v_assignee := v_candidate;
      exit;
    end if;
  end loop;
  if v_assignee is null then
    perform private.notify_lead_unassigned(p_org, p_lead, 'no_eligible');
    return pg_catalog.jsonb_build_object('outcome', 'unassigned', 'reason', 'no_eligible');
  end if;

  v_open := private.first_stage_of_kind(p_org, v_stage.pipeline_id, 'open'::public.stage_kind);
  if v_open is null then
    perform private.notify_lead_unassigned(p_org, p_lead, 'failed');
    return pg_catalog.jsonb_build_object('outcome', 'unassigned', 'reason', 'failed');
  end if;
  update public.leads set assignee_id = v_assignee, stage_id = v_open where id = p_lead and organization_id = p_org;
  if v_rule.strategy = 'round_robin' then
    update public.assignment_rules set cursor = (v_idx + 1) % v_n where id = v_rule.id and organization_id = p_org;
  end if;
  perform private.audit_write(p_org, 'lead.auto_assigned', 'lead', p_lead, null,
    pg_catalog.jsonb_build_object('rule_id', v_rule.id, 'assignee_id', v_assignee));
  return pg_catalog.jsonb_build_object('outcome', 'assigned', 'assignee_id', v_assignee);
end;
$$;

-- Alerte posée par le worker quand le job d'assignation échoue DÉFINITIVEMENT (erreur technique) : seulement pour un lead de CETTE
-- entreprise qui est toujours dans la file « non assignés ».
create function private.flag_lead_unassigned(p_org uuid, p_lead uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.leads l
    join public.pipeline_stages s on s.organization_id = l.organization_id and s.id = l.stage_id
   where l.id = p_lead and l.organization_id = p_org and l.assignee_id is null and s.kind = 'unassigned';
  if not found then
    return false;
  end if;
  perform private.notify_lead_unassigned(p_org, p_lead, 'failed');
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits puis enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.audit_assignment_rules() from public, anon, authenticated, service_role;
revoke all on function private.assert_rule_members(uuid, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.create_assignment_rule(uuid, uuid, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.update_assignment_rule(uuid, uuid, text, uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function private.delete_assignment_rule(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.notify_lead_unassigned(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.mark_notification_read(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.auto_assign_lead(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.flag_lead_unassigned(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.create_assignment_rule(uuid, uuid, text, uuid[]) to authenticated;
grant execute on function private.update_assignment_rule(uuid, uuid, text, uuid[], boolean) to authenticated;
grant execute on function private.delete_assignment_rule(uuid, uuid) to authenticated;
grant execute on function private.mark_notification_read(uuid, uuid) to authenticated;
grant execute on function private.auto_assign_lead(uuid, uuid) to service_role;
grant execute on function private.flag_lead_unassigned(uuid, uuid) to service_role;

create function public.create_assignment_rule(p_org uuid, p_project uuid, p_strategy text, p_members uuid[])
returns uuid language sql security invoker set search_path = '' as $$ select private.create_assignment_rule(p_org, p_project, p_strategy, p_members); $$;
create function public.update_assignment_rule(p_org uuid, p_id uuid, p_strategy text, p_members uuid[], p_active boolean)
returns void language sql security invoker set search_path = '' as $$ select private.update_assignment_rule(p_org, p_id, p_strategy, p_members, p_active); $$;
create function public.delete_assignment_rule(p_org uuid, p_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.delete_assignment_rule(p_org, p_id); $$;
create function public.mark_notification_read(p_org uuid, p_id uuid)
returns void language sql security invoker set search_path = '' as $$ select private.mark_notification_read(p_org, p_id); $$;
create function public.auto_assign_lead(p_org uuid, p_lead uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.auto_assign_lead(p_org, p_lead); $$;
create function public.flag_lead_unassigned(p_org uuid, p_lead uuid)
returns boolean language sql security invoker set search_path = '' as $$ select private.flag_lead_unassigned(p_org, p_lead); $$;

revoke all on function public.create_assignment_rule(uuid, uuid, text, uuid[]) from public, anon, service_role;
revoke all on function public.update_assignment_rule(uuid, uuid, text, uuid[], boolean) from public, anon, service_role;
revoke all on function public.delete_assignment_rule(uuid, uuid) from public, anon, service_role;
revoke all on function public.mark_notification_read(uuid, uuid) from public, anon, service_role;
revoke all on function public.auto_assign_lead(uuid, uuid) from public, anon, authenticated;
revoke all on function public.flag_lead_unassigned(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_assignment_rule(uuid, uuid, text, uuid[]) to authenticated;
grant execute on function public.update_assignment_rule(uuid, uuid, text, uuid[], boolean) to authenticated;
grant execute on function public.delete_assignment_rule(uuid, uuid) to authenticated;
grant execute on function public.mark_notification_read(uuid, uuid) to authenticated;
grant execute on function public.auto_assign_lead(uuid, uuid) to service_role;
grant execute on function public.flag_lead_unassigned(uuid, uuid) to service_role;
