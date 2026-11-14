-- J36b — Retrait de consentement WhatsApp par un mot d'arrêt (spec §9.3 : « toute demande d'arrêt met à jour `consent_events` immédiatement et arrête les jobs en attente »).
--
-- Prérequis relevé par les revues J35 et J36 avant tout envoi marketing WhatsApp réel : un « STOP » reçu était enregistré comme un message ordinaire.
--  * `private.is_stop_keyword(texte)` : le message ENTIER (sans casse, espaces ni ponctuation finale) est un mot d'arrêt (STOP, ARRET, UNSUBSCRIBE, DÉSABONNER, إيقاف...) ;
--    une phrase qui CONTIENT « stop » n'en est pas une (aucun retrait par erreur).
--  * `private.whatsapp_opt_out` (comme le désabonnement e-mail, J33) : révoque les consentements WhatsApp du contact (historique conservé), inscrit le numéro dans
--    `suppressions` (raison `unsubscribe`, message source tracé), annule les messages WhatsApp en file non réclamés et leurs jobs, audite sans numéro ni texte.
--    `do_not_contact` n'est PAS modifié (réservé à la plainte, décision de la responsable technique). Un envoi déjà réclamé est refusé par le contrôle final s'il
--    n'est pas encore parti ; sinon l'appel peut partir (fenêtre de quelques secondes).
--  * `whatsapp_inbound_apply` appelle le retrait quand un message reçu d'un contact CONNU est un mot d'arrêt (même si le fil est plein ou l'identifiant en conflit) ; pour un numéro SANS contact\n--    (expéditeur inconnu, pas de canal, canal ambigu) seul le NUMÉRO est supprimé (aucun contact n'est créé) : l'envoi y reste bloqué.\n--  * Rattrapage unique en fin de migration : les mots d'arrêt déjà reçus (J35) sont honorés. Normalisation : NFKC, marques invisibles et diacritiques arabes retirés, ponctuation, symboles et\n--    émojis aux extrémités ignorés, espaces ignorés ; liste CTIA + libellés de boutons Meta + français + arabe. Un retrait en texte libre (« ne m'écrivez plus ») reste à traiter par un humain dans la boîte (J37).
create function private.is_stop_keyword(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- normalisation : NFKC (largeur pleine, formes décomposées), minuscules, sans marques invisibles (bidi, largeur nulle), sans diacritiques arabes ni tatweel,
  -- sans ponctuation, symbole ni émoji aux extrémités, puis SANS aucun espace (« S T O P », « stop  all »). Le message ENTIER doit correspondre.
  select p_text is not null and pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(
             pg_catalog.regexp_replace(pg_catalog.lower(normalize(p_text, NFKC)), '[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\u064b-\u065f\u0640]', '', 'g'),
             '^[[:punct:][:space:]\u00a0\u2000-\u206f\u2190-\u2bff\U0001f000-\U0001faff]+|[[:punct:][:space:]\u00a0\u2000-\u206f\u2190-\u2bff\U0001f000-\U0001faff]+$', '', 'g'),
           '[[:space:]\u00a0]+', '', 'g'
         ) = any (array[
    -- anglais (CTIA et libellés de boutons recommandés par Meta)
    'stop', 'stopall', 'end', 'quit', 'cancel', 'unsubscribe', 'unsub', 'optout', 'removeme', 'stoppromotions', 'stoppromo', 'stopmessages', 'stopmessaging',
    'cancelsubscription', 'unsubscribeme',
    -- français
    'arret', 'arrêt', 'arreter', 'arrêter', 'arrete', 'arrête', 'arretez', 'arrêtez', 'stoppe', 'stoppez', 'desabonner', 'désabonner', 'desabonne', 'désabonne',
    'sedesabonner', 'sedésabonner', 'medesabonner', 'medésabonner', 'desabonnement', 'désabonnement', 'desinscription', 'désinscription', 'desinscrire', 'désinscrire',
    -- arabe
    'إيقاف', 'ايقاف', 'توقف', 'أوقف', 'اوقف', 'إلغاء', 'الغاء', 'إلغاءالاشتراك', 'الغاءالاشتراك', 'ألغالاشتراك', 'الغالاشتراك'
  ]);
$$;

create function private.whatsapp_opt_out_phone(p_org uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supp uuid;
begin
  -- numéro sans contact (ou message non enregistré) : le numéro seul est supprimé, l'envoi y est bloqué dès qu'un contact portera ce numéro
  insert into public.suppressions (organization_id, channel, value_normalized, reason, source_message_id)
  values (p_org, 'whatsapp', p_phone, 'unsubscribe', null)
  on conflict (organization_id, channel, value_normalized) do nothing
  returning id into v_supp;
  if v_supp is not null then
    perform private.audit_write(p_org, 'suppression.added', 'suppression', v_supp, null, pg_catalog.jsonb_build_object('reason', 'unsubscribe', 'channel', 'whatsapp'));
  end if;
end;
$$;

create function private.whatsapp_opt_out(p_org uuid, p_contact uuid, p_channel uuid, p_phone text, p_source_message uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supp uuid;
  v_revoked integer;
  v_cancelled integer;
begin
  perform 1 from public.contacts ct where ct.organization_id = p_org and ct.id = p_contact for update;
  update public.consent_events e set revoked_at = pg_catalog.now()
   where e.organization_id = p_org and e.contact_id = p_contact and e.channel = 'whatsapp' and e.revoked_at is null;
  get diagnostics v_revoked = row_count;
  if v_revoked > 0 then
    perform private.refresh_consent_status(p_org, p_contact);
  end if;
  insert into public.suppressions (organization_id, channel, value_normalized, reason, source_message_id)
  values (p_org, 'whatsapp', p_phone, 'unsubscribe', p_source_message)
  on conflict (organization_id, channel, value_normalized) do nothing
  returning id into v_supp;
  if v_supp is not null then
    perform private.audit_write(p_org, 'suppression.added', 'suppression', v_supp, null, pg_catalog.jsonb_build_object('reason', 'unsubscribe', 'channel', 'whatsapp'));
  end if;
  with doomed as (
    select m.id
      from public.messages m
      join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
     where m.organization_id = p_org and c.contact_id = p_contact and m.direction = 'outbound'
       and m.status = 'queued' and m.send_claimed_at is null
       and exists (select 1 from public.channels ch where ch.organization_id = m.organization_id and ch.id = m.channel_id and ch.type = 'whatsapp')
     for update of m
  ), upd as (
    update public.messages m set status = 'cancelled' from doomed d where m.organization_id = p_org and m.id = d.id returning m.id
  ), jobs_cancelled as (
    update public.jobs j set status = 'cancelled', finished_at = pg_catalog.now()
     where j.organization_id = p_org and j.kind = 'send_message' and j.status = 'queued' and (j.payload ->> 'message_id') in (select u.id::text from upd u)
    returning j.id
  )
  select pg_catalog.count(*)::integer into v_cancelled from upd;
  if v_cancelled > 0 then
    perform private.audit_write(p_org, 'message.cancelled', 'contact', p_contact, null, pg_catalog.jsonb_build_object('reason', 'opt_out', 'count', v_cancelled));
  end if;
  -- audit seulement si quelque chose a changé (un STOP répété ne fait pas de bruit)
  if v_revoked > 0 or v_supp is not null or v_cancelled > 0 then
    perform private.audit_write(p_org, 'whatsapp.opt_out', 'contact', p_contact, null,
      pg_catalog.jsonb_build_object('source_message_id', p_source_message, 'revoked', v_revoked, 'cancelled', v_cancelled));
  end if;
end;
$$;

create or replace function private.whatsapp_inbound_apply(
  p_org uuid, p_integration uuid, p_provider_message_id text, p_from text, p_type text, p_body text, p_received_at timestamptz
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
  v_body text;
begin
  if p_org is null or p_integration is null
     or p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9._=+/-]{1,255}$'
     or p_from is null or p_from !~ '^\+[0-9]{5,20}$'
     or p_type is null or p_type !~ '^[a-z_]{1,30}$'
     or (p_body is not null and pg_catalog.char_length(p_body) not between 1 and 4096) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'whatsapp' and i.status in ('pending', 'active', 'error');
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.inbound_unmatched u where u.organization_id = p_org and u.integration_id = p_integration and u.provider_message_id = p_provider_message_id) then
    return pg_catalog.jsonb_build_object('outcome', 'duplicate');
  end if;
  v_body := coalesce(p_body, '[' || p_type || ']');
  -- un horodatage du fournisseur n'est jamais dans le futur (même plafond que les messages)
  p_received_at := least(p_received_at, pg_catalog.now());

  select pg_catalog.array_agg(ch.id) into v_channels
    from public.channels ch
   where ch.organization_id = p_org and ch.integration_id = p_integration and ch.type = 'whatsapp' and ch.status <> 'disconnected';
  v_channel := case when pg_catalog.cardinality(v_channels) = 1 then v_channels[1] else null end;
  v_reason := case
    when v_channels is null then 'no_channel'
    when pg_catalog.cardinality(v_channels) > 1 then 'ambiguous_channel'
    else null end;
  if v_reason is null then
    select ct.id into v_contact from public.contacts ct where ct.organization_id = p_org and ct.phone_e164 = p_from;
    if v_contact is null then
      v_reason := 'unknown_sender';
    end if;
  end if;
  if v_reason is not null then
    if private.is_stop_keyword(p_body) then
      perform private.whatsapp_opt_out_phone(p_org, p_from);
    end if;
    v_added := private.inbound_unmatched_add(p_org, p_integration, v_channel, p_provider_message_id, p_from, null, v_body, v_reason, p_received_at);
    return case v_added
      when 'duplicate' then pg_catalog.jsonb_build_object('outcome', 'duplicate')
      when 'added' then pg_catalog.jsonb_build_object('outcome', 'unmatched', 'reason', v_reason)
      else pg_catalog.jsonb_build_object('outcome', 'dropped', 'reason', v_added) end;
  end if;

  v_conv := (private.conversation_get_or_create(p_org, v_contact, v_channel) ->> 'id')::uuid;
  begin
    v_result := private.message_record(p_org, v_conv, 'inbound', p_provider_message_id, v_body, null, p_received_at);
  exception when sqlstate 'P0001' then
    if sqlerrm not in ('too_many_messages', 'idempotency_conflict') then
      raise;
    end if;
    v_reason := case when sqlerrm = 'too_many_messages' then 'conversation_full' else 'id_conflict' end;
    if private.is_stop_keyword(p_body) then
      perform private.whatsapp_opt_out(p_org, v_contact, v_channel, p_from, null);
    end if;
    v_added := private.inbound_unmatched_add(p_org, p_integration, v_channel,
      case when v_reason = 'id_conflict' then pg_catalog.left(p_provider_message_id, 250) || ':conflict:' || pg_catalog.left(pg_catalog.md5(v_body), 16) else p_provider_message_id end,
      p_from, null, v_body, v_reason, p_received_at);
    return case v_added
      when 'duplicate' then pg_catalog.jsonb_build_object('outcome', 'duplicate')
      when 'added' then pg_catalog.jsonb_build_object('outcome', 'unmatched', 'reason', v_reason)
      else pg_catalog.jsonb_build_object('outcome', 'dropped', 'reason', v_added) end;
  end;
  -- un mot d'arrêt (STOP...) d'un contact connu : retrait du consentement WhatsApp, numéro supprimé, envois en attente annulés (jamais de réponse automatique)
  if (v_result ->> 'duplicate')::boolean is not true and private.is_stop_keyword(p_body) then
    perform private.whatsapp_opt_out(p_org, v_contact, v_channel, p_from, (v_result ->> 'message_id')::uuid);
    return pg_catalog.jsonb_build_object('outcome', 'recorded', 'opt_out', true);
  end if;
  return pg_catalog.jsonb_build_object('outcome', case when (v_result ->> 'duplicate')::boolean then 'duplicate' else 'recorded' end);
end;
$$;

revoke all on function private.is_stop_keyword(text) from public, anon, authenticated, service_role;
revoke all on function private.whatsapp_opt_out_phone(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.whatsapp_opt_out(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- Rattrapage (une seule fois) : un mot d'arrêt DÉJÀ reçu et enregistré par le J35 est honoré, sauf si le contact a donné un nouveau consentement WhatsApp depuis.
do $backfill$
declare
  r record;
begin
  for r in
    select m.id as message_id, m.organization_id, m.channel_id, c.contact_id, ct.phone_e164
      from public.messages m
      join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
      join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
      join public.channels ch on ch.organization_id = m.organization_id and ch.id = m.channel_id
     where m.direction = 'inbound' and ch.type = 'whatsapp' and ct.phone_e164 is not null and private.is_stop_keyword(m.body)
       and not exists (select 1 from public.consent_events e where e.organization_id = m.organization_id and e.contact_id = c.contact_id and e.channel = 'whatsapp' and e.captured_at > m.received_at)
  loop
    perform private.whatsapp_opt_out(r.organization_id, r.contact_id, r.channel_id, r.phone_e164, r.message_id);
  end loop;
end
$backfill$;
