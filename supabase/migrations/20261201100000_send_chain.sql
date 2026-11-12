-- J31 — Envoi d'e-mail derrière la chaîne de contrôles (spec §5.7, §9.2, figure 9 ; ADR 007 G-D5, ADR 008 ; menaces B3, C3).
--
--  * `messages` : `approved_by`, `approved_at`, `approved_purpose` (approbation HUMAINE habilitée d'un message sortant, pour UNE finalité) et
--    `send_claimed_at` (au plus UNE tentative d'appel au fournisseur par message). Le corps est déjà immuable (J30) : l'approbation couvre
--    donc exactement le texte envoyé. Les colonnes d'approbation ne s'écrivent que par `message_approve` (owner / admin) et ne changent plus.
--  * `message_approve` met aussi le job `send_message` en file, dans la même transaction (l'envoi se fait dans le worker, jamais dans une requête) ;
--  * garde-fou de base : un message sortant ne peut PAS passer à `accepted`, `sent`, `delivered` ou `read` sans approbation, et les statuts ne
--    reculent jamais (queued -> accepted -> sent -> delivered -> read ; `failed`, `bounced`, `cancelled` sont terminaux).
--  * `suppressions` (ADR 007 G-D5) : adresses à ne plus contacter (rebond, plainte, désinscription, manuel). Lecture owner / admin / marketing ;
--    AUCUNE écriture aujourd'hui (les événements fournisseur du J32 et le désabonnement du J33 l'alimenteront par des fonctions service_role).
--  * fonctions service_role pour le worker : `message_send_claim` (relit tout l'état en UNE lecture verrouillée et pose la tentative),
--    `message_mark_accepted`, `message_mark_failed`, `message_release_claim` (réponse du fournisseur reçue mais refusée : un nouvel essai est permis).
--    Une tentative sans réponse (délai dépassé) reste « réclamée » : le message n'est JAMAIS renvoyé à l'aveugle (risque de doublon chez le destinataire).
--  * (revue adverse) l'approbation est REVALIDÉE à l'envoi : approbateur toujours owner / admin actif, approbation de moins de 72 h, adresse du destinataire
--    inchangée depuis l'approbation (`approved_recipient`), entreprise active et abonnement actif ; `approved_by` n'a PAS de clé étrangère vers l'adhésion
--    (fait d'audit : supprimer un compte ne doit pas être bloqué) ; un envoi en cours (moins de 5 min) n'est pas déclaré « inconnu » ; un `accepted` tardif
--    est accepté après `send_outcome_unknown` (le fournisseur a bien accepté) ; compteur de débit sérialisé par canal et limité aux envois réels ;
--  * `delivered` ne vient QUE d'un événement du fournisseur (J32), jamais de l'acceptation de l'API.

alter table public.messages
  add column approved_by uuid,
  add column approved_at timestamptz,
  add column approved_purpose text,
  add column approved_recipient text,
  add column send_claimed_at timestamptz;

alter table public.messages
  add constraint messages_approval_shape check (
    (approved_by is null) = (approved_at is null) and (approved_by is null) = (approved_purpose is null) and (approved_by is null) = (approved_recipient is null)
  ),
  add constraint messages_approved_recipient_valid check (approved_recipient is null or pg_catalog.char_length(approved_recipient) between 3 and 320),
  add constraint messages_approval_outbound check (approved_by is null or direction = 'outbound'),
  add constraint messages_approved_purpose_valid check (approved_purpose is null or approved_purpose ~ '^[a-z][a-z0-9_]{0,49}$'),
  add constraint messages_claim_outbound check (send_claimed_at is null or direction = 'outbound');

-- Garde : colonnes immuables + approbation écrite une seule fois + statuts qui ne reculent pas + pas d'envoi accepté sans approbation.
create or replace function private.messages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.conversation_id is distinct from old.conversation_id or new.channel_id is distinct from old.channel_id
     or new.direction is distinct from old.direction or new.body is distinct from old.body
     or (old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id) then
    raise exception 'message_immutable' using errcode = '23514';
  end if;
  if old.approved_by is not null
     and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
          or new.approved_purpose is distinct from old.approved_purpose or new.approved_recipient is distinct from old.approved_recipient) then
    raise exception 'message_approval_immutable' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'queued' and new.status in ('accepted', 'failed', 'cancelled'))
      or (old.status = 'accepted' and new.status in ('sent', 'delivered', 'read', 'failed', 'bounced'))
      or (old.status = 'sent' and new.status in ('delivered', 'read', 'failed', 'bounced'))
      or (old.status = 'delivered' and new.status in ('read', 'bounced'))
      -- le fournisseur a bien accepté un envoi dont la réponse s'était perdue (résultat inconnu) : seule sortie du statut « failed »
      or (old.status = 'failed' and old.error_code = 'send_outcome_unknown' and new.status = 'accepted')
    ) then
      raise exception 'message_status_invalid' using errcode = '23514';
    end if;
    if new.status in ('accepted', 'sent', 'delivered', 'read') and new.approved_by is null then
      raise exception 'message_not_approved' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- suppressions (ADR 007 G-D5)
-- ---------------------------------------------------------------------------
create table public.suppressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  channel public.channel_type not null,
  value_normalized text not null,
  reason text not null,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  constraint suppressions_org_id_key unique (organization_id, id),
  constraint suppressions_value_key unique (organization_id, channel, value_normalized),
  constraint suppressions_message_fkey foreign key (organization_id, source_message_id)
    references public.messages (organization_id, id) on delete restrict,
  constraint suppressions_reason_valid check (reason in ('bounce', 'complaint', 'unsubscribe', 'manual')),
  constraint suppressions_value_valid check (pg_catalog.char_length(value_normalized) between 1 and 320 and value_normalized = pg_catalog.btrim(value_normalized))
);
comment on table public.suppressions is 'Adresses à ne plus contacter (rebond, plainte, désinscription, manuel), J31 ; écrite par les fonctions du J32 et du J33. Spec §9.2, ADR 007 G-D5.';
alter table public.suppressions enable row level security;
revoke all on table public.suppressions from authenticated, anon;
revoke insert, update, delete, truncate on table public.suppressions from service_role;
grant select on table public.suppressions to authenticated;
create policy suppressions_select on public.suppressions
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- Approbation humaine (owner / admin) : une finalité, une fois, jamais modifiée
-- Codes : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 · not_found PT404 · P0001 : message_not_approvable
-- ---------------------------------------------------------------------------
create function private.message_approve(p_org uuid, p_message uuid, p_purpose text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.messages;
  v_email text;
begin
  perform private.assert_project_manager(p_org);
  if p_purpose is null or p_purpose !~ '^[a-z][a-z0-9_]{0,49}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.messages m where m.organization_id = p_org and m.id = p_message for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.direction <> 'outbound' or v_row.status <> 'queued' or v_row.approved_by is not null or v_row.send_claimed_at is not null then
    raise exception 'message_not_approvable' using errcode = 'P0001';
  end if;
  -- l'approbation couvre UNE adresse : celle du contact du fil à cet instant
  select ct.email_normalized into v_email
    from public.conversations c join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
   where c.organization_id = p_org and c.id = v_row.conversation_id;
  if v_email is null then
    raise exception 'message_not_approvable' using errcode = 'P0001';
  end if;
  update public.messages set approved_by = auth.uid(), approved_at = pg_catalog.now(), approved_purpose = p_purpose, approved_recipient = v_email
   where organization_id = p_org and id = p_message;
  perform private.audit_write(p_org, 'message.approved', 'message', p_message, null, pg_catalog.jsonb_build_object('purpose', p_purpose));
  -- l'envoi se fait par le worker, jamais dans la requête : le job naît avec l'approbation (même transaction, une clé par message)
  perform private.enqueue_job(p_org, 'send_message', pg_catalog.jsonb_build_object('message_id', p_message), 'send-message:' || p_message::text, null, 5);
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker (service_role) : relecture de l'état + tentative unique, résultats
-- ---------------------------------------------------------------------------
-- Relit TOUT ce que la chaîne de contrôles doit connaître, dans UNE transaction verrouillée, et pose la tentative. Statuts :
--   missing (inconnu ou autre entreprise) · not_queued (déjà traité, entrant) · in_progress (tentative posée il y a moins de 5 minutes : un autre worker travaille
--   peut-être encore) · ambiguous (tentative plus ancienne sans résultat connu) · claimed.
-- Aucun corps n'est renvoyé hors du statut `claimed`.
create function private.message_send_claim(p_org uuid, p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_conv public.conversations;
  v_contact public.contacts;
  v_channel public.channels;
  v_integration_status text;
  v_org_paused boolean;
  v_consent boolean;
  v_suppressed boolean;
  v_recent integer;
  v_org_status public.org_status;
  v_sub_status public.subscription_status;
  v_approver_ok boolean;
begin
  select * into v_m from public.messages m where m.organization_id = p_org and m.id = p_message for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  if v_m.direction <> 'outbound' or v_m.status <> 'queued' then
    return pg_catalog.jsonb_build_object('status', 'not_queued');
  end if;
  if v_m.send_claimed_at is not null then
    return pg_catalog.jsonb_build_object('status', case when v_m.send_claimed_at > pg_catalog.now() - interval '5 minutes' then 'in_progress' else 'ambiguous' end);
  end if;
  select * into v_conv from public.conversations c where c.organization_id = p_org and c.id = v_m.conversation_id;
  select * into v_contact from public.contacts ct where ct.organization_id = p_org and ct.id = v_conv.contact_id;
  select * into v_channel from public.channels ch where ch.organization_id = p_org and ch.id = v_m.channel_id;
  select i.status into v_integration_status from public.integrations i where i.organization_id = p_org and i.id = v_channel.integration_id;
  select coalesce((o.settings ->> 'send_paused') = 'true', false), o.status into v_org_paused, v_org_status from public.organizations o where o.id = p_org;
  select sub.status into v_sub_status from public.subscriptions sub where sub.organization_id = p_org;
  -- l'approbation est revalidée : l'approbateur doit être, MAINTENANT, owner ou admin actif de l'entreprise
  v_approver_ok := v_m.approved_by is not null and exists (
    select 1 from public.organization_members om
     where om.organization_id = p_org and om.user_id = v_m.approved_by and om.status = 'active' and om.role in ('company_owner', 'company_admin')
  );
  v_consent := v_m.approved_purpose is not null and exists (
    select 1 from public.consent_events ce
     where ce.organization_id = p_org and ce.contact_id = v_contact.id and ce.channel = v_channel.type
       and ce.purpose = v_m.approved_purpose and ce.revoked_at is null
  );
  v_suppressed := v_contact.email_normalized is not null and exists (
    select 1 from public.suppressions s
     where s.organization_id = p_org and s.channel = v_channel.type and s.value_normalized = v_contact.email_normalized
  );
  -- compteur de débit sérialisé par canal (deux workers ne lisent pas le même nombre), limité aux envois réels ou en cours
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('send-rate:' || v_m.channel_id::text, 0));
  select pg_catalog.count(*)::integer into v_recent from public.messages x
   where x.organization_id = p_org and x.channel_id = v_m.channel_id and x.direction = 'outbound'
     and ((x.status in ('accepted', 'sent', 'delivered', 'read') and x.sent_at > pg_catalog.now() - interval '1 hour')
          or (x.status = 'queued' and x.send_claimed_at > pg_catalog.now() - interval '1 hour'));
  update public.messages set send_claimed_at = pg_catalog.now() where organization_id = p_org and id = p_message;
  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'message', pg_catalog.jsonb_build_object(
      'body', v_m.body, 'approved', v_m.approved_by is not null, 'purpose', v_m.approved_purpose,
      'approver_valid', v_approver_ok,
      'approval_age_seconds', case when v_m.approved_at is null then null else pg_catalog.floor(extract(epoch from pg_catalog.now() - v_m.approved_at))::bigint end,
      'recipient_unchanged', v_m.approved_recipient is not null and v_m.approved_recipient = v_contact.email_normalized
    ),
    'organization_active', v_org_status = 'active' and v_sub_status is not null and v_sub_status not in ('suspended', 'cancelled'),
    'contact', pg_catalog.jsonb_build_object('email', v_contact.email_normalized, 'do_not_contact', v_contact.do_not_contact),
    'channel', pg_catalog.jsonb_build_object(
      'type', v_channel.type, 'status', v_channel.status, 'send_paused', v_channel.send_paused,
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;

create function private.message_mark_accepted(p_org uuid, p_message uuid, p_provider_message_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider_message_id is null or pg_catalog.char_length(p_provider_message_id) not between 1 and 998
     or p_provider_message_id !~ '^[A-Za-z0-9._:=+/@<>$%-]+$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.messages set status = 'accepted', provider_message_id = p_provider_message_id, sent_at = pg_catalog.now(), error_code = null
   where organization_id = p_org and id = p_message and direction = 'outbound' and send_claimed_at is not null
     and (status = 'queued' or (status = 'failed' and error_code = 'send_outcome_unknown'));
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform private.audit_write(p_org, 'message.accepted', 'message', p_message, null, null);
end;
$$;

create function private.message_mark_failed(p_org uuid, p_message uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.messages set status = 'failed', error_code = p_code
   where organization_id = p_org and id = p_message and direction = 'outbound' and status = 'queued';
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform private.audit_write(p_org, 'message.failed', 'message', p_message, null, pg_catalog.jsonb_build_object('error_code', p_code));
end;
$$;

-- Le fournisseur a répondu qu'il n'a PAS accepté (erreur transitoire) : la tentative est libérée, un nouvel essai est permis.
create function private.message_release_claim(p_org uuid, p_message uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.messages set send_claimed_at = null
   where organization_id = p_org and id = p_message and direction = 'outbound' and status = 'queued';
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits et enveloppes publiques
-- ---------------------------------------------------------------------------
revoke all on function private.message_approve(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.message_send_claim(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.message_mark_accepted(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.message_mark_failed(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.message_release_claim(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.message_approve(uuid, uuid, text) to authenticated;
grant execute on function private.message_send_claim(uuid, uuid) to service_role;
grant execute on function private.message_mark_accepted(uuid, uuid, text) to service_role;
grant execute on function private.message_mark_failed(uuid, uuid, text) to service_role;
grant execute on function private.message_release_claim(uuid, uuid) to service_role;

create function public.message_approve(p_org uuid, p_message uuid, p_purpose text)
returns void language sql security invoker set search_path = ''
as $$ select private.message_approve(p_org, p_message, p_purpose); $$;
create function public.message_send_claim(p_org uuid, p_message uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.message_send_claim(p_org, p_message); $$;
create function public.message_mark_accepted(p_org uuid, p_message uuid, p_provider_message_id text)
returns void language sql security invoker set search_path = ''
as $$ select private.message_mark_accepted(p_org, p_message, p_provider_message_id); $$;
create function public.message_mark_failed(p_org uuid, p_message uuid, p_code text)
returns void language sql security invoker set search_path = ''
as $$ select private.message_mark_failed(p_org, p_message, p_code); $$;
create function public.message_release_claim(p_org uuid, p_message uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.message_release_claim(p_org, p_message); $$;

revoke all on function public.message_approve(uuid, uuid, text) from public, anon, service_role;
revoke all on function public.message_send_claim(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.message_mark_accepted(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.message_mark_failed(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.message_release_claim(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.message_approve(uuid, uuid, text) to authenticated;
grant execute on function public.message_send_claim(uuid, uuid) to service_role;
grant execute on function public.message_mark_accepted(uuid, uuid, text) to service_role;
grant execute on function public.message_mark_failed(uuid, uuid, text) to service_role;
grant execute on function public.message_release_claim(uuid, uuid) to service_role;
