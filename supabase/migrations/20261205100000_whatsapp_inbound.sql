-- J35 — Réception WhatsApp (spec §9.3, plan J35).
--
-- L'événement a déjà été authentifié (signature) et normalisé par la route publique (J34), puis enregistré dans `webhook_events` ; le worker l'applique ici avec
-- la clé service_role. L'entreprise et l'intégration sont celles de la LIGNE du job, jamais du contenu. Réutilise les tables du J30 (conversations, messages) et
-- du J32 (`inbound_unmatched`, qui ne dépend pas du fournisseur).
--  * `whatsapp_inbound_apply` : un message reçu est rattaché au contact par son NUMÉRO (E.164) dans le canal WhatsApp de l'intégration, un fil par contact et canal ;
--    un expéditeur inconnu ne crée JAMAIS de contact (file `inbound_unmatched`, raison `unknown_sender`), pas de canal ou plusieurs canaux : `no_channel`,
--    `ambiguous_channel`. Déduplication par identifiant du message chez Meta (`wamid`) : le même message n'est jamais enregistré deux fois. Un message
--    non textuel est enregistré avec son seul type (`[image]`).
--  * `whatsapp_status_apply` : statuts de NOS messages (sent, delivered, read, failed) ; ils n'avancent que dans l'ordre `accepted` < `sent` < `delivered` < `read` :
--    un statut hors ordre ou rejoué est ignoré ; `failed` n'est accepté que tant que le message n'est pas délivré ; le code d'erreur de Meta est un entier
--    (`wa_<code>`), jamais son texte. Un « failed » de Meta suivi d'un « delivered » ou « read » est corrigé (Meta ne garantit pas l'ordre).
--  * LIMITE (prérequis du J36) : un statut reçu AVANT l'enregistrement de l'envoi (l'identifiant Meta n'est pas encore dans `messages`) est ignoré (`message_not_found`) ;
--    le J36 doit réclamer l'envoi avant l'appel et réconcilier comme l'e-mail (J31 et J32) pour ne perdre aucun statut.
-- Garde des messages (J31) reprise avec UNE transition de plus : un « failed » posé par Meta (`error_code` `wa_<code>`) peut devenir « delivered » ou « read » si un
-- statut arrive hors ordre. Un échec posé par la chaîne d'envoi (`send_*`, `refused_*`) reste définitif, sauf la réconciliation de « résultat inconnu » du J32.
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
      -- le fournisseur a bien accepté un envoi dont la réponse s'était perdue (résultat inconnu) : seule sortie du statut « failed » côté envoi
      or (old.status = 'failed' and old.error_code = 'send_outcome_unknown' and new.status = 'accepted')
      -- J35 : échec annoncé par Meta, puis statut de livraison hors ordre
      or (old.status = 'failed' and old.error_code like 'wa\_%' and new.status in ('delivered', 'read'))
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

create function private.whatsapp_inbound_apply(
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
    v_added := private.inbound_unmatched_add(p_org, p_integration, v_channel,
      case when v_reason = 'id_conflict' then pg_catalog.left(p_provider_message_id, 250) || ':conflict:' || pg_catalog.left(pg_catalog.md5(v_body), 16) else p_provider_message_id end,
      p_from, null, v_body, v_reason, p_received_at);
    return case v_added
      when 'duplicate' then pg_catalog.jsonb_build_object('outcome', 'duplicate')
      when 'added' then pg_catalog.jsonb_build_object('outcome', 'unmatched', 'reason', v_reason)
      else pg_catalog.jsonb_build_object('outcome', 'dropped', 'reason', v_added) end;
  end;
  return pg_catalog.jsonb_build_object('outcome', case when (v_result ->> 'duplicate')::boolean then 'duplicate' else 'recorded' end);
end;
$$;

create function private.whatsapp_status_apply(
  p_org uuid, p_integration uuid, p_provider_message_id text, p_status text, p_error_code integer, p_event_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_rank integer;
  v_current integer;
begin
  if p_org is null or p_integration is null
     or p_provider_message_id is null or p_provider_message_id !~ '^[A-Za-z0-9._=+/-]{1,255}$'
     or p_status is null or p_status not in ('sent', 'delivered', 'read', 'failed')
     or (p_error_code is not null and p_error_code not between 0 and 999999) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'whatsapp' and i.status in ('pending', 'active', 'error');
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- le message est cherché dans l'entreprise ET l'intégration authentifiées, par l'identifiant de Meta
  select m.* into v_m
    from public.messages m
    join public.channels ch on ch.organization_id = m.organization_id and ch.id = m.channel_id
   where m.organization_id = p_org and ch.integration_id = p_integration and m.direction = 'outbound' and m.provider_message_id = p_provider_message_id
   limit 1
   for update of m;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'message_not_found');
  end if;
  if v_m.status not in ('accepted', 'sent', 'delivered', 'read', 'failed', 'bounced') then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'not_sent');
  end if;

  if p_status = 'failed' then
    if v_m.status in ('accepted', 'sent') then
      update public.messages set status = 'failed', error_code = 'wa_' || coalesce(p_error_code::text, '0')
       where organization_id = p_org and id = v_m.id;
      perform private.audit_write(p_org, 'message.failed', 'message', v_m.id, null, pg_catalog.jsonb_build_object('error_code', 'wa_' || coalesce(p_error_code::text, '0')));
      return pg_catalog.jsonb_build_object('outcome', 'applied');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', case when v_m.status = 'failed' then 'already_applied' else 'status_conflict' end);
  end if;

  v_rank := case p_status when 'sent' then 1 when 'delivered' then 2 else 3 end;
  -- Meta ne garantit pas l'ordre : un « failed » de Meta suivi d'un vrai « delivered » ou « read » est corrigé (jamais un échec posé par la chaîne d'envoi, `send_*`)
  if v_m.status = 'failed' and v_m.error_code like 'wa\_%' and v_rank >= 2 then
    update public.messages set status = p_status, error_code = null where organization_id = p_org and id = v_m.id;
    perform private.audit_write(p_org, 'message.' || p_status, 'message', v_m.id, null, null);
    return pg_catalog.jsonb_build_object('outcome', 'applied');
  end if;
  v_current := case v_m.status when 'accepted' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else -1 end;
  if v_current < 0 then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', 'status_conflict');
  end if;
  if v_rank <= v_current then
    return pg_catalog.jsonb_build_object('outcome', 'ignored', 'reason', case when v_rank = v_current then 'already_applied' else 'out_of_order' end);
  end if;
  update public.messages set status = p_status where organization_id = p_org and id = v_m.id;
  perform private.audit_write(p_org, 'message.' || p_status, 'message', v_m.id, null, null);
  return pg_catalog.jsonb_build_object('outcome', 'applied');
end;
$$;

revoke all on function private.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz) from public, anon, authenticated, service_role;
grant execute on function private.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function private.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz) to service_role;

create function public.whatsapp_inbound_apply(p_org uuid, p_integration uuid, p_provider_message_id text, p_from text, p_type text, p_body text, p_received_at timestamptz)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.whatsapp_inbound_apply(p_org, p_integration, p_provider_message_id, p_from, p_type, p_body, p_received_at); $$;
create function public.whatsapp_status_apply(p_org uuid, p_integration uuid, p_provider_message_id text, p_status text, p_error_code integer, p_event_at timestamptz)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.whatsapp_status_apply(p_org, p_integration, p_provider_message_id, p_status, p_error_code, p_event_at); $$;
revoke all on function public.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz) to service_role;
grant execute on function public.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz) to service_role;
