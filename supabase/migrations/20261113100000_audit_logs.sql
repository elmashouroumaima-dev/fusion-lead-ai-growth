-- J12 — Journal d'audit append-only (ADR 007 G-D10, ADR 014 « Journal d'audit : lire », ADR 005, menaces D2, G1, G2).
-- Sources : spec §7, §11 ; ADR 005 ; ADR 006 (logs) ; ADR 007 (audit_logs) ; ADR 014.
-- Retour arrière : supabase/rollbacks/20261113100000_audit_logs.sql
--
-- EXCEPTION ASSUMÉE : cette migration n'a jamais été commitée ni appliquée ailleurs que sur la pile locale
-- de développement ; elle est donc corrigée sur place (avec son retour arrière et ses tests) plutôt que
-- complétée par une nouvelle migration. Toute modification APRÈS publication exige une nouvelle migration.
--
-- Décisions validées par la responsable technique (J12) :
--  * l'audit est écrit DANS la base par des triggers AFTER ROW (atomique avec la mutation : si l'écriture
--    d'audit échoue, la mutation échoue — « fail closed » ; personne ne peut l'oublier ni la falsifier) ;
--    aucun service_role n'est impliqué dans l'écriture ;
--  * les e-mails d'invitation n'apparaissent dans l'audit que MASQUÉS (j***@domaine) avec l'id de l'invitation ;
--    jamais token_hash ni l'e-mail complet ;
--  * la colonne ip reste NULL au J12 (aucun proxy de confiance : une IP fournie par le client serait falsifiable) ;
--  * actor_id n'a PAS de clé étrangère : supprimer un compte ne doit jamais être bloqué ni réécrire l'histoire ;
--  * ni page d'interface, ni purge/rétention, ni migration des actions d'authentification du J8 dans cette journée.
--
-- Sécurité :
--  * RLS activée, UNE politique SELECT (owner/admin ACTIFS de l'entreprise, via private.has_role) ;
--    authenticated : SELECT seul ; anon : rien ; service_role : SELECT seul (lecture serveur) —
--    aucun INSERT/UPDATE/DELETE/TRUNCATE accordé par l'API à qui que ce soit ;
--  * IMMUABILITÉ : triggers BEFORE UPDATE OR DELETE (ligne) et BEFORE TRUNCATE (instruction) qui lèvent
--    toujours 42501 'audit_logs_immutable', réglés sur ENABLE ALWAYS : session_replication_role = replica
--    ne les contourne pas. LIMITE ASSUMÉE : le propriétaire de la table / un superutilisateur de la base
--    peut encore désactiver ou supprimer les triggers (hors périmètre : l'accès base de données
--    d'administration est protégé par l'infrastructure, pas par ce schéma) ;
--  * ERADICATION D'UNE ENTREPRISE : la clé étrangère organization_id est ON DELETE RESTRICT. Supprimer une
--    entreprise (droit à l'effacement) exige donc une procédure documentée et revue (runbook), jamais un
--    DELETE ordinaire : les lignes d'audit de l'entreprise doivent d'abord être traitées par cette procédure ;
--  * private.audit_write n'est appelable que par du code SECURITY DEFINER (aucun GRANT) ; il passe toujours
--    before/after par private.audit_redact (suppression des clés sensibles, troncature des chaînes longues).

-- ---------------------------------------------------------------------------
-- Table audit_logs
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Aucune clé étrangère : la suppression d'un compte ne bloque ni ne modifie jamais l'historique.
  actor_id uuid,
  actor_kind text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip inet,
  request_id text,
  created_at timestamptz not null default now(),
  constraint audit_logs_org_id_key unique (organization_id, id),
  constraint audit_logs_actor_kind_check check (actor_kind in ('user', 'system', 'support')),
  constraint audit_logs_action_format check (action ~ '^[a-z_]+\.[a-z_]+$' and char_length(action) <= 64),
  constraint audit_logs_entity_type_format check (entity_type ~ '^[a-z_]+$' and char_length(entity_type) <= 64),
  constraint audit_logs_before_size check (before is null or octet_length(before::text) <= 16384),
  constraint audit_logs_after_size check (after is null or octet_length(after::text) <= 16384),
  constraint audit_logs_request_id_format check (request_id is null or request_id ~ '^[A-Za-z0-9._-]{8,128}$')
);
comment on table public.audit_logs is
  'Journal d''audit APPEND-ONLY (ADR 007 G-D10). Écrit uniquement par private.audit_write depuis des triggers. Jamais de secret, de jeton ni de corps de message.';
comment on column public.audit_logs.actor_id is
  'auth.uid() de l''auteur ; NULL pour une action système. Sans clé étrangère (la suppression d''un compte ne réécrit pas l''histoire).';
comment on column public.audit_logs.ip is
  'Réservé : reste NULL tant qu''aucun proxy de confiance n''existe (une IP fournie par le client est falsifiable).';

create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_org_entity_idx on public.audit_logs (organization_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- RLS et privilèges : lecture owner/admin ; aucune écriture par l'API
-- ---------------------------------------------------------------------------
alter table public.audit_logs enable row level security;
revoke all on table public.audit_logs from anon, authenticated, service_role;
grant select on table public.audit_logs to authenticated;
grant select on table public.audit_logs to service_role;

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Immuabilité : UPDATE, DELETE et TRUNCATE lèvent toujours, même sous session_replication_role = replica
-- ---------------------------------------------------------------------------
create function private.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs_immutable' using errcode = '42501';
end;
$$;

create trigger audit_logs_no_update_delete
  before update or delete on public.audit_logs
  for each row execute function private.audit_logs_immutable();
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function private.audit_logs_immutable();

-- ENABLE ALWAYS : le trigger se déclenche aussi quand session_replication_role = replica.
alter table public.audit_logs enable always trigger audit_logs_no_update_delete;
alter table public.audit_logs enable always trigger audit_logs_no_truncate;

-- ---------------------------------------------------------------------------
-- private.audit_redact : suppression des clés sensibles, troncature des chaînes, jamais d'exception
-- ---------------------------------------------------------------------------
-- ============================ MOTIF DES CLÉS SENSIBLES ============================
-- SOURCE UNIQUE du motif de caviardage : la constante v_pattern de private.audit_redact (ci-dessous).
-- Liste exacte (regex insensible à la casse, appliquée aux NOMS de clés JSON) :
--   token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp
-- Doit rester IDENTIQUE au motif du logger TypeScript (apps/web/lib/service/logger.ts) ; un test de
-- parité côté application lit ce fichier et compare. Un test pgTAP vérifie que pg_get_functiondef de
-- private.audit_redact contient cette chaîne exacte, et que audit_redact_value n'en contient aucune copie.
-- ===============================================================================
create function private.audit_redact_value(p jsonb, p_depth integer, p_pattern text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type text;
  v_result jsonb;
  v_text text;
begin
  if p is null then
    return null;
  end if;
  -- Profondeur plafonnée : au-delà, la valeur est remplacée (jamais copiée telle quelle).
  if p_depth > 16 then
    return pg_catalog.to_jsonb('[truncated]'::text);
  end if;
  v_type := pg_catalog.jsonb_typeof(p);
  if v_type = 'object' then
    select coalesce(
             pg_catalog.jsonb_object_agg(e.key, private.audit_redact_value(e.value, p_depth + 1, p_pattern)),
             '{}'::jsonb)
      into v_result
      from pg_catalog.jsonb_each(p) as e
     where e.key !~* p_pattern;
    return v_result;
  elsif v_type = 'array' then
    select coalesce(
             pg_catalog.jsonb_agg(private.audit_redact_value(e.value, p_depth + 1, p_pattern) order by e.ord),
             '[]'::jsonb)
      into v_result
      from pg_catalog.jsonb_array_elements(p) with ordinality as e(value, ord);
    return v_result;
  elsif v_type = 'string' then
    v_text := p #>> '{}';
    if pg_catalog.char_length(v_text) > 200 then
      return pg_catalog.to_jsonb(pg_catalog.left(v_text, 197) || '...');
    end if;
    return p;
  end if;
  return p;
end;
$$;

create function private.audit_redact(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Motif des clés sensibles (voir le bloc MOTIF DES CLÉS SENSIBLES) : seul endroit où il est écrit.
  v_pattern constant text := 'token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp';
begin
  return private.audit_redact_value(p, 0, v_pattern);
exception when others then
  -- Ne lève jamais et ne renvoie jamais l'entrée brute : repli sûr.
  return pg_catalog.to_jsonb('[redaction_failed]'::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.mask_email : j***@domaine (1er caractère conservé si la partie locale compte au moins 3
-- caractères ; sinon masquée entièrement : ***@domaine), null-safe, malformé => '***'
-- ---------------------------------------------------------------------------
create function private.mask_email(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_at integer;
begin
  if p is null then
    return null;
  end if;
  v_at := pg_catalog.strpos(p, '@');
  -- Exactement un '@', une partie locale et un domaine non vides.
  if v_at < 2
     or v_at = pg_catalog.char_length(p)
     or pg_catalog.strpos(pg_catalog.substr(p, v_at + 1), '@') > 0 then
    return '***';
  end if;
  -- Partie locale de moins de 3 caractères : un caractère conservé en révélerait trop => masquée entièrement.
  if v_at - 1 < 3 then
    return '***@' || pg_catalog.substr(p, v_at + 1);
  end if;
  return pg_catalog.left(p, 1) || '***@' || pg_catalog.substr(p, v_at + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.audit_write : seul point d'écriture du journal (SECURITY DEFINER, aucun GRANT)
-- ---------------------------------------------------------------------------
create function private.audit_write(
  p_org uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_request_id text;
begin
  v_uid := auth.uid();

  -- request_id : en-tête x-request-id relayé par PostgREST (request.headers). Absent ou malformé => NULL ;
  -- ne lève jamais.
  begin
    v_request_id := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id';
  exception when others then
    v_request_id := null;
  end;
  if v_request_id is null or v_request_id !~ '^[A-Za-z0-9._-]{8,128}$' then
    v_request_id := null;
  end if;

  insert into public.audit_logs
    (organization_id, actor_id, actor_kind, action, entity_type, entity_id, before, after, request_id)
  values (
    p_org,
    v_uid,
    case when v_uid is null then 'system' else 'user' end,
    p_action,
    p_entity_type,
    p_entity_id,
    private.audit_redact(p_before),
    private.audit_redact(p_after),
    v_request_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers d'audit (AFTER ROW, SECURITY DEFINER, search_path vide)
-- ---------------------------------------------------------------------------
create function private.audit_organizations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(
      new.id, 'organization.created', 'organization', new.id, null,
      pg_catalog.jsonb_build_object(
        'name', new.name, 'slug', new.slug, 'timezone', new.timezone,
        'locale', new.locale, 'status', new.status));
    return null;
  end if;

  -- UPDATE : seulement name, timezone, locale, status (settings / updated_at ne produisent aucune ligne).
  if new.name is distinct from old.name then
    v_before := v_before || pg_catalog.jsonb_build_object('name', old.name);
    v_after := v_after || pg_catalog.jsonb_build_object('name', new.name);
  end if;
  if new.timezone is distinct from old.timezone then
    v_before := v_before || pg_catalog.jsonb_build_object('timezone', old.timezone);
    v_after := v_after || pg_catalog.jsonb_build_object('timezone', new.timezone);
  end if;
  if new.locale is distinct from old.locale then
    v_before := v_before || pg_catalog.jsonb_build_object('locale', old.locale);
    v_after := v_after || pg_catalog.jsonb_build_object('locale', new.locale);
  end if;
  if new.status is distinct from old.status then
    v_before := v_before || pg_catalog.jsonb_build_object('status', old.status);
    v_after := v_after || pg_catalog.jsonb_build_object('status', new.status);
  end if;
  if v_after = '{}'::jsonb then
    return null;
  end if;
  perform private.audit_write(
    new.id, 'organization.updated', 'organization', new.id, v_before, v_after);
  return null;
end;
$$;

create function private.audit_organization_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_action text;
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(
      new.organization_id, 'member.joined', 'member', new.id, null,
      pg_catalog.jsonb_build_object('user_id', new.user_id, 'role', new.role, 'status', new.status));
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform private.audit_write(
      old.organization_id, 'member.deleted', 'member', old.id,
      pg_catalog.jsonb_build_object('user_id', old.user_id, 'role', old.role, 'status', old.status),
      null);
    return null;
  end if;

  v_old := pg_catalog.jsonb_build_object('user_id', old.user_id, 'role', old.role, 'status', old.status);
  v_new := pg_catalog.jsonb_build_object('user_id', new.user_id, 'role', new.role, 'status', new.status);

  if new.role is distinct from old.role then
    perform private.audit_write(
      new.organization_id, 'member.role_changed', 'member', new.id, v_old, v_new);
  end if;

  if new.status is distinct from old.status then
    v_action := case
      when old.status = 'active' and new.status = 'removed' then 'member.removed'
      when old.status in ('removed', 'suspended') and new.status = 'active' then 'member.reactivated'
      when old.status = 'active' and new.status = 'suspended' then 'member.suspended'
      else 'member.status_changed'
    end;
    perform private.audit_write(
      new.organization_id, v_action, 'member', new.id, v_old, v_new);
  end if;
  return null;
end;
$$;

create function private.audit_invitations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- JAMAIS token_hash, JAMAIS l'e-mail complet : e-mail masqué + id de l'invitation (entity_id).
  if tg_op = 'INSERT' then
    perform private.audit_write(
      new.organization_id, 'invitation.created', 'invitation', new.id, null,
      pg_catalog.jsonb_build_object(
        'role', new.role,
        'email_masked', private.mask_email(new.email_normalized),
        'expires_at', new.expires_at));
    return null;
  end if;

  if old.revoked_at is null and new.revoked_at is not null then
    perform private.audit_write(
      new.organization_id, 'invitation.revoked', 'invitation', new.id, null,
      pg_catalog.jsonb_build_object('revoked_at', new.revoked_at));
  end if;
  if old.accepted_at is null and new.accepted_at is not null then
    perform private.audit_write(
      new.organization_id, 'invitation.accepted', 'invitation', new.id, null,
      pg_catalog.jsonb_build_object('accepted_by', new.accepted_by, 'accepted_at', new.accepted_at));
  end if;
  return null;
end;
$$;

create trigger audit_organizations
  after insert or update on public.organizations
  for each row execute function private.audit_organizations();
create trigger audit_organization_members
  after insert or update or delete on public.organization_members
  for each row execute function private.audit_organization_members();
create trigger audit_invitations
  after insert or update on public.invitations
  for each row execute function private.audit_invitations();

-- ENABLE ALWAYS (tgenabled = 'A') : l'audit des mutations n'est jamais ignoré silencieusement sous
-- session_replication_role = replica (pg_restore, réplication logique, SQL de support, nettoyage de tests).
alter table public.organizations enable always trigger audit_organizations;
alter table public.organization_members enable always trigger audit_organization_members;
alter table public.invitations enable always trigger audit_invitations;

-- ---------------------------------------------------------------------------
-- Privilèges des fonctions : aucune n'est appelable par un rôle de l'API
-- (les triggers n'exigent pas EXECUTE au déclenchement ; audit_write n'est appelée que par du code definer)
-- ---------------------------------------------------------------------------
revoke all on function private.audit_logs_immutable() from public, anon, authenticated, service_role;
revoke all on function private.audit_redact_value(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function private.audit_redact(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.mask_email(text) from public, anon, authenticated, service_role;
revoke all on function private.audit_write(uuid, text, text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.audit_organizations() from public, anon, authenticated, service_role;
revoke all on function private.audit_organization_members() from public, anon, authenticated, service_role;
revoke all on function private.audit_invitations() from public, anon, authenticated, service_role;
