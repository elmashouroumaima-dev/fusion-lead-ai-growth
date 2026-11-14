-- J36 — Envoi WhatsApp conforme (spec §9.3 et §13-6, ADR 007 E5, plan J36).
--
--  * `message_templates` (ADR 007 E5) : modèles de message WhatsApp d'un canal (nom, langue, catégorie, version, statut, composants). Écriture par fonctions seulement :
--    `message_templates_sync` (service_role : la liste de Meta) ; une nouvelle version naît quand les composants changent ; seuls les modèles `approved` s'utilisent.
--  * `messages.template_id` et `template_variables` : le modèle (donc nom, langue et version) et ses variables sont enregistrés AVANT l'approbation (`message_attach_template`,
--    owner et admin) et deviennent immuables avec elle ; le modèle doit appartenir au canal du message et être approuvé.
--  * `message_approve` : l'approbation couvre UNE adresse, l'e-mail pour un canal e-mail, le numéro (E.164) pour un canal WhatsApp.
--  * `message_send_claim` : relit en plus le destinataire du canal, la FENÊTRE DE CONVERSATION (le contact a écrit il y a moins de 24 h dans ce fil), le modèle et le compte
--    du fournisseur ; hors fenêtre, le contrôle final exige un modèle approuvé (`template_missing`).
--  * `whatsapp_status_apply` : un statut reçu avant l'enregistrement de l'envoi (identifiant Meta pas encore connu) est réessayé pendant 5 minutes au lieu d'être perdu.
--  * `messages_guard` : le modèle, ses variables et son texte rendu sont immuables après l'approbation.
--  * un modèle remplacé par une version PLUS RÉCENTE (même canal, nom, langue) est vu `superseded` par la réclamation : l'envoi est refusé (ce qui part est la dernière version chez Meta, pas celle approuvée).

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  channel_id uuid not null,
  provider text not null default 'whatsapp',
  name text not null,
  version integer not null default 1,
  language text not null,
  category text not null,
  status text not null,
  components jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint message_templates_org_id_key unique (organization_id, id),
  constraint message_templates_channel_fkey foreign key (organization_id, channel_id)
    references public.channels (organization_id, id) on delete restrict,
  constraint message_templates_key unique (organization_id, channel_id, name, language, version),
  constraint message_templates_provider_valid check (provider = 'whatsapp'),
  constraint message_templates_name_valid check (name ~ '^[a-z0-9_]{1,200}$'),
  constraint message_templates_language_valid check (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  constraint message_templates_category_valid check (category in ('marketing', 'utility', 'authentication')),
  constraint message_templates_status_valid check (status in ('pending', 'approved', 'rejected', 'paused')),
  constraint message_templates_version_valid check (version between 1 and 1000),
  constraint message_templates_components_valid check (pg_catalog.jsonb_typeof(components) = 'array' and pg_catalog.char_length(components::text) <= 16384)
);
create index message_templates_lookup_idx on public.message_templates (organization_id, channel_id, name, language, version desc);
comment on table public.message_templates is 'Modèles de message WhatsApp (ADR 007 E5, J36). Écriture par fonctions seulement ; lecture owner, admin et marketing.';
create trigger message_templates_set_updated_at before update on public.message_templates for each row execute function private.set_updated_at();
create trigger message_templates_org_immutable before update on public.message_templates for each row execute function private.prevent_organization_id_change();
alter table public.message_templates enable row level security;
revoke all on table public.message_templates from authenticated, anon;
revoke insert, update, delete, truncate on table public.message_templates from service_role;
grant select on table public.message_templates to authenticated;
create policy message_templates_select on public.message_templates
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]));

alter table public.messages
  add column template_id uuid,
  add column template_variables jsonb,
  add column template_text text;
alter table public.messages
  add constraint messages_template_fkey foreign key (organization_id, template_id) references public.message_templates (organization_id, id) on delete restrict,
  add constraint messages_template_shape check (
    template_variables is null
    or (template_id is not null and pg_catalog.jsonb_typeof(template_variables) = 'array' and pg_catalog.jsonb_array_length(template_variables) <= 10
        and pg_catalog.char_length(template_variables::text) <= 8000)
  ),
  add constraint messages_template_text_valid check (template_text is null or (template_id is not null and pg_catalog.char_length(template_text) between 1 and 4096)),
  add constraint messages_template_outbound check (template_id is null or direction = 'outbound');

-- Garde des messages : le modèle et ses variables sont immuables après l'approbation.
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
  if old.approved_by is not null and (new.template_id is distinct from old.template_id or new.template_variables is distinct from old.template_variables or new.template_text is distinct from old.template_text) then
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

-- Approbation : l'adresse approuvée est celle du canal (e-mail ou numéro).
create or replace function private.message_approve(p_org uuid, p_message uuid, p_purpose text)
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
  select case when ch.type = 'whatsapp' then ct.phone_e164 else ct.email_normalized end into v_email
    from public.conversations c join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
    join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id
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

-- Réclamation : destinataire du canal, fenêtre de conversation, modèle, compte du fournisseur.
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
  select i.status, i.external_account_id into v_integration_status, v_account from public.integrations i where i.organization_id = p_org and i.id = v_channel.integration_id;
  v_recipient := case when v_channel.type = 'whatsapp' then v_contact.phone_e164 else v_contact.email_normalized end;
  -- fenêtre de conversation WhatsApp : ouverte si le contact a écrit il y a moins de 24 heures dans ce fil
  v_window := exists (select 1 from public.messages x where x.organization_id = p_org and x.conversation_id = v_m.conversation_id and x.direction = 'inbound' and x.received_at > pg_catalog.now() - interval '24 hours');
  if v_m.template_id is not null then
    select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = v_m.template_id;
  end if;
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
  v_suppressed := v_recipient is not null and exists (
    select 1 from public.suppressions s
     where s.organization_id = p_org and s.channel = v_channel.type and s.value_normalized = v_recipient
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
      'recipient_unchanged', v_m.approved_recipient is not null and v_m.approved_recipient = v_recipient
    ),
    'organization_active', v_org_status = 'active' and v_sub_status is not null and v_sub_status not in ('suspended', 'cancelled'),
    'contact', pg_catalog.jsonb_build_object('email', v_contact.email_normalized, 'phone', v_contact.phone_e164, 'do_not_contact', v_contact.do_not_contact),
    'window_open', v_window,
    'template', case when v_tpl.id is null then null else pg_catalog.jsonb_build_object(
      'status', case when exists (select 1 from public.message_templates nv where nv.organization_id = p_org and nv.channel_id = v_tpl.channel_id and nv.name = v_tpl.name and nv.language = v_tpl.language and nv.version > v_tpl.version) then 'superseded' else v_tpl.status end, 'text', v_m.template_text, 'name', v_tpl.name, 'language', v_tpl.language, 'category', v_tpl.category, 'version', v_tpl.version, 'variables', coalesce(v_m.template_variables, '[]'::jsonb)) end,
    'channel', pg_catalog.jsonb_build_object(
      'type', v_channel.type, 'status', v_channel.status, 'send_paused', v_channel.send_paused,
      'sender', v_channel.sender_identity, 'integration_id', v_channel.integration_id, 'integration_status', v_integration_status, 'account', v_account
    ),
    'organization_send_paused', v_org_paused,
    'consent', v_consent,
    'suppressed', v_suppressed,
    'sent_last_hour', v_recent
  );
end;
$$;

-- Statut reçu avant l'enregistrement de l'envoi : réessayé.
create or replace function private.whatsapp_status_apply(
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
    -- un envoi de cette intégration est EN COURS (réclamé il y a moins de 5 minutes, identifiant Meta pas encore enregistré) : le statut peut l'avoir devancé, le job est rejoué
    if exists (select 1 from public.messages q join public.channels qc on qc.organization_id = q.organization_id and qc.id = q.channel_id
                where q.organization_id = p_org and qc.integration_id = p_integration and q.direction = 'outbound' and q.status = 'queued'
                  and q.send_claimed_at > pg_catalog.now() - interval '5 minutes') then
      raise exception 'retry_later' using errcode = 'P0001';
    end if;
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

-- Rattache un modèle approuvé (et ses variables) à un message sortant en file, AVANT l'approbation (owner et admin).
-- Codes : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 · not_found PT404 · P0001 : message_not_attachable | template_not_usable
create function private.message_attach_template(p_org uuid, p_message uuid, p_template uuid, p_variables jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.messages;
  v_tpl public.message_templates;
  v_text text;
  v_i integer;
begin
  perform private.assert_project_manager(p_org);
  if p_template is null or p_variables is null or pg_catalog.jsonb_typeof(p_variables) <> 'array' or pg_catalog.jsonb_array_length(p_variables) > 10
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_variables) e where pg_catalog.jsonb_typeof(e) <> 'string' or pg_catalog.char_length(e #>> '{}') not between 1 and 1024 or (e #>> '{}') ~ '[[:cntrl:]]') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.messages m where m.organization_id = p_org and m.id = p_message for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.direction <> 'outbound' or v_row.status <> 'queued' or v_row.approved_by is not null or v_row.send_claimed_at is not null then
    raise exception 'message_not_attachable' using errcode = 'P0001';
  end if;
  -- le modèle appartient au canal du message et est approuvé
  if v_tpl.channel_id <> v_row.channel_id or v_tpl.status <> 'approved' then
    raise exception 'template_not_usable' using errcode = 'P0001';
  end if;
  -- le texte RENDU (corps du modèle + variables) est enregistré : c'est ce que l'approbateur relit et ce que le destinataire recevra
  select c ->> 'text' into v_text from pg_catalog.jsonb_array_elements(v_tpl.components) c where pg_catalog.upper(c ->> 'type') = 'BODY' limit 1;
  if v_text is null or pg_catalog.char_length(v_text) = 0 then
    raise exception 'template_not_usable' using errcode = 'P0001';
  end if;
  for v_i in 1 .. pg_catalog.jsonb_array_length(p_variables) loop
    v_text := pg_catalog.replace(v_text, '{{' || v_i || '}}', p_variables ->> (v_i - 1));
  end loop;
  v_text := pg_catalog.left(v_text, 4096);
  update public.messages set template_id = p_template, template_variables = p_variables, template_text = v_text where organization_id = p_org and id = p_message;
  perform private.audit_write(p_org, 'message.template_attached', 'message', p_message, null,
    pg_catalog.jsonb_build_object('template_id', p_template, 'name', v_tpl.name, 'language', v_tpl.language, 'version', v_tpl.version));
end;
$$;

-- Synchronise les modèles d'un canal avec la liste de Meta (service_role). `p_items` : 200 éléments au plus {name, language, category, status, components}.
-- Une nouvelle VERSION naît quand les composants changent (l'ancienne reste, historique) ; sinon seuls la catégorie et le statut sont mis à jour.
-- Résultat : {inserted, updated, unchanged}. Codes : validation_failed 22023 · not_found PT404 · P0001 too_many_templates (2000 par canal).
create function private.message_templates_sync(p_org uuid, p_channel uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_last public.message_templates;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
begin
  if p_org is null or p_channel is null or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) > 200 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform 1 from public.channels ch where ch.organization_id = p_org and ch.id = p_channel and ch.type = 'whatsapp';
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('templates-sync:' || p_channel::text, 0));
  for v_item in select e from pg_catalog.jsonb_array_elements(p_items) e loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (v_item ->> 'name') is null or (v_item ->> 'name') !~ '^[a-z0-9_]{1,200}$'
       or (v_item ->> 'language') is null or (v_item ->> 'language') !~ '^[a-z]{2}(_[A-Z]{2})?$'
       or (v_item ->> 'category') is null or (v_item ->> 'category') not in ('marketing', 'utility', 'authentication')
       or (v_item ->> 'status') is null or (v_item ->> 'status') not in ('pending', 'approved', 'rejected', 'paused')
       or pg_catalog.jsonb_typeof(coalesce(v_item -> 'components', '[]'::jsonb)) <> 'array'
       or pg_catalog.char_length(coalesce(v_item -> 'components', '[]'::jsonb)::text) > 16384 then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
    select * into v_last from public.message_templates t
     where t.organization_id = p_org and t.channel_id = p_channel and t.name = v_item ->> 'name' and t.language = v_item ->> 'language'
     order by t.version desc limit 1;
    if not found then
      if (select pg_catalog.count(*) from public.message_templates t where t.organization_id = p_org and t.channel_id = p_channel) >= 2000 then
        raise exception 'too_many_templates' using errcode = 'P0001';
      end if;
      insert into public.message_templates (organization_id, channel_id, name, version, language, category, status, components)
      values (p_org, p_channel, v_item ->> 'name', 1, v_item ->> 'language', v_item ->> 'category', v_item ->> 'status', coalesce(v_item -> 'components', '[]'::jsonb));
      v_inserted := v_inserted + 1;
    elsif v_last.components is distinct from coalesce(v_item -> 'components', '[]'::jsonb) then
      if v_last.version >= 1000 then
        raise exception 'too_many_templates' using errcode = 'P0001';
      end if;
      if (select pg_catalog.count(*) from public.message_templates t where t.organization_id = p_org and t.channel_id = p_channel) >= 2000 then
        raise exception 'too_many_templates' using errcode = 'P0001';
      end if;
      insert into public.message_templates (organization_id, channel_id, name, version, language, category, status, components)
      values (p_org, p_channel, v_item ->> 'name', v_last.version + 1, v_item ->> 'language', v_item ->> 'category', v_item ->> 'status', coalesce(v_item -> 'components', '[]'::jsonb));
      v_inserted := v_inserted + 1;
    elsif v_last.status is distinct from v_item ->> 'status' or v_last.category is distinct from v_item ->> 'category' then
      update public.message_templates set status = v_item ->> 'status', category = v_item ->> 'category' where organization_id = p_org and id = v_last.id;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;
  perform private.audit_write(p_org, 'templates.synced', 'channel', p_channel, null,
    pg_catalog.jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged));
  return pg_catalog.jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged);
end;
$$;

revoke all on function private.message_attach_template(uuid, uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.message_templates_sync(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.message_attach_template(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function private.message_templates_sync(uuid, uuid, jsonb) to service_role;

create function public.message_attach_template(p_org uuid, p_message uuid, p_template uuid, p_variables jsonb)
returns void language sql security invoker set search_path = ''
as $$ select private.message_attach_template(p_org, p_message, p_template, p_variables); $$;
create function public.message_templates_sync(p_org uuid, p_channel uuid, p_items jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.message_templates_sync(p_org, p_channel, p_items); $$;
revoke all on function public.message_attach_template(uuid, uuid, uuid, jsonb) from public, anon, service_role;
revoke all on function public.message_templates_sync(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.message_attach_template(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.message_templates_sync(uuid, uuid, jsonb) to service_role;
