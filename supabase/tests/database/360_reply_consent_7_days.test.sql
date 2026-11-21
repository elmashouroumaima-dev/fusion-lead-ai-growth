-- Consentement conversationnel de 7 jours (décision du 2026-11-21) : une réponse (finalité « reply ») est couverte par un message ENTRANT du contact dans le même fil depuis 7 jours au plus
-- (avant : 30). Frontière : reçu il y a 6 jours = couvert ; il y a 8 jours ou 29 jours (couvert avant) = non couvert. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  values ('ea800000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@cw.test', now());
insert into public.organizations (id, name, slug) values ('eb800000-0000-4000-8000-00000000000a', 'CW Alpha', 'cw-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values ('eb800000-0000-4000-8000-00000000000a', 'ea800000-0000-4000-8000-000000000001', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('eb800000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('ec800000-0000-4000-8000-0000000000a1', 'eb800000-0000-4000-8000-00000000000a', 'CW 6 jours', 'c6@cw.test', 'c6@cw.test'),
  ('ec800000-0000-4000-8000-0000000000a2', 'eb800000-0000-4000-8000-00000000000a', 'CW 8 jours', 'c8@cw.test', 'c8@cw.test'),
  ('ec800000-0000-4000-8000-0000000000a3', 'eb800000-0000-4000-8000-00000000000a', 'CW 29 jours', 'c29@cw.test', 'c29@cw.test');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

select pg_temp.as_user('ea800000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb800000-0000-4000-8000-00000000000a', 'email', 'cw-mail', '{}', 'ed800000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
update public.integrations set status = 'active' where external_account_id = 'cw-mail';
select pg_temp.as_user('ea800000-0000-4000-8000-000000000001');
select public.create_channel('eb800000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cw-mail'), 'email', 'ventes@cw.test', '{}');
reset role;

select private.conversation_get_or_create('eb800000-0000-4000-8000-00000000000a', c.id, (select id from public.channels where sender_identity = 'ventes@cw.test'))
  from public.contacts c where c.organization_id = 'eb800000-0000-4000-8000-00000000000a';
select private.message_record('eb800000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec800000-0000-4000-8000-0000000000a1'), 'inbound', 'cw.m1', 'Bonjour 6', null, now() - interval '6 days');
select private.message_record('eb800000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec800000-0000-4000-8000-0000000000a2'), 'inbound', 'cw.m2', 'Bonjour 8', null, now() - interval '8 days');
select private.message_record('eb800000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec800000-0000-4000-8000-0000000000a3'), 'inbound', 'cw.m3', 'Bonjour 29', null, now() - interval '29 days');

select pg_temp.as_user('ea800000-0000-4000-8000-000000000001');
select public.conversation_reply('eb800000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec800000-0000-4000-8000-0000000000a1'), 'Réponse 6 jours', 'cw-key-000001');
select public.conversation_reply('eb800000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec800000-0000-4000-8000-0000000000a2'), 'Réponse 8 jours', 'cw-key-000002');
select public.conversation_reply('eb800000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec800000-0000-4000-8000-0000000000a3'), 'Réponse 29 jours', 'cw-key-000003');
reset role;

select is((select private.message_send_claim('eb800000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'cw-key-000001')) ->> 'status'), 'claimed', 'la réponse est réclamable');
-- la réclamation marque le message : on relit le consentement sur une réclamation fraîche pour chacun
select is((select private.message_send_claim('eb800000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'cw-key-000002')) ->> 'consent'), 'false', 'message reçu il y a 8 jours : plus couvert');
select is((select private.message_send_claim('eb800000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'cw-key-000003')) ->> 'consent'), 'false', 'message reçu il y a 29 jours (couvert avant, avec 30 jours) : plus couvert');
update public.messages set send_claimed_at = null where idempotency_key in ('cw-key-000001', 'cw-key-000002', 'cw-key-000003');
select is((select private.message_send_claim('eb800000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'cw-key-000001')) ->> 'consent'), 'true', 'message reçu il y a 6 jours : couvert');
update public.messages set send_claimed_at = null where idempotency_key = 'cw-key-000001';
select is((select pg_get_functiondef('private.message_send_claim(uuid,uuid)'::regprocedure) like '%interval ''7 days''%'), true, 'la fonction porte bien la durée de 7 jours');
select is((select pg_get_functiondef('private.message_send_claim(uuid,uuid)'::regprocedure) like '%interval ''30 days''%'), false, 'plus aucune trace de la durée de 30 jours');

select * from finish();
rollback;
