-- Intégrations, canaux et secrets d'intégration (J28, spec §2, §7 et §11, ADR 004, 007 et 014).
-- Retour arrière : supabase/rollbacks/20261128100000_integrations_secrets.sql
--
-- Décisions (mini-plan validé le 2026-11-09) :
--  * `integrations` (J25, version minimale) gagne `scopes`, `secret_ref` et `has_secret` (booléen généré) ; les fournisseurs `email` et
--    `whatsapp` s'ajoutent à `csv` et `internal` ; statuts `pending`, `active`, `error`, `disconnected`, `disabled` ;
--  * le SELECT de `authenticated` est ACCORDÉ PAR COLONNES : `secret_ref` n'est lisible par personne (ni owner, ni admin) par la Data API ;
--    l'interface ne connaît que `has_secret` ;
--  * le secret (jeton, clé d'API) est chiffré par l'APPLICATION (AES-256-GCM, ADR 004) et seul le chiffré est enregistré dans
--    `private.secrets` (aucun droit d'API) avec `organization_id` : une clé étrangère composite lie un secret à l'entreprise de son
--    intégration ; l'AAD du chiffrement (`org:<organization_id>:<secret_id>`) empêche de rejouer un secret dans une autre entreprise ;
--  * écriture par fonctions owner / admin : `create_provider_integration`, `set_integration_secret` (remplacer = ROTATION : le nouveau
--    secret est écrit puis l'ancien supprimé dans la même transaction), `disconnect_integration` (supprime le secret et met en pause les
--    canaux), `create_channel`, `update_channel` ; lecture du chiffré : `get_integration_secret`, RÉSERVÉE à service_role (worker et
--    envois), l'entreprise étant celle de la ligne du job ;
--  * unicité GLOBALE `(provider, external_account_id)` pour `email` et `whatsapp` (G-R6) : un compte déjà connecté chez une autre entreprise
--    est refusé ; `csv` et `internal` restent uniques par entreprise ;
--  * `channels` (ADR 007 E4) : `type`, `integration_id` (clé étrangère composite), `sender_identity`, `status`, `project_scope`, `send_paused` ;
--  * audit : ids et noms de champs seulement, jamais de secret, de chiffré ni d'identité d'expéditeur ;
--  * (revue adverse) une intégration déconnectée se RECONNECTE en remplaçant son jeton (statut `pending`, canaux `pending` mais en pause) :
--    le compte reste attaché à son entreprise, aucune voie sans issue ; `get_integration_secret` ne sert que les statuts pending, active, error ;
--    l'identité d'un canal a un format imposé (e-mail ou E.164) ; la PREUVE de propriété de l'expéditeur viendra de la validation par le
--    fournisseur (J31 e-mail, J34 WhatsApp) : un canal ne passe à `active` qu'à ce moment-là.

-- ---------------------------------------------------------------------------
-- private.secrets : unicité (organization_id, id) pour la clé étrangère composite
-- ---------------------------------------------------------------------------
alter table private.secrets add constraint secrets_org_id_key unique (organization_id, id);

-- ---------------------------------------------------------------------------
-- integrations : portée, référence du secret
-- ---------------------------------------------------------------------------
create function private.is_valid_scopes(p_scopes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_scopes is not null
    and coalesce(pg_catalog.cardinality(p_scopes), 0) <= 50
    and not exists (select 1 from pg_catalog.unnest(p_scopes) as s where s is null or s !~ '^[A-Za-z0-9._:/-]{1,100}$')
    and (select pg_catalog.count(distinct s) from pg_catalog.unnest(p_scopes) as s) = coalesce(pg_catalog.cardinality(p_scopes), 0);
$$;

alter table public.integrations
  add column scopes text[] not null default '{}',
  add column secret_ref uuid,
  add column has_secret boolean generated always as (secret_ref is not null) stored;

alter table public.integrations
  add constraint integrations_scopes_valid check (private.is_valid_scopes(scopes)),
  add constraint integrations_secret_fkey foreign key (organization_id, secret_ref)
    references private.secrets (organization_id, id) on delete restrict,
  add constraint integrations_secret_only_providers check (secret_ref is null or provider in ('email', 'whatsapp'));

alter table public.integrations drop constraint integrations_provider_valid;
alter table public.integrations add constraint integrations_provider_valid check (provider in ('csv', 'internal', 'email', 'whatsapp'));
alter table public.integrations drop constraint integrations_status_valid;
alter table public.integrations add constraint integrations_status_valid check (status in ('pending', 'active', 'error', 'disconnected', 'disabled'));

create unique index integrations_provider_account_global on public.integrations (provider, external_account_id) where provider in ('email', 'whatsapp');
create index integrations_secret_idx on public.integrations (organization_id, secret_ref) where secret_ref is not null;

-- SELECT par colonnes : `secret_ref` n'est jamais lisible par la Data API.
revoke select on table public.integrations from authenticated;
grant select (id, organization_id, provider, status, external_account_id, scopes, has_secret, last_sync_at, last_sync_finished_at, last_error, created_at, updated_at)
  on table public.integrations to authenticated;

-- ---------------------------------------------------------------------------
-- channels (ADR 007 E4)
-- ---------------------------------------------------------------------------
create table public.channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  type public.channel_type not null,
  integration_id uuid not null,
  sender_identity text not null,
  status text not null default 'pending',
  project_scope uuid[] not null default '{}',
  send_paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channels_org_id_key unique (organization_id, id),
  constraint channels_integration_fkey foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete restrict,
  constraint channels_sender_unique unique (organization_id, type, sender_identity),
  constraint channels_sender_valid check (private.is_safe_text(sender_identity, 1, 200) and sender_identity = pg_catalog.btrim(sender_identity)),
  constraint channels_status_valid check (status in ('pending', 'active', 'paused', 'disconnected')),
  constraint channels_scope_valid check (coalesce(pg_catalog.cardinality(project_scope), 0) <= 100 and project_scope is not null)
);
create index channels_org_integration_idx on public.channels (organization_id, integration_id);
comment on table public.channels is 'Canaux d''envoi et de réception (J28, ADR 007 E4). Écriture par fonctions owner / admin uniquement.';
create trigger channels_set_updated_at before update on public.channels for each row execute function private.set_updated_at();
create trigger channels_org_immutable before update on public.channels for each row execute function private.prevent_organization_id_change();

create function private.audit_channels()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(new.organization_id, 'channel.created', 'channel', new.id, null, pg_catalog.jsonb_build_object('type', new.type, 'integration_id', new.integration_id));
  elsif tg_op = 'UPDATE' then
    if new.sender_identity is distinct from old.sender_identity then v_changed := pg_catalog.array_append(v_changed, 'sender_identity'::text); end if;
    if new.status is distinct from old.status then v_changed := pg_catalog.array_append(v_changed, 'status'::text); end if;
    if new.project_scope is distinct from old.project_scope then v_changed := pg_catalog.array_append(v_changed, 'project_scope'::text); end if;
    if new.send_paused is distinct from old.send_paused then v_changed := pg_catalog.array_append(v_changed, 'send_paused'::text); end if;
    if pg_catalog.cardinality(v_changed) > 0 then
      perform private.audit_write(new.organization_id, 'channel.updated', 'channel', new.id, null, pg_catalog.jsonb_build_object('fields', v_changed));
    end if;
  end if;
  return null;
end;
$$;
create trigger audit_channels after insert or update on public.channels for each row execute function private.audit_channels();

alter table public.channels enable row level security;
revoke all on table public.channels from authenticated;
grant select on table public.channels to authenticated;
revoke insert, update, delete, truncate on table public.channels from service_role;
create policy channels_select on public.channels
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Gestion des intégrations à secret (owner / admin)
-- ---------------------------------------------------------------------------
create function private.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_scopes text[] := coalesce(p_scopes, '{}');
begin
  perform private.assert_project_manager(p_org);
  if p_provider is null or p_provider not in ('email', 'whatsapp') or p_account is null or p_account !~ '^[A-Za-z0-9._-]{1,100}$'
     or not private.is_valid_scopes(v_scopes) or p_secret_id is null or p_ciphertext is null or p_nonce is null or p_key_version is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_subscription_active(p_org);
  perform 1 from public.organizations o where o.id = p_org for update;
  perform private.assert_within_limit(p_org, 'integrations', 1);
  if (select count(*) from public.integrations i where i.organization_id = p_org) >= 20 then
    raise exception 'too_many_integrations' using errcode = 'P0001';
  end if;
  begin
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'integration', p_org, p_ciphertext, p_nonce, p_key_version);
    insert into public.integrations (organization_id, provider, status, external_account_id, scopes, secret_ref)
    values (p_org, p_provider, 'pending', p_account, v_scopes, p_secret_id)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- Remplacer le secret = ROTATION : le nouveau est écrit, puis l'ancien supprimé, dans la même transaction.
create function private.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
begin
  perform private.assert_project_manager(p_org);
  if p_secret_id is null or p_ciphertext is null or p_nonce is null or p_key_version is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider not in ('email', 'whatsapp') then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  begin
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'integration', p_org, p_ciphertext, p_nonce, p_key_version);
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  update public.integrations
     set secret_ref = p_secret_id,
         status = case when status in ('error', 'disconnected') then 'pending' else status end,
         last_error = null
   where organization_id = p_org and id = p_integration;
  -- reconnexion : les canaux redeviennent `pending` mais RESTENT en pause (le propriétaire les relance après validation)
  if v_row.status = 'disconnected' then
    update public.channels set status = 'pending' where organization_id = p_org and integration_id = p_integration and status = 'disconnected';
  end if;
  if v_row.secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.secret_ref;
  end if;
  perform private.audit_write(p_org, case when v_row.status = 'disconnected' then 'integration.reconnected' when v_row.secret_ref is null then 'integration.secret_set' else 'integration.secret_rotated' end, 'integration', p_integration, null,
    pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

-- Déconnexion : supprime le secret, met l'intégration en `disconnected` et ses canaux en pause.
create function private.disconnect_integration(p_org uuid, p_integration uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
begin
  perform private.assert_project_manager(p_org);
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider not in ('email', 'whatsapp') then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  if v_row.status = 'disconnected' then
    return;
  end if;
  update public.integrations set secret_ref = null, status = 'disconnected' where organization_id = p_org and id = p_integration;
  if v_row.secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.secret_ref;
  end if;
  update public.channels set status = 'disconnected', send_paused = true where organization_id = p_org and integration_id = p_integration;
  perform private.audit_write(p_org, 'integration.disconnected', 'integration', p_integration, null, pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

-- Lecture du chiffré par le serveur ou le worker : l'entreprise est celle de la ligne du job (service_role seulement).
create function private.get_integration_secret(p_org uuid, p_integration uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('secret_id', s.id, 'ciphertext', s.ciphertext, 'nonce', s.nonce, 'key_version', s.key_version)
    from public.integrations i
    join private.secrets s on s.organization_id = i.organization_id and s.id = i.secret_ref
   where i.organization_id = p_org and i.id = p_integration and i.status in ('pending', 'active', 'error');
$$;

-- ---------------------------------------------------------------------------
-- Canaux (owner / admin)
-- ---------------------------------------------------------------------------
create function private.assert_projects_in_org(p_org uuid, p_scope uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_scope is null or pg_catalog.cardinality(p_scope) > 100
     or (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_scope) as x) <> coalesce(pg_catalog.cardinality(p_scope), 0)
     or exists (select 1 from pg_catalog.unnest(p_scope) as x where x is null or not exists (select 1 from public.projects p where p.organization_id = p_org and p.id = x)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
end;
$$;

create function private.create_channel(p_org uuid, p_integration uuid, p_type public.channel_type, p_sender text, p_scope uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
  v_id uuid;
  v_scope uuid[] := coalesce(p_scope, '{}');
begin
  perform private.assert_project_manager(p_org);
  if p_type is null or not private.is_safe_text(p_sender, 1, 200) or p_sender <> pg_catalog.btrim(p_sender)
     or (p_type = 'email' and p_sender !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
     or (p_type = 'whatsapp' and p_sender !~ '^\+[1-9][0-9]{6,14}$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.assert_projects_in_org(p_org, v_scope);
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.provider::text is distinct from p_type::text or v_row.status = 'disconnected' then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  if (select count(*) from public.channels c where c.organization_id = p_org) >= 50 then
    raise exception 'too_many_channels' using errcode = 'P0001';
  end if;
  begin
    insert into public.channels (organization_id, type, integration_id, sender_identity, project_scope)
    values (p_org, p_type, p_integration, p_sender, v_scope)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- `p_scope` et `p_paused` nuls = inchangés ; l'identité de l'expéditeur ne change pas (un autre expéditeur = un autre canal).
create function private.update_channel(p_org uuid, p_id uuid, p_scope uuid[], p_paused boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.channels;
begin
  perform private.assert_project_manager(p_org);
  select * into v_row from public.channels c where c.organization_id = p_org and c.id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.status = 'disconnected' then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  if p_scope is not null then
    perform private.assert_projects_in_org(p_org, p_scope);
  end if;
  update public.channels
     set project_scope = coalesce(p_scope, project_scope),
         send_paused = coalesce(p_paused, send_paused)
   where organization_id = p_org and id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits et enveloppes publiques (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.is_valid_scopes(text[]) from public, anon, authenticated, service_role;
revoke all on function private.audit_channels() from public, anon, authenticated, service_role;
revoke all on function private.assert_projects_in_org(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.set_integration_secret(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.disconnect_integration(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.get_integration_secret(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_channel(uuid, uuid, public.channel_type, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.update_channel(uuid, uuid, uuid[], boolean) from public, anon, authenticated, service_role;
grant execute on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer) to authenticated;
grant execute on function private.set_integration_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
grant execute on function private.disconnect_integration(uuid, uuid) to authenticated;
grant execute on function private.create_channel(uuid, uuid, public.channel_type, text, uuid[]) to authenticated;
grant execute on function private.update_channel(uuid, uuid, uuid[], boolean) to authenticated;
grant execute on function private.get_integration_secret(uuid, uuid) to service_role;

create function public.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_provider_integration(p_org, p_provider, p_account, p_scopes, p_secret_id, p_ciphertext, p_nonce, p_key_version); $$;
create function public.set_integration_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void language sql security invoker set search_path = ''
as $$ select private.set_integration_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version); $$;
create function public.disconnect_integration(p_org uuid, p_integration uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.disconnect_integration(p_org, p_integration); $$;
create function public.get_integration_secret(p_org uuid, p_integration uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_integration_secret(p_org, p_integration); $$;
create function public.create_channel(p_org uuid, p_integration uuid, p_type public.channel_type, p_sender text, p_scope uuid[])
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_channel(p_org, p_integration, p_type, p_sender, p_scope); $$;
create function public.update_channel(p_org uuid, p_id uuid, p_scope uuid[], p_paused boolean)
returns void language sql security invoker set search_path = ''
as $$ select private.update_channel(p_org, p_id, p_scope, p_paused); $$;

revoke all on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer) from public, anon, service_role;
revoke all on function public.set_integration_secret(uuid, uuid, uuid, text, text, integer) from public, anon, service_role;
revoke all on function public.disconnect_integration(uuid, uuid) from public, anon, service_role;
revoke all on function public.get_integration_secret(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_channel(uuid, uuid, public.channel_type, text, uuid[]) from public, anon, service_role;
revoke all on function public.update_channel(uuid, uuid, uuid[], boolean) from public, anon, service_role;
grant execute on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer) to authenticated;
grant execute on function public.set_integration_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.disconnect_integration(uuid, uuid) to authenticated;
grant execute on function public.get_integration_secret(uuid, uuid) to service_role;
grant execute on function public.create_channel(uuid, uuid, public.channel_type, text, uuid[]) to authenticated;
grant execute on function public.update_channel(uuid, uuid, uuid[], boolean) to authenticated;
