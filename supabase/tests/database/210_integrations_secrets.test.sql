-- J28 — Intégrations à secret et canaux : colonnes lisibles (jamais secret_ref), secrets chiffrés dans private.secrets sans aucun droit d'API,
-- création / remplacement (rotation) / déconnexion réservés owner et admin, lecture du chiffré réservée à service_role, unicité GLOBALE
-- des comptes email et whatsapp, canaux, isolation entre entreprises, audit sans secret. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(119);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ca000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@cz.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('cb000000-0000-4000-8000-00000000000a', 'CZ Alpha', 'cz-alpha-test'),
  ('cb000000-0000-4000-8000-00000000000b', 'CZ Beta', 'cz-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('cb000000-0000-4000-8000-00000000000b', 'ca000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('cb000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('cb000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('cc000000-0000-4000-8000-0000000000a1', 'cb000000-0000-4000-8000-00000000000a', 'website_sales', 'CZ site A', 'active', '{}'),
  ('cc000000-0000-4000-8000-0000000000b1', 'cb000000-0000-4000-8000-00000000000b', 'website_sales', 'CZ site B', 'active', '{}');

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

-- ---------------------------------------------------------------------------
-- Structure et droits
-- ---------------------------------------------------------------------------
select has_table('public', 'channels', 'la table channels existe');
select has_column('public', 'integrations', 'secret_ref', 'integrations porte secret_ref');
select has_column('public', 'integrations', 'has_secret', 'integrations porte has_secret (booléen généré)');
select has_column('public', 'integrations', 'scopes', 'integrations porte scopes');
select ok((select relrowsecurity from pg_class where oid = 'public.channels'::regclass), 'RLS activée sur channels');
select ok(has_column_privilege('authenticated', 'public.integrations', 'has_secret', 'select'), 'authenticated lit has_secret');
select ok(not has_column_privilege('authenticated', 'public.integrations', 'secret_ref', 'select'), 'authenticated ne lit PAS secret_ref');
select ok(not has_column_privilege('anon', 'public.integrations', 'id', 'select'), 'anon ne lit rien de integrations');
select ok(not has_table_privilege('authenticated', 'private.secrets', 'select'), 'authenticated n''a aucun droit sur private.secrets');
select ok(not has_table_privilege('service_role', 'private.secrets', 'select'), 'service_role n''a aucun droit direct sur private.secrets');
select ok(not has_table_privilege('authenticated', 'public.channels', 'insert') and not has_table_privilege('service_role', 'public.channels', 'insert'), 'aucune écriture directe sur channels');
select ok(has_function_privilege('authenticated', 'public.create_provider_integration(uuid,text,text,text[],uuid,text,text,integer)', 'execute'), 'authenticated exécute create_provider_integration');
select ok(not has_function_privilege('anon', 'public.create_provider_integration(uuid,text,text,text[],uuid,text,text,integer)', 'execute'), 'anon n''exécute pas create_provider_integration');
select ok(has_function_privilege('service_role', 'public.get_integration_secret(uuid,uuid)', 'execute'), 'service_role exécute get_integration_secret');
select ok(not has_function_privilege('authenticated', 'public.get_integration_secret(uuid,uuid)', 'execute'), 'authenticated n''exécute PAS get_integration_secret');
select ok(not has_function_privilege('anon', 'public.get_integration_secret(uuid,uuid)', 'execute'), 'anon n''exécute pas get_integration_secret');

-- ---------------------------------------------------------------------------
-- Création (owner et admin)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select lives_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'whatsapp', 'cz-wa-a', array['messages', 'templates'],
  'cd000000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, 'owner A crée une intégration whatsapp avec son jeton chiffré');
select is((select status || ':' || has_secret::text || ':' || array_to_string(scopes, ',') from public.integrations where external_account_id = 'cz-wa-a'),
  'pending:true:messages,templates', 'statut pending, has_secret vrai, portée enregistrée');
reset role;
select is((select count(*)::int from private.secrets where organization_id = 'cb000000-0000-4000-8000-00000000000a' and purpose = 'integration'), 1, 'un secret chiffré, rattaché à l''entreprise A');
select is((select ciphertext from private.secrets where id = 'cd000000-0000-4000-8000-000000000001'), 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'seul le chiffré est stocké');

select pg_temp.as_user('ca000000-0000-4000-8000-000000000002');
select lives_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-mail-a', '{}',
  'cd000000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, 'admin A crée une intégration e-mail');
reset role;

select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-mail-m', '{}',
  'cd000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'marketing : refusé');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-mail-s', '{}',
  'cd000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'commercial : refusé');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000005');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-mail-an', '{}',
  'cd000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'analyste : refusé');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-mail-x', '{}',
  'cd000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'anonyme : refusé');
reset role;

select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-mail-b', '{}',
  'cd000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'owner de B ne crée rien chez A');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000b', 'whatsapp', 'cz-wa-a', '{}',
  'cd000000-0000-4000-8000-000000000004', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '23505', null, 'compte whatsapp déjà connecté chez A : refusé chez B (unicité globale)');
select lives_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000b', 'whatsapp', 'cz-wa-b', '{}',
  'cd000000-0000-4000-8000-000000000005', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, 'owner B connecte son propre compte');
reset role;
select is((select count(*)::int from private.secrets where id = 'cd000000-0000-4000-8000-000000000004'), 0, 'le secret du refus n''est pas conservé (transaction annulée)');

select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'whatsapp', 'cz-wa-a', '{}',
  'cd000000-0000-4000-8000-000000000006', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '23505', null, 'même compte deux fois chez A : conflit');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'csv', 'cz-csv', '{}',
  'cd000000-0000-4000-8000-000000000006', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '22023', null, 'fournisseur csv refusé ici');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'a b', '{}',
  'cd000000-0000-4000-8000-000000000006', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '22023', null, 'compte mal formé refusé');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-dup', array['a', 'a'],
  'cd000000-0000-4000-8000-000000000006', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '22023', null, 'portées en double refusées');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-nul', '{}',
  'cd000000-0000-4000-8000-000000000006', null, 'QUJDREVGR0hJSktM', 1)$$, '22023', null, 'chiffré absent refusé');
select throws_ok($$select public.create_provider_integration('cb000000-0000-4000-8000-00000000000a', 'email', 'cz-bad', '{}',
  'cd000000-0000-4000-8000-000000000006', 'pas du base64 !!!!!!!!!!!!!!!!', 'QUJDREVGR0hJSktM', 1)$$, '23514', null, 'chiffré mal formé refusé par la contrainte de private.secrets');
reset role;
select is((select count(*)::int from private.secrets where organization_id = 'cb000000-0000-4000-8000-00000000000a'), 2, 'aucun secret orphelin après les refus');

-- ---------------------------------------------------------------------------
-- Lecture : colonnes accordées seulement
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.integrations), 2, 'owner A voit les 2 intégrations d''Alpha');
select throws_ok($$select secret_ref from public.integrations$$, '42501', null, 'owner : lire secret_ref est interdit');
select throws_ok($$select * from public.integrations$$, '42501', null, 'owner : select * est interdit (il inclurait secret_ref)');
select throws_ok($$select ciphertext from private.secrets$$, '42501', null, 'owner : private.secrets est inaccessible');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.integrations), 2, 'admin A voit les 2 intégrations');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.integrations), 0, 'marketing ne voit aucune intégration');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.integrations), 0, 'commercial ne voit aucune intégration');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.integrations), 0, 'analyste ne voit aucune intégration');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.integrations), 1, 'owner B ne voit que la sienne');
select is((select count(*)::int from public.integrations where external_account_id = 'cz-wa-a'), 0, 'owner B ne voit pas l''intégration d''Alpha');
reset role;

-- aucune écriture directe
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$insert into public.integrations (organization_id, provider, external_account_id) values ('cb000000-0000-4000-8000-00000000000a', 'email', 'direct')$$, '42501', null, 'INSERT direct refusé');
select throws_ok($$update public.integrations set status = 'active'$$, '42501', null, 'UPDATE direct refusé');
select throws_ok($$delete from public.integrations$$, '42501', null, 'DELETE direct refusé');
reset role;
select pg_temp.as_service();
select throws_ok($$update public.integrations set status = 'active'$$, '42501', null, 'service_role : UPDATE direct refusé');
reset role;

-- ---------------------------------------------------------------------------
-- Lecture du chiffré : service_role seulement, entreprise de la ligne du job
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select is((select public.get_integration_secret('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999')), null, 'identifiant inconnu : null');
reset role;
select is((select (private.get_integration_secret('cb000000-0000-4000-8000-00000000000a', i.id)) ->> 'ciphertext' from public.integrations i where i.external_account_id = 'cz-wa-a'),
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'la fonction renvoie le chiffré de l''entreprise');
select is((select (private.get_integration_secret('cb000000-0000-4000-8000-00000000000a', i.id)) ->> 'secret_id' from public.integrations i where i.external_account_id = 'cz-wa-a'),
  'cd000000-0000-4000-8000-000000000001', 'avec l''identifiant du secret (partie de l''AAD)');
select is((select private.get_integration_secret('cb000000-0000-4000-8000-00000000000b', i.id) from public.integrations i where i.external_account_id = 'cz-wa-a'), null,
  'une autre entreprise (job de B) ne lit pas le secret d''Alpha');
select pg_temp.as_service();
select lives_ok($$select public.get_integration_secret('cb000000-0000-4000-8000-00000000000a', 'cd000000-0000-4000-8000-0000000000ff')$$, 'service_role peut appeler la fonction publique');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$select public.get_integration_secret('cb000000-0000-4000-8000-00000000000a', 'cd000000-0000-4000-8000-0000000000ff')$$, '42501', null, 'owner : get_integration_secret refusé');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.get_integration_secret('cb000000-0000-4000-8000-00000000000a', 'cd000000-0000-4000-8000-0000000000ff')$$, '42501', null, 'anonyme : get_integration_secret refusé');
reset role;

-- ---------------------------------------------------------------------------
-- Rotation : remplacer le secret
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000002');
select lives_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'),
  'cd000000-0000-4000-8000-000000000010', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, 'admin remplace le jeton (rotation)');
reset role;
select is((select count(*)::int from private.secrets where organization_id = 'cb000000-0000-4000-8000-00000000000a' and purpose = 'integration'), 2, 'toujours un seul secret par intégration (l''ancien est supprimé)');
select is((select count(*)::int from private.secrets where id = 'cd000000-0000-4000-8000-000000000001'), 0, 'l''ancien secret n''existe plus');
select is((select key_version from private.secrets where id = 'cd000000-0000-4000-8000-000000000010'), 2, 'le nouveau secret porte sa version de clé');
select is((select (private.get_integration_secret('cb000000-0000-4000-8000-00000000000a', i.id)) ->> 'secret_id' from public.integrations i where i.external_account_id = 'cz-wa-a'),
  'cd000000-0000-4000-8000-000000000010', 'la lecture renvoie désormais le nouveau secret');

select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'),
  'cd000000-0000-4000-8000-000000000010', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, '23505', null, 'même identifiant de secret deux fois : conflit, rien ne change');
select throws_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999',
  'cd000000-0000-4000-8000-000000000011', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, 'PT404', null, 'intégration inconnue : introuvable');
reset role;
select is((select count(*)::int from private.secrets where organization_id = 'cb000000-0000-4000-8000-00000000000a'), 2, 'les refus n''ont créé aucun secret');

select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'),
  'cd000000-0000-4000-8000-000000000012', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, '42501', null, 'marketing ne remplace pas un jeton');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000004');
select throws_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999',
  'cd000000-0000-4000-8000-000000000012', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, '42501', null, 'commercial ne remplace pas un jeton');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select throws_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999',
  'cd000000-0000-4000-8000-000000000012', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, '42501', null, 'owner de B ne remplace rien chez A');
reset role;

-- intégration CRM (csv) : ni secret ni déconnexion
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select lives_ok($$select public.create_integration('cb000000-0000-4000-8000-00000000000a', 'csv', 'cz-crm')$$, 'une intégration CRM csv se crée toujours (J25)');
select throws_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-crm'),
  'cd000000-0000-4000-8000-000000000013', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, 'P0001', 'integration_not_replaceable', 'csv : pas de secret');
select throws_ok($$select public.disconnect_integration('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-crm'))$$, 'P0001', 'integration_not_replaceable', 'csv : pas de déconnexion');
reset role;
select throws_ok($$update public.integrations set secret_ref = 'cd000000-0000-4000-8000-000000000010' where external_account_id = 'cz-crm'$$, '23514', null, 'garde-fou base : seule une intégration email ou whatsapp porte un secret');
select throws_ok($$update public.integrations set secret_ref = 'cd000000-0000-4000-8000-000000000005' where external_account_id = 'cz-wa-a'$$, '23503', null, 'clé composite : le secret d''une autre entreprise est refusé');

-- ---------------------------------------------------------------------------
-- Canaux
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select lives_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', '+212600000001',
  array['cc000000-0000-4000-8000-0000000000a1']::uuid[])$$, 'owner crée un canal whatsapp limité à un projet');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'email', 'x@cz.test', '{}')$$, 'P0001', 'integration_not_replaceable', 'type du canal différent du fournisseur : refusé');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', '+212600000001', '{}')$$, '23505', null, 'même expéditeur deux fois : conflit');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', '+212600000002',
  array['cc000000-0000-4000-8000-0000000000b1']::uuid[])$$, '22023', null, 'projet d''une autre entreprise refusé');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', ' ', '{}')$$, '22023', null, 'expéditeur vide refusé');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999', 'whatsapp', '+212600000003', '{}')$$, 'PT404', null, 'intégration inconnue : introuvable');
select lives_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-mail-a'), 'email', 'ventes@cz.test', '{}')$$, 'canal e-mail sur l''intégration e-mail');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999', 'email', 'm@cz.test', '{}')$$, '42501', null, 'marketing ne crée pas de canal');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999', 'email', 's@cz.test', '{}')$$, '42501', null, 'commercial ne crée pas de canal');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.channels), 2, 'owner A lit ses 2 canaux');
select lives_ok($$select public.update_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.channels where sender_identity = '+212600000001'), null, true)$$, 'owner met le canal en pause');
select is((select send_paused from public.channels where sender_identity = '+212600000001'), true, 'send_paused vrai');
select is((select cardinality(project_scope) from public.channels where sender_identity = '+212600000001'), 1, 'portée inchangée quand elle n''est pas fournie');
select throws_ok($$select public.update_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.channels where sender_identity = '+212600000001'), array['cc000000-0000-4000-8000-0000000000b1']::uuid[], null)$$, '22023', null, 'portée vers un projet étranger refusée');
select throws_ok($$select public.update_channel('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999', null, true)$$, 'PT404', null, 'canal inconnu : introuvable');
select throws_ok($$insert into public.channels (organization_id, type, integration_id, sender_identity) values ('cb000000-0000-4000-8000-00000000000a', 'email', gen_random_uuid(), 'direct@cz.test')$$, '42501', null, 'INSERT direct sur channels refusé');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.channels), 0, 'analyste ne voit aucun canal');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.channels), 0, 'owner B ne voit aucun canal d''Alpha');
select throws_ok($$select public.update_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.channels limit 1), null, false)$$, '42501', null, 'owner B ne modifie pas un canal d''Alpha');
reset role;

select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-mail-a'), 'email', 'pas-une-adresse', '{}')$$, '22023', null, 'identité e-mail mal formée refusée');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-mail-a'), 'email', 'a b@cz.test', '{}')$$, '22023', null, 'identité e-mail avec espace refusée');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', '0600000001', '{}')$$, '22023', null, 'numéro WhatsApp hors E.164 refusé');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', 'ventes@cz.test', '{}')$$, '22023', null, 'une adresse e-mail n''est pas un numéro WhatsApp');
reset role;

-- le chiffré n'est servi que pour les statuts pending, active et error
update public.integrations set status = 'disabled' where external_account_id = 'cz-wa-a';
select is((select private.get_integration_secret('cb000000-0000-4000-8000-00000000000a', i.id) from public.integrations i where i.external_account_id = 'cz-wa-a'), null, 'une intégration désactivée ne sert plus son secret');
update public.integrations set status = 'error' where external_account_id = 'cz-wa-a';
select isnt((select private.get_integration_secret('cb000000-0000-4000-8000-00000000000a', i.id) from public.integrations i where i.external_account_id = 'cz-wa-a'), null, 'en erreur : le secret reste lisible (pour retenter la validation)');
update public.integrations set status = 'pending' where external_account_id = 'cz-wa-a';

-- ---------------------------------------------------------------------------
-- Déconnexion
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select throws_ok($$select public.disconnect_integration('cb000000-0000-4000-8000-00000000000a', '99999999-9999-4999-8999-999999999999')$$, '42501', null, 'marketing ne déconnecte pas');
reset role;
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select lives_ok($$select public.disconnect_integration('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'))$$, 'owner déconnecte l''intégration whatsapp');
select is((select status || ':' || has_secret::text from public.integrations where external_account_id = 'cz-wa-a'), 'disconnected:false', 'statut disconnected, plus de secret');
select is((select status || ':' || send_paused::text from public.channels where sender_identity = '+212600000001'), 'disconnected:true', 'ses canaux sont déconnectés et en pause');
select lives_ok($$select public.disconnect_integration('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'))$$, 'déconnecter deux fois est sans effet');
-- reconnexion : remplacer le jeton d'une intégration déconnectée la remet en attente de validation, ses canaux restent en pause
select lives_ok($$select public.set_integration_secret('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'),
  'cd000000-0000-4000-8000-000000000014', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', 'QkJCQkJCQkJCQkJC', 2)$$, 'reconnexion : un nouveau jeton remet l''intégration déconnectée en attente');
select is((select status || ':' || has_secret::text from public.integrations where external_account_id = 'cz-wa-a'), 'pending:true', 'statut pending, jeton présent');
select is((select status || ':' || send_paused::text from public.channels where sender_identity = '+212600000001'), 'pending:true', 'ses canaux redeviennent pending mais RESTENT en pause');
select lives_ok($$select public.update_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.channels where sender_identity = '+212600000001'), null, false)$$, 'le propriétaire relance le canal après la reconnexion');
select lives_ok($$select public.disconnect_integration('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'))$$, 'et peut déconnecter de nouveau');
select throws_ok($$select public.update_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.channels where sender_identity = '+212600000001'), null, false)$$, 'P0001', 'integration_not_replaceable', 'un canal déconnecté ne se modifie plus');
select throws_ok($$select public.create_channel('cb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cz-wa-a'), 'whatsapp', '+212600000009', '{}')$$, 'P0001', 'integration_not_replaceable', 'pas de nouveau canal sur une intégration déconnectée');
reset role;
select is((select count(*)::int from private.secrets where id in ('cd000000-0000-4000-8000-000000000010', 'cd000000-0000-4000-8000-000000000014')), 0, 'les secrets ont été supprimés à la déconnexion');
select is((select private.get_integration_secret('cb000000-0000-4000-8000-00000000000a', i.id) from public.integrations i where i.external_account_id = 'cz-wa-a'), null, 'plus aucun secret lisible');

-- ---------------------------------------------------------------------------
-- Audit : identifiants et noms de champs, jamais de secret
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from public.audit_logs where organization_id = 'cb000000-0000-4000-8000-00000000000a' and action = 'integration.created'), 'audit : integration.created');
select ok(exists (select 1 from public.audit_logs where organization_id = 'cb000000-0000-4000-8000-00000000000a' and action = 'integration.secret_rotated'), 'audit : integration.secret_rotated');
select ok(exists (select 1 from public.audit_logs where organization_id = 'cb000000-0000-4000-8000-00000000000a' and action = 'integration.disconnected'), 'audit : integration.disconnected');
select ok(exists (select 1 from public.audit_logs where organization_id = 'cb000000-0000-4000-8000-00000000000a' and action = 'integration.reconnected'), 'audit : integration.reconnected');
select ok(exists (select 1 from public.audit_logs where organization_id = 'cb000000-0000-4000-8000-00000000000a' and action = 'channel.created'), 'audit : channel.created');
select ok(exists (select 1 from public.audit_logs where organization_id = 'cb000000-0000-4000-8000-00000000000a' and action = 'channel.updated'), 'audit : channel.updated');
select is((select count(*)::int from public.audit_logs a where a.organization_id = 'cb000000-0000-4000-8000-00000000000a'
  and (a.action like 'integration.%' or a.action like 'channel.%')
  and to_jsonb(a)::text ~* '(QUJDREVG|QkJCQkJC|ciphertext|nonce|\+2126000000|ventes@cz)'), 0, 'aucun chiffré, nonce, expéditeur ni numéro dans l''audit');

select * from finish();
rollback;
