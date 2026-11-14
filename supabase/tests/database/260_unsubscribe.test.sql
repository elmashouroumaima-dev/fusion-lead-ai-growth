-- J33 — Désabonnement : `unsubscribe_apply` (service_role seulement) révoque les consentements e-mail du contact, inscrit l'adresse dans `suppressions`,
-- annule les messages en file non réclamés et leurs jobs, sans toucher aux autres contacts, aux autres canaux ni aux autres entreprises ; idempotent ;
-- l'envoi suivant est refusé par la réclamation. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea300000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@un.test', now()
    from generate_series(1, 2) n;
insert into public.organizations (id, name, slug) values
  ('eb300000-0000-4000-8000-00000000000a', 'UN Alpha', 'un-alpha-test'),
  ('eb300000-0000-4000-8000-00000000000b', 'UN Beta', 'un-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb300000-0000-4000-8000-00000000000a', 'ea300000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb300000-0000-4000-8000-00000000000b', 'ea300000-0000-4000-8000-000000000002', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb300000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb300000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec300000-0000-4000-8000-0000000000a1', 'eb300000-0000-4000-8000-00000000000a', 'K1', 'k1@un.test', 'k1@un.test', '+212600000001'),
  ('ec300000-0000-4000-8000-0000000000a2', 'eb300000-0000-4000-8000-00000000000a', 'K2', 'k2@un.test', 'k2@un.test', null),
  ('ec300000-0000-4000-8000-0000000000b1', 'eb300000-0000-4000-8000-00000000000b', 'KB', 'kb@un.test', 'kb@un.test', null);
insert into public.integrations (id, organization_id, provider, status, external_account_id) values
  ('ee300000-0000-4000-8000-000000000001', 'eb300000-0000-4000-8000-00000000000a', 'email', 'active', 'un-mail-a'),
  ('ee300000-0000-4000-8000-000000000002', 'eb300000-0000-4000-8000-00000000000b', 'email', 'active', 'un-mail-b');
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status) values
  ('ef300000-0000-4000-8000-000000000001', 'eb300000-0000-4000-8000-00000000000a', 'email', 'ee300000-0000-4000-8000-000000000001', 'ventes@un.test', 'active'),
  ('ef300000-0000-4000-8000-000000000002', 'eb300000-0000-4000-8000-00000000000b', 'email', 'ee300000-0000-4000-8000-000000000002', 'ventes-b@un.test', 'active');
-- consentements : k1 (e-mail marketing, e-mail transactionnel, WhatsApp), k2 (e-mail marketing), kb (e-mail marketing)
insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values
  ('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'form'),
  ('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a1', 'email', 'transactional', 'form'),
  ('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a1', 'whatsapp', 'marketing', 'form'),
  ('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a2', 'email', 'marketing', 'form'),
  ('eb300000-0000-4000-8000-00000000000b', 'ec300000-0000-4000-8000-0000000000b1', 'email', 'marketing', 'form');
select private.refresh_consent_status('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a1');
select private.refresh_consent_status('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a2');
select private.refresh_consent_status('eb300000-0000-4000-8000-00000000000b', 'ec300000-0000-4000-8000-0000000000b1');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end $f$;
grant execute on function pg_temp.as_user(text), pg_temp.as_service(), pg_temp.as_anon() to public;

select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a1', 'ef300000-0000-4000-8000-000000000001');
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a2', 'ef300000-0000-4000-8000-000000000001');
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000b', 'ec300000-0000-4000-8000-0000000000b1', 'ef300000-0000-4000-8000-000000000002');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
insert into fx select 'conv1', id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a1';
insert into fx select 'conv2', id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a2';
insert into fx select 'convb', id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000b1';
-- k1 : m1 accepté (c'est son lien), m2 en file non réclamé (annulé), m3 en file DÉJÀ réclamé (conservé) ; k2 : m4 en file ; kb : m5 en file
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M1', 'envoi-un-0001', null);
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M2', 'envoi-un-0002', null);
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M3', 'envoi-un-0003', null);
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv2'), 'outbound', null, 'M4', 'envoi-un-0004', null);
select private.message_record('eb300000-0000-4000-8000-00000000000b', (select v from fx where k = 'convb'), 'outbound', null, 'M5', 'envoi-un-0005', null);
insert into fx select 'm' || right(idempotency_key, 1), id from public.messages where idempotency_key ~ 'envoi-un-000[1-5]$';
update public.messages set approved_by = 'ea300000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@un.test',
  status = 'accepted', provider_message_id = 'pm-un-1', send_claimed_at = now(), sent_at = now() where id = (select v from fx where k = 'm1');
update public.messages set approved_by = 'ea300000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@un.test'
  where id = (select v from fx where k = 'm2');
update public.messages set approved_by = 'ea300000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@un.test',
  send_claimed_at = now() where id = (select v from fx where k = 'm3');
update public.messages set approved_by = 'ea300000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k2@un.test'
  where id = (select v from fx where k = 'm4');
update public.messages set approved_by = 'ea300000-0000-4000-8000-000000000002', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'kb@un.test'
  where id = (select v from fx where k = 'm5');
select private.enqueue_job('eb300000-0000-4000-8000-00000000000a', 'send_message', jsonb_build_object('message_id', (select v from fx where k = 'm2')), 'send-message:un2', null, 5);
select private.enqueue_job('eb300000-0000-4000-8000-00000000000a', 'send_message', jsonb_build_object('message_id', (select v from fx where k = 'm3')), 'send-message:un3', null, 5);
select private.enqueue_job('eb300000-0000-4000-8000-00000000000a', 'send_message', jsonb_build_object('message_id', (select v from fx where k = 'm4')), 'send-message:un4', null, 5);
select private.enqueue_job('eb300000-0000-4000-8000-00000000000b', 'send_message', jsonb_build_object('message_id', (select v from fx where k = 'm5')), 'send-message:un5', null, 5);

-- ---------------------------------------------------------------------------
-- Structure et droits
-- ---------------------------------------------------------------------------
select has_function('private', 'unsubscribe_apply', array['uuid', 'uuid'], 'private.unsubscribe_apply existe');
select has_function('public', 'unsubscribe_apply', array['uuid', 'uuid'], 'public.unsubscribe_apply existe');
select is((select prosecdef from pg_proc where oid = 'private.unsubscribe_apply(uuid, uuid)'::regprocedure), true, 'la fonction privée est SECURITY DEFINER');
select is((select prosecdef from pg_proc where oid = 'public.unsubscribe_apply(uuid, uuid)'::regprocedure), false, 'l''enveloppe publique est SECURITY INVOKER');
select is(has_function_privilege('service_role', 'public.unsubscribe_apply(uuid, uuid)', 'execute'), true, 'service_role peut l''exécuter');
select is(has_function_privilege('authenticated', 'public.unsubscribe_apply(uuid, uuid)', 'execute'), false, 'authenticated ne peut pas');
select is(has_function_privilege('anon', 'public.unsubscribe_apply(uuid, uuid)', 'execute'), false, 'anon ne peut pas');
select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select throws_ok($$select public.unsubscribe_apply('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'))$$, '42501', null, 'un owner connecté ne peut pas appeler la fonction');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.unsubscribe_apply('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'))$$, '42501', null, 'anon ne peut pas appeler la fonction');
reset role;

-- ---------------------------------------------------------------------------
-- Entrées invalides : rien n'est écrit
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select throws_ok($$select public.unsubscribe_apply(null, null)$$, '22023', null, 'entreprise et message obligatoires');
select throws_ok($$select public.unsubscribe_apply('eb300000-0000-4000-8000-00000000000a', gen_random_uuid())$$, 'PT404', null, 'message inconnu : introuvable');
select throws_ok($$select public.unsubscribe_apply('eb300000-0000-4000-8000-00000000000b', (select v from fx where k = 'm1'))$$, 'PT404', null, 'le message d''une autre entreprise est introuvable (jamais l''entreprise du client)');
reset role;
select is((select count(*)::int from public.suppressions where organization_id in ('eb300000-0000-4000-8000-00000000000a', 'eb300000-0000-4000-8000-00000000000b')), 0, 'aucune suppression après les refus');

-- ---------------------------------------------------------------------------
-- Application
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
create temp table res (r jsonb);
grant all on res to public;
insert into res select public.unsubscribe_apply('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'));
reset role;
select is((select r ->> 'outcome' from res), 'applied', 'premier appel : applied');
select is((select (r ->> 'revoked')::int from res), 2, 'deux consentements e-mail révoqués (marketing et transactionnel)');
select is((select (r ->> 'cancelled')::int from res), 1, 'un message en file annulé');
select is((select count(*)::int from public.consent_events where contact_id = 'ec300000-0000-4000-8000-0000000000a1' and channel = 'email' and revoked_at is null), 0, 'plus aucun consentement e-mail actif pour k1');
select is((select count(*)::int from public.consent_events where contact_id = 'ec300000-0000-4000-8000-0000000000a1' and channel = 'whatsapp' and revoked_at is null), 1, 'le consentement WhatsApp de k1 est intact (autre canal)');
select is((select count(*)::int from public.consent_events where contact_id = 'ec300000-0000-4000-8000-0000000000a1' and channel = 'email' and revoked_at is not null), 2, 'l''historique est conservé (révoqué, jamais supprimé)');
select is((select reason from public.suppressions where organization_id = 'eb300000-0000-4000-8000-00000000000a' and value_normalized = 'k1@un.test'), 'unsubscribe', 'adresse inscrite en suppression (unsubscribe)');
select is((select source_message_id from public.suppressions where organization_id = 'eb300000-0000-4000-8000-00000000000a' and value_normalized = 'k1@un.test'), (select v from fx where k = 'm1'), 'le message source est tracé');
select is((select status from public.messages where id = (select v from fx where k = 'm2')), 'cancelled', 'message en file non réclamé : cancelled');
select is((select status from public.jobs where idempotency_key = 'send-message:un2'), 'cancelled', 'son job d''envoi est annulé');
select is((select status from public.messages where id = (select v from fx where k = 'm3')), 'queued', 'message DÉJÀ réclamé : non touché (le contrôle final le refusera)');
select is((select status from public.jobs where idempotency_key = 'send-message:un3'), 'queued', 'son job reste en file');
select is((select status from public.messages where id = (select v from fx where k = 'm1')), 'accepted', 'le message déjà accepté n''est pas modifié');

-- les autres contacts et entreprises ne sont pas touchés
select is((select count(*)::int from public.consent_events where contact_id = 'ec300000-0000-4000-8000-0000000000a2' and revoked_at is null), 1, 'k2 : consentement intact');
select is((select status from public.messages where id = (select v from fx where k = 'm4')), 'queued', 'k2 : message en file intact');
select is((select status from public.jobs where idempotency_key = 'send-message:un4'), 'queued', 'k2 : job intact');
select is((select count(*)::int from public.suppressions where value_normalized = 'k2@un.test'), 0, 'k2 : aucune suppression');
select is((select count(*)::int from public.consent_events where contact_id = 'ec300000-0000-4000-8000-0000000000b1' and revoked_at is null), 1, 'entreprise B : consentement intact');
select is((select status from public.jobs where idempotency_key = 'send-message:un5'), 'queued', 'entreprise B : job intact');
select is((select count(*)::int from public.suppressions where organization_id = 'eb300000-0000-4000-8000-00000000000b'), 0, 'entreprise B : aucune suppression');

-- audit : identifiants et nombres seulement
select is((select count(*)::int from public.audit_logs where organization_id = 'eb300000-0000-4000-8000-00000000000a' and action = 'unsubscribe.applied'), 1, 'un événement d''audit unsubscribe.applied');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb300000-0000-4000-8000-00000000000a' and action = 'consent.revoked'), 2, 'les révocations sont auditées');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb300000-0000-4000-8000-00000000000a' and (before::text || after::text) ~* 'k1@un\.test|M1|M2'), 0, 'aucune adresse ni corps de message dans l''audit');

-- idempotence
select pg_temp.as_service();
delete from res;
insert into res select public.unsubscribe_apply('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'));
reset role;
select is((select r ->> 'outcome' from res), 'already', 'second appel : already');
select is((select count(*)::int from public.suppressions where value_normalized = 'k1@un.test'), 1, 'toujours une seule suppression');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb300000-0000-4000-8000-00000000000a' and action = 'unsubscribe.applied'), 1, 'pas de second événement d''audit');

-- l'envoi suivant est refusé : la réclamation voit « pas de consentement » et « adresse supprimée »
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M6 apres desabonnement', 'envoi-un-0006', null);
update public.messages set approved_by = 'ea300000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@un.test'
  where idempotency_key = 'envoi-un-0006';
select pg_temp.as_service();
delete from res;
insert into res select public.message_send_claim('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'envoi-un-0006'));
reset role;
select is((select r ->> 'status' from res), 'claimed', 'la réclamation est posée (le refus se décide dans le worker)');
select is((select (r ->> 'consent')::boolean from res), false, 'consentement : absent pour le message suivant');
select is((select (r ->> 'suppressed')::boolean from res), true, 'adresse : supprimée pour le message suivant');

select * from finish();
rollback;
