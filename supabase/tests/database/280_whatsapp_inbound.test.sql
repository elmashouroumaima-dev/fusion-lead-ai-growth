-- J35 — Réception WhatsApp : `whatsapp_inbound_apply` et `whatsapp_status_apply` (service_role seulement). Un message est rattaché au contact par son numéro dans le
-- canal WhatsApp de l'intégration, jamais de contact créé, déduplication par identifiant Meta, file de tri pour les cas ambigus ; les statuts n'avancent que dans
-- l'ordre et restent dans l'entreprise et l'intégration authentifiées. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea500000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@wi.test', now()
    from generate_series(1, 2) n;
insert into public.organizations (id, name, slug) values
  ('eb500000-0000-4000-8000-00000000000a', 'WI Alpha', 'wi-alpha-test'),
  ('eb500000-0000-4000-8000-00000000000b', 'WI Beta', 'wi-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb500000-0000-4000-8000-00000000000a', 'ea500000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb500000-0000-4000-8000-00000000000b', 'ea500000-0000-4000-8000-000000000002', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb500000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb500000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec500000-0000-4000-8000-0000000000a1', 'eb500000-0000-4000-8000-00000000000a', 'K1', 'k1@wi.test', 'k1@wi.test', '+212600000001'),
  ('ec500000-0000-4000-8000-0000000000b1', 'eb500000-0000-4000-8000-00000000000b', 'KB', 'kb@wi.test', 'kb@wi.test', '+212600000001');
insert into public.integrations (id, organization_id, provider, status, external_account_id) values
  ('ee500000-0000-4000-8000-000000000001', 'eb500000-0000-4000-8000-00000000000a', 'whatsapp', 'active', '700000000000001'),
  ('ee500000-0000-4000-8000-000000000002', 'eb500000-0000-4000-8000-00000000000a', 'whatsapp', 'active', '700000000000002'),
  ('ee500000-0000-4000-8000-000000000003', 'eb500000-0000-4000-8000-00000000000a', 'whatsapp', 'active', '700000000000003'),
  ('ee500000-0000-4000-8000-000000000004', 'eb500000-0000-4000-8000-00000000000b', 'whatsapp', 'active', '700000000000004'),
  ('ee500000-0000-4000-8000-000000000005', 'eb500000-0000-4000-8000-00000000000a', 'email', 'active', 'wi-mail-a');
-- 001 : un canal ; 002 : aucun canal ; 003 : deux canaux ; 004 (Beta) : un canal
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status) values
  ('ef500000-0000-4000-8000-000000000001', 'eb500000-0000-4000-8000-00000000000a', 'whatsapp', 'ee500000-0000-4000-8000-000000000001', '+15550000001', 'active'),
  ('ef500000-0000-4000-8000-000000000003', 'eb500000-0000-4000-8000-00000000000a', 'whatsapp', 'ee500000-0000-4000-8000-000000000003', '+15550000003', 'active'),
  ('ef500000-0000-4000-8000-000000000033', 'eb500000-0000-4000-8000-00000000000a', 'whatsapp', 'ee500000-0000-4000-8000-000000000003', '+15550000033', 'active'),
  ('ef500000-0000-4000-8000-000000000004', 'eb500000-0000-4000-8000-00000000000b', 'whatsapp', 'ee500000-0000-4000-8000-000000000004', '+15550000004', 'active');

create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end $f$;
grant execute on function pg_temp.as_service(), pg_temp.as_user(text), pg_temp.as_anon() to public;

-- droits
select is(has_function_privilege('service_role', 'public.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz)', 'execute'), true, 'inbound : service_role peut');
select is(has_function_privilege('authenticated', 'public.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz)', 'execute'), false, 'inbound : authenticated ne peut pas');
select is(has_function_privilege('anon', 'public.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz)', 'execute'), false, 'status : anon ne peut pas');
select is(has_function_privilege('authenticated', 'public.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz)', 'execute'), false, 'status : authenticated ne peut pas');
select pg_temp.as_user('ea500000-0000-4000-8000-000000000001');
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.X', '+212600000001', 'text', 'x', null)$$, '42501', null, 'un owner connecté ne peut pas injecter un message');
reset role;

-- entrées invalides et intégrations interdites
select pg_temp.as_service();
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'pas valide !', '+212600000001', 'text', 'x', null)$$, '22023', null, 'identifiant de message invalide');
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.X', '212600000001', 'text', 'x', null)$$, '22023', null, 'numéro sans + refusé');
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.X', '+212600000001', 'Texte', 'x', null)$$, '22023', null, 'type invalide');
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.X', '+212600000001', 'text', repeat('a', 4097), null)$$, '22023', null, 'texte trop long');
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000b', 'ee500000-0000-4000-8000-000000000001', 'wamid.X', '+212600000001', 'text', 'x', null)$$, 'PT404', null, 'l''intégration d''une autre entreprise est introuvable');
select throws_ok($$select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000005', 'wamid.X', '+212600000001', 'text', 'x', null)$$, 'PT404', null, 'une intégration e-mail n''est pas une intégration WhatsApp');
select throws_ok($$select public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.X', 'deleted', null, null)$$, '22023', null, 'statut inconnu refusé');
reset role;

-- réception : contact connu
select pg_temp.as_service();
create temp table res (r jsonb);
grant all on res to public;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.AAA', '+212600000001', 'text', 'Bonjour, je suis intéressé', '2026-11-13 10:00:00+00');
reset role;
select is((select r ->> 'outcome' from res), 'recorded', 'message d''un contact connu : recorded');
select is((select count(*)::int from public.messages where organization_id = 'eb500000-0000-4000-8000-00000000000a' and provider_message_id = 'wamid.AAA' and direction = 'inbound'), 1, 'un message entrant enregistré');
select is((select body from public.messages where provider_message_id = 'wamid.AAA' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), 'Bonjour, je suis intéressé', 'corps enregistré');
select is((select c.contact_id from public.messages m join public.conversations c on c.id = m.conversation_id where m.provider_message_id = 'wamid.AAA' and m.organization_id = 'eb500000-0000-4000-8000-00000000000a'), 'ec500000-0000-4000-8000-0000000000a1'::uuid, 'rattaché au contact de l''entreprise A (pas à celui de Beta qui a le même numéro)');
select is((select count(*)::int from public.messages where organization_id = 'eb500000-0000-4000-8000-00000000000b'), 0, 'rien chez Beta');

-- déduplication
select pg_temp.as_service();
delete from res;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.AAA', '+212600000001', 'text', 'Bonjour, je suis intéressé', null);
reset role;
select is((select r ->> 'outcome' from res), 'duplicate', 'même identifiant Meta : duplicate');
select is((select count(*)::int from public.messages where provider_message_id = 'wamid.AAA' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), 1, 'toujours un seul message');

-- non textuel : seul le type est conservé
select pg_temp.as_service();
delete from res;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.IMG', '+212600000001', 'image', null, null);
reset role;
select is((select body from public.messages where provider_message_id = 'wamid.IMG' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), '[image]', 'message non textuel : « [image] »');

-- cas de tri : expéditeur inconnu, pas de canal, canaux multiples
select pg_temp.as_service();
delete from res;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.UNK', '+212699999999', 'text', 'Qui êtes-vous', null);
reset role;
select is((select r ->> 'reason' from res), 'unknown_sender', 'expéditeur inconnu : file de tri');
select is((select count(*)::int from public.contacts where phone_e164 = '+212699999999'), 0, 'AUCUN contact créé');
select is((select count(*)::int from public.inbound_unmatched where provider_message_id = 'wamid.UNK' and status = 'pending'), 1, 'message rangé dans la file de tri');
select pg_temp.as_service();
delete from res;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000002', 'wamid.NOCH', '+212600000001', 'text', 'x', null);
reset role;
select is((select r ->> 'reason' from res), 'no_channel', 'intégration sans canal : no_channel');
select pg_temp.as_service();
delete from res;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000003', 'wamid.AMB', '+212600000001', 'text', 'x', null);
reset role;
select is((select r ->> 'reason' from res), 'ambiguous_channel', 'deux canaux : ambiguous_channel (aucun choix au hasard)');
select pg_temp.as_service();
delete from res;
insert into res select public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.UNK', '+212699999999', 'text', 'Qui êtes-vous', null);
reset role;
select is((select r ->> 'outcome' from res), 'duplicate', 'rejeu d''un message en file de tri : duplicate');

-- audit : aucun corps de message ni numéro
select is((select count(*)::int from public.audit_logs where organization_id = 'eb500000-0000-4000-8000-00000000000a' and (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'intéressé|Qui êtes|212600000001|212699999999'), 0, 'ni corps ni numéro dans l''audit');

-- statuts : message sortant accepté (k1, intégration 001)
select private.conversation_get_or_create('eb500000-0000-4000-8000-00000000000a', 'ec500000-0000-4000-8000-0000000000a1', 'ef500000-0000-4000-8000-000000000001');
select private.message_record('eb500000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec500000-0000-4000-8000-0000000000a1' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), 'outbound', null, 'Offre 1', 'envoi-wi-0001', null);
select private.message_record('eb500000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec500000-0000-4000-8000-0000000000a1' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), 'outbound', null, 'Offre 2', 'envoi-wi-0002', null);
select private.message_record('eb500000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec500000-0000-4000-8000-0000000000a1' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), 'outbound', null, 'Offre 3', 'envoi-wi-0003', null);
update public.messages set approved_by = 'ea500000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@wi.test',
  status = 'accepted', provider_message_id = 'wamid.OUT' || right(idempotency_key, 1), send_claimed_at = now(), sent_at = now()
 where idempotency_key in ('envoi-wi-0001', 'envoi-wi-0002', 'envoi-wi-0003');

select pg_temp.as_service();
create temp table st (k text, r jsonb);
grant all on st to public;
insert into st select 'sent', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT1', 'sent', null, null);
insert into st select 'delivered', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT1', 'delivered', null, null);
insert into st select 'read', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT1', 'read', null, null);
insert into st select 'late_sent', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT1', 'sent', null, null);
insert into st select 'again_read', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT1', 'read', null, null);
insert into st select 'failed_after_read', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT1', 'failed', 131047, null);
reset role;
select is((select r ->> 'outcome' from st where k = 'sent'), 'applied', 'accepted → sent');
select is((select r ->> 'outcome' from st where k = 'delivered'), 'applied', 'sent → delivered');
select is((select r ->> 'outcome' from st where k = 'read'), 'applied', 'delivered → read');
select is((select status from public.messages where provider_message_id = 'wamid.OUT1'), 'read', 'statut final : read');
select is((select r ->> 'reason' from st where k = 'late_sent'), 'out_of_order', 'un « sent » tardif après « read » est ignoré (hors ordre)');
select is((select r ->> 'reason' from st where k = 'again_read'), 'already_applied', 'statut rejoué : ignoré');
select is((select r ->> 'reason' from st where k = 'failed_after_read'), 'status_conflict', 'failed après read : ignoré');
select is((select status from public.messages where provider_message_id = 'wamid.OUT1'), 'read', 'le message lu n''est pas rétrogradé');

-- hors ordre dès le départ : delivered avant sent
select pg_temp.as_service();
delete from st;
insert into st select 'delivered', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT2', 'delivered', null, null);
insert into st select 'sent_after', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT2', 'sent', null, null);
insert into st select 'failed', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT3', 'failed', 131047, null);
insert into st select 'unknown', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.INCONNU', 'read', null, null);
insert into st select 'other_integration', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000003', 'wamid.OUT2', 'read', null, null);
reset role;
select is((select status from public.messages where provider_message_id = 'wamid.OUT2'), 'delivered', 'delivered avant sent : appliqué, le sent tardif est ignoré');
select is((select r ->> 'reason' from st where k = 'sent_after'), 'out_of_order', 'sent après delivered : hors ordre');
select is((select error_code from public.messages where provider_message_id = 'wamid.OUT3'), 'wa_131047', 'failed : code numérique de Meta (wa_<code>), jamais son texte');
select is((select r ->> 'reason' from st where k = 'unknown'), 'message_not_found', 'identifiant inconnu : ignoré');
select is((select r ->> 'reason' from st where k = 'other_integration'), 'message_not_found', 'un message n''est jamais atteint par une AUTRE intégration, même de la même entreprise');

-- Meta ne garantit pas l'ordre : un « failed » de Meta suivi d'un vrai « delivered » est corrigé (et l'erreur effacée)
select pg_temp.as_service();
delete from st;
insert into st select 'recover', public.whatsapp_inbound_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.FUT', '+212600000001', 'text', 'Message futur', now() + interval '10 days');
insert into st select 'recover2', public.whatsapp_status_apply('eb500000-0000-4000-8000-00000000000a', 'ee500000-0000-4000-8000-000000000001', 'wamid.OUT3', 'delivered', null, null);
reset role;
select is((select r ->> 'outcome' from st where k = 'recover2'), 'applied', 'failed puis delivered : corrigé');
select is((select status from public.messages where provider_message_id = 'wamid.OUT3'), 'delivered', 'le message est « delivered »');
select is((select error_code from public.messages where provider_message_id = 'wamid.OUT3'), null, 'l''erreur de Meta est effacée');
select ok((select created_at <= now() from public.messages where provider_message_id = 'wamid.FUT' and organization_id = 'eb500000-0000-4000-8000-00000000000a'), 'un horodatage futur du fournisseur est ramené à maintenant');

select * from finish();
rollback;
