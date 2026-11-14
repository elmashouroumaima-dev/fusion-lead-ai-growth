-- J37 — Boîte de réception : `search_conversations` (droits de lecture des conversations réappliqués : owner et admin toutes, le commercial SES
-- conversations, marketing et analyste aucune ; isolation entre entreprises), nom du contact, type du canal (e-mail et WhatsApp dans une même
-- liste), aperçu tronqué sans le corps entier, filtres, recherche échappée, pagination, validation, droits d'exécution. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U5 analyste A · U6 owner B · U7 second commercial A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea100000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@ib.test', now()
    from generate_series(1, 7) n;
insert into public.organizations (id, name, slug) values
  ('eb100000-0000-4000-8000-00000000000a', 'IB Alpha', 'ib-alpha-test'),
  ('eb100000-0000-4000-8000-00000000000b', 'IB Beta', 'ib-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('eb100000-0000-4000-8000-00000000000b', 'ea100000-0000-4000-8000-000000000006', 'company_owner', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000007', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb100000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb100000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec100000-0000-4000-8000-0000000000a1', 'eb100000-0000-4000-8000-00000000000a', 'Nadia Mail', 'nadia@ib.test', 'nadia@ib.test', null),
  ('ec100000-0000-4000-8000-0000000000a2', 'eb100000-0000-4000-8000-00000000000a', 'Youssef WhatsApp', null, null, '+212612340099'),
  ('ec100000-0000-4000-8000-0000000000a3', 'eb100000-0000-4000-8000-00000000000a', 'Remise 100% Club', 'remise@ib.test', 'remise@ib.test', null),
  ('ec100000-0000-4000-8000-0000000000b1', 'eb100000-0000-4000-8000-00000000000b', 'Contact Beta', 'b1@ib.test', 'b1@ib.test', null);

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
grant execute on function pg_temp.as_user(text), pg_temp.as_anon() to public;

-- canaux : e-mail et WhatsApp chez A, WhatsApp chez B
select pg_temp.as_user('ea100000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb100000-0000-4000-8000-00000000000a', 'email', 'ib-mail-a', '{}', 'ed100000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb100000-0000-4000-8000-00000000000a', 'whatsapp', 'ib-wa-a', '{}', 'ed100000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_channel('eb100000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ib-mail-a'), 'email', 'ventes@ib.test', '{}');
select public.create_channel('eb100000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ib-wa-a'), 'whatsapp', '+212600000020', '{}');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000006');
select public.create_provider_integration('eb100000-0000-4000-8000-00000000000b', 'whatsapp', 'ib-wa-b', '{}', 'ed100000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_channel('eb100000-0000-4000-8000-00000000000b', (select id from public.integrations where external_account_id = 'ib-wa-b'), 'whatsapp', '+212600000021', '{}');
reset role;

-- fils : Nadia (e-mail), Youssef (WhatsApp), Remise (e-mail) chez A ; Beta chez B. Messages : un long corps avec des espaces multiples.
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000a', 'ec100000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = 'ventes@ib.test'));
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000a', 'ec100000-0000-4000-8000-0000000000a2', (select id from public.channels where sender_identity = '+212600000020'));
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000a', 'ec100000-0000-4000-8000-0000000000a3', (select id from public.channels where sender_identity = 'ventes@ib.test'));
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000b', 'ec100000-0000-4000-8000-0000000000b1', (select id from public.channels where sender_identity = '+212600000021'));
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a1'), 'inbound', 'ib.m1', 'Bonjour, je   veux' || repeat(' un devis très détaillé', 30), null, '2026-11-10 10:00:00+00');
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a2'), 'inbound', 'ib.m2', 'Salut, vous livrez ?', null, '2026-11-10 11:00:00+00');
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a3'), 'inbound', 'ib.m3', 'Remise 100% ?', null, '2026-11-10 09:00:00+00');
select private.message_record('eb100000-0000-4000-8000-00000000000b', (select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000b1'), 'inbound', 'ib.m4', 'Hello Beta', null, '2026-11-10 12:00:00+00');
create temp table beta_conversation as select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000b1';
grant select on beta_conversation to public;
-- le commercial U4 a la conversation de Youssef (WhatsApp)
select pg_temp.as_user('ea100000-0000-4000-8000-000000000001');
select public.assign_conversation('eb100000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a2'), 'ea100000-0000-4000-8000-000000000004');
reset role;

-- owner A : trois conversations d'Alpha, la plus récente d'abord, e-mail et WhatsApp dans la même liste, jamais celle de Beta
select pg_temp.as_user('ea100000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 3, 'owner : 3 conversations');
select is((select max(total_count)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 3, 'le total accompagne chaque ligne');
select is((select string_agg(contact_name, ' > ' order by ordinality) from (select contact_name, row_number() over () as ordinality from public.search_conversations('eb100000-0000-4000-8000-00000000000a')) s), 'Youssef WhatsApp > Nadia Mail > Remise 100% Club', 'la plus récemment active d''abord');
select is((select string_agg(distinct channel_type::text, ',' order by channel_type::text) from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 'email,whatsapp', 'e-mail et WhatsApp dans une même liste');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000b')), 0, 'owner A : rien dans Beta');
select is((select last_preview from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, 'youssef')), 'Salut, vous livrez ?', 'aperçu d''un message court, sans troncature');
select is((select last_truncated from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, 'youssef')), false, 'message court : non tronqué');
select is((select length(last_preview) from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, 'nadia')), 140, 'aperçu limité à 140 caractères');
select is((select last_truncated from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, 'nadia')), true, 'long message : tronqué');
select ok((select last_preview from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, 'nadia')) like 'Bonjour, je veux un devis%', 'espaces multiples réduits dans l''aperçu');
select is((select last_direction from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, 'nadia')), 'inbound', 'sens du dernier message');

-- filtres
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, 'whatsapp')), 1, 'filtre canal WhatsApp');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, 'email')), 2, 'filtre canal e-mail');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, true)), 2, 'filtre « non assignées » : les deux fils en tri');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', 'open')), 1, 'filtre état « ouverte »');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, 'ea100000-0000-4000-8000-000000000004')), 1, 'filtre responsable');

-- recherche : nom, téléphone, e-mail ; « % » et « _ » ne sont pas des motifs
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, '06 12 34 00')), 1, 'recherche par numéro');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, '%')), 1, '« % » est un caractère : seul le contact qui en porte un répond');

-- une seule conversation (en-tête du fil)
select is((select contact_name from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, null, 25, 0, (select id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a1'))), 'Nadia Mail', 'une conversation précise par son identifiant');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, null, 25, 0, (select id from beta_conversation))), 0, 'l''identifiant d''une conversation d''une autre entreprise ne donne rien');

-- pagination et validation
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, null, 2, 0)), 2, 'pagination : première page');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, null, 2, 2)), 1, 'pagination : dernière page partielle');
select throws_ok($$select * from public.search_conversations('eb100000-0000-4000-8000-00000000000a', 'bidon')$$, '22023', 'validation_failed', 'état inconnu refusé');
select throws_ok($$select * from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, 'sms')$$, '22023', 'validation_failed', 'canal inconnu refusé');
select throws_ok($$select * from public.search_conversations('eb100000-0000-4000-8000-00000000000a', null, null, null, false, null, 101, 0)$$, '22023', 'validation_failed', 'limite hors bornes refusée');

-- le commercial U4 : SA conversation seulement (WhatsApp), avec le nom du contact bien qu'il ne lise ni `channels` ni ce contact
select pg_temp.as_user('ea100000-0000-4000-8000-000000000004');
select is((select string_agg(contact_name || ':' || channel_type::text, ',') from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 'Youssef WhatsApp:whatsapp', 'commercial : sa seule conversation, avec contact et canal');
-- le second commercial, le marketing et l'analyste : aucune ; l'owner de Beta : rien chez Alpha
select pg_temp.as_user('ea100000-0000-4000-8000-000000000007');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 0, 'autre commercial : aucune conversation');
select pg_temp.as_user('ea100000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 0, 'marketing : aucune conversation');
select pg_temp.as_user('ea100000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 0, 'analyste : aucune conversation');
select pg_temp.as_user('ea100000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.search_conversations('eb100000-0000-4000-8000-00000000000a')), 0, 'owner B : rien chez Alpha');
select pg_temp.as_anon();
select throws_ok($$select * from public.search_conversations('eb100000-0000-4000-8000-00000000000a')$$, '42501', null, 'anon : exécution refusée');

select * from finish();
rollback;
