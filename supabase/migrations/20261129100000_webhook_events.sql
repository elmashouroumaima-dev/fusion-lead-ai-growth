-- Pipeline webhook (J29, spec §8 et §11, ADR 005 décision 9, ADR 007 `webhook_events`, menaces C1 à C5).
-- Retour arrière : supabase/rollbacks/20261129100000_webhook_events.sql
--
-- Décisions (mini-plan validé le 2026-11-09) :
--  * `webhook_events` : un événement reçu d'un fournisseur par entreprise ; l'entreprise est résolue par le COMPTE FOURNISSEUR
--    (`integrations`, unicité globale des comptes email et whatsapp, J28), jamais par un champ libre du payload ;
--  * unicité `(organization_id, provider, external_event_id)` et non `(provider, external_event_id)` (écart à l'ADR 007) : avec une
--    unicité globale, l'entreprise B pourrait réserver des identifiants d'événements pour empêcher l'entreprise A de recevoir les siens ;
--  * statuts `received`, `processed`, `ignored`, `failed`, `rejected` ; un événement `rejected` (signature invalide ou trop ancien) n'a NI
--    payload NI identifiant d'événement (donnée contrôlée par l'émetteur non authentifié) et n'entre pas dans l'unicité ; ces lignes sont
--    plafonnées (200 par intégration et par heure) pour qu'un inconnu ne remplisse pas la table ;
--  * le payload peut contenir des données personnelles : `authenticated` lit les MÉTADONNÉES seulement (SELECT par colonnes, sans `payload`) ;
--    aucune écriture directe, même service_role : tout passe par des fonctions réservées à service_role (route publique et worker) ;
--  * l'enregistrement d'un événement valide et la mise en file du job `process_webhook` se font dans la MÊME transaction (rien n'est perdu,
--    rien n'est enfilé deux fois : clé d'idempotence du job = identifiant de l'événement) ;
--  * plafond technique : 10 000 événements `received` des 7 derniers jours par entreprise (au-delà : `too_many_webhooks`, la route répond 503 et le
--    fournisseur réessaie) : un job mort n'obstrue pas la file indéfiniment ; la taille d'un payload est plafonnée à 4 Mo de jsonb (les adaptateurs
--    bornent le corps BRUT, 3 Mo pour WhatsApp : la marge couvre la mise en forme du jsonb) ;
--  * pas de purge du payload dans ce jour : politique de rétention à définir avec l'exploitation (J39, J58).

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  integration_id uuid not null,
  provider text not null,
  external_event_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',
  payload jsonb,
  signature_valid boolean not null,
  failure_code text,
  constraint webhook_events_org_id_key unique (organization_id, id),
  constraint webhook_events_integration_fkey foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete restrict,
  constraint webhook_events_dedup_key unique (organization_id, provider, external_event_id),
  constraint webhook_events_provider_valid check (provider in ('email', 'whatsapp')),
  constraint webhook_events_status_valid check (status in ('received', 'processed', 'ignored', 'failed', 'rejected')),
  constraint webhook_events_event_id_valid check (external_event_id is null or external_event_id ~ '^[A-Za-z0-9._:=+/@-]{1,200}$'),
  constraint webhook_events_failure_valid check (failure_code is null or failure_code ~ '^[a-z_]{1,40}$'),
  constraint webhook_events_payload_size check (payload is null or pg_catalog.octet_length(payload::text) <= 4194304),
  constraint webhook_events_state_valid check (
    (status = 'rejected' and payload is null and external_event_id is null and signature_valid = false)
    or (status <> 'rejected' and payload is not null and external_event_id is not null and signature_valid = true)
  )
);
create index webhook_events_integration_idx on public.webhook_events (organization_id, integration_id, received_at desc);
create index webhook_events_pending_idx on public.webhook_events (organization_id, received_at) where status = 'received';
create index webhook_events_rejected_idx on public.webhook_events (integration_id, received_at) where status = 'rejected';
comment on table public.webhook_events is 'Événements reçus des fournisseurs (J29, ADR 007). Écriture par fonctions service_role uniquement ; le payload n''est lisible par aucun rôle d''API.';

alter table public.webhook_events enable row level security;
revoke all on table public.webhook_events from authenticated;
grant select (id, organization_id, integration_id, provider, external_event_id, received_at, processed_at, status, signature_valid, failure_code)
  on table public.webhook_events to authenticated;
revoke insert, update, delete, truncate on table public.webhook_events from service_role;
create policy webhook_events_select on public.webhook_events
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Résolution du tenant : par le compte fournisseur, jamais par le payload
-- ---------------------------------------------------------------------------
create function private.webhook_resolve_integration(p_provider text, p_account text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('organization_id', i.organization_id, 'integration_id', i.id)
    from public.integrations i
   where i.provider = p_provider
     and i.external_account_id = p_account
     and i.provider in ('email', 'whatsapp')
     and i.status in ('pending', 'active', 'error');
$$;

-- ---------------------------------------------------------------------------
-- Enregistrement idempotent d'un événement VALIDE + job `process_webhook` (même transaction)
-- ---------------------------------------------------------------------------
create function private.webhook_record(p_org uuid, p_integration uuid, p_provider text, p_event_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_org is null or p_integration is null or p_provider is null or p_event_id is null or p_payload is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i where i.organization_id = p_org and i.id = p_integration and i.provider = p_provider;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if (select pg_catalog.count(*) from public.webhook_events e
       where e.organization_id = p_org and e.status = 'received' and e.received_at > pg_catalog.now() - interval '7 days') >= 10000 then
    raise exception 'too_many_webhooks' using errcode = 'P0001';
  end if;
  insert into public.webhook_events (organization_id, integration_id, provider, external_event_id, payload, signature_valid)
  values (p_org, p_integration, p_provider, p_event_id, p_payload, true)
  on conflict (organization_id, provider, external_event_id) do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id from public.webhook_events e where e.organization_id = p_org and e.provider = p_provider and e.external_event_id = p_event_id;
    return pg_catalog.jsonb_build_object('event_id', v_id, 'duplicate', true);
  end if;
  perform private.enqueue_job(p_org, 'process_webhook', pg_catalog.jsonb_build_object('event_id', v_id), 'process_webhook:' || v_id::text);
  return pg_catalog.jsonb_build_object('event_id', v_id, 'duplicate', false);
end;
$$;

-- Trace d'un événement REJETÉ (signature invalide, trop ancien) : sans payload ni identifiant, plafonnée à 200 par intégration et par heure.
create function private.webhook_record_rejection(p_org uuid, p_integration uuid, p_provider text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.integrations i where i.organization_id = p_org and i.id = p_integration and i.provider = p_provider;
  if not found then
    return false;
  end if;
  if (select pg_catalog.count(*) from public.webhook_events e
       where e.integration_id = p_integration and e.status = 'rejected' and e.received_at > pg_catalog.now() - interval '1 hour') >= 200 then
    return false;
  end if;
  insert into public.webhook_events (organization_id, integration_id, provider, status, signature_valid, failure_code)
  values (p_org, p_integration, p_provider, 'rejected', false, 'signature_invalid');
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker : démarrer et terminer le traitement d'un événement (l'entreprise est celle de la ligne du job)
-- ---------------------------------------------------------------------------
create function private.webhook_start(p_org uuid, p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.webhook_events;
begin
  select * into v_row from public.webhook_events e where e.organization_id = p_org and e.id = p_event for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  if v_row.status <> 'received' then
    return pg_catalog.jsonb_build_object('status', 'done');
  end if;
  return pg_catalog.jsonb_build_object('status', 'running', 'provider', v_row.provider, 'integration_id', v_row.integration_id, 'payload', v_row.payload);
end;
$$;

create function private.webhook_finish(p_org uuid, p_event uuid, p_status text, p_failure text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('processed', 'ignored', 'failed') or (p_failure is not null and p_failure !~ '^[a-z_]{1,40}$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.webhook_events
     set status = p_status, processed_at = pg_catalog.now(), failure_code = p_failure
   where organization_id = p_org and id = p_event and status = 'received';
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits et enveloppes publiques (SECURITY INVOKER) : service_role seulement
-- ---------------------------------------------------------------------------
revoke all on function private.webhook_resolve_integration(text, text) from public, anon, authenticated, service_role;
revoke all on function private.webhook_record(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.webhook_record_rejection(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.webhook_start(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.webhook_finish(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function private.webhook_resolve_integration(text, text) to service_role;
grant execute on function private.webhook_record(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function private.webhook_record_rejection(uuid, uuid, text) to service_role;
grant execute on function private.webhook_start(uuid, uuid) to service_role;
grant execute on function private.webhook_finish(uuid, uuid, text, text) to service_role;

create function public.webhook_resolve_integration(p_provider text, p_account text)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.webhook_resolve_integration(p_provider, p_account); $$;
create function public.webhook_record(p_org uuid, p_integration uuid, p_provider text, p_event_id text, p_payload jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.webhook_record(p_org, p_integration, p_provider, p_event_id, p_payload); $$;
create function public.webhook_record_rejection(p_org uuid, p_integration uuid, p_provider text)
returns boolean language sql security invoker set search_path = ''
as $$ select private.webhook_record_rejection(p_org, p_integration, p_provider); $$;
create function public.webhook_start(p_org uuid, p_event uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.webhook_start(p_org, p_event); $$;
create function public.webhook_finish(p_org uuid, p_event uuid, p_status text, p_failure text)
returns void language sql security invoker set search_path = ''
as $$ select private.webhook_finish(p_org, p_event, p_status, p_failure); $$;

revoke all on function public.webhook_resolve_integration(text, text) from public, anon, authenticated, service_role;
revoke all on function public.webhook_record(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.webhook_record_rejection(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.webhook_start(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.webhook_finish(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.webhook_resolve_integration(text, text) to service_role;
grant execute on function public.webhook_record(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.webhook_record_rejection(uuid, uuid, text) to service_role;
grant execute on function public.webhook_start(uuid, uuid) to service_role;
grant execute on function public.webhook_finish(uuid, uuid, text, text) to service_role;
