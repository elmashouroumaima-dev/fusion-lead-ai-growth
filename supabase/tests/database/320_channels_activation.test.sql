-- Activation des canaux (écran de canaux) — ADR 007 E4 : « un canal ne passe `active` qu'après la validation par le fournisseur ». Règle : un canal est `active` si et seulement
-- si son intégration est `active` (validée par le serveur : `integration_set_validation`, service_role seulement) ; `create_channel` crée un canal `active` sur une intégration déjà
-- validée, `pending` sinon ; la validation active les canaux `pending`, un échec les remet `pending` ; une reconnexion remet les canaux en pause : la validation ne les relance pas.
-- Aucun autre chemin : ni `update_channel` (portée et pause seulement), ni une écriture directe, ni un rôle autre qu'owner et admin. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U5 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea400000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@ca.test', now()
    from generate_series(1, 5) n;
insert into public.organizations (id, name, slug) values
  ('eb400000-0000-4000-8000-00000000000a', 'CA Alpha', 'ca-alpha-test'),
  ('eb400000-0000-4000-8000-00000000000b', 'CA Beta', 'ca-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb400000-0000-4000-8000-00000000000a', 'ea400000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb400000-0000-4000-8000-00000000000a', 'ea400000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb400000-0000-4000-8000-00000000000a', 'ea400000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb400000-0000-4000-8000-00000000000a', 'ea400000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb400000-0000-4000-8000-00000000000b', 'ea400000-0000-4000-8000-000000000005', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb400000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb400000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');

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
grant execute on function pg_temp.as_user(text), pg_temp.as_service() to public;

-- trois intégrations e-mail d'Alpha (A1 : validée plus tard, A2 : validée avant le canal, A3 : déconnectée puis reconnectée) et une de Beta
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb400000-0000-4000-8000-00000000000a', 'email', 'ca-a1', '{}', 'ed400000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb400000-0000-4000-8000-00000000000a', 'email', 'ca-a2', '{}', 'ed400000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb400000-0000-4000-8000-00000000000a', 'email', 'ca-a3', '{}', 'ed400000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
select pg_temp.as_user('ea400000-0000-4000-8000-000000000005');
select public.create_provider_integration('eb400000-0000-4000-8000-00000000000b', 'email', 'ca-b1', '{}', 'ed400000-0000-4000-8000-000000000004', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;

-- ---------------------------------------------------------------------------
-- Canal créé sur une intégration NON validée : `pending`
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea400000-0000-4000-8000-000000000002');
select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a1'), 'email', 'a1@ca.test', '{}');
reset role;
select is((select status from public.channels where sender_identity = 'a1@ca.test'), 'pending', 'un canal créé sur une intégration non validée est « pending »');
select is((select status from public.integrations where external_account_id = 'ca-a1'), 'pending', 'l''intégration est « pending »');

-- ---------------------------------------------------------------------------
-- La validation (service_role seulement) active les canaux « pending » ; la pause n'est pas touchée
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a1'), true, null, 'ea400000-0000-4000-8000-000000000001')$$, '42501', null, 'un owner ne peut pas déclarer une intégration validée');
reset role;
select is((select status from public.channels where sender_identity = 'a1@ca.test'), 'pending', 'le refus laisse le canal « pending »');
select pg_temp.as_service();
select is(public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a1'), true, null, 'ea400000-0000-4000-8000-000000000001'), 'active', 'le serveur valide l''intégration');
reset role;
select is((select status from public.channels where sender_identity = 'a1@ca.test'), 'active', 'la validation active le canal « pending »');
select is((select send_paused from public.channels where sender_identity = 'a1@ca.test'), false, 'la validation ne touche pas à la pause');

-- ---------------------------------------------------------------------------
-- Canal créé sur une intégration DÉJÀ validée : `active`
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a2'), true, null, 'ea400000-0000-4000-8000-000000000001');
reset role;
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a2'), 'email', 'a2@ca.test', '{}');
reset role;
select is((select status from public.channels where sender_identity = 'a2@ca.test'), 'active', 'un canal créé sur une intégration validée est « active »');

-- ---------------------------------------------------------------------------
-- Un échec de validation remet les canaux « pending » ; une validation réussie les réactive
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select is(public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a2'), false, 'provider_auth', 'ea400000-0000-4000-8000-000000000001'), 'error', 'jeton refusé : l''intégration passe « error »');
reset role;
select is((select status from public.channels where sender_identity = 'a2@ca.test'), 'pending', 'l''échec remet le canal « pending » (rien ne part)');
select pg_temp.as_service();
select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a2'), true, null, 'ea400000-0000-4000-8000-000000000001');
reset role;
select is((select status from public.channels where sender_identity = 'a2@ca.test'), 'active', 'la validation suivante le réactive');

-- ---------------------------------------------------------------------------
-- Déconnexion puis reconnexion : les canaux restent EN PAUSE après la validation (le propriétaire les relance)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'), 'email', 'a3@ca.test', '{}');
reset role;
select pg_temp.as_service();
select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'), true, null, 'ea400000-0000-4000-8000-000000000001');
reset role;
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select public.disconnect_integration('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'));
select throws_ok($$select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'), 'email', 'a3bis@ca.test', '{}')$$, 'P0001', 'integration_not_replaceable', 'pas de nouveau canal sur une intégration déconnectée');
reset role;
select is((select status || ':' || send_paused::text from public.channels where sender_identity = 'a3@ca.test'), 'disconnected:true', 'déconnexion : canal « disconnected » et en pause');
select pg_temp.as_service();
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'), true, null, 'ea400000-0000-4000-8000-000000000001')$$, 'P0001', 'integration_not_validatable', 'une intégration déconnectée ne se valide pas');
reset role;
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select public.set_integration_secret('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'), 'ed400000-0000-4000-8000-000000000005', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
select pg_temp.as_service();
select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a3'), true, null, 'ea400000-0000-4000-8000-000000000001');
reset role;
select is((select status || ':' || send_paused::text from public.channels where sender_identity = 'a3@ca.test'), 'active:true', 'reconnexion validée : canal « active » mais TOUJOURS en pause');

-- ---------------------------------------------------------------------------
-- Aucun autre chemin d'activation : droits et isolation
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select throws_ok($$update public.channels set status = 'active' where sender_identity = 'a1@ca.test'$$, '42501', null, 'aucune écriture directe sur les canaux (statut)');
select throws_ok($$select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-b1'), 'email', 'x@ca.test', '{}')$$, 'PT404', null, 'l''intégration d''une autre entreprise est introuvable');
select pg_temp.as_user('ea400000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a2'), 'email', 'sales@ca.test', '{}')$$, '42501', null, 'le commercial ne crée pas de canal');
select pg_temp.as_user('ea400000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'ca-a2'), 'email', 'mkt@ca.test', '{}')$$, '42501', null, 'le responsable marketing non plus');
reset role;
select pg_temp.as_service();
-- la validation d'une intégration de Beta (mauvaise entreprise) ne touche pas les canaux d'Alpha
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000b', (select id from public.integrations where external_account_id = 'ca-a2'), false, 'provider_auth', 'ea400000-0000-4000-8000-000000000005')$$, 'PT404', null, 'validation avec une entreprise qui n''est pas la bonne : introuvable');
reset role;
select is((select status from public.channels where sender_identity = 'a2@ca.test'), 'active', 'les canaux d''Alpha restent « active »');

-- pause et reprise par l'admin : la pause n'est pas une activation
select pg_temp.as_user('ea400000-0000-4000-8000-000000000002');
select public.update_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.channels where sender_identity = 'a2@ca.test'), null, true);
reset role;
select is((select status || ':' || send_paused::text from public.channels where sender_identity = 'a2@ca.test'), 'active:true', 'pause par l''admin : le statut ne change pas');
select pg_temp.as_user('ea400000-0000-4000-8000-000000000002');
select public.update_channel('eb400000-0000-4000-8000-00000000000a', (select id from public.channels where sender_identity = 'a2@ca.test'), null, false);
reset role;
select is((select send_paused from public.channels where sender_identity = 'a2@ca.test'), false, 'reprise par l''admin');

select * from finish();
rollback;
