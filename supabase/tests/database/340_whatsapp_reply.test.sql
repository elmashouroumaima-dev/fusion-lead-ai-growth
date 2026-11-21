-- Réponse WhatsApp depuis la boîte de réception (écart n° 3 de C3) : `conversation_reply` accepte WhatsApp en TEXTE LIBRE dans la fenêtre de 24 h seulement.
-- Refus d'abord (hors fenêtre, fenêtre limite, rôles sans droit, canal en pause, contact sans numéro, rejeu avec un autre texte), puis le cas nominal (destinataire = numéro du contact,
-- finalité « reply », aucun modèle, job d'envoi) et le rejeu. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- U1 owner A · U2 marketing A · U3 commercial A (assigné au fil W1) · U4 second commercial A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea600000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@wr.test', now()
    from generate_series(1, 4) n;
insert into public.organizations (id, name, slug) values ('eb600000-0000-4000-8000-00000000000a', 'WR Alpha', 'wr-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000002', 'marketing_manager', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000003', 'sales_agent', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000004', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('eb600000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');
-- W1 : message reçu il y a 1 h (fenêtre ouverte) · W2 : reçu il y a 30 h (fenêtre fermée) · W3 : jamais écrit · W4 : sans numéro · W5 : reçu il y a 23 h 59 min
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec600000-0000-4000-8000-0000000000a1', 'eb600000-0000-4000-8000-00000000000a', 'WR W1', null, null, '+212600000061'),
  ('ec600000-0000-4000-8000-0000000000a2', 'eb600000-0000-4000-8000-00000000000a', 'WR W2', null, null, '+212600000062'),
  ('ec600000-0000-4000-8000-0000000000a3', 'eb600000-0000-4000-8000-00000000000a', 'WR W3', null, null, '+212600000063'),
  ('ec600000-0000-4000-8000-0000000000a4', 'eb600000-0000-4000-8000-00000000000a', 'WR W4', 'w4@wr.test', 'w4@wr.test', null),
  ('ec600000-0000-4000-8000-0000000000a5', 'eb600000-0000-4000-8000-00000000000a', 'WR W5', null, null, '+212600000065');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb600000-0000-4000-8000-00000000000a', 'whatsapp', '800000000000001', '{}', 'ed600000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'kapso');
select public.create_channel('eb600000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '800000000000001'), 'whatsapp', '+212600000090', '{}');
reset role;
-- le canal devient actif quand son intégration est validée par le serveur (service_role) : simulé ici sans appel sortant
update public.integrations set status = 'active' where external_account_id = '800000000000001';
update public.channels set status = 'active' where sender_identity = '+212600000090';

select private.conversation_get_or_create('eb600000-0000-4000-8000-00000000000a', c.id, (select id from public.channels where sender_identity = '+212600000090'))
  from public.contacts c where c.organization_id = 'eb600000-0000-4000-8000-00000000000a';
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select public.assign_conversation('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'ea600000-0000-4000-8000-000000000003');
reset role;
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'inbound', 'wr.m1', 'Bonjour W1', null, now() - interval '1 hour');
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a2'), 'inbound', 'wr.m2', 'Bonjour W2', null, now() - interval '30 hours');
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a5'), 'inbound', 'wr.m5', 'Bonjour W5', null, now() - interval '23 hours 59 minutes');

-- ---------------------------------------------------------------------------
-- Refus
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a2'), 'Réponse tardive', 'wr-key-000001')$$, 'P0001', 'window_closed', 'fenêtre fermée (dernier message reçu il y a 30 h) : window_closed');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a3'), 'Premier contact', 'wr-key-000002')$$, 'P0001', 'window_closed', 'contact qui n''a jamais écrit : window_closed (jamais de premier message en texte libre)');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a4'), 'Sans numéro', 'wr-key-000003')$$, 'P0001', 'message_not_approvable', 'contact sans numéro : refusé');
reset role;
select is((select count(*)::int from public.messages where idempotency_key in ('wr-key-000001', 'wr-key-000002', 'wr-key-000003')), 0, 'aucun refus ne crée de message');
select is((select count(*)::int from public.jobs where payload ->> 'message_id' in (select id::text from public.messages where direction = 'outbound')), 0, 'aucun refus ne crée de job d''envoi');

select pg_temp.as_user('ea600000-0000-4000-8000-000000000002');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'Marketing', 'wr-key-000004')$$, '42501', null, 'le marketing ne répond pas');
select pg_temp.as_user('ea600000-0000-4000-8000-000000000004');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'Autre commercial', 'wr-key-000005')$$, 'PT404', null, 'un commercial ne répond pas sur le fil d''un autre');
reset role;

update public.channels set status = 'paused' where sender_identity = '+212600000090';
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'Canal en pause', 'wr-key-000006')$$, 'P0001', 'channel_inactive', 'canal non actif : refusé');
reset role;
update public.channels set status = 'active' where sender_identity = '+212600000090';

-- ---------------------------------------------------------------------------
-- Cas nominal : le commercial assigné répond dans la fenêtre
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea600000-0000-4000-8000-000000000003');
select is((select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'Bonjour, voici la réponse.', 'wr-key-000007') ->> 'duplicate'), 'false', 'le commercial assigné répond dans la fenêtre');
reset role;
select is((select approved_recipient from public.messages where idempotency_key = 'wr-key-000007'), '+212600000061', 'destinataire figé = numéro du contact (E.164)');
select is((select approved_purpose || ':' || (approved_by = 'ea600000-0000-4000-8000-000000000003')::text from public.messages where idempotency_key = 'wr-key-000007'), 'reply:true', 'finalité « reply », approuvé par l''auteur');
select is((select template_id is null from public.messages where idempotency_key = 'wr-key-000007'), true, 'texte libre : aucun modèle');
select is((select status::text from public.messages where idempotency_key = 'wr-key-000007'), 'queued', 'le message est en file');
select is((select count(*)::int from public.jobs where kind = 'send_message' and payload ->> 'message_id' = (select id::text from public.messages where idempotency_key = 'wr-key-000007')), 1, 'un job d''envoi');

-- rejeu : même message, pas de second job ; autre texte avec la même clé : refusé
select pg_temp.as_user('ea600000-0000-4000-8000-000000000003');
select is((select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'Bonjour, voici la réponse.', 'wr-key-000007') ->> 'duplicate'), 'true', 'rejeu : le même message');
select throws_ok($$select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1'), 'Autre texte', 'wr-key-000007')$$, 'P0001', 'idempotency_conflict', 'même clé, autre texte : refusé');
reset role;

-- limite de la fenêtre : 23 h 59 min = ouverte
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select is((select public.conversation_reply('eb600000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a5'), 'Juste dans la fenêtre', 'wr-key-000008') ->> 'duplicate'), 'false', 'reçu il y a 23 h 59 min : fenêtre encore ouverte');
reset role;

select * from finish();
rollback;
