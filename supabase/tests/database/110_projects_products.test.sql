-- J16 — Projets et produits : structure, droits, contraintes, FK composites, rôles, quota, archivage, assets, audit.
-- Les fixtures sont créées sous le propriétaire ; les appels d'API sous les rôles concernés. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(128);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyst A · U6 owner B · U7 sans adhésion · U8 retiré de A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('7a000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@pp.test', now()
    from generate_series(1, 8) n;
insert into public.organizations (id, name, slug) values
  ('7b000000-0000-4000-8000-00000000000a', 'PP Alpha', 'pp-alpha-test'),
  ('7b000000-0000-4000-8000-00000000000b', 'PP Beta', 'pp-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000008', 'analyst', 'removed'),
  ('7b000000-0000-4000-8000-00000000000b', '7a000000-0000-4000-8000-000000000006', 'company_owner', 'active');
-- Alpha : plan « starter » (3 projets) ; Beta : plan « trial » (1 projet)
insert into public.subscriptions (organization_id, plan_id, status) values
  ('7b000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'starter'), 'active'),
  ('7b000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
-- Fixtures : A1 et A2 chez Alpha, B1 chez Beta (usage : Alpha 2/3, Beta 1/1) ; un produit sur A1.
insert into public.projects (id, organization_id, type, name, owner_id, settings) values
  ('7c000000-0000-4000-8000-0000000000a1', '7b000000-0000-4000-8000-00000000000a', 'website_sales', 'Alpha site', '7a000000-0000-4000-8000-000000000001', '{"target_market": "MA"}'),
  ('7c000000-0000-4000-8000-0000000000a2', '7b000000-0000-4000-8000-00000000000a', 'salla_app', 'Alpha app', '7a000000-0000-4000-8000-000000000002', '{}'),
  ('7c000000-0000-4000-8000-0000000000b1', '7b000000-0000-4000-8000-00000000000b', 'custom', 'Beta custom', null, '{}');
insert into public.products (id, organization_id, project_id, kind, offer, price_hint, landing_url) values
  ('7d000000-0000-4000-8000-0000000000a1', '7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1',
   'site vitrine', 'Site vitrine en 5 jours', 'à partir de 2 000 MAD', 'https://exemple.test/offre');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'projects', 'projects existe');
select has_table('public', 'products', 'products existe');
select ok((select relrowsecurity from pg_class where oid = 'public.projects'::regclass), 'RLS activée sur projects');
select ok((select relrowsecurity from pg_class where oid = 'public.products'::regclass), 'RLS activée sur products');
select is(enum_range(null::public.project_type)::text[], array['website_sales', 'salla_app', 'salla_theme', 'custom'], '4 types de projet (spec §4)');
select is(enum_range(null::public.project_status)::text[], array['active', 'archived'], '2 statuts de projet');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'projects'), 1, 'projects : une seule politique (lecture)');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'products'), 1, 'products : une seule politique (lecture)');
select ok(has_table_privilege('authenticated', 'public.projects', 'select'), 'authenticated lit projects');
select ok(not has_table_privilege('authenticated', 'public.projects', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur projects');
select ok(not has_table_privilege('authenticated', 'public.products', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur products');
select ok(not has_table_privilege('service_role', 'public.projects', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur projects');
select ok(not has_table_privilege('service_role', 'public.products', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur products');
select ok(not has_table_privilege('anon', 'public.projects', 'select,insert,update,delete'), 'anon : aucun droit sur projects');
select ok(not has_table_privilege('anon', 'public.products', 'select,insert,update,delete'), 'anon : aucun droit sur products');
select ok(not has_function_privilege('anon', 'public.create_project(uuid, public.project_type, text, jsonb, uuid)', 'execute'), 'anon : create_project non exécutable');
select ok(not has_function_privilege('service_role', 'public.create_project(uuid, public.project_type, text, jsonb, uuid)', 'execute'), 'service_role : create_project non exécutable');

-- 2. Contraintes (sous le propriétaire : seule la base juge) ------------------------------------------------------------
select throws_ok($$insert into public.projects (organization_id, type, name) values ('7b000000-0000-4000-8000-00000000000a', 'custom', '')$$, '23514', null, 'nom vide refusé');
select throws_ok($$insert into public.projects (organization_id, type, name) values ('7b000000-0000-4000-8000-00000000000a', 'custom', repeat('x', 121))$$, '23514', null, 'nom de 121 caractères refusé');
select throws_ok($$insert into public.projects (organization_id, type, name) values ('7b000000-0000-4000-8000-00000000000a', 'custom', ' espace')$$, '23514', null, 'nom avec espace en bordure refusé');
select throws_ok($$insert into public.projects (organization_id, type, name) values ('7b000000-0000-4000-8000-00000000000a', 'custom', E'a\nb')$$, '23514', null, 'nom avec saut de ligne refusé');
select throws_ok($$insert into public.projects (organization_id, type, name) values ('7b000000-0000-4000-8000-00000000000a', 'custom', E'a‮b')$$, '23514', null, 'nom avec caractère de direction refusé');
select throws_ok($$insert into public.projects (organization_id, type, name, settings) values ('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '[]')$$, '23514', null, 'réglages : un tableau est refusé');
select throws_ok($$insert into public.projects (organization_id, type, name, settings) values ('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', jsonb_build_object('k', repeat('a', 33000)))$$, '23514', null, 'réglages de plus de 32 Ko refusés');
select throws_ok($$insert into public.projects (organization_id, type, name, owner_id) values ('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '7a000000-0000-4000-8000-000000000006')$$, '23503', null, 'propriétaire membre d''une AUTRE entreprise refusé (FK composite)');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000b', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o')$$, '23503', null, 'produit visant le projet d''une autre entreprise refusé (FK composite)');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', '', 'o')$$, '23514', null, 'type de produit vide refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', '')$$, '23514', null, 'offre vide refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'http://exemple.test/x')$$, '23514', null, 'URL http (non chiffrée) refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'javascript:alert(1)')$$, '23514', null, 'URL javascript: refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://user:pass@exemple.test/x')$$, '23514', null, 'URL avec identifiants intégrés refusée');
select lives_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://exemple.test:8443/p?utm=1#a')$$, 'URL https valide acceptée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, assets) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', '["7b000000-0000-4000-8000-00000000000b/7c000000-0000-4000-8000-0000000000b1/logo.png"]')$$, '23514', null, 'asset d''une autre entreprise refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, assets) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', '["7b000000-0000-4000-8000-00000000000a/7c000000-0000-4000-8000-0000000000a2/logo.png"]')$$, '23514', null, 'asset d''un autre projet refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, assets) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', '["7b000000-0000-4000-8000-00000000000a/7c000000-0000-4000-8000-0000000000a1/../x.png"]')$$, '23514', null, 'asset avec « .. » refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, assets) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', '[1]')$$, '23514', null, 'asset non textuel refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, assets) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', '{}')$$, '23514', null, 'assets : un objet est refusé');
select lives_ok($$insert into public.products (organization_id, project_id, kind, offer, assets) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', '["7b000000-0000-4000-8000-00000000000a/7c000000-0000-4000-8000-0000000000a1/img/logo.png"]')$$, 'asset du bon projet accepté');
select throws_ok($$update public.projects set type = 'custom' where id = '7c000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'le type d''un projet est immuable');
select throws_ok($$update public.projects set organization_id = '7b000000-0000-4000-8000-00000000000b' where id = '7c000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'l''entreprise d''un projet est immuable');
select throws_ok($$update public.products set project_id = '7c000000-0000-4000-8000-0000000000a2' where id = '7d000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'le projet d''un produit est immuable');

-- 3. Lecture (RLS) -------------------------------------------------------------------------------------------------
select pg_temp.as_user('7a000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.projects), 2, 'analyste d''Alpha : voit les 2 projets d''Alpha et aucun de Beta');
select is((select count(*)::int from public.products), 3, 'analyste d''Alpha : voit les produits d''Alpha');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.projects), 2, 'commercial d''Alpha : lecture autorisée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000006');
select is((select array_agg(name) from public.projects), array['Beta custom'], 'propriétaire de Beta : ne voit que Beta');
select is((select count(*)::int from public.products), 0, 'propriétaire de Beta : aucun produit d''Alpha');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000007');
select is((select count(*)::int from public.projects), 0, 'sans adhésion : aucun projet');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000008');
select is((select count(*)::int from public.projects), 0, 'membre retiré : aucun projet');
reset role;
set local role anon;
select throws_ok($$select count(*) from public.projects$$, '42501', null, 'anon : lecture refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$delete from public.projects$$, '42501', null, 'owner : aucune suppression directe');
select throws_ok($$update public.projects set name = 'x'$$, '42501', null, 'owner : aucune modification directe');
select throws_ok($$insert into public.projects (organization_id, type, name) values ('7b000000-0000-4000-8000-00000000000a', 'custom', 'direct')$$, '42501', null, 'owner : aucune insertion directe');
reset role;

-- 4. Création : rôles, validation, propriétaire -----------------------------------------------------------------------
select pg_temp.as_user('7a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'marketing : création refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'commercial : création refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000005');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'analyste : création refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000007');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'sans adhésion : création refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000008');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'membre retiré : création refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'owner de Beta : création refusée chez Alpha');
reset role;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '28000', null, 'sans identité : non authentifié');
reset role;
set local role anon;
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{}')$$, '42501', null, 'anon : création refusée');
reset role;

select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', '', '{}')$$, '22023', null, 'nom invalide : validation_failed');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'ok', '[]')$$, '22023', null, 'réglages invalides : validation_failed');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', null, 'ok', '{}')$$, '22023', null, 'type absent : validation_failed');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'ok', '{}', '7a000000-0000-4000-8000-000000000006')$$, 'P0001', 'owner_invalid', 'propriétaire d''une autre entreprise : owner_invalid');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'ok', '{}', '7a000000-0000-4000-8000-000000000008')$$, 'P0001', 'owner_invalid', 'propriétaire retiré : owner_invalid');
select lives_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'website_sales', 'Nouveau 1', '{"offers": ["pack"]}', '7a000000-0000-4000-8000-000000000003')$$, 'owner : crée un projet (3e sur 3)');
select is((select owner_id from public.projects where name = 'Nouveau 1'), '7a000000-0000-4000-8000-000000000003'::uuid, 'le propriétaire désigné est enregistré');
reset role;

-- 5. Quota « projects » ----------------------------------------------------------------------------------------------
select pg_temp.as_user('7a000000-0000-4000-8000-000000000002');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'Nouveau 2', '{}')$$, 'P0001', 'quota_exceeded', 'admin : 4e projet refusé (quota_exceeded)');
select lives_ok($$select public.set_project_status('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a2', 'archived')$$, 'admin : archive un projet');
select lives_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'Nouveau 2', '{}')$$, 'un projet archivé ne compte plus : création possible');
select throws_ok($$select public.set_project_status('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a2', 'active')$$, 'P0001', 'quota_exceeded', 'réactivation refusée au quota (pas de contournement)');
select lives_ok($$select public.set_project_status('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a2', 'archived')$$, 'archiver deux fois : sans effet');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select is((select used from public.get_org_usage('7b000000-0000-4000-8000-00000000000a') where metric = 'projects'), 3::bigint, 'usage « projects » d''Alpha = 3 projets actifs');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000b', 'custom', 'Beta 2', '{}')$$, 'P0001', 'quota_exceeded', 'Beta (essai, 1 projet) : 2e projet refusé');
reset role;
select is((select count(*)::int from public.projects where organization_id = '7b000000-0000-4000-8000-00000000000b'), 1, 'les quotas ne se mélangent pas : Beta garde 1 projet');

-- 6. Modification, archivage, propriétaire --------------------------------------------------------------------------
select pg_temp.as_user('7a000000-0000-4000-8000-000000000002');
select lives_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'Alpha site v2', '{"target_market": "SA"}', '7a000000-0000-4000-8000-000000000002')$$, 'admin : modifie un projet');
select is((select name from public.projects where id = '7c000000-0000-4000-8000-0000000000a1'), 'Alpha site v2', 'le nom est modifié');
select throws_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000b1', 'piraté', '{}', null)$$, 'PT404', 'not_found', 'projet d''une autre entreprise : not_found');
select throws_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000b', '7c000000-0000-4000-8000-0000000000b1', 'piraté', '{}', null)$$, '42501', null, 'admin d''Alpha : modification refusée chez Beta');
select throws_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a2', 'archivé', '{}', null)$$, 'P0001', 'project_archived', 'projet archivé : lecture seule');
select throws_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'ok', '{}', '7a000000-0000-4000-8000-000000000008')$$, 'P0001', 'owner_invalid', 'modification avec propriétaire retiré : owner_invalid');
select throws_ok($$select public.set_project_status('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000ff', 'archived')$$, 'PT404', 'not_found', 'projet inconnu : not_found');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000005');
select throws_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'x', '{}', null)$$, '42501', null, 'analyste : modification refusée');
select throws_ok($$select public.set_project_status('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'archived')$$, '42501', null, 'analyste : archivage refusé');
reset role;

-- 7. Produits --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'pack', 'Pack e-commerce', '1 500 MAD', 'https://exemple.test/pack', '["7b000000-0000-4000-8000-00000000000a/7c000000-0000-4000-8000-0000000000a1/pack.png"]')$$, 'owner : crée un produit avec un asset du projet');
select throws_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000b1', 'pack', 'Offre', null, null, '[]')$$, 'PT404', 'not_found', 'produit sur le projet d''une autre entreprise : not_found');
select throws_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a2', 'pack', 'Offre', null, null, '[]')$$, 'P0001', 'project_archived', 'produit sur un projet archivé : refusé');
select throws_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'pack', 'Offre', null, 'http://exemple.test', '[]')$$, '22023', null, 'URL non https : validation_failed');
select throws_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'pack', 'Offre', null, null, '["7b000000-0000-4000-8000-00000000000b/7c000000-0000-4000-8000-0000000000b1/x.png"]')$$, '22023', null, 'asset d''une autre entreprise : validation_failed');
select lives_ok($$select public.update_product('7b000000-0000-4000-8000-00000000000a', '7d000000-0000-4000-8000-0000000000a1', 'site vitrine', 'Site vitrine v2', null, null, '[]')$$, 'owner : modifie un produit');
select is((select offer from public.products where id = '7d000000-0000-4000-8000-0000000000a1'), 'Site vitrine v2', 'l''offre est modifiée');
select throws_ok($$select public.update_product('7b000000-0000-4000-8000-00000000000a', '7d000000-0000-4000-8000-0000000000ff', 'k', 'o', null, null, '[]')$$, 'PT404', 'not_found', 'produit inconnu : not_found');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.update_product('7b000000-0000-4000-8000-00000000000a', '7d000000-0000-4000-8000-0000000000a1', 'k', 'piraté', null, null, '[]')$$, '42501', null, 'owner de Beta : modification de produit refusée chez Alpha');
select throws_ok($$select public.update_product('7b000000-0000-4000-8000-00000000000b', '7d000000-0000-4000-8000-0000000000a1', 'k', 'piraté', null, null, '[]')$$, 'PT404', 'not_found', 'produit d''Alpha demandé via Beta : not_found');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', null, null, '[]')$$, '42501', null, 'commercial : création de produit refusée');
reset role;

-- 8. Abonnement suspendu ----------------------------------------------------------------------------------------------
update public.subscriptions set status = 'suspended' where organization_id = '7b000000-0000-4000-8000-00000000000b';
select pg_temp.as_user('7a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000b', 'custom', 'Beta 3', '{}')$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : création refusée');
reset role;

-- 9. Propriétaire supprimé -------------------------------------------------------------------------------------------
delete from public.organization_members where organization_id = '7b000000-0000-4000-8000-00000000000a' and user_id = '7a000000-0000-4000-8000-000000000002';
select is((select owner_id from public.projects where id = '7c000000-0000-4000-8000-0000000000a1'), null, 'adhésion supprimée : owner_id passe à NULL');
select is((select organization_id from public.projects where id = '7c000000-0000-4000-8000-0000000000a1'), '7b000000-0000-4000-8000-00000000000a'::uuid, '...sans toucher à organization_id');

-- 10. Audit ----------------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.audit_logs where action = 'project.created' and entity_type = 'project' and after ->> 'name' = 'Nouveau 1' and actor_kind = 'user'), 1, 'audit : project.created (acteur = utilisateur)');
select is((select count(*)::int from public.audit_logs where action = 'project.archived' and entity_id = '7c000000-0000-4000-8000-0000000000a2'), 1, 'audit : project.archived');
select is((select (after -> 'changed') from public.audit_logs where action = 'project.updated' and entity_id = '7c000000-0000-4000-8000-0000000000a1' order by created_at desc limit 1), '["name", "owner_id", "settings"]'::jsonb, 'audit : project.updated ne liste que les NOMS des champs modifiés');
select ok(not exists (select 1 from public.audit_logs where entity_type = 'project' and (after ? 'settings' or before ? 'settings')), 'audit : le contenu des réglages n''est jamais journalisé');
select is((select count(*)::int from public.audit_logs where action = 'product.created' and after ->> 'kind' = 'pack'), 1, 'audit : product.created');
select ok(not exists (select 1 from public.audit_logs where entity_type = 'product' and (after ? 'offer' or after ? 'landing_url' or after ? 'assets')), 'audit : ni offre, ni URL, ni assets dans le journal');
select is((select count(*)::int from public.audit_logs where action = 'product.updated' and entity_id = '7d000000-0000-4000-8000-0000000000a1' and after -> 'changed' @> '["offer"]'::jsonb), 1, 'audit : product.updated');

-- 11. Revue sécurité adverse (J16) ----------------------------------------------------------------------------------
-- Caractères invisibles et de direction (M1)
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', E'a\u061cb', 'o')$$, '23514', null, 'type de produit avec marque de lettre arabe (U+061C) refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', E'a\u2060b', 'o')$$, '23514', null, 'type de produit avec joint de mots (U+2060) refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', E'a\u00adb', 'o')$$, '23514', null, 'type de produit avec trait d''union conditionnel (U+00AD) refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', E'a\u0085b')$$, '23514', null, 'offre avec saut de ligne NEL (U+0085) refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', E'\nabc')$$, '23514', null, 'offre commençant par un saut de ligne refusée');
-- URL : nom de domaine seulement (M2)
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://127.0.0.1/')$$, '23514', null, 'URL vers une adresse IP refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://localhost/')$$, '23514', null, 'URL vers localhost refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://2130706433/')$$, '23514', null, 'URL à adresse numérique refusée');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://exemple.test:99999/')$$, '23514', null, 'port hors limites refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://exemple.test:0/')$$, '23514', null, 'port 0 refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://a..test/')$$, '23514', null, 'hôte avec deux points consécutifs refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://serveur.internal/x')$$, '23514', null, 'hôte interne (.internal) refusé');
select throws_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', E'https://exemple.test/\u202ex')$$, '23514', null, 'caractère de direction dans le chemin refusé');
select lives_ok($$insert into public.products (organization_id, project_id, kind, offer, landing_url) values ('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'o', 'https://sous.exemple.test:65535/a/b?x=1#y')$$, 'URL valide (domaine, port 65535) acceptée');
-- Réglages : la base ne dépend plus de zod pour la forme générale (appel direct de la fonction)
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'website_sales', 'x', '{"inconnue": 1}')$$, '22023', null, 'réglage : clé inconnue refusée');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'salla_theme', 'x', '{"preview_url": "javascript:alert(1)"}')$$, '22023', null, 'réglage : lien javascript: refusé');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'website_sales', 'x', '{"landing_pages": [{"name": "a", "url": "http://exemple.test"}]}')$$, '22023', null, 'réglage : page d''atterrissage en http refusée');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'custom', 'x', '{"fields": {"a": {"b": {"c": {"d": 1}}}}}')$$, '22023', null, 'réglage : imbrication de plus de 4 niveaux refusée');
select throws_ok($$select public.create_project('7b000000-0000-4000-8000-00000000000a', 'website_sales', 'x', '{"offers": ["a"]}'::jsonb || jsonb_build_object('target_market', repeat(chr(233), 17000)))$$, '22023', null, 'réglage : plus de 32 Ko (octets) refusé');
-- Modification : le propriétaire est explicite (plus d'effacement silencieux) (F1)
select throws_ok($$select public.update_project('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'x', '{}'::jsonb)$$, '42883', null, 'update_project sans propriétaire explicite : fonction inexistante (aucun effacement silencieux)');
reset role;
-- Plafond de produits par projet (M3)
insert into public.products (organization_id, project_id, kind, offer)
  select '7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'fill', 'o' || n from generate_series(1, 100 - (select count(*)::int from public.products where project_id = '7c000000-0000-4000-8000-0000000000a1')) n;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_product('7b000000-0000-4000-8000-00000000000a', '7c000000-0000-4000-8000-0000000000a1', 'k', 'de trop', null, null, '[]')$$, 'P0001', 'quota_exceeded', 'plafond de 100 produits par projet');
reset role;
-- Membre suspendu : il perd ses projets (F3)
select is((select owner_id from public.projects where name = 'Nouveau 1'), '7a000000-0000-4000-8000-000000000003'::uuid, 'avant suspension : le marketing est propriétaire de « Nouveau 1 »');
update public.organization_members set status = 'suspended' where organization_id = '7b000000-0000-4000-8000-00000000000a' and user_id = '7a000000-0000-4000-8000-000000000003';
select is((select owner_id from public.projects where name = 'Nouveau 1'), null, 'membre suspendu : owner_id passe à NULL');

select * from finish();
rollback;
