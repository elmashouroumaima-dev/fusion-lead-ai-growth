-- J23 — Import CSV : droits, politiques Storage, lots (création, confirmation, annulation), dédup en lecture seule, fonctions du worker
-- (import_row : création, doublon dans le fichier, rejeu, « ne plus contacter », quota), rapport sans donnée de contact, aucun
-- consentement créé, isolation entre entreprises, audit. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(117);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@im.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('eb000000-0000-4000-8000-00000000000a', 'IM Alpha', 'im-alpha-test'),
  ('eb000000-0000-4000-8000-00000000000b', 'IM Beta', 'im-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('eb000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('ec000000-0000-4000-8000-0000000000a1', 'eb000000-0000-4000-8000-00000000000a', 'website_sales', 'IM site', 'active', '{}'),
  ('ec000000-0000-4000-8000-0000000000a2', 'eb000000-0000-4000-8000-00000000000a', 'custom', 'IM archivé', 'archived', '{}'),
  ('ec000000-0000-4000-8000-0000000000b1', 'eb000000-0000-4000-8000-00000000000b', 'custom', 'IM beta', 'active', '{}');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164, do_not_contact) values
  ('ed000000-0000-4000-8000-0000000000e1', 'eb000000-0000-4000-8000-00000000000a', 'Existant', 'existant@im.test', 'existant@im.test', '+212600000011', false),
  ('ed000000-0000-4000-8000-0000000000e2', 'eb000000-0000-4000-8000-00000000000a', 'Désinscrit', 'stop@im.test', 'stop@im.test', null, true);

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
-- chemin d'un lot : {entreprise}/{lot}.csv
create function pg_temp.pth(p_org text, p_n int) returns text language sql as $f$
  select p_org || '/ee000000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0') || '.csv' $f$;
grant execute on function pg_temp.pth(text, int) to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'import_batches', 'import_batches existe');
select has_table('public', 'import_rows', 'import_rows existe');
select ok((select relrowsecurity from pg_class where oid = 'public.import_batches'::regclass), 'RLS activée sur import_batches');
select ok((select relrowsecurity from pg_class where oid = 'public.import_rows'::regclass), 'RLS activée sur import_rows');
select ok(not has_table_privilege('authenticated', 'public.import_batches', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur les lots');
select ok(not has_table_privilege('authenticated', 'public.import_rows', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur le rapport');
select ok(not has_table_privilege('service_role', 'public.import_batches', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur les lots');
select ok(not has_table_privilege('service_role', 'public.import_rows', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur le rapport');
select ok(not has_table_privilege('anon', 'public.import_batches', 'select'), 'anon : aucun droit sur les lots');
select ok(not has_column_privilege('authenticated', 'public.import_batches', 'file_path', 'select'), 'authenticated : ne lit pas le chemin du fichier');
select ok(not has_column_privilege('authenticated', 'public.import_batches', 'mapping', 'select'), 'authenticated : ne lit pas le mapping');
select ok(not has_column_privilege('authenticated', 'public.import_rows', 'contact_id', 'select'), 'authenticated : ne lit pas le contact d''une ligne');
select ok(has_function_privilege('service_role', 'public.import_row(uuid, uuid, integer, text, text, text, text, text, text)', 'execute'), 'service_role : import_row exécutable');
select ok(not has_function_privilege('authenticated', 'public.import_row(uuid, uuid, integer, text, text, text, text, text, text)', 'execute'), 'authenticated : import_row non exécutable');
select ok(not has_function_privilege('anon', 'public.import_row(uuid, uuid, integer, text, text, text, text, text, text)', 'execute'), 'anon : import_row non exécutable');
select ok(not has_function_privilege('authenticated', 'public.import_start(uuid, uuid)', 'execute'), 'authenticated : import_start non exécutable');
select ok(not has_function_privilege('authenticated', 'public.import_finish(uuid, uuid, integer)', 'execute'), 'authenticated : import_finish non exécutable');
select ok(not has_function_privilege('service_role', 'public.confirm_import(uuid, uuid, jsonb, text, integer)', 'execute'), 'service_role : confirm_import non exécutable');
select ok(not has_function_privilege('anon', 'public.create_import_batch(uuid, uuid, text, integer)', 'execute'), 'anon : create_import_batch non exécutable');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'imports\_%'), 3, 'bucket imports : trois politiques (lecture, envoi, suppression)');
select ok((select not public from storage.buckets where id = 'imports'), 'bucket imports privé');
select is((select file_size_limit from storage.buckets where id = 'imports'), 10485760::bigint, 'bucket imports : 10 Mo');

-- 2. Politiques Storage : owner et admin de l'entreprise du chemin --------------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('imports', %L)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), 'owner : envoie un fichier dans le dossier de son entreprise');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('imports', %L)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000b', 90)), '42501', null, 'owner : pas dans le dossier d''une autre entreprise');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('imports', 'eb000000-0000-4000-8000-00000000000a/fichier.csv')$$, '42501', null, 'chemin mal formé refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('imports', %L)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 91)), '42501', null, 'marketing : ne peut pas envoyer');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('imports', %L)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 92)), '42501', null, 'commercial : ne peut pas envoyer');
select is((select count(*)::int from storage.objects where bucket_id = 'imports'), 0, 'commercial : ne lit aucun fichier d''import');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is((select count(*)::int from storage.objects where bucket_id = 'imports' and name = pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), 1, 'admin : lit le fichier de son entreprise');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is((select count(*)::int from storage.objects where bucket_id = 'imports'), 0, 'owner d''une autre entreprise : ne lit rien');
reset role;
-- fichiers préparés pour la suite (postgres)
insert into storage.objects (bucket_id, name) values
  ('imports', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 2)),
  ('imports', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 3)),
  ('imports', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 4)),
  ('imports', pg_temp.pth('eb000000-0000-4000-8000-00000000000b', 5));

-- 3. Création d'un lot -------------------------------------------------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '42501', null, 'commercial : refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '42501', null, 'marketing : refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '42501', null, 'analyste : refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '42501', null, 'owner d''une autre entreprise : refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 0)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '22023', null, 'taille nulle refusée');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 10485761)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '22023', null, 'plus de 10 Mo refusé');
select throws_ok($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', 'n-importe-quoi.csv', 1000)$$, '22023', null, 'chemin mal formé refusé');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000b', 5)), '22023', null, 'chemin d''une autre entreprise refusé');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 77)), '22023', null, 'fichier absent du Storage : refusé');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a2', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), 'P0001', null, 'projet archivé refusé');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000b1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), 'PT404', null, 'projet d''une autre entreprise : introuvable');
select is(public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1), 1000)::text,
  'ee000000-0000-4000-8000-000000000001', 'owner : crée le lot (identifiant = celui du chemin)');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 1)), '23505', null, 'même fichier enregistré deux fois : conflit');
select is(public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 2), 500)::text,
  'ee000000-0000-4000-8000-000000000002', 'owner : crée un deuxième lot');
select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 3), 500);
reset role;
select is((select status from public.import_batches where id = 'ee000000-0000-4000-8000-000000000001'), 'uploaded', 'lot créé : statut « uploaded »');
select is((select count(*)::int from public.contacts where organization_id = 'eb000000-0000-4000-8000-00000000000a' and created_at > now() - interval '1 minute' and email_normalized is distinct from 'existant@im.test' and email_normalized is distinct from 'stop@im.test'), 0, 'rien n''est écrit dans les contacts avant la confirmation');

-- 4. Lecture, dédup en lecture seule -----------------------------------------------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.import_batches), 3, 'admin : lit les lots de son entreprise');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.import_batches), 0, 'marketing : ne lit aucun lot');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.import_batches), 0, 'commercial : ne lit aucun lot');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.import_batches), 0, 'owner d''une autre entreprise : ne lit aucun lot');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select is((public.import_dedup_check('eb000000-0000-4000-8000-00000000000a', array['existant@im.test', 'nouveau@im.test'], array['+212600000011', '+212699999999']))::text,
  '{"emails": ["existant@im.test"], "phones": ["+212600000011"]}'::jsonb::text, 'dédup : indique les e-mails et téléphones déjà connus');
select throws_ok($$select public.import_dedup_check('eb000000-0000-4000-8000-00000000000a', (select array_agg('a' || n || '@x.test') from generate_series(1, 1001) n), null)$$, '22023', null, 'dédup : 1000 valeurs au plus');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select throws_ok($$select public.import_dedup_check('eb000000-0000-4000-8000-00000000000a', array['existant@im.test'], null)$$, '42501', null, 'dédup : marketing refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select throws_ok($$select public.import_dedup_check('eb000000-0000-4000-8000-00000000000a', array['existant@im.test'], null)$$, '42501', null, 'dédup : autre entreprise refusée');
reset role;

-- 5. Confirmation et annulation -------------------------------------------------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"name": 0}', 'MA', 10)$$, '22023', null, 'mapping sans e-mail ni téléphone : refusé');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 1, "phone": 1}', 'MA', 10)$$, '22023', null, 'mapping : colonne partagée refusée');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 1, "role": 2}', 'MA', 10)$$, '22023', null, 'mapping : champ inconnu refusé');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 50}', 'MA', 10)$$, '22023', null, 'mapping : rang hors limite refusé');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 1}', 'ma', 10)$$, '22023', null, 'pays par défaut mal formé refusé');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-0000000000ff', '{"email": 1}', 'MA', 10)$$, 'PT404', null, 'lot inconnu : introuvable');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 1}', 'MA', 10)$$, '42501', null, 'marketing : refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 1}', 'MA', 10)$$, '42501', null, 'owner d''une autre entreprise : refusé');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select lives_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"name": 0, "email": 1, "phone": 2}', 'MA', 6)$$, 'owner : confirme le lot');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', '{"email": 1}', 'MA', 6)$$, 'P0001', null, 'confirmation répétée : refusée');
select lives_ok($$select public.cancel_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000002')$$, 'owner : annule un lot envoyé');
select throws_ok($$select public.cancel_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000002')$$, 'P0001', null, 'annulation répétée : refusée');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000002', '{"email": 1}', 'MA', 6)$$, 'P0001', null, 'lot annulé : confirmation refusée');
reset role;
select is((select status from public.import_batches where id = 'ee000000-0000-4000-8000-000000000001'), 'queued', 'lot confirmé : « queued »');
select is((select payload::text from public.jobs where kind = 'import_csv' and organization_id = 'eb000000-0000-4000-8000-00000000000a'), '{"batch_id": "ee000000-0000-4000-8000-000000000001"}', 'job import_csv : identifiant du lot seulement');
select is((select count(*)::int from public.contacts where organization_id = 'eb000000-0000-4000-8000-00000000000a'), 2, 'confirmer n''écrit encore aucun contact (le worker s''en charge)');

-- 6. Worker : lecture du fichier, lignes, rapport -------------------------------------------------------------------------------------
select pg_temp.as_service();
select is((public.import_start('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000001') ->> 'status'), 'missing', 'import_start avec une AUTRE entreprise : lot introuvable');
select is((public.import_start('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000002') ->> 'status'), 'cancelled', 'import_start : lot annulé, rien à faire');
select is((public.import_start('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001'))::text,
  '{"path": "eb000000-0000-4000-8000-00000000000a/ee000000-0000-4000-8000-000000000001.csv", "status": "running", "mapping": {"name": 0, "email": 1, "phone": 2}, "project_id": "ec000000-0000-4000-8000-0000000000a1", "default_country": "MA"}'::jsonb::text,
  'import_start : état « running » et paramètres du fichier');
select is((public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 2, 'Nadia', 'Nadia@im.test', 'nadia@im.test', '+212612345678', null, null))::text,
  '{"reason": null, "outcome": "created", "lead_created": true}'::jsonb::text, 'ligne 2 : contact et lead créés');
select is((public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 3, 'Nadia bis', 'nadia@im.test', 'nadia@im.test', null, null, null))::text,
  '{"reason": "duplicate_in_file", "outcome": "matched", "lead_created": false}'::jsonb::text, 'ligne 3 : même e-mail dans le fichier = doublon, aucun nouveau lead');
select is((public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 4, null, null, null, '+212600000011', null, null))::text,
  '{"reason": null, "outcome": "matched", "lead_created": true}'::jsonb::text, 'ligne 4 : téléphone d''un contact existant = rattaché, lead créé');
select is((public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 5, 'Stop', 'stop@im.test', 'stop@im.test', null, null, null))::text,
  '{"reason": "do_not_contact", "outcome": "skipped", "lead_created": false}'::jsonb::text, 'ligne 5 : « ne plus contacter » ignoré');
select is((public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 2, 'Autre nom', 'nadia@im.test', 'nadia@im.test', null, null, null))::text,
  '{"reason": null, "outcome": "created", "lead_created": true}'::jsonb::text, 'rejeu de la ligne 2 : résultat déjà enregistré, rien de plus');
select lives_ok($$select public.import_record_error('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 6, 'invalid_email')$$, 'ligne 6 : refus de validation enregistré (code seulement)');
select throws_ok($$select public.import_record_error('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 7, 'sa@mail.com')$$, '22023', null, 'motif libre refusé (aucune valeur de contact dans le rapport)');
select throws_ok($$select public.import_row('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000001', 8, 'X', 'x@im.test', 'x@im.test', null, null, null)$$, 'P0001', null, 'import_row avec une AUTRE entreprise : lot non exécutable');
select throws_ok($$select public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 0, 'X', 'x@im.test', 'x@im.test', null, null, null)$$, '22023', null, 'numéro de ligne hors limites refusé');
select is((public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 9, 'Pays faux', 'p@im.test', 'p@im.test', null, null, 'MAR') ->> 'reason'), 'failed', 'valeur invalide transmise à la base : ligne en erreur (contraintes re-contrôlées)');
select throws_ok($$select public.import_fail('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 'secret@x.com')$$, '22023', null, 'import_fail : code libre refusé');
select lives_ok($$select public.import_finish('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 8)$$, 'import_finish : lot terminé');
select throws_ok($$select public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001', 10, 'Y', 'y@im.test', 'y@im.test', null, null, null)$$, 'P0001', null, 'lot terminé : plus de ligne acceptée');
select is((public.import_start('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000001') ->> 'status'), 'done', 'import_start sur un lot terminé : rien à refaire (rejeu du job sans effet)');
reset role;
select is((select status || ':' || created_count || ':' || matched_count || ':' || skipped_count || ':' || error_count from public.import_batches where id = 'ee000000-0000-4000-8000-000000000001'), 'done:1:2:1:2', 'compteurs : 1 créé, 2 rattachés, 1 ignoré, 2 erreurs');
select is((select count(*)::int from public.contacts where organization_id = 'eb000000-0000-4000-8000-00000000000a'), 3, 'contacts : 2 existants + 1 créé (pas de doublon, rejeu compris)');
select is((select count(*)::int from public.leads where organization_id = 'eb000000-0000-4000-8000-00000000000a' and source = 'csv_import'), 2, 'leads créés par l''import : source csv_import (2)');
select is((select count(*)::int from public.jobs where kind = 'lead.assign' and organization_id = 'eb000000-0000-4000-8000-00000000000a'), 2, 'un job d''assignation par lead créé');
select is((select count(*)::int from public.consent_events where organization_id = 'eb000000-0000-4000-8000-00000000000a'), 0, 'AUCUN consentement créé par l''import');
select is((select consent_status::text from public.contacts where email_normalized = 'nadia@im.test'), 'unknown', 'contact importé : consentement « inconnu »');
select is((select count(*)::int from public.import_rows where batch_id = 'ee000000-0000-4000-8000-000000000001'), 6, 'rapport : 6 lignes');

-- 7. Rapport : lecture réservée à owner / admin, sans donnée de contact -----------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.import_rows where batch_id = 'ee000000-0000-4000-8000-000000000001'), 6, 'admin : lit le rapport');
select ok(not exists (select 1 from public.import_rows r where r.reason ~ '@' or r.reason ~ '[0-9]{6}'), 'rapport : motifs en codes, aucune donnée de contact');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.import_rows), 0, 'commercial : ne lit pas le rapport');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.import_rows), 0, 'owner d''une autre entreprise : ne lit pas le rapport');
reset role;

-- 8. Quota « contacts » : la ligne en excès est en erreur, le lot continue ------------------------------------------------------------
update public.subscriptions set limits_override = '{"contacts": 1}'::jsonb where organization_id = 'eb000000-0000-4000-8000-00000000000b';
insert into public.import_batches (id, organization_id, project_id, file_path, file_size, status, mapping)
  values ('ee000000-0000-4000-8000-000000000005', 'eb000000-0000-4000-8000-00000000000b', 'ec000000-0000-4000-8000-0000000000b1',
          pg_temp.pth('eb000000-0000-4000-8000-00000000000b', 5), 100, 'running', '{"email": 0}');
select pg_temp.as_service();
select is((public.import_row('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000005', 2, null, 'q1@im.test', 'q1@im.test', null, null, null) ->> 'outcome'), 'created', 'quota : première ligne créée');
select is((public.import_row('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000005', 3, null, 'q2@im.test', 'q2@im.test', null, null, null))::text,
  '{"reason": "quota_exceeded", "outcome": "error", "lead_created": false}'::jsonb::text, 'quota plein : ligne en erreur « quota_exceeded »');
select is((public.import_row('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000005', 4, null, 'q1@im.test', 'q1@im.test', null, null, null) ->> 'outcome'), 'matched', 'quota plein : un contact existant passe quand même');
reset role;

-- 8b. Revue sécurité : projet archivé, lot « running » dont le job est mort, jobs d'assignation étalés ----------------------------------------
update public.projects set status = 'archived' where id = 'ec000000-0000-4000-8000-0000000000a1';
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select throws_ok($$select public.confirm_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000003', '{"email": 1}', 'MA', 1)$$, 'P0001', null, 'projet archivé : confirmation refusée');
reset role;
update public.projects set status = 'active' where id = 'ec000000-0000-4000-8000-0000000000a1';
update public.projects set status = 'archived' where id = 'ec000000-0000-4000-8000-0000000000b1';
select pg_temp.as_service();
select throws_ok($$select public.import_row('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000005', 9, null, 'arch@im.test', 'arch@im.test', null, null, null)$$, 'P0001', null, 'projet archivé en cours de route : ligne refusée (le worker échoue le lot)');
select is((public.import_start('eb000000-0000-4000-8000-00000000000b', 'ee000000-0000-4000-8000-000000000005') ->> 'status'), 'failed', 'projet archivé : import_start échoue le lot');
reset role;
select is((select error_code from public.import_batches where id = 'ee000000-0000-4000-8000-000000000005'), 'project_archived', 'code d''échec « project_archived »');
update public.projects set status = 'active' where id = 'ec000000-0000-4000-8000-0000000000b1';
select is((select count(*)::int from public.contacts where email_normalized = 'arch@im.test'), 0, 'projet archivé : aucun contact créé');

insert into public.import_batches (id, organization_id, project_id, file_path, file_size, status, mapping) values
  ('ee000000-0000-4000-8000-000000000006', 'eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 6), 100, 'running', '{"email": 0}'),
  ('ee000000-0000-4000-8000-000000000007', 'eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 7), 100, 'running', '{"email": 0}');
select private.enqueue_job('eb000000-0000-4000-8000-00000000000a', 'import_csv', '{"batch_id": "ee000000-0000-4000-8000-000000000006"}'::jsonb, 'dead-job-6');
update public.jobs set status = 'dead_letter' where idempotency_key = 'dead-job-6';
select private.enqueue_job('eb000000-0000-4000-8000-00000000000a', 'import_csv', '{"batch_id": "ee000000-0000-4000-8000-000000000007"}'::jsonb, 'live-job-7');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select throws_ok($$select public.cancel_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000007')$$, 'P0001', null, 'lot « running » dont le job est vivant : annulation refusée');
select lives_ok($$select public.cancel_import('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000006')$$, 'lot « running » dont le job est mort (dead_letter) : annulable, plus bloqué');
reset role;
select pg_temp.as_service();
select public.import_row('eb000000-0000-4000-8000-00000000000a', 'ee000000-0000-4000-8000-000000000007', 5000, 'Étalé', 'spread@im.test', 'spread@im.test', null, null, null);
reset role;
select ok((select j.next_run_at > now() + interval '90 seconds' from public.jobs j where j.kind = 'lead.assign' and j.payload ->> 'lead_id' = (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = 'spread@im.test')), 'jobs d''assignation étalés (ligne 5000 : plus de 90 secondes plus tard)');

-- 9. Abonnement suspendu : création de lot et confirmation refusées ----------------------------------------------------------------------
update public.subscriptions set status = 'suspended' where organization_id = 'eb000000-0000-4000-8000-00000000000a';
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 4)), 'P0001', null, 'abonnement suspendu : création de lot refusée');
reset role;
update public.subscriptions set status = 'active' where organization_id = 'eb000000-0000-4000-8000-00000000000a';

-- 10. Plafond de lots en cours -----------------------------------------------------------------------------------------------------------
insert into public.import_batches (id, organization_id, project_id, file_path, file_size)
  select ('ee000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, 'eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1',
         'eb000000-0000-4000-8000-00000000000a/ee000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0') || '.csv', 100
    from generate_series(1, 9) n;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select throws_ok(format($$select public.create_import_batch('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', %L, 1000)$$, pg_temp.pth('eb000000-0000-4000-8000-00000000000a', 4)), 'P0001', null, '10 lots en cours : le suivant est refusé');
reset role;

-- 11. Audit : identifiants et compteurs, jamais de donnée de contact ------------------------------------------------------------------------
select ok(exists (select 1 from public.audit_logs where action = 'import.uploaded' and entity_id = 'ee000000-0000-4000-8000-000000000001'), 'audit : import.uploaded');
select ok(exists (select 1 from public.audit_logs where action = 'import.queued' and entity_id = 'ee000000-0000-4000-8000-000000000001'), 'audit : import.queued');
select ok(exists (select 1 from public.audit_logs where action = 'import.completed' and entity_id = 'ee000000-0000-4000-8000-000000000001' and (after ->> 'created')::int = 1), 'audit : import.completed avec les compteurs');
select ok(exists (select 1 from public.audit_logs where action = 'import.cancelled' and entity_id = 'ee000000-0000-4000-8000-000000000002'), 'audit : import.cancelled');
select is((select count(*)::int from public.audit_logs where action like 'import.%' and (before::text like '%@%' or after::text like '%@%' or after::text like '%Nadia%')), 0, 'audit : aucune donnée de contact');
select ok(exists (select 1 from public.audit_logs where action = 'contact.created' and actor_kind = 'system'), 'audit : contacts créés par l''import avec l''acteur « système »');

select * from finish();
rollback;
