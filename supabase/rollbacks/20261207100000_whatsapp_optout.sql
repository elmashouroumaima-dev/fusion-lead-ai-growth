-- Retour arrière de 20261207100000_whatsapp_optout.sql (J36b). Les retraits déjà enregistrés (consentements révoqués, suppressions) restent.
-- `whatsapp_inbound_apply` redevient celle du J35.
begin;
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

drop function if exists private.whatsapp_opt_out(uuid, uuid, uuid, text, uuid);
drop function if exists private.whatsapp_opt_out_phone(uuid, text);
drop function if exists private.is_stop_keyword(text);
commit;
