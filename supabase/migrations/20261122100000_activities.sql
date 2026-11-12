-- J20 — Activités et chronologie d'un lead (spec §3 et §7 ; ADR 007 `activities`, E2 ; ADR 014).
-- Retour arrière : supabase/rollbacks/20261122100000_activities.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * enum `activity_type` (note, call, email, task, meeting, stage_change, assignment) ; le contenu vit dans `metadata`, par
--    type et VALIDÉ par la base (pas de colonne texte dans l'ADR) ;
--  * ÉCRITURE UNIQUEMENT PAR FONCTIONS (SECURITY DEFINER), comme les autres modules : aucun droit INSERT / UPDATE / DELETE
--    direct, même pour service_role ;
--  * toute activité vise un LEAD (le contact en est déduit, et vérifié) ; une activité sur un contact sans lead n'existe pas ;
--  * journal AUTOMATIQUE par déclencheurs : `stage_change` et `assignment` à chaque changement d'étape ou d'assignation d'un
--    lead (libérations automatiques comprises) et `stage_change` (avec `deal_id`) à chaque changement d'étape d'un deal ; ces
--    deux types ne se créent pas à la main ;
--  * rôles (ADR 014, « Leads / deals : modifier, changer d'étape, tâches ») : owner et admin sur tous les leads, commercial sur
--    SES leads, marketing et analyste jamais ; lecture comme les leads ; un projet archivé est en lecture seule ;
--  * historique FIABLE : note, appel, e-mail (compte rendu, aucun envoi) et rendez-vous ne se modifient ni ne se suppriment
--    jamais ; seules les tâches évoluent (contenu, échéance, responsable, fait / à refaire) ; aucune suppression ;
--  * tâche : responsable = l'auteur par défaut ; owner et admin peuvent la confier à un membre assignable ; le commercial ne se
--    l'attribue qu'à lui-même ;
--  * plafond technique : 500 activités par lead ; abonnement actif exigé pour créer ;
--  * audit : identifiants, type, noms de champs ; jamais le contenu (texte, titre, objet).

create type public.activity_type as enum ('note', 'call', 'email', 'task', 'meeting', 'stage_change', 'assignment');

-- ---------------------------------------------------------------------------
-- Validation du contenu par type (fonction pure, search_path vide)
-- ---------------------------------------------------------------------------
create function private.is_valid_activity_metadata(p_type public.activity_type, p_meta jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_allowed text[];
  v_required text[];
  v_key text;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_type is null or p_meta is null or pg_catalog.jsonb_typeof(p_meta) <> 'object' or pg_catalog.octet_length(p_meta::text) > 4096 then
    return false;
  end if;
  v_allowed := case p_type
    when 'note' then array['text']
    when 'call' then array['text', 'outcome', 'duration_minutes']
    when 'email' then array['subject', 'text']
    when 'meeting' then array['title', 'text']
    when 'task' then array['title', 'text']
    when 'stage_change' then array['from_stage_id', 'to_stage_id', 'deal_id']
    else array['from_assignee_id', 'to_assignee_id']
  end;
  v_required := case p_type
    when 'note' then array['text']
    when 'email' then array['subject']
    when 'meeting' then array['title']
    when 'task' then array['title']
    when 'stage_change' then array['from_stage_id', 'to_stage_id']
    when 'assignment' then array['from_assignee_id', 'to_assignee_id']
    else array[]::text[]
  end;
  foreach v_key in array v_required loop
    if not (p_meta ? v_key) then return false; end if;
  end loop;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_meta) as k loop
    if not (v_key = any (v_allowed)) then return false; end if;
  end loop;
  if p_type = 'call' and not (p_meta ? 'text' or p_meta ? 'outcome') then
    return false;
  end if;

  if p_meta ? 'text' and (pg_catalog.jsonb_typeof(p_meta -> 'text') <> 'string' or not private.is_safe_text(p_meta ->> 'text', 1, 2000, true)) then
    return false;
  end if;
  foreach v_key in array array['title', 'subject'] loop
    if p_meta ? v_key and (pg_catalog.jsonb_typeof(p_meta -> v_key) <> 'string' or not private.is_safe_text(p_meta ->> v_key, 1, 200)) then
      return false;
    end if;
  end loop;
  if p_meta ? 'outcome' and (pg_catalog.jsonb_typeof(p_meta -> 'outcome') <> 'string'
     or not ((p_meta ->> 'outcome') = any (array['answered', 'no_answer', 'voicemail', 'busy', 'wrong_number']))) then
    return false;
  end if;
  if p_meta ? 'duration_minutes' and (pg_catalog.jsonb_typeof(p_meta -> 'duration_minutes') <> 'number'
     or (p_meta ->> 'duration_minutes')::numeric not between 0 and 600
     or (p_meta ->> 'duration_minutes')::numeric <> pg_catalog.trunc((p_meta ->> 'duration_minutes')::numeric)) then
    return false;
  end if;
  foreach v_key in array array['from_stage_id', 'to_stage_id', 'deal_id'] loop
    if p_meta ? v_key and (pg_catalog.jsonb_typeof(p_meta -> v_key) <> 'string' or (p_meta ->> v_key) !~ v_uuid) then
      return false;
    end if;
  end loop;
  foreach v_key in array array['from_assignee_id', 'to_assignee_id'] loop
    if p_meta ? v_key and not (pg_catalog.jsonb_typeof(p_meta -> v_key) = 'null'
       or (pg_catalog.jsonb_typeof(p_meta -> v_key) = 'string' and (p_meta ->> v_key) ~ v_uuid)) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null,
  contact_id uuid not null,
  type public.activity_type not null,
  owner_id uuid,
  due_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activities_org_id_key unique (organization_id, id),
  constraint activities_lead_fkey foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete restrict,
  constraint activities_contact_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete restrict,
  -- auteur ou responsable = membre de la MÊME entreprise ; si l'adhésion est supprimée, seul owner_id passe à NULL
  constraint activities_owner_fkey foreign key (organization_id, owner_id)
    references public.organization_members (organization_id, user_id) on delete set null (owner_id),
  constraint activities_metadata_valid check (private.is_valid_activity_metadata(type, metadata)),
  constraint activities_due_only_task_meeting check (due_at is null or type in ('task', 'meeting')),
  constraint activities_completed_only_task check (completed_at is null or type = 'task'),
  constraint activities_due_range check (due_at is null or (due_at > timestamptz '2000-01-01' and due_at < timestamptz '2100-01-01'))
);
create index activities_org_lead_idx on public.activities (organization_id, lead_id, created_at desc);
create index activities_org_open_tasks_idx on public.activities (organization_id, owner_id, due_at) where type = 'task' and completed_at is null;
comment on table public.activities is 'Chronologie des leads (spec §7). Écriture par fonctions et déclencheurs ; notes, appels, e-mails et rendez-vous sont immuables ; aucune suppression.';

-- ---------------------------------------------------------------------------
-- Triggers : updated_at, immutabilité, cohérence lead / contact
-- ---------------------------------------------------------------------------
create trigger activities_set_updated_at before update on public.activities for each row execute function private.set_updated_at();
create trigger activities_org_immutable before update on public.activities for each row execute function private.prevent_organization_id_change();

create function private.activities_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'activities are never deleted' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    -- Le contact est celui du lead (jamais celui d'un autre contact de l'entreprise).
    select l.contact_id into v_contact from public.leads l where l.organization_id = new.organization_id and l.id = new.lead_id;
    if v_contact is distinct from new.contact_id then
      raise exception 'activity contact must be the lead contact' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- Mise à jour : seule une TÂCHE évolue (contenu, échéance, responsable, fait / à refaire) ; le reste est figé.
  if new.type is distinct from old.type or new.lead_id is distinct from old.lead_id
     or new.contact_id is distinct from old.contact_id or new.created_at is distinct from old.created_at then
    raise exception 'activity history is immutable' using errcode = 'check_violation';
  end if;
  if old.type <> 'task' then
    -- Seule exception : la suppression de l'adhésion de l'auteur (clé étrangère « set null ») efface le seul champ owner_id.
    if not (new.owner_id is null and old.owner_id is not null and new.metadata = old.metadata
            and new.due_at is not distinct from old.due_at and new.completed_at is not distinct from old.completed_at) then
      raise exception 'activity history is immutable' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger activities_guard before insert or update or delete on public.activities
  for each row execute function private.activities_guard();

-- ---------------------------------------------------------------------------
-- Journal automatique : changements d'étape et d'assignation d'un lead, changements d'étape d'un deal
-- ---------------------------------------------------------------------------
create function private.log_lead_activities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  -- L'acteur n'est enregistré que s'il est membre de l'entreprise (tâches système : NULL).
  select m.user_id into v_actor from public.organization_members m where m.organization_id = new.organization_id and m.user_id = auth.uid();
  -- Plafond technique du journal automatique : 1000 entrées par lead (l'historique complet reste dans l'audit `lead.*`) ;
  -- sans cela, des changements d'étape en boucle rempliraient la chronologie.
  if (select count(*) from public.activities a
       where a.organization_id = new.organization_id and a.lead_id = new.id and a.type in ('stage_change', 'assignment')) >= 1000 then
    return null;
  end if;
  if new.stage_id is distinct from old.stage_id then
    insert into public.activities (organization_id, lead_id, contact_id, type, owner_id, metadata)
    values (new.organization_id, new.id, new.contact_id, 'stage_change', v_actor,
            pg_catalog.jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    insert into public.activities (organization_id, lead_id, contact_id, type, owner_id, metadata)
    values (new.organization_id, new.id, new.contact_id, 'assignment', v_actor,
            pg_catalog.jsonb_build_object('from_assignee_id', old.assignee_id, 'to_assignee_id', new.assignee_id));
  end if;
  return null;
end;
$$;
create trigger log_lead_activities after update on public.leads
  for each row
  when (old.stage_id is distinct from new.stage_id or old.assignee_id is distinct from new.assignee_id)
  execute function private.log_lead_activities();

create function private.log_deal_activities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_contact uuid;
begin
  select m.user_id into v_actor from public.organization_members m where m.organization_id = new.organization_id and m.user_id = auth.uid();
  select l.contact_id into v_contact from public.leads l where l.organization_id = new.organization_id and l.id = new.lead_id;
  if (select count(*) from public.activities a
       where a.organization_id = new.organization_id and a.lead_id = new.lead_id and a.type in ('stage_change', 'assignment')) >= 1000 then
    return null;
  end if;
  insert into public.activities (organization_id, lead_id, contact_id, type, owner_id, metadata)
  values (new.organization_id, new.lead_id, v_contact, 'stage_change', v_actor,
          pg_catalog.jsonb_build_object('from_stage_id', old.stage_id, 'to_stage_id', new.stage_id, 'deal_id', new.id));
  return null;
end;
$$;
create trigger log_deal_activities after update on public.deals
  for each row
  when (old.stage_id is distinct from new.stage_id)
  execute function private.log_deal_activities();

-- ---------------------------------------------------------------------------
-- Audit : identifiants, type, noms de champs (jamais le contenu)
-- ---------------------------------------------------------------------------
create function private.audit_activities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    -- Les changements d'étape et d'assignation sont déjà journalisés par `lead.*` et `deal.*`.
    if new.type in ('stage_change', 'assignment') then
      return null;
    end if;
    perform private.audit_write(new.organization_id, 'activity.created', 'activity', new.id, null,
      pg_catalog.jsonb_build_object('lead_id', new.lead_id, 'type', new.type));
    return null;
  end if;
  if new.completed_at is not null and old.completed_at is null then
    perform private.audit_write(new.organization_id, 'activity.completed', 'activity', new.id, null, pg_catalog.jsonb_build_object('lead_id', new.lead_id));
  elsif new.completed_at is null and old.completed_at is not null then
    perform private.audit_write(new.organization_id, 'activity.reopened', 'activity', new.id, null, pg_catalog.jsonb_build_object('lead_id', new.lead_id));
  end if;
  if new.metadata is distinct from old.metadata then v_changed := pg_catalog.array_append(v_changed, 'metadata'::text); end if;
  if new.due_at is distinct from old.due_at then v_changed := pg_catalog.array_append(v_changed, 'due_at'::text); end if;
  if new.owner_id is distinct from old.owner_id then v_changed := pg_catalog.array_append(v_changed, 'owner_id'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(new.organization_id, 'activity.updated', 'activity', new.id, null,
      pg_catalog.jsonb_build_object('lead_id', new.lead_id, 'changed', v_changed));
  end if;
  return null;
end;
$$;
create trigger audit_activities after insert or update on public.activities
  for each row execute function private.audit_activities();

-- ---------------------------------------------------------------------------
-- RLS : lecture comme les leads ; aucune écriture directe
-- ---------------------------------------------------------------------------
alter table public.activities enable row level security;
grant select on table public.activities to authenticated;
revoke insert, update, delete, truncate on table public.activities from service_role;

create policy activities_select on public.activities
  for select to authenticated
  using (
    private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[])
    or (private.has_role(organization_id, array['sales_agent']::public.app_role[])
        and exists (select 1 from public.leads l
                     where l.organization_id = activities.organization_id and l.id = activities.lead_id and l.assignee_id = auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Fonctions d'écriture (SECURITY DEFINER ; identité = auth.uid())
-- Codes d'erreur : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 (ou 23514 contrainte) · not_found PT404 ·
-- P0001 : project_archived, assignee_invalid, subscription_inactive, too_many_activities.
-- ---------------------------------------------------------------------------
-- Verrouille une activité pour écriture : mêmes règles que le lead (owner / admin ; commercial sur SES leads ; projet archivé =
-- lecture seule) ; un identifiant absent est « introuvable » pour un rôle autorisé, « interdit » pour un autre.
create function private.lock_activity_for_write(p_org uuid, p_activity uuid)
returns public.activities
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities;
  v_lead uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_activity is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select a.lead_id into v_lead from public.activities a where a.id = p_activity and a.organization_id = p_org;
  if not found then
    perform private.lock_lead_for_write(p_org, gen_random_uuid());
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform private.lock_lead_for_write(p_org, v_lead);
  select * into v_activity from public.activities a where a.id = p_activity and a.organization_id = p_org for update;
  return v_activity;
end;
$$;

-- Responsable demandé pour une tâche : l'appelant, ou (owner / admin) un membre assignable.
create function private.resolve_task_owner(p_org uuid, p_owner uuid, p_lead uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner is null or p_owner = auth.uid() then
    return auth.uid();
  end if;
  if not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.assert_assignable(p_org, p_owner);
  -- Un commercial ne voit que SES leads : une tâche ne lui est confiée que sur un lead dont il est responsable (sinon il ne
  -- pourrait ni la lire ni la terminer). Owner et admin voient tout.
  if exists (select 1 from public.organization_members m
              where m.organization_id = p_org and m.user_id = p_owner and m.role = 'sales_agent')
     and not exists (select 1 from public.leads l where l.organization_id = p_org and l.id = p_lead and l.assignee_id = p_owner) then
    raise exception 'assignee_invalid' using errcode = 'P0001';
  end if;
  return p_owner;
end;
$$;

create function private.create_activity(
  p_org uuid, p_lead uuid, p_type public.activity_type, p_metadata jsonb, p_due_at timestamptz, p_owner uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_lead public.leads;
  v_owner uuid;
begin
  v_lead := private.lock_lead_for_write(p_org, p_lead);
  perform private.assert_subscription_active(p_org);
  if p_type is null or p_type not in ('note', 'call', 'email', 'task', 'meeting')
     or (p_type <> 'task' and p_owner is not null)
     or (p_due_at is not null and p_type not in ('task', 'meeting')) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_owner := case when p_type = 'task' then private.resolve_task_owner(p_org, p_owner, p_lead) else auth.uid() end;
  -- Contenu validé AVANT l'insertion : une contrainte violée écrirait la ligne fautive (texte compris) dans les journaux du serveur.
  if not private.is_valid_activity_metadata(p_type, coalesce(p_metadata, '{}'::jsonb)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Plafond technique (hors plan) : 500 activités MANUELLES par lead (le journal automatique a son propre plafond).
  if (select count(*) from public.activities a
       where a.organization_id = p_org and a.lead_id = p_lead and a.type in ('note', 'call', 'email', 'task', 'meeting')) >= 500 then
    raise exception 'too_many_activities' using errcode = 'P0001';
  end if;
  insert into public.activities (id, organization_id, lead_id, contact_id, type, owner_id, due_at, metadata)
  values (v_id, p_org, p_lead, v_lead.contact_id, p_type, v_owner, p_due_at, coalesce(p_metadata, '{}'::jsonb));
  return v_id;
end;
$$;

-- Modifie une tâche (contenu, échéance, responsable : NULL = inchangé).
create function private.update_task(p_org uuid, p_id uuid, p_metadata jsonb, p_due_at timestamptz, p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities;
begin
  v_activity := private.lock_activity_for_write(p_org, p_id);
  if v_activity.type <> 'task' or (p_metadata is not null and not private.is_valid_activity_metadata('task', p_metadata)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- p_due_at NULL retire l'échéance (le service l'exige explicitement) ; p_owner NULL laisse le responsable inchangé.
  update public.activities
     set metadata = coalesce(p_metadata, metadata),
         due_at = p_due_at,
         owner_id = case when p_owner is null then owner_id else private.resolve_task_owner(p_org, p_owner, v_activity.lead_id) end
   where id = p_id and organization_id = p_org;
end;
$$;

-- Marque une tâche faite (date posée par la base) ou à refaire.
create function private.complete_task(p_org uuid, p_id uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities;
begin
  v_activity := private.lock_activity_for_write(p_org, p_id);
  if v_activity.type <> 'task' or p_done is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.activities
     set completed_at = case when p_done then coalesce(v_activity.completed_at, now()) end
   where id = p_id and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits sur les fonctions privées puis enveloppes publiques (SECURITY INVOKER) : surface PostgREST
-- ---------------------------------------------------------------------------
revoke all on function private.is_valid_activity_metadata(public.activity_type, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.activities_guard() from public, anon, authenticated, service_role;
revoke all on function private.log_lead_activities() from public, anon, authenticated, service_role;
revoke all on function private.log_deal_activities() from public, anon, authenticated, service_role;
revoke all on function private.audit_activities() from public, anon, authenticated, service_role;
revoke all on function private.lock_activity_for_write(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.resolve_task_owner(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid) from public, anon, authenticated, service_role;
revoke all on function private.update_task(uuid, uuid, jsonb, timestamptz, uuid) from public, anon, authenticated, service_role;
revoke all on function private.complete_task(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function private.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid) to authenticated;
grant execute on function private.update_task(uuid, uuid, jsonb, timestamptz, uuid) to authenticated;
grant execute on function private.complete_task(uuid, uuid, boolean) to authenticated;

create function public.create_activity(p_org uuid, p_lead uuid, p_type public.activity_type, p_metadata jsonb, p_due_at timestamptz, p_owner uuid)
returns uuid language sql security invoker set search_path = '' as $$ select private.create_activity(p_org, p_lead, p_type, p_metadata, p_due_at, p_owner); $$;
create function public.update_task(p_org uuid, p_id uuid, p_metadata jsonb, p_due_at timestamptz, p_owner uuid)
returns void language sql security invoker set search_path = '' as $$ select private.update_task(p_org, p_id, p_metadata, p_due_at, p_owner); $$;
create function public.complete_task(p_org uuid, p_id uuid, p_done boolean)
returns void language sql security invoker set search_path = '' as $$ select private.complete_task(p_org, p_id, p_done); $$;

revoke all on function public.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid) from public, anon, service_role;
revoke all on function public.update_task(uuid, uuid, jsonb, timestamptz, uuid) from public, anon, service_role;
revoke all on function public.complete_task(uuid, uuid, boolean) from public, anon, service_role;
grant execute on function public.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid) to authenticated;
grant execute on function public.update_task(uuid, uuid, jsonb, timestamptz, uuid) to authenticated;
grant execute on function public.complete_task(uuid, uuid, boolean) to authenticated;
