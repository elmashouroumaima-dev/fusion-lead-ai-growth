-- Passerelle WhatsApp (ADR 017, décision du 2026-11-21) : chaque intégration porte sa passerelle, `meta` (API Graph en direct, comportement existant)
-- ou `kapso`. Le fournisseur reste `whatsapp` : aucune table, aucun processeur de webhook, aucune contrainte de fournisseur ne change.
--  * `integrations.gateway` : défaut `meta` (les intégrations existantes ne changent pas) ; l'application crée les nouvelles en `kapso`.
--    Lisible par owner / admin comme les autres colonnes (aucun secret).
--  * `create_provider_integration` : paramètre `p_gateway` (défaut `meta`, `kapso` seulement pour WhatsApp). Même nom, signature élargie
--    (l'ancienne est supprimée ; les appels existants sans le paramètre continuent de fonctionner grâce au défaut).
--  * `webhook_resolve_integration` : paramètre `p_gateway` (défaut null = sans filtre) : un webhook Kapso ne retrouve qu'une intégration Kapso
--    et inversement.
--  * `message_send_claim` : renvoie `channel.gateway` au worker (le reste est identique à la version de 20261211100000).
-- Retour arrière : supabase/rollbacks/20261215100000_integration_gateway.sql

alter table public.integrations add column gateway text not null default 'meta';
alter table public.integrations add constraint integrations_gateway_valid check (gateway in ('meta', 'kapso'));
alter table public.integrations add constraint integrations_gateway_whatsapp_only check (gateway = 'meta' or provider = 'whatsapp');
grant select (gateway) on table public.integrations to authenticated;

drop function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer);
drop function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer);
create function private.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer,
  p_gateway text default 'meta'
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
     or p_gateway is null or p_gateway not in ('meta', 'kapso') or (p_gateway = 'kapso' and p_provider <> 'whatsapp')
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
    insert into public.integrations (organization_id, provider, status, external_account_id, scopes, secret_ref, gateway)
    values (p_org, p_provider, 'pending', p_account, v_scopes, p_secret_id, p_gateway)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_id;
end;
$$;
create function public.create_provider_integration(
  p_org uuid, p_provider text, p_account text, p_scopes text[], p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer,
  p_gateway text default 'meta'
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_provider_integration(p_org, p_provider, p_account, p_scopes, p_secret_id, p_ciphertext, p_nonce, p_key_version, p_gateway); $$;
revoke all on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) to authenticated;
revoke all on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) from public, anon, service_role;
grant execute on function public.create_provider_integration(uuid, text, text, text[], uuid, text, text, integer, text) to authenticated;

drop function public.webhook_resolve_integration(text, text);
drop function private.webhook_resolve_integration(text, text);
create function private.webhook_resolve_integration(p_provider text, p_account text, p_gateway text default null)
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
     and (p_gateway is null or i.gateway = p_gateway)
     and i.status in ('pending', 'active', 'error');
$$;
create function public.webhook_resolve_integration(p_provider text, p_account text, p_gateway text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.webhook_resolve_integration(p_provider, p_account, p_gateway); $$;
revoke all on function private.webhook_resolve_integration(text, text, text) from public, anon, authenticated, service_role;
grant execute on function private.webhook_resolve_integration(text, text, text) to service_role;
revoke all on function public.webhook_resolve_integration(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.webhook_resolve_integration(text, text, text) to service_role;

create or replace function private.message_send_claim(p_org uuid, p_message uuid)
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
  v_recipient text;
  v_window boolean;
  v_tpl public.message_templates;
  v_account text;
  v_gateway text;
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
  select i.status, i.external_account_id, i.gateway into v_integration_status, v_account, v_gateway from public.integrations i where i.organization_id = p_org and i.id = v_channel.integration_id;
  v_recipient := case when v_channel.type = 'whatsapp' then v_contact.phone_e164 else v_contact.email_normalized end;
  -- fenêtre de conversation WhatsApp : ouverte si le contact a écrit il y a moins de 24 heures dans ce fil
  v_window := exists (select 1 from public.messages x where x.organization_id = p_org and x.conversation_id = v_m.conversation_id and x.direction = 'inbound' and x.received_at > pg_catalog.now() - interval '24 hours');
  if v_m.template_id is not null then
    select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = v_m.template_id;
  end if;
  select coalesce((o.settings ->> 'send_paused') = 'true', false), o.status into v_org_paused, v_org_status from public.organizations o where o.id = p_org;
  select sub.status into v_sub_status from public.subscriptions sub where sub.organization_id = p_org;
  -- l'approbation est revalidée : l'approbateur doit être, MAINTENANT, owner ou admin actif de l'entreprise
  -- (J38) ... ou, pour une RÉPONSE (finalité « reply »), le commercial qui l'a approuvée en l'envoyant, tant qu'il est encore le responsable du fil
  v_approver_ok := v_m.approved_by is not null and exists (
    select 1 from public.organization_members om
     where om.organization_id = p_org and om.user_id = v_m.approved_by and om.status = 'active'
       and (om.role in ('company_owner', 'company_admin')
            or (om.role = 'sales_agent' and v_m.approved_purpose = 'reply' and v_conv.assignee_id = v_m.approved_by))
  );
  -- (J38) une RÉPONSE (finalité « reply ») est couverte par un message entrant du contact dans CE fil depuis 30 jours au plus (échange
  -- à son initiative) ; ne plus contacter, suppression, entreprise et canal en pause restent contrôlés plus bas. Toute autre finalité
  -- exige toujours un consentement actif enregistré.
  v_consent := v_m.approved_purpose is not null and (
    exists (
      select 1 from public.consent_events ce
       where ce.organization_id = p_org and ce.contact_id = v_contact.id and ce.channel = v_channel.type
         and ce.purpose = v_m.approved_purpose and ce.revoked_at is null
    )
    or (v_m.approved_purpose = 'reply' and exists (
      select 1 from public.messages im
       where im.organization_id = p_org and im.conversation_id = v_m.conversation_id and im.direction = 'inbound'
         and im.received_at >= pg_catalog.now() - interval '30 days'
    ))
  );
  v_suppressed := v_recipient is not null and exists (
    select 1 from public.suppressions s
     where s.organization_id = p_org and s.channel = v_channel.type and s.value_normalized = v_recipient
  );
  -- compteur de débit sérialisé par canal (deux workers ne lisent pas le même nombre), limité aux envois réels ou en cours
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('send-rate:' || p_org::text || ':' || v_channel.type::text, 0));
  select pg_catalog.count(*)::integer into v_recent from public.messages x
   join public.channels xc on xc.organization_id = x.organization_id and xc.id = x.channel_id
   where x.organization_id = p_org and xc.type = v_channel.type and x.direction = 'outbound'
     and ((x.status in ('accepted', 'sent', 'delivered', 'read') and x.sent_at > pg_catalog.now() - interval '1 hour')
          or (x.status = 'queued' and x.send_claimed_at > pg_catalog.now() - interval '1 hour'));
  update public.messages set send_claimed_at = pg_catalog.now() where organization_id = p_org and id = p_message;
  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'message', pg_catalog.jsonb_build_object(
      'body', v_m.body, 'approved', v_m.approved_by is not null, 'purpose', v_m.approved_purpose,
      'approver_valid', v_approver_ok,
      'approval_age_seconds', case when v_m.approved_at is null then null else pg_catalog.floor(extract(epoch from pg_catalog.now() - v_m.approved_at))::bigint end,
      'recipient_unchanged', v_m.approved_recipient is not null and v_m.approved_recipient = v_recipient
    ),
    'organization_active', v_org_status = 'active' and v_sub_status is not null and v_sub_status not in ('suspended', 'cancelled'),
    'contact', pg_catalog.jsonb_build_object('email', v_contact.email_normalized, 'phone', v_contact.phone_e164, 'do_not_contact', v_contact.do_not_contact),
    'window_open', v_window,
    'template', case when v_tpl.id is null then null else pg_catalog.jsonb_build_object(
      'status', case when exists (select 1 from public.message_templates nv where nv.organization_id = p_org and nv.channel_id = v_tpl.channel_id and nv.name = v_tpl.name and nv.language = v_tpl.language and nv.version > v_tpl.version) then 'superseded' else v_tpl.status end, 'text', v_m.template_text, 'name', v_tpl.name, 'language', v_tpl.language, 'category', v_tpl.category, 'version', v_tpl.version, 'variables', coalesce(v_m.template_variables, '[]'::jsonb)) end,
    'channel', pg_catalog.jsonb_build_object(
      'type', v_channel.type, 'status', v_channel.status, 'send_paused', v_channel.send_paused,
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status, 'account', v_account, 'gateway', v_gateway
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;
