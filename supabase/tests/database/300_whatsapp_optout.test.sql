-- J36b — Retrait de consentement WhatsApp par un mot d'arrêt : le message ENTIER doit être un mot d'arrêt ; le consentement WhatsApp est révoqué (l'e-mail intact), le numéro
-- supprimé, les envois WhatsApp en file non réclamés annulés avec leurs jobs ; rien pour un expéditeur inconnu ni pour les autres contacts et entreprises. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea700000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@oo.test', now()
    from generate_series(1, 2) n;
insert into public.organizations (id, name, slug) values
  ('eb700000-0000-4000-8000-00000000000a', 'OO Alpha', 'oo-alpha-test'),
  ('eb700000-0000-4000-8000-00000000000b', 'OO Beta', 'oo-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb700000-0000-4000-8000-00000000000a', 'ea700000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb700000-0000-4000-8000-00000000000b', 'ea700000-0000-4000-8000-000000000002', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb700000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb700000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec700000-0000-4000-8000-0000000000a1', 'eb700000-0000-4000-8000-00000000000a', 'K1', 'k1@oo.test', 'k1@oo.test', '+212600000001'),
  ('ec700000-0000-4000-8000-0000000000a2', 'eb700000-0000-4000-8000-00000000000a', 'K2', 'k2@oo.test', 'k2@oo.test', '+212600000002'),
  ('ec700000-0000-4000-8000-0000000000b1', 'eb700000-0000-4000-8000-00000000000b', 'KB', 'kb@oo.test', 'kb@oo.test', '+212600000001');
insert into public.integrations (id, organization_id, provider, status, external_account_id) values
  ('ee700000-0000-4000-8000-000000000001', 'eb700000-0000-4000-8000-00000000000a', 'whatsapp', 'active', '900000000000001'),
  ('ee700000-0000-4000-8000-000000000002', 'eb700000-0000-4000-8000-00000000000b', 'whatsapp', 'active', '900000000000002');
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status) values
  ('ef700000-0000-4000-8000-000000000001', 'eb700000-0000-4000-8000-00000000000a', 'whatsapp', 'ee700000-0000-4000-8000-000000000001', '+15550000001', 'active'),
  ('ef700000-0000-4000-8000-000000000002', 'eb700000-0000-4000-8000-00000000000b', 'whatsapp', 'ee700000-0000-4000-8000-000000000002', '+15550000002', 'active');
-- consentements : k1 (WhatsApp et e-mail), k2 (WhatsApp), kb (WhatsApp)
insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values
  ('eb700000-0000-4000-8000-00000000000a', 'ec700000-0000-4000-8000-0000000000a1', 'whatsapp', 'marketing', 'form'),
  ('eb700000-0000-4000-8000-00000000000a', 'ec700000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'form'),
  ('eb700000-0000-4000-8000-00000000000a', 'ec700000-0000-4000-8000-0000000000a2', 'whatsapp', 'marketing', 'form'),
  ('eb700000-0000-4000-8000-00000000000b', 'ec700000-0000-4000-8000-0000000000b1', 'whatsapp', 'marketing', 'form');

create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
grant execute on function pg_temp.as_service() to public;

-- mots d'arrêt : le message ENTIER seulement
select is(private.is_stop_keyword('STOP'), true, 'STOP');
select is(private.is_stop_keyword('  stop. '), true, 'stop avec espaces et point final');
select is(private.is_stop_keyword('Stop!!'), true, 'Stop avec ponctuation');
select is(private.is_stop_keyword('Arrêt'), true, 'Arrêt');
select is(private.is_stop_keyword('désabonner'), true, 'désabonner');
select is(private.is_stop_keyword('إيقاف'), true, 'إيقاف');
-- variantes de forme : marques invisibles, ponctuation, émoji, largeur pleine, espaces, formes décomposées
select is(private.is_stop_keyword(U&'STOP\200F'), true, 'STOP suivi d''une marque bidi (RLM)');
select is(private.is_stop_keyword(U&'\200ESTOP'), true, 'marque LRM avant STOP');
select is(private.is_stop_keyword(U&'\200BSTOP\200B'), true, 'espaces de largeur nulle autour de STOP');
select is(private.is_stop_keyword(E'\n\tSTOP'), true, 'saut de ligne et tabulation avant STOP');
select is(private.is_stop_keyword('*STOP*'), true, '*STOP*');
select is(private.is_stop_keyword('"STOP"'), true, '« STOP » entre guillemets');
select is(private.is_stop_keyword(U&'STOP \+01F6D1'), true, 'STOP suivi d''un émoji');
select is(private.is_stop_keyword('ＳＴＯＰ'), true, 'largeur pleine (NFKC)');
select is(private.is_stop_keyword('S T O P'), true, 'S T O P');
select is(private.is_stop_keyword('stop   all'), true, 'espaces multiples');
select is(private.is_stop_keyword('Stop promotions'), true, 'libellé de bouton « Stop promotions »');
select is(private.is_stop_keyword('END'), true, 'END (CTIA)');
select is(private.is_stop_keyword('quit'), true, 'quit');
select is(private.is_stop_keyword('arrête'), true, 'arrête');
select is(private.is_stop_keyword('Se désabonner'), true, 'Se désabonner');
select is(private.is_stop_keyword('إلغاء الاشتراك'), true, 'إلغاء الاشتراك');
select is(private.is_stop_keyword(U&'arr\0065\0302t'), true, 'Arrêt en forme décomposée (NFD)');
select is(private.is_stop_keyword('cancel my order'), false, 'cancel my order : une phrase');
select is(private.is_stop_keyword('end of the month'), false, 'end of the month : une phrase');
select is(private.is_stop_keyword('please stop sending me this'), false, 'une phrase qui CONTIENT stop n''est pas un mot d''arrêt');
select is(private.is_stop_keyword('stopping'), false, 'stopping non plus');
select is(private.is_stop_keyword(''), false, 'vide');
select is(private.is_stop_keyword(null), false, 'nul');
select is(has_function_privilege('service_role', 'private.whatsapp_opt_out(uuid, uuid, uuid, text, uuid)', 'execute'), false, 'le retrait n''est pas exécutable directement (seulement via la réception)');

-- fil de k1 et messages sortants : m1 en file non réclamé (annulé), m2 en file DÉJÀ réclamé (conservé)
select private.conversation_get_or_create('eb700000-0000-4000-8000-00000000000a', 'ec700000-0000-4000-8000-0000000000a1', 'ef700000-0000-4000-8000-000000000001');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
insert into fx select 'conv1', id from public.conversations where contact_id = 'ec700000-0000-4000-8000-0000000000a1';
select private.message_record('eb700000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M1', 'envoi-oo-0001', null);
select private.message_record('eb700000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M2', 'envoi-oo-0002', null);
insert into fx select 'm' || right(idempotency_key, 1), id from public.messages where idempotency_key ~ 'envoi-oo-000[12]$';
update public.messages set approved_by = 'ea700000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = '+212600000001' where id in (select v from fx where k in ('m1', 'm2'));
update public.messages set send_claimed_at = now() where id = (select v from fx where k = 'm2');
select private.enqueue_job('eb700000-0000-4000-8000-00000000000a', 'send_message', jsonb_build_object('message_id', (select v from fx where k = 'm1')), 'send-message:oo1', null, 5);
select private.enqueue_job('eb700000-0000-4000-8000-00000000000a', 'send_message', jsonb_build_object('message_id', (select v from fx where k = 'm2')), 'send-message:oo2', null, 5);

-- un message ordinaire ne retire rien
select pg_temp.as_service();
create temp table res (k text, r jsonb);
grant all on res to public;
insert into res select 'normal', public.whatsapp_inbound_apply('eb700000-0000-4000-8000-00000000000a', 'ee700000-0000-4000-8000-000000000001', 'wamid.OO0', '+212600000001', 'text', 'Je veux arrêter de payer mais pas de recevoir vos offres', null);
reset role;
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000a1' and channel = 'whatsapp' and revoked_at is null), 1, 'phrase ordinaire : consentement intact');
select is((select count(*)::int from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a'), 0, 'phrase ordinaire : aucune suppression');

-- STOP d'un expéditeur inconnu : aucun contact, aucune suppression
select pg_temp.as_service();
insert into res select 'unknown', public.whatsapp_inbound_apply('eb700000-0000-4000-8000-00000000000a', 'ee700000-0000-4000-8000-000000000001', 'wamid.OOU', '+212699999999', 'text', 'STOP', null);
reset role;
select is((select r ->> 'reason' from res where k = 'unknown'), 'unknown_sender', 'STOP d''un inconnu : file de tri');
select is((select count(*)::int from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a' and value_normalized = '+212699999999' and source_message_id is null), 1, 'STOP d''un inconnu : le NUMÉRO seul est supprimé');
select is((select count(*)::int from public.contacts where phone_e164 = '+212699999999'), 0, 'STOP d''un inconnu : aucun contact créé');

-- STOP de k1
select pg_temp.as_service();
insert into res select 'stop', public.whatsapp_inbound_apply('eb700000-0000-4000-8000-00000000000a', 'ee700000-0000-4000-8000-000000000001', 'wamid.OO1', '+212600000001', 'text', 'STOP', null);
reset role;
select is((select r ->> 'outcome' from res where k = 'stop'), 'recorded', 'le STOP est enregistré comme message');
select is((select (r ->> 'opt_out')::boolean from res where k = 'stop'), true, 'et déclenche le retrait');
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000a1' and channel = 'whatsapp' and revoked_at is null), 0, 'consentement WhatsApp révoqué');
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000a1' and channel = 'email' and revoked_at is null), 1, 'consentement e-mail INTACT');
select is((select value_normalized || ':' || reason from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a' and channel = 'whatsapp' and value_normalized = '+212600000001'), '+212600000001:unsubscribe', 'numéro supprimé (raison unsubscribe)');
select is((select do_not_contact from public.contacts where id = 'ec700000-0000-4000-8000-0000000000a1'), false, 'do_not_contact inchangé');
select is((select status from public.messages where id = (select v from fx where k = 'm1')), 'cancelled', 'message en file non réclamé : annulé');
select is((select status from public.jobs where idempotency_key = 'send-message:oo1'), 'cancelled', 'son job est annulé');
select is((select status from public.messages where id = (select v from fx where k = 'm2')), 'queued', 'message déjà réclamé : conservé (le contrôle final le refusera)');
select is((select status from public.jobs where idempotency_key = 'send-message:oo2'), 'queued', 'son job reste en file');

-- les autres contacts et entreprises ne bougent pas ; rejeu sans second effet ; audit sans numéro ni texte
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000a2' and revoked_at is null), 1, 'k2 : consentement intact');
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000b1' and revoked_at is null), 1, 'autre entreprise (même numéro) : consentement intact');
select pg_temp.as_service();
delete from res;
insert into res select 'again', public.whatsapp_inbound_apply('eb700000-0000-4000-8000-00000000000a', 'ee700000-0000-4000-8000-000000000001', 'wamid.OO1', '+212600000001', 'text', 'STOP', null);
reset role;
select is((select r ->> 'outcome' from res where k = 'again'), 'duplicate', 'même message rejoué : doublon, pas de second retrait');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb700000-0000-4000-8000-00000000000a' and action = 'whatsapp.opt_out'), 1, 'un seul événement d''audit');
select pg_temp.as_service();
insert into res select 'again2', public.whatsapp_inbound_apply('eb700000-0000-4000-8000-00000000000a', 'ee700000-0000-4000-8000-000000000001', 'wamid.OO1B', '+212600000001', 'text', 'STOP', null);
reset role;
select is((select count(*)::int from public.audit_logs where organization_id = 'eb700000-0000-4000-8000-00000000000a' and action = 'whatsapp.opt_out'), 1, 'un STOP répété (rien à changer) n''écrit pas d''audit');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb700000-0000-4000-8000-00000000000a' and (coalesce(before::text, '') || coalesce(after::text, '')) ~* '212600000001|STOP'), 0, 'ni numéro ni texte dans l''audit');

-- l'envoi suivant est refusé à la réclamation
select private.message_record('eb700000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M3 apres STOP', 'envoi-oo-0003', null);
update public.messages set approved_by = 'ea700000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = '+212600000001' where idempotency_key = 'envoi-oo-0003';
select pg_temp.as_service();
delete from res;
insert into res select 'claim', public.message_send_claim('eb700000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'envoi-oo-0003'));
reset role;
select is((select (r ->> 'consent')::boolean from res where k = 'claim'), false, 'réclamation suivante : plus de consentement');
select is((select (r ->> 'suppressed')::boolean from res where k = 'claim'), true, 'réclamation suivante : numéro supprimé');

select * from finish();
rollback;
