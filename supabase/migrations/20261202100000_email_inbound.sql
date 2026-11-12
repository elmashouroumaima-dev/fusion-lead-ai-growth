-- J32 — E-mail entrant et statuts (spec §9.2 ; ADR 007, ADR 008 ; menaces C1 à C5).
--
--  * SECRET DE WEBHOOK : un second secret par intégration (`webhook_secret_ref`, chiffré dans `private.secrets` comme celui du J28, jamais lisible par
--    la Data API). Il sert à authentifier les webhooks du fournisseur (Postmark n'a pas de signature : Basic Auth, l'identifiant du compte est
--    l'utilisateur et ce secret le mot de passe) ; WhatsApp l'utilisera pour l'App Secret (J34). Distinct du jeton d'envoi : un secret de webhook
--    divulgué ne permet pas d'envoyer. Supprimé à la déconnexion.
--  * `inbound_unmatched` : file des e-mails entrants qu'aucun fil ne peut recevoir avec certitude (expéditeur inconnu ou non authentifié par SPF, canal
--    introuvable ou ambigu, spam, fil plein). Lecture owner et admin (le corps est une donnée personnelle), AUCUNE écriture directe. On ne crée JAMAIS de
--    contact à partir d'un e-mail inconnu. Le rattachement par un humain arrive avec la boîte de réception (J37).
--  * fonctions service_role pour le worker : `email_status_apply` (delivered, rebond dur, plainte ; message retrouvé par l'identifiant du fournisseur ou
--    par l'identifiant de NOTRE message renvoyé dans les métadonnées, toujours dans l'entreprise ET l'intégration authentifiées) et `email_inbound_apply`
--    (canal par l'adresse destinataire, contact par l'adresse expéditrice, un fil par contact et canal, sinon file des cas ambigus).
--  * décisions : un rebond dur ajoute l'adresse à `suppressions` SANS toucher `do_not_contact` (adresse invalide ≠ refus du contact) ; une plainte ajoute
--    l'adresse à `suppressions` ET pose `do_not_contact = true` ; un rebond doux est ignoré ; `delivered` ne vient que d'un événement du fournisseur.

--  * (revue adverse) file des cas ambigus : corps tronqué à 2 000 caractères, au plus 20 en attente par expéditeur, plafond de 10 000 par entreprise
--    SÉRIALISÉ ; une file pleine ne lève plus d'exception réessayable : le résultat est `dropped` (événement conservé, visible, jamais perdu en silence) ;
--    canal : correspondance EXACTE de l'adresse destinataire d'abord, sans étiquette `+xxx` seulement à défaut ; une plainte ne remplace qu'un `bounce`
--    (elle garde la provenance d'un `manual` ou d'un `unsubscribe`) ; un envoi réclamé depuis plus de 5 minutes et confirmé par le fournisseur est
--    réconcilié ; un identifiant du fournisseur reçu deux fois avec un autre contenu est tracé (`id_conflict`).

-- ---------------------------------------------------------------------------
-- Secret de webhook
-- ---------------------------------------------------------------------------
alter table public.integrations
  add column webhook_secret_ref uuid,
  add column has_webhook_secret boolean generated always as (webhook_secret_ref is not null) stored;

alter table public.integrations
  add constraint integrations_webhook_secret_fkey foreign key (organization_id, webhook_secret_ref)
    references private.secrets (organization_id, id) on delete restrict,
  add constraint integrations_webhook_secret_only_providers check (webhook_secret_ref is null or provider in ('email', 'whatsapp')),
  add constraint integrations_webhook_secret_distinct check (webhook_secret_ref is null or webhook_secret_ref is distinct from secret_ref);
create index integrations_webhook_secret_idx on public.integrations (organization_id, webhook_secret_ref) where webhook_secret_ref is not null;

-- `webhook_secret_ref` reste illisible : seul l'indicateur `has_webhook_secret` est accordé.
grant select (has_webhook_secret) on table public.integrations to authenticated;

create function private.set_integration_webhook_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
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
  if v_row.provider not in ('email', 'whatsapp') or v_row.status = 'disconnected' then
    raise exception 'integration_not_replaceable' using errcode = 'P0001';
  end if;
  begin
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'integration_webhook', p_org, p_ciphertext, p_nonce, p_key_version);
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  update public.integrations set webhook_secret_ref = p_secret_id where organization_id = p_org and id = p_integration;
  if v_row.webhook_secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.webhook_secret_ref;
  end if;
  perform private.audit_write(p_org, case when v_row.webhook_secret_ref is null then 'integration.webhook_secret_set' else 'integration.webhook_secret_rotated' end,
    'integration', p_integration, null, pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

-- Lecture du chiffré par le serveur (route de webhook) : service_role seulement.
create function private.get_integration_webhook_secret(p_org uuid, p_integration uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('secret_id', s.id, 'ciphertext', s.ciphertext, 'nonce', s.nonce, 'key_version', s.key_version)
    from public.integrations i
    join private.secrets s on s.organization_id = i.organization_id and s.id = i.webhook_secret_ref
   where i.organization_id = p_org and i.id = p_integration and i.status in ('pending', 'active', 'error');
$$;

-- La déconnexion supprime AUSSI le secret de webhook (même signature que celle du J28).
create or replace function private.disconnect_integration(p_org uuid, p_integration uuid)
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
  update public.integrations set secret_ref = null, webhook_secret_ref = null, status = 'disconnected' where organization_id = p_org and id = p_integration;
  if v_row.secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.secret_ref;
  end if;
  if v_row.webhook_secret_ref is not null then
    delete from private.secrets s where s.organization_id = p_org and s.id = v_row.webhook_secret_ref;
  end if;
  update public.channels set status = 'disconnected', send_paused = true where organization_id = p_org and integration_id = p_integration;
  perform private.audit_write(p_org, 'integration.disconnected', 'integration', p_integration, null, pg_catalog.jsonb_build_object('provider', v_row.provider));
end;
$$;

-- ---------------------------------------------------------------------------
-- inbound_unmatched : file des cas ambigus
-- ---------------------------------------------------------------------------
create table public.inbound_unmatched (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  integration_id uuid not null,
  channel_id uuid,
  provider_message_id text not null,
  from_normalized text not null,
  subject text,
  body text not null,
  reason text not null,
  status text not null default 'pending',
  received_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  constraint inbound_unmatched_org_id_key unique (organization_id, id),
  constraint inbound_unmatched_provider_key unique (organization_id, integration_id, provider_message_id),
  constraint inbound_unmatched_integration_fkey foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete restrict,
  constraint inbound_unmatched_channel_fkey foreign key (organization_id, channel_id)
    references public.channels (organization_id, id) on delete restrict,
  constraint inbound_unmatched_reason_valid check (reason in ('unknown_sender', 'sender_unverified', 'no_channel', 'ambiguous_channel', 'spam', 'conversation_full', 'id_conflict')),
  constraint inbound_unmatched_status_valid check (status in ('pending', 'attached', 'discarded')),
  constraint inbound_unmatched_body_valid check (pg_catalog.char_length(body) between 1 and 2000),
  constraint inbound_unmatched_subject_valid check (subject is null or pg_catalog.char_length(subject) <= 300),
  constraint inbound_unmatched_from_valid check (pg_catalog.char_length(from_normalized) between 3 and 320 and from_normalized !~ '[[:space:]]'),
  constraint inbound_unmatched_provider_id_valid check (pg_catalog.char_length(provider_message_id) between 1 and 998 and provider_message_id ~ '^[A-Za-z0-9._:=+/@<>$%-]+$')
);
create index inbound_unmatched_queue_idx on public.inbound_unmatched (organization_id, status, created_at desc, id);
comment on table public.inbound_unmatched is 'E-mails entrants sans fil certain (J32). Données personnelles : lecture owner et admin ; aucune écriture directe ; le rattachement humain arrive au J37.';
alter table public.inbound_unmatched enable row level security;
revoke all on table public.inbound_unmatched from authenticated, anon;
revoke insert, update, delete, truncate on table public.inbound_unmatched from service_role;
grant select on table public.inbound_unmatched to authenticated;
create policy inbound_unmatched_select on public.inbound_unmatched
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- Ajout dans la file. Résultat : `added`, `duplicate`, `queue_full` (10 000 en attente par entreprise) ou `sender_limit` (20 en attente par expéditeur).
-- Comptage et insertion sérialisés par entreprise (verrou transactionnel). Le corps est tronqué à 2 000 caractères : la file sert au tri, le contenu
-- complet reste dans l'événement conservé (`webhook_events`).
create function private.inbound_unmatched_add(
  p_org uuid, p_integration uuid, p_channel uuid, p_provider_message_id text, p_from text, p_subject text, p_body text, p_reason text, p_received_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inbound-unmatched:' || p_org::text, 0));
  if exists (select 1 from public.inbound_unmatched u where u.organization_id = p_org and u.integration_id = p_integration and u.provider_message_id = p_provider_message_id) then
    return 'duplicate';
  end if;
  if (select pg_catalog.count(*) from public.inbound_unmatched u where u.organization_id = p_org and u.status = 'pending') >= 10000 then
    return 'queue_full';
  end if;
  if (select pg_catalog.count(*) from public.inbound_unmatched u where u.organization_id = p_org and u.from_normalized = p_from and u.status = 'pending') >= 20 then
    return 'sender_limit';
  end if;
  insert into public.inbound_unmatched (organization_id, integration_id, channel_id, provider_message_id, from_normalized, subject, body, reason, received_at)
  values (p_org, p_integration, p_channel, p_provider_message_id, p_from, p_subject, pg_catalog.left(p_body, 2000), p_reason, coalesce(p_received_at, pg_catalog.now()))
  returning id into v_id;
  return 'added';
end;
$$;

-- ---------------------------------------------------------------------------
-- Statuts du fournisseur : delivered, rebond dur, plainte
-- Codes : validation_failed 22023 · not_found PT404 · retry_later P0001 (l'envoi est encore en cours : le job est rejoué)
-- ---------------------------------------------------------------------------
create function private.email_status_apply(
  p_org uuid, p_integration uuid, p_event text, p_hard boolean, p_provider_message_id text, p_ref text, p_event_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_contact public.contacts;
  v_address text;
  v_ref uuid;
  v_supp uuid;
begin
  if p_org is null or p_integration is null or p_event is null or p_event not in ('delivered', 'bounced', 'complaint')
     or (p_provider_message_id is not null and (pg_catalog.char_length(p_provider_message_id) not between 1 and 998 or p_provider_message_id !~ '^[A-Za-z0-9._:=+/@<>$%-]+$'))
     or (p_ref is not null and p_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (p_provider_message_id is null and p_ref is null) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_ref := p_ref::uuid;
  perform 1 from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'email' and i.status in ('pending', 'active', 'error');
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  -- le message est cherché dans l'entreprise ET l'intégration authentifiées ; l'identifiant du fournisseur prime sur la métadonnée
  select m.* into v_m
    from public.messages m
    join public.channels ch on ch.organization_id = m.organization_id and ch.id = m.channel_id
   where m.organization_id = p_org and ch.integration_id = p_integration and m.direction = 'outbound'
     and ((p_provider_message_id is not null and m.provider_message_id = p_provider_message_id) or (v_ref is not null and m.id = v_ref))
   order by (m.provider_message_id is not distinct from p_provider_message_id) desc
   limit 1
   for update of m;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'message_not_found');
  end if;
  if v_m.provider_message_id is not null and p_provider_message_id is not null and v_m.provider_message_id <> p_provider_message_id then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'message_mismatch');
  end if;

  -- réponse du fournisseur arrivée avant l'enregistrement de l'acceptation : on rejoue plus tard ; si la tentative date de plus de 5 minutes (worker mort
  -- avant l'enregistrement), le fournisseur prouve que le message est parti : réconciliation
  if v_m.status = 'queued' then
    if v_m.send_claimed_at is null then
      return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'not_sent');
    end if;
    if v_m.send_claimed_at > pg_catalog.now() - interval '5 minutes' or p_provider_message_id is null or v_m.approved_by is null then
      raise exception 'retry_later' using errcode = 'P0001';
    end if;
    update public.messages set status = 'accepted', provider_message_id = p_provider_message_id, sent_at = coalesce(sent_at, pg_catalog.now()), error_code = null
     where organization_id = p_org and id = v_m.id;
    perform private.audit_write(p_org, 'message.reconciled', 'message', v_m.id, null, null);
    v_m.status := 'accepted';
  end if;
  -- l'envoi avait été déclaré « résultat inconnu » : le fournisseur confirme qu'il l'a bien accepté
  if v_m.status = 'failed' and v_m.error_code = 'send_outcome_unknown' and p_provider_message_id is not null then
    update public.messages set status = 'accepted', provider_message_id = p_provider_message_id, sent_at = coalesce(sent_at, pg_catalog.now()), error_code = null
     where organization_id = p_org and id = v_m.id;
    perform private.audit_write(p_org, 'message.reconciled', 'message', v_m.id, null, null);
    v_m.status := 'accepted';
  end if;

  select ct.* into v_contact
    from public.conversations c
    join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
   where c.organization_id = p_org and c.id = v_m.conversation_id;
  -- l'adresse retirée est celle où le message est RÉELLEMENT parti (figée à l'approbation), jamais un champ du payload
  v_address := coalesce(v_m.approved_recipient, v_contact.email_normalized);

  if p_event = 'delivered' then
    if v_m.status in ('accepted', 'sent') then
      update public.messages set status = 'delivered' where organization_id = p_org and id = v_m.id;
      perform private.audit_write(p_org, 'message.delivered', 'message', v_m.id, null, null);
      return pg_catalog.jsonb_build_object('outcome', 'applied');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', case when v_m.status in ('delivered', 'read') then 'already_applied' else 'status_conflict' end);
  end if;

  if p_event = 'bounced' then
    if p_hard is distinct from true then
      return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'soft_bounce');
    end if;
    -- rebond dur : l'adresse est invalide (suppression) ; `do_not_contact` n'est PAS modifié
    if v_address is not null then
      insert into public.suppressions (organization_id, channel, value_normalized, reason, source_message_id)
      values (p_org, 'email', v_address, 'bounce', v_m.id)
      on conflict (organization_id, channel, value_normalized) do nothing
      returning id into v_supp;
      if v_supp is not null then
        perform private.audit_write(p_org, 'suppression.added', 'suppression', v_supp, null, pg_catalog.jsonb_build_object('reason', 'bounce'));
      end if;
    end if;
    if v_m.status in ('accepted', 'sent', 'delivered') then
      update public.messages set status = 'bounced' where organization_id = p_org and id = v_m.id;
      perform private.audit_write(p_org, 'message.bounced', 'message', v_m.id, null, null);
      return pg_catalog.jsonb_build_object('outcome', 'applied');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'applied', 'reason', case when v_m.status = 'bounced' then 'already_applied' else 'status_conflict' end);
  end if;

  -- plainte : refus explicite du contact : suppression ET do_not_contact
  if v_address is not null then
    insert into public.suppressions (organization_id, channel, value_normalized, reason, source_message_id)
    values (p_org, 'email', v_address, 'complaint', v_m.id)
    on conflict (organization_id, channel, value_normalized) do update set reason = 'complaint', source_message_id = excluded.source_message_id
      where public.suppressions.reason = 'bounce'
    returning id into v_supp;
    if v_supp is not null then
      perform private.audit_write(p_org, 'suppression.added', 'suppression', v_supp, null, pg_catalog.jsonb_build_object('reason', 'complaint'));
    end if;
  end if;
  update public.contacts set do_not_contact = true where organization_id = p_org and id = v_contact.id and do_not_contact = false;
  perform private.audit_write(p_org, 'message.complaint', 'message', v_m.id, null, null);
  return pg_catalog.jsonb_build_object('outcome', 'applied');
end;
$$;

-- ---------------------------------------------------------------------------
-- E-mail entrant : canal par l'adresse destinataire, contact par l'adresse expéditrice
-- Résultats : recorded · duplicate · unmatched (raison) . Un expéditeur inconnu ne crée JAMAIS de contact.
-- ---------------------------------------------------------------------------
create function private.email_inbound_apply(
  p_org uuid, p_integration uuid, p_provider_message_id text, p_recipients text[], p_from text, p_subject text, p_body text,
  p_received_at timestamptz, p_verified boolean, p_spam boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channels uuid[];
  v_channel uuid;
  v_contact uuid;
  v_conv uuid;
  v_result jsonb;
  v_reason text;
  v_added text;
begin
  if p_org is null or p_integration is null or p_verified is null or p_spam is null
     or p_provider_message_id is null or pg_catalog.char_length(p_provider_message_id) not between 1 and 998 or p_provider_message_id !~ '^[A-Za-z0-9._:=+/@<>$%-]+$'
     or p_from is null or pg_catalog.char_length(p_from) not between 3 and 320 or p_from ~ '[[:space:]]' or p_from !~ '^[^@]+@[^@]+$'
     or p_body is null or pg_catalog.char_length(p_body) not between 1 and 100000
     or (p_subject is not null and pg_catalog.char_length(p_subject) > 300)
     or p_recipients is null or pg_catalog.cardinality(p_recipients) not between 1 and 50 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'email' and i.status in ('pending', 'active', 'error');
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.inbound_unmatched u where u.organization_id = p_org and u.integration_id = p_integration and u.provider_message_id = p_provider_message_id) then
    return pg_catalog.jsonb_build_object('outcome', 'duplicate');
  end if;

  -- correspondance EXACTE de l'adresse destinataire d'abord ; sans l'étiquette `+xxx` de la partie locale seulement à défaut
  select pg_catalog.array_agg(ch.id) into v_channels
    from public.channels ch
   where ch.organization_id = p_org and ch.integration_id = p_integration and ch.type = 'email' and ch.status <> 'disconnected'
     and pg_catalog.lower(ch.sender_identity) = any (p_recipients);
  if v_channels is null then
    select pg_catalog.array_agg(ch.id) into v_channels
      from public.channels ch
     where ch.organization_id = p_org and ch.integration_id = p_integration and ch.type = 'email' and ch.status <> 'disconnected'
       and pg_catalog.lower(ch.sender_identity) = any (array(select pg_catalog.regexp_replace(r, '\+[^@]*@', '@') from pg_catalog.unnest(p_recipients) as r));
  end if;
  v_channel := case when pg_catalog.cardinality(v_channels) = 1 then v_channels[1] else null end;

  v_reason := case
    when v_channels is null then 'no_channel'
    when pg_catalog.cardinality(v_channels) > 1 then 'ambiguous_channel'
    when p_spam then 'spam'
    when not p_verified then 'sender_unverified'
    else null end;
  if v_reason is null then
    select ct.id into v_contact from public.contacts ct where ct.organization_id = p_org and ct.email_normalized = p_from;
    if v_contact is null then
      v_reason := 'unknown_sender';
    end if;
  end if;
  if v_reason is not null then
    v_added := private.inbound_unmatched_add(p_org, p_integration, v_channel, p_provider_message_id, p_from, p_subject, p_body, v_reason, p_received_at);
    return case v_added
      when 'duplicate' then pg_catalog.jsonb_build_object('outcome', 'duplicate')
      when 'added' then pg_catalog.jsonb_build_object('outcome', 'unmatched', 'reason', v_reason)
      else pg_catalog.jsonb_build_object('outcome', 'dropped', 'reason', v_added) end;
  end if;

  v_conv := (private.conversation_get_or_create(p_org, v_contact, v_channel) ->> 'id')::uuid;
  begin
    v_result := private.message_record(p_org, v_conv, 'inbound', p_provider_message_id, p_body, null, p_received_at);
  exception when sqlstate 'P0001' then
    if sqlerrm not in ('too_many_messages', 'idempotency_conflict') then
      raise;
    end if;
    -- fil plein, ou même identifiant du fournisseur avec un autre contenu (jamais un second message) : placé dans la file, tracé
    v_reason := case when sqlerrm = 'too_many_messages' then 'conversation_full' else 'id_conflict' end;
    -- l'identifiant de la file doit rester unique : un conflit d'identifiant est rangé sous un identifiant dérivé
    v_added := private.inbound_unmatched_add(p_org, p_integration, v_channel,
      case when v_reason = 'id_conflict' then pg_catalog.left(p_provider_message_id, 900) || ':conflict:' || pg_catalog.left(pg_catalog.md5(p_body), 16) else p_provider_message_id end,
      p_from, p_subject, p_body, v_reason, p_received_at);
    return case v_added
      when 'duplicate' then pg_catalog.jsonb_build_object('outcome', 'duplicate')
      when 'added' then pg_catalog.jsonb_build_object('outcome', 'unmatched', 'reason', v_reason)
      else pg_catalog.jsonb_build_object('outcome', 'dropped', 'reason', v_added) end;
  end;
  return pg_catalog.jsonb_build_object('outcome', case when (v_result ->> 'duplicate')::boolean then 'duplicate' else 'recorded' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits et enveloppes publiques
-- ---------------------------------------------------------------------------
revoke all on function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.get_integration_webhook_secret(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.inbound_unmatched_add(uuid, uuid, uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean) from public, anon, authenticated, service_role;
grant execute on function private.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
grant execute on function private.get_integration_webhook_secret(uuid, uuid) to service_role;
grant execute on function private.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz) to service_role;
grant execute on function private.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean) to service_role;

create function public.set_integration_webhook_secret(p_org uuid, p_integration uuid, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void language sql security invoker set search_path = ''
as $$ select private.set_integration_webhook_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version); $$;
create function public.get_integration_webhook_secret(p_org uuid, p_integration uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_integration_webhook_secret(p_org, p_integration); $$;
create function public.email_status_apply(p_org uuid, p_integration uuid, p_event text, p_hard boolean, p_provider_message_id text, p_ref text, p_event_at timestamptz)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.email_status_apply(p_org, p_integration, p_event, p_hard, p_provider_message_id, p_ref, p_event_at); $$;
create function public.email_inbound_apply(
  p_org uuid, p_integration uuid, p_provider_message_id text, p_recipients text[], p_from text, p_subject text, p_body text,
  p_received_at timestamptz, p_verified boolean, p_spam boolean
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.email_inbound_apply(p_org, p_integration, p_provider_message_id, p_recipients, p_from, p_subject, p_body, p_received_at, p_verified, p_spam); $$;

revoke all on function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) from public, anon, service_role;
revoke all on function public.get_integration_webhook_secret(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer) to authenticated;
grant execute on function public.get_integration_webhook_secret(uuid, uuid) to service_role;
grant execute on function public.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz) to service_role;
grant execute on function public.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean) to service_role;
