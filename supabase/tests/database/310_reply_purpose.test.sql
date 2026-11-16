-- J38 (durcissement) — la finalité « reply » est RÉSERVÉE à la réponse : seule `conversation_reply` (le composeur : l'envoi vaut approbation de CE message,
-- adresse figée, auteur revalidé par le worker) peut la poser. `message_approve` la refuse : sinon un message promotionnel approuvé « reply » serait couvert par le
-- consentement conversationnel de 30 jours (un message entrant du contact) sans consentement marketing. Vérifie aussi que le consentement conversationnel ne vient
-- que du MÊME fil, qu'il ne contourne ni « ne plus contacter » ni la liste de suppression, et que le commercial n'approuve jamais par `message_approve`.
-- Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea300000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@rpp.test', now()
    from generate_series(1, 4) n;
insert into public.organizations (id, name, slug) values ('eb300000-0000-4000-8000-00000000000a', 'RPP Alpha', 'rpp-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb300000-0000-4000-8000-00000000000a', 'ea300000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb300000-0000-4000-8000-00000000000a', 'ea300000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb300000-0000-4000-8000-00000000000a', 'ea300000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb300000-0000-4000-8000-00000000000a', 'ea300000-0000-4000-8000-000000000004', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb300000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');
-- A1 : écrit sur le canal 1 (fil 1) ; A2 : écrit sur le canal 2 seulement (le fil du canal 1 n'a AUCUN message entrant) ; A3 : « ne plus contacter » ; A4 : adresse supprimée
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, do_not_contact) values
  ('ec300000-0000-4000-8000-0000000000a1', 'eb300000-0000-4000-8000-00000000000a', 'RPP A1', 'a1@rpp.test', 'a1@rpp.test', false),
  ('ec300000-0000-4000-8000-0000000000a2', 'eb300000-0000-4000-8000-00000000000a', 'RPP A2', 'a2@rpp.test', 'a2@rpp.test', false),
  ('ec300000-0000-4000-8000-0000000000a3', 'eb300000-0000-4000-8000-00000000000a', 'RPP A3', 'a3@rpp.test', 'a3@rpp.test', true),
  ('ec300000-0000-4000-8000-0000000000a4', 'eb300000-0000-4000-8000-00000000000a', 'RPP A4', 'a4@rpp.test', 'a4@rpp.test', false);

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb300000-0000-4000-8000-00000000000a', 'email', 'rpp-mail-1', '{}', 'ed300000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb300000-0000-4000-8000-00000000000a', 'email', 'rpp-mail-2', '{}', 'ed300000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_channel('eb300000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'rpp-mail-1'), 'email', 'ventes1@rpp.test', '{}');
select public.create_channel('eb300000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'rpp-mail-2'), 'email', 'ventes2@rpp.test', '{}');
reset role;
update public.integrations set status = 'active' where external_account_id in ('rpp-mail-1', 'rpp-mail-2');
update public.channels set status = 'active' where sender_identity in ('ventes1@rpp.test', 'ventes2@rpp.test');

-- fils : A1, A3, A4 sur le canal 1 avec un message entrant récent ; A2 : fil canal 1 SANS entrant, fil canal 2 AVEC entrant
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = 'ventes1@rpp.test'));
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a2', (select id from public.channels where sender_identity = 'ventes1@rpp.test'));
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a2', (select id from public.channels where sender_identity = 'ventes2@rpp.test'));
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a3', (select id from public.channels where sender_identity = 'ventes1@rpp.test'));
select private.conversation_get_or_create('eb300000-0000-4000-8000-00000000000a', 'ec300000-0000-4000-8000-0000000000a4', (select id from public.channels where sender_identity = 'ventes1@rpp.test'));
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a1'), 'inbound', 'rpp.m1', 'Bonjour A1', null, now() - interval '1 hour');
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.id = c.channel_id where c.contact_id = 'ec300000-0000-4000-8000-0000000000a2' and ch.sender_identity = 'ventes2@rpp.test'), 'inbound', 'rpp.m2', 'Bonjour A2', null, now() - interval '1 hour');
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a3'), 'inbound', 'rpp.m3', 'Bonjour A3', null, now() - interval '1 hour');
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a4'), 'inbound', 'rpp.m4', 'Bonjour A4', null, now() - interval '1 hour');
insert into public.suppressions (organization_id, channel, value_normalized, reason) values ('eb300000-0000-4000-8000-00000000000a', 'email', 'a4@rpp.test', 'unsubscribe');
-- le commercial U4 est responsable du fil A1
select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select public.assign_conversation('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a1'), 'ea300000-0000-4000-8000-000000000004');
reset role;

-- messages sortants promotionnels (non approuvés) dans le fil A1
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a1'), 'outbound', null, 'Offre promotionnelle 1', 'rpp-promo-0001', null);
select private.message_record('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a1'), 'outbound', null, 'Offre promotionnelle 2', 'rpp-promo-0002', null);

-- ---------------------------------------------------------------------------
-- La finalité « reply » est réservée : message_approve la refuse (owner et admin), rien n'est approuvé ni mis en file
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select throws_ok($$select public.message_approve('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0001'), 'reply')$$, '22023', null, 'l''owner ne peut pas approuver un message avec la finalité réservée « reply »');
select pg_temp.as_user('ea300000-0000-4000-8000-000000000002');
select throws_ok($$select public.message_approve('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0001'), 'reply')$$, '22023', null, 'l''admin non plus');
reset role;
select is((select approved_by::text from public.messages where idempotency_key = 'rpp-promo-0001'), null, 'le message refusé n''est pas approuvé');
select is((select count(*)::int from public.jobs where kind = 'send_message' and payload ->> 'message_id' = (select id::text from public.messages where idempotency_key = 'rpp-promo-0001')), 0, 'aucun job d''envoi pour le message refusé');

-- le commercial ne passe jamais par message_approve (quelle que soit la finalité)
select pg_temp.as_user('ea300000-0000-4000-8000-000000000004');
select throws_ok($$select public.message_approve('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0002'), 'reply')$$, '42501', null, 'le commercial ne peut pas approuver avec « reply »');
select throws_ok($$select public.message_approve('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0002'), 'marketing')$$, '42501', null, 'ni avec « marketing »');
select pg_temp.as_user('ea300000-0000-4000-8000-000000000003');
select throws_ok($$select public.message_approve('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0002'), 'reply')$$, '42501', null, 'le responsable marketing non plus');
reset role;

-- les autres finalités ne changent pas : « marketing » reste approuvable par l'owner et exige toujours un consentement enregistré
select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select lives_ok($$select public.message_approve('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0002'), 'marketing')$$, 'la finalité « marketing » reste approuvable par l''owner');
reset role;
select is((select private.message_send_claim('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-promo-0002')) ->> 'consent'), 'false', 'le message marketing n''est pas couvert par le message entrant du contact');

-- ---------------------------------------------------------------------------
-- Le chemin légitime reste ouvert : le composeur pose « reply » et le worker voit un consentement conversationnel
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea300000-0000-4000-8000-000000000004');
select public.conversation_reply('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a1'), 'Merci de votre message.', 'rpp-reply-0001');
reset role;
select is((select approved_purpose from public.messages where idempotency_key = 'rpp-reply-0001'), 'reply', 'conversation_reply pose bien la finalité « reply »');
select is((select private.message_send_claim('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-reply-0001')) ->> 'consent'), 'true', 'la réponse est couverte par le message entrant du MÊME fil');

-- un message entrant d'un AUTRE fil (autre canal) du même contact ne couvre pas la réponse
select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select public.conversation_reply('eb300000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.id = c.channel_id where c.contact_id = 'ec300000-0000-4000-8000-0000000000a2' and ch.sender_identity = 'ventes1@rpp.test'), 'Réponse dans le fil sans message entrant.', 'rpp-reply-0002');
reset role;
select is((select private.message_send_claim('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-reply-0002')) ->> 'consent'), 'false', 'un message entrant d''un autre fil du même contact ne couvre pas la réponse');

-- « reply » ne contourne ni « ne plus contacter » ni la suppression : le worker les voit et refuse (contrôle final)
select pg_temp.as_user('ea300000-0000-4000-8000-000000000001');
select public.conversation_reply('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a3'), 'Réponse à un contact « ne plus contacter ».', 'rpp-reply-0003');
select public.conversation_reply('eb300000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec300000-0000-4000-8000-0000000000a4'), 'Réponse à une adresse supprimée.', 'rpp-reply-0004');
reset role;
select is((select private.message_send_claim('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-reply-0003')) #>> '{contact,do_not_contact}'), 'true', 'la réclamation signale « ne plus contacter » malgré la finalité « reply » (le worker refuse)');
select is((select private.message_send_claim('eb300000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'rpp-reply-0004')) ->> 'suppressed'), 'true', 'la réclamation signale l''adresse supprimée malgré la finalité « reply » (le worker refuse)');

select * from finish();
rollback;
