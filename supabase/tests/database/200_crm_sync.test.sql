-- J25 — Synchro CRM : intégrations, mapping de champs, demande / rejeu / statut de synchro (owner et admin), fonctions du worker (service_role)
-- pour les contacts (recherche, création, mise à jour, rattachement, conflits audités, fin et échec), « ne plus contacter » intact, aucun
-- consentement créé, isolation entre entreprises, audit sans valeur. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(107);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ba000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@cy.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('bb000000-0000-4000-8000-00000000000a', 'CY Alpha', 'cy-alpha-test'),
  ('bb000000-0000-4000-8000-00000000000b', 'CY Beta', 'cy-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('bb000000-0000-4000-8000-00000000000b', 'ba000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('bb000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('bb000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('bc000000-0000-4000-8000-0000000000a1', 'bb000000-0000-4000-8000-00000000000a', 'website_sales', 'CY site', 'active', '{}');
-- fichier CSV déjà envoyé (lot « uploaded » de l'assistant d'import)
insert into public.import_batches (id, organization_id, project_id, file_path, file_size) values
  ('bd000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-00000000000a', 'bc000000-0000-4000-8000-0000000000a1',
   'bb000000-0000-4000-8000-00000000000a/bd000000-0000-4000-8000-000000000001.csv', 100);
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164, language, country, external_source, external_id, do_not_contact) values
  ('be000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-00000000000a', 'Existant', 'existant@cy.test', 'existant@cy.test', '+212600000011', 'fr', 'MA', null, null, false),
  ('be000000-0000-4000-8000-000000000002', 'bb000000-0000-4000-8000-00000000000a', 'Déjà lié', 'lie@cy.test', 'lie@cy.test', null, 'fr', 'MA', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-lie', false),
  ('be000000-0000-4000-8000-000000000003', 'bb000000-0000-4000-8000-00000000000a', 'Désinscrit', 'stop@cy.test', 'stop@cy.test', null, null, null, null, null, true);

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
grant execute on function pg_temp.as_service() to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'integrations', 'integrations existe');
select has_table('public', 'crm_field_mappings', 'crm_field_mappings existe');
select ok((select relrowsecurity from pg_class where oid = 'public.integrations'::regclass), 'RLS activée sur integrations');
select ok((select relrowsecurity from pg_class where oid = 'public.crm_field_mappings'::regclass), 'RLS activée sur crm_field_mappings');
select ok(not has_table_privilege('authenticated', 'public.integrations', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur les intégrations');
select ok(not has_table_privilege('authenticated', 'public.crm_field_mappings', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur les mappings');
select ok(not has_table_privilege('service_role', 'public.integrations', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur les intégrations');
select ok(not has_table_privilege('service_role', 'public.crm_field_mappings', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur les mappings');
select ok(not has_table_privilege('anon', 'public.integrations', 'select'), 'anon : aucun droit sur les intégrations');
select ok(not has_function_privilege('authenticated', 'public.crm_sync_create(uuid, text, text, text, text, text, text, text, text)', 'execute'), 'authenticated : crm_sync_create non exécutable');
select ok(not has_function_privilege('authenticated', 'public.crm_sync_update(uuid, uuid, text, text, jsonb)', 'execute'), 'authenticated : crm_sync_update non exécutable');
select ok(not has_function_privilege('anon', 'public.crm_sync_start(uuid, uuid, uuid)', 'execute'), 'anon : crm_sync_start non exécutable');
select ok(has_function_privilege('service_role', 'public.crm_sync_finish(uuid, uuid, uuid, timestamptz, jsonb)', 'execute'), 'service_role : crm_sync_finish exécutable');
select ok(not has_function_privilege('service_role', 'public.save_crm_mappings(uuid, uuid, jsonb)', 'execute'), 'service_role : save_crm_mappings non exécutable');
select ok(not has_function_privilege('anon', 'public.create_integration(uuid, text, text)', 'execute'), 'anon : create_integration non exécutable');

-- 2. Intégrations ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_integration('bb000000-0000-4000-8000-00000000000a', 'csv', 'compte-1')$$, '42501', null, 'commercial : refusé');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_integration('bb000000-0000-4000-8000-00000000000a', 'csv', 'compte-1')$$, '42501', null, 'marketing : refusé');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_integration('bb000000-0000-4000-8000-00000000000a', 'csv', 'compte-1')$$, '42501', null, 'owner d''une autre entreprise : refusé');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_integration('bb000000-0000-4000-8000-00000000000a', 'salla', 'compte-1')$$, '22023', null, 'fournisseur inconnu refusé');
select throws_ok($$select public.create_integration('bb000000-0000-4000-8000-00000000000a', 'csv', 'compte avec espaces')$$, '22023', null, 'identifiant de compte mal formé refusé');
select set_config('t.int', public.create_integration('bb000000-0000-4000-8000-00000000000a', 'csv', 'compte-1')::text, true);
select ok(current_setting('t.int')::uuid is not null, 'owner : crée une intégration CSV');
select throws_ok($$select public.create_integration('bb000000-0000-4000-8000-00000000000a', 'csv', 'compte-1')$$, '23505', null, 'même fournisseur et même compte : conflit');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000002');
select set_config('t.int_internal', public.create_integration('bb000000-0000-4000-8000-00000000000a', 'internal', 'interne')::text, true);
select ok(current_setting('t.int_internal')::uuid is not null, 'admin : crée l''intégration « internal »');
reset role;

-- 3. Mapping ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[]')$$, '42501', null, 'commercial : ne modifie pas le mapping');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"}]')$$, '22023', null, 'moins de 2 entrées : refusé');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"},{"internal_field":"email","external_field":"Mail","source_of_truth":"internal","direction":"pull"}]')$$, '22023', null, 'sans external_id : refusé');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"both"},{"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"}]')$$, '22023', null, 'external_id en sens autre que pull : refusé');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull"},{"internal_field":"do_not_contact","external_field":"Stop","source_of_truth":"external","direction":"pull"}]')$$, '22023', null, 'champ interne hors liste blanche : refusé');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull"},{"internal_field":"name","external_field":"ID","source_of_truth":"internal","direction":"both"}]')$$, '22023', null, 'même colonne externe deux fois : refusé');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull","organization_id":"x"},{"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"}]')$$, '22023', null, 'clé inconnue dans une entrée : refusée');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', gen_random_uuid(), '[{"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull"},{"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"}]')$$, 'PT404', null, 'intégration inconnue : introuvable');
select lives_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[
  {"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull"},
  {"internal_field":"external_updated_at","external_field":"Modifié le","source_of_truth":"external","direction":"pull"},
  {"internal_field":"email","external_field":"E-mail","source_of_truth":"internal","direction":"pull"},
  {"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"},
  {"internal_field":"country","external_field":"Pays","source_of_truth":"external","direction":"both"}]')$$, 'owner : enregistre le mapping');
select is((select count(*)::int from public.crm_field_mappings where integration_id = current_setting('t.int')::uuid), 5, 'mapping : 5 entrées');
select lives_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[
  {"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull"},
  {"internal_field":"external_updated_at","external_field":"Modifié le","source_of_truth":"external","direction":"pull"},
  {"internal_field":"email","external_field":"E-mail","source_of_truth":"internal","direction":"pull"},
  {"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"},
  {"internal_field":"country","external_field":"Pays","source_of_truth":"external","direction":"both"}]')$$, 'enregistrer deux fois : remplace sans doublon');
select is((select count(*)::int from public.crm_field_mappings where integration_id = current_setting('t.int')::uuid), 5, 'toujours 5 entrées après remplacement');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[]')$$, '42501', null, 'owner d''une autre entreprise : refusé');
reset role;

-- 4. Lecture ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.integrations), 2, 'admin : lit les intégrations');
select is((select count(*)::int from public.crm_field_mappings), 5, 'admin : lit le mapping');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.integrations), 0, 'marketing : ne lit aucune intégration');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.crm_field_mappings), 0, 'commercial : ne lit aucun mapping');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.integrations), 0, 'owner d''une autre entreprise : ne lit rien');
reset role;

-- 5. Demande, statut et rejeu --------------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select is((public.crm_sync_status('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid) ->> 'status'), 'never', 'statut : jamais synchronisé');
select throws_ok($$select public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int_internal')::uuid, 'bd000000-0000-4000-8000-000000000001')$$, '22023', null, 'fournisseur « internal » : pas de synchro de fichier');
select throws_ok($$select public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, gen_random_uuid())$$, 'PT404', null, 'fichier inconnu : introuvable');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select throws_ok($$select public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001')$$, '42501', null, 'commercial : refusé');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select throws_ok($$select public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001')$$, '42501', null, 'owner d''une autre entreprise : refusé');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select set_config('t.job', public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001')::text, true);
select ok(current_setting('t.job')::uuid is not null, 'owner : demande une synchro');
select throws_ok($$select public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001')$$, 'P0001', null, 'une synchro est déjà en cours : refusé');
select is((public.crm_sync_status('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid) ->> 'status'), 'queued', 'statut : en file');
reset role;
select is((select payload::text from public.jobs where id = current_setting('t.job')::uuid), format('{"batch_id": "bd000000-0000-4000-8000-000000000001", "integration_id": "%s"}', current_setting('t.int')), 'job crm_sync : identifiants seulement');
update public.jobs set status = 'dead_letter', last_error = 'x' where id = current_setting('t.job')::uuid;
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select is((public.crm_sync_status('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid) ->> 'status'), 'failed', 'statut : échec (job en échec définitif)');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000003');
select throws_ok($$select public.retry_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid)$$, '42501', null, 'marketing : ne rejoue pas');
select throws_ok($$select public.crm_sync_status('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid)$$, '42501', null, 'marketing : ne lit pas le statut');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select is(public.retry_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid), true, 'owner : rejoue la synchro en échec');
select is((public.crm_sync_status('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid) ->> 'status'), 'queued', 'statut : de nouveau en file');
select is(public.retry_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid), false, 'rejouer ce qui n''est pas en échec : sans effet');
reset role;
select is((select count(*)::int from public.jobs where kind = 'crm_sync'), 1, 'un seul job (rejeu sans doublon)');

-- 6. Worker : démarrage --------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select is((public.crm_sync_start('bb000000-0000-4000-8000-00000000000b', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001') ->> 'status'), 'missing', 'démarrage avec une AUTRE entreprise : intégration introuvable');
select is((public.crm_sync_start('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, gen_random_uuid()) ->> 'status'), 'file_missing', 'fichier absent : « file_missing »');
select is((public.crm_sync_start('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001') ->> 'path'), 'bb000000-0000-4000-8000-00000000000a/bd000000-0000-4000-8000-000000000001.csv', 'démarrage : chemin du fichier lu en base');
select is((jsonb_array_length(public.crm_sync_start('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001') -> 'mappings')), 5, 'démarrage : mapping transmis');

-- 7. Worker : recherche, création, mise à jour ----------------------------------------------------------------------------------
select is((public.crm_sync_find('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'inconnu', 'nouveau@cy.test', null)), null::jsonb, 'recherche : rien');
select is((public.crm_sync_find('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-lie', null, null) ->> 'id'), 'be000000-0000-4000-8000-000000000002', 'recherche par identifiant externe');
select is((public.crm_sync_find('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-lie', null, null) ->> 'linked'), 'true', 'identifiant externe : déjà rattaché');
select is((public.crm_sync_find('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-9', 'existant@cy.test', null) ->> 'linked'), 'false', 'recherche par e-mail : contact rattachable');
select is((public.crm_sync_find('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-9', 'lie@cy.test', null) ->> 'status'), 'identity_taken', 'e-mail d''un contact déjà lié à un AUTRE identifiant : jamais rattaché');
select is((public.crm_sync_find('bb000000-0000-4000-8000-00000000000b', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-lie', null, null)), null::jsonb, 'recherche dans une autre entreprise : rien');
select is((public.crm_sync_create('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-new', 'Nouveau', 'Nouveau@cy.test', 'nouveau@cy.test', '+212611111111', 'fr', 'MA') ->> 'status'), 'created', 'création d''un contact');
select is((public.crm_sync_create('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-new', 'Nouveau', 'autre@cy.test', 'autre@cy.test', null, null, null) ->> 'status'), 'exists', 'même identifiant externe : déjà créé (rejeu sans doublon)');
select is((public.crm_sync_create('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-x', 'X', 'pas-un-email', 'pas-un-email', null, null, null) ->> 'status'), 'invalid', 'e-mail invalide : refusé');
select is((public.crm_sync_create('bb000000-0000-4000-8000-00000000000a', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-y', 'Y', null, null, null, 'fra', null) ->> 'status'), 'invalid', 'sans identité : refusé');
select is((public.crm_sync_update('bb000000-0000-4000-8000-00000000000a', 'be000000-0000-4000-8000-000000000001', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-1', '{"name": "Renommé", "country": "SA"}') ->> 'status'), 'updated', 'mise à jour : nom et pays');
reset role;
select is((select name || ':' || country || ':' || external_id from public.contacts where id = 'be000000-0000-4000-8000-000000000001'), 'Renommé:SA:ext-1', 'le contact est mis à jour et RATTACHÉ à l''identifiant externe');
select is((select email_normalized || ':' || phone_e164 from public.contacts where id = 'be000000-0000-4000-8000-000000000001'), 'existant@cy.test:+212600000011', 'l''identité n''est pas modifiée');
select pg_temp.as_service();
select is((public.crm_sync_update('bb000000-0000-4000-8000-00000000000a', 'be000000-0000-4000-8000-000000000003', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-stop', '{"name": "Piraté"}') ->> 'status'), 'do_not_contact', 'contact « ne plus contacter » : jamais modifié');
select is((public.crm_sync_update('bb000000-0000-4000-8000-00000000000a', 'be000000-0000-4000-8000-000000000002', 'csv:7f000000-0000-4000-8000-000000000001', 'autre-id', '{"name": "Piraté"}') ->> 'status'), 'identity_taken', 'contact lié à un autre identifiant : jamais écrasé');
select throws_ok($$select public.crm_sync_update('bb000000-0000-4000-8000-00000000000a', 'be000000-0000-4000-8000-000000000001', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-1', '{"email_normalized": "x@y.z"}')$$, '22023', null, 'champ hors liste blanche (identité) : refusé');
select throws_ok($$select public.crm_sync_update('bb000000-0000-4000-8000-00000000000a', 'be000000-0000-4000-8000-000000000001', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-1', '{"do_not_contact": false}')$$, '22023', null, 'do_not_contact : jamais modifiable par une synchro');
select is((public.crm_sync_update('bb000000-0000-4000-8000-00000000000b', 'be000000-0000-4000-8000-000000000001', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-1', '{"name": "Autre entreprise"}') ->> 'status'), 'not_found', 'contact d''une autre entreprise : introuvable');
reset role;
select is((select name from public.contacts where id = 'be000000-0000-4000-8000-000000000001'), 'Renommé', 'le contact d''Alpha n''a pas été touché par Beta');
select is((select count(*)::int from public.consent_events where organization_id = 'bb000000-0000-4000-8000-00000000000a'), 0, 'AUCUN consentement créé par la synchro');

-- 8. Worker : conflits, fin, échec ------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select lives_ok($$select public.crm_sync_audit_conflict('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'be000000-0000-4000-8000-000000000001', '[{"field": "name", "winner": "internal"}]')$$, 'conflit consigné');
select throws_ok($$select public.crm_sync_audit_conflict('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'be000000-0000-4000-8000-000000000001', '[{"field": "email", "winner": "internal"}]')$$, '22023', null, 'conflit sur un champ hors liste : refusé');
select throws_ok($$select public.crm_sync_audit_conflict('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'be000000-0000-4000-8000-000000000001', '[]')$$, '22023', null, 'liste de conflits vide : refusée');
select throws_ok($$select public.crm_sync_finish('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001', now(), '{"email": 3}')$$, '22023', null, 'compteur inconnu refusé');
select throws_ok($$select public.crm_sync_finish('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001', now(), '{"created": "x@y.z"}')$$, '22023', null, 'compteur non numérique refusé');
select throws_ok($$select public.crm_sync_finish('bb000000-0000-4000-8000-00000000000b', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001', now(), '{"created": 1}')$$, 'PT404', null, 'fin avec une AUTRE entreprise : introuvable');
select lives_ok($$select public.crm_sync_fail('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'file_malformed')$$, 'échec enregistré (code)');
select throws_ok($$select public.crm_sync_fail('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'secret@x.com')$$, '22023', null, 'code d''échec libre refusé');
reset role;
select is((select last_error from public.integrations where id = current_setting('t.int')::uuid), 'file_malformed', 'dernière erreur visible');
select pg_temp.as_service();
select lives_ok($$select public.crm_sync_finish('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001', now() - interval '1 minute', '{"created": 1, "updated": 1, "conflicts": 1}')$$, 'synchro terminée');
reset role;
select ok((select last_sync_at is not null and last_error is null from public.integrations where id = current_setting('t.int')::uuid), 'dernière synchro enregistrée, erreur effacée');

-- 8b. Revue sécurité : lot consommé, abonnement, source propre à l'intégration -------------------------------------------------------------
select is((select status from public.import_batches where id = 'bd000000-0000-4000-8000-000000000001'), 'synced', 'le lot de fichier est CONSOMMÉ par la synchro (statut « synced »)');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.request_crm_sync('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001')$$, 'PT404', null, 'lot consommé : plus synchronisable');
select throws_ok($$select public.confirm_import('bb000000-0000-4000-8000-00000000000a', 'bd000000-0000-4000-8000-000000000001', '{"email": 1}', 'MA', 1)$$, 'P0001', null, 'lot consommé : plus importable (pas de double traitement du fichier)');
reset role;
select pg_temp.as_service();
select is((public.crm_sync_start('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, 'bd000000-0000-4000-8000-000000000001') ->> 'status'), 'missing', 'rejeu d''un job dont le lot est consommé : rien à refaire');
reset role;
select ok((select last_sync_finished_at >= last_sync_at from public.integrations where id = current_setting('t.int')::uuid), 'curseur de FIN enregistré (au moins égal au début)');
update public.subscriptions set status = 'suspended' where organization_id = 'bb000000-0000-4000-8000-00000000000a';
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.save_crm_mappings('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, '[{"internal_field":"external_id","external_field":"ID","source_of_truth":"external","direction":"pull"},{"internal_field":"name","external_field":"Nom","source_of_truth":"internal","direction":"both"}]')$$, 'P0001', null, 'abonnement suspendu : mapping non modifiable');
reset role;
select pg_temp.as_service();
select throws_ok($$select public.crm_sync_start('bb000000-0000-4000-8000-00000000000a', current_setting('t.int')::uuid, gen_random_uuid())$$, 'P0001', null, 'abonnement suspendu : synchro non démarrée');
select throws_ok($$select public.crm_sync_update('bb000000-0000-4000-8000-00000000000a', 'be000000-0000-4000-8000-000000000001', 'csv:7f000000-0000-4000-8000-000000000001', 'ext-1', '{"name": "Suspendu"}')$$, 'P0001', null, 'abonnement suspendu : contact non mis à jour');
reset role;
update public.subscriptions set status = 'active' where organization_id = 'bb000000-0000-4000-8000-00000000000a';
select pg_temp.as_service();
select is((public.crm_sync_create('bb000000-0000-4000-8000-00000000000a', 'csv', 'ext-z', 'Z', 'z@cy.test', 'z@cy.test', null, null, null) ->> 'status'), 'invalid', 'source « csv » seule (partagée entre intégrations) : refusée, il faut csv:<identifiant d''intégration>');
reset role;

-- 9. Audit sans valeur ----------------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from public.audit_logs where action = 'integration.created'), 'audit : integration.created');
select ok(exists (select 1 from public.audit_logs where action = 'crm_mapping.saved'), 'audit : crm_mapping.saved');
select ok(exists (select 1 from public.audit_logs where action = 'crm_sync.conflict' and actor_kind = 'system' and (after -> 'conflicts' -> 0 ->> 'winner') = 'internal'), 'audit : conflit (champ et gagnant, acteur système)');
select ok(exists (select 1 from public.audit_logs where action = 'crm_sync.completed' and (after ->> 'created')::int = 1), 'audit : synchro terminée avec compteurs');
select ok(exists (select 1 from public.audit_logs where action = 'crm_sync.failed' and after ->> 'error' = 'file_malformed'), 'audit : échec avec code');
select is((select count(*)::int from public.audit_logs where action like 'crm\_%' and (after::text like '%@%' or after::text like '%Renommé%' or after::text like '%Nouveau%')), 0, 'audit : aucune valeur de contact');

select * from finish();
rollback;
