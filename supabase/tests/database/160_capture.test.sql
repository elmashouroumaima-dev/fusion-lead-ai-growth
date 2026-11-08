-- J21 — Capture publique : clés de formulaire (génération, empreinte, rôles, plafond, lecture sans empreinte) et capture_lead
-- (clé -> entreprise, origine, déduplication, lead ouvert réutilisé, consentement, job, quota, isolation, audit sans donnée
-- personnelle). Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(137);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ca000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@cp.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('cb000000-0000-4000-8000-00000000000a', 'CP Alpha', 'cp-alpha-test'),
  ('cb000000-0000-4000-8000-00000000000b', 'CP Beta', 'cp-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('cb000000-0000-4000-8000-00000000000a', 'ca000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('cb000000-0000-4000-8000-00000000000b', 'ca000000-0000-4000-8000-000000000006', 'company_owner', 'active');
-- Alpha : « growth » (50 000 contacts) ; Beta : « trial » (500 contacts)
insert into public.subscriptions (organization_id, plan_id, status) values
  ('cb000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('cb000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('cc000000-0000-4000-8000-0000000000a1', 'cb000000-0000-4000-8000-00000000000a', 'website_sales', 'CP site', 'active', '{}'),
  ('cc000000-0000-4000-8000-0000000000a2', 'cb000000-0000-4000-8000-00000000000a', 'custom', 'CP archivé', 'archived', '{}'),
  ('cc000000-0000-4000-8000-0000000000b1', 'cb000000-0000-4000-8000-00000000000b', 'custom', 'CP beta', 'active', '{}');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('cd000000-0000-4000-8000-0000000000e1', 'cb000000-0000-4000-8000-00000000000a', 'Existant e-mail', 'ancien@cp.test', 'ancien@cp.test', '+212600000011'),
  ('cd000000-0000-4000-8000-0000000000e2', 'cb000000-0000-4000-8000-00000000000a', 'Existant téléphone', 'autre@cp.test', 'autre@cp.test', '+212600000022');

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
create function pg_temp.hk(p_key text) returns text language sql as $f$ select encode(sha256(convert_to(p_key, 'UTF8')), 'hex') $f$;
grant execute on function pg_temp.hk(text) to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'form_keys', 'form_keys existe');
select ok((select relrowsecurity from pg_class where oid = 'public.form_keys'::regclass), 'RLS activée sur form_keys');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'form_keys'), 1, 'une seule politique (lecture)');
select ok(not has_table_privilege('authenticated', 'public.form_keys', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe');
select ok(not has_column_privilege('authenticated', 'public.form_keys', 'key_hash', 'select'), 'authenticated : ne lit pas l''empreinte de la clé');
select ok(has_column_privilege('authenticated', 'public.form_keys', 'key_prefix', 'select'), 'authenticated : lit le préfixe non secret');
select ok(not has_table_privilege('service_role', 'public.form_keys', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe');
select ok(not has_table_privilege('anon', 'public.form_keys', 'select,insert,update,delete'), 'anon : aucun droit');
select ok(has_function_privilege('service_role', 'public.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb)', 'execute'), 'service_role : capture_lead exécutable');
select ok(not has_function_privilege('anon', 'public.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb)', 'execute'), 'anon : capture_lead non exécutable');
select ok(not has_function_privilege('authenticated', 'public.capture_lead(text, text, text, text, text, text, text, text, jsonb, jsonb)', 'execute'), 'authenticated : capture_lead non exécutable');
select ok(not has_function_privilege('anon', 'public.form_origin_allowed(text)', 'execute'), 'anon : form_origin_allowed non exécutable');
select ok(not has_function_privilege('anon', 'public.create_form_key(uuid, uuid, text[])', 'execute'), 'anon : create_form_key non exécutable');
select ok(not has_function_privilege('service_role', 'public.create_form_key(uuid, uuid, text[])', 'execute'), 'service_role : create_form_key non exécutable');

-- 2. Contraintes sur les origines (sous le propriétaire) ---------------------------------------------------------------
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['http://exemple.ma'])$$, '23514', null, 'origine http refusée');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://Exemple.ma'])$$, '23514', null, 'origine avec majuscules refusée');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://exemple.ma/page'])$$, '23514', null, 'origine avec chemin refusée');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://*.exemple.ma'])$$, '23514', null, 'joker refusé');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://127.0.0.1'])$$, '23514', null, 'adresse IP refusée');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://intranet.local'])$$, '23514', null, 'hôte interne refusé');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://exemple.ma', 'https://exemple.ma'])$$, '23514', null, 'origines en double refusées');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array[]::text[])$$, '23514', null, 'aucune origine : refusé');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', (select array_agg('https://site' || n || '.exemple.ma') from generate_series(1, 11) n))$$, '23514', null, 'plus de 10 origines : refusé');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', 'pas-une-empreinte', 'flk_aaaa', array['https://exemple.ma'])$$, '23514', null, 'empreinte mal formée refusée');
select throws_ok($$insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins) values ('cb000000-0000-4000-8000-00000000000b', 'cc000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'flk_aaaa', array['https://exemple.ma'])$$, '23503', null, 'clé visant le projet d''une autre entreprise : refusée (FK composite)');

-- 3. Gestion des clés : rôles, génération, empreinte, plafond ----------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select lives_ok($$select set_config('t.k1', (public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://exemple.ma', 'https://www.exemple.ma']) ->> 'key'), true)$$, 'owner : crée une clé de formulaire');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000002');
select lives_ok($$select set_config('t.k2', (public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://autre.ma']) ->> 'key'), true)$$, 'admin : crée une clé de formulaire');
reset role;
select matches(current_setting('t.k1'), '^flk_[0-9a-f]{64}$', 'clé générée : préfixe flk_ et 64 caractères hexadécimaux');
select isnt(current_setting('t.k1'), current_setting('t.k2'), 'deux clés différentes');
select is((select count(*)::int from public.form_keys where key_hash = pg_temp.hk(current_setting('t.k1'))), 1, 'seule l''empreinte SHA-256 de la clé est conservée');
select is((select count(*)::int from public.form_keys where key_hash = current_setting('t.k1') or key_prefix = current_setting('t.k1')), 0, 'la clé en clair n''est stockée nulle part');
select is((select key_prefix from public.form_keys where key_hash = pg_temp.hk(current_setting('t.k1'))), substr(current_setting('t.k1'), 1, 8), 'préfixe non secret : 8 premiers caractères');
select is((select count(*)::int from public.audit_logs where action = 'form_key.created' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 2, 'audit : form_key.created');
select ok(not exists (select 1 from public.audit_logs where entity_type = 'form_key' and (coalesce(after::text, '') || coalesce(before::text, '')) like '%' || substr(current_setting('t.k1'), 5) || '%'), 'audit : jamais la clé ni son empreinte');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://x.ma'])$$, '42501', null, 'marketing : création refusée');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://x.ma'])$$, '42501', null, 'commercial : création refusée');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000005');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://x.ma'])$$, '42501', null, 'analyste : création refusée');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://x.ma'])$$, '42501', null, 'owner de Beta : création chez Alpha refusée');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a2', array['https://x.ma'])$$, 'P0001', 'project_archived', 'projet archivé : création refusée');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000b1', array['https://x.ma'])$$, 'PT404', null, 'projet d''une autre entreprise : introuvable');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['http://x.ma'])$$, '22023', null, 'origine http : validation_failed');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array[]::text[])$$, '22023', null, 'aucune origine : validation_failed');
select lives_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://c3.ma'])$$, 'troisième clé active');
select lives_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://c4.ma'])$$, 'quatrième clé active');
select lives_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://c5.ma'])$$, 'cinquième clé active');
select throws_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://c6.ma'])$$, 'P0001', 'too_many_form_keys', 'sixième clé active : refusée');
select lives_ok($$select public.set_form_key_active('cb000000-0000-4000-8000-00000000000a', (select id from public.form_keys where key_prefix = substr(current_setting('t.k2'), 1, 8)), false)$$, 'owner : révoque une clé');
select lives_ok($$select public.create_form_key('cb000000-0000-4000-8000-00000000000a', 'cc000000-0000-4000-8000-0000000000a1', array['https://c6.ma'])$$, 'après révocation, une place se libère');
select throws_ok($$select public.set_form_key_active('cb000000-0000-4000-8000-00000000000a', (select id from public.form_keys where key_prefix = substr(current_setting('t.k2'), 1, 8)), true)$$, 'P0001', 'too_many_form_keys', 'réactiver au-delà de 5 clés actives : refusé');
select lives_ok($$select public.set_form_key_origins('cb000000-0000-4000-8000-00000000000a', (select id from public.form_keys where key_prefix = substr(current_setting('t.k1'), 1, 8)), array['https://exemple.ma', 'https://www.exemple.ma', 'https://blog.exemple.ma'])$$, 'owner : modifie les origines');
select throws_ok($$select public.set_form_key_origins('cb000000-0000-4000-8000-00000000000a', (select id from public.form_keys where key_prefix = substr(current_setting('t.k1'), 1, 8)), array['https://*.ma'])$$, '22023', null, 'origines invalides : refusées');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_form_key_active('cb000000-0000-4000-8000-00000000000a', (select id from public.form_keys limit 1), false)$$, '42501', null, 'marketing : ne révoque pas');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select throws_ok($$select public.set_form_key_active('cb000000-0000-4000-8000-00000000000a', gen_random_uuid(), false)$$, '42501', null, 'owner de Beta : refusé');
reset role;
select throws_ok($$update public.form_keys set key_hash = repeat('b', 64) where key_prefix = substr(current_setting('t.k1'), 1, 8)$$, '23514', null, 'l''empreinte ne change jamais');
select throws_ok($$update public.form_keys set project_id = 'cc000000-0000-4000-8000-0000000000a2' where key_prefix = substr(current_setting('t.k1'), 1, 8)$$, '23514', null, 'le projet d''une clé ne change jamais');

-- 4. Lecture des clés : owner et admin, sans l'empreinte ----------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select ok((select count(*) from public.form_keys) >= 6, 'owner : voit les clés d''Alpha');
select throws_ok($$select key_hash from public.form_keys$$, '42501', null, 'owner : l''empreinte n''est pas lisible');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000002');
select ok((select count(*) from public.form_keys) >= 6, 'admin : voit les clés');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.form_keys), 0, 'marketing : aucune clé');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.form_keys), 0, 'commercial : aucune clé');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.form_keys), 0, 'analyste : aucune clé');
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.form_keys), 0, 'owner de Beta : aucune clé d''Alpha');
reset role;

-- 5. Capture : clé, origine, projet -----------------------------------------------------------------------------------------
select set_config('t.kb', (select 'x'), true);
select pg_temp.as_user('ca000000-0000-4000-8000-000000000006');
select set_config('t.kb', (public.create_form_key('cb000000-0000-4000-8000-00000000000b', 'cc000000-0000-4000-8000-0000000000b1', array['https://beta.ma']) ->> 'key'), true);
reset role;
select pg_temp.as_service();
select is(public.form_origin_allowed('https://exemple.ma'), true, 'origine d''une clé active : autorisée (préflight)');
select is(public.form_origin_allowed('https://inconnu.ma'), false, 'origine inconnue : refusée');
select is(public.form_origin_allowed(null), false, 'origine absente : refusée');
select throws_ok($$select public.capture_lead(pg_temp.hk('flk_inconnue'), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'clé inconnue : form_key_invalid');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://pirate.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'origine refusée : même erreur');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), null, 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'origine absente : même erreur');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://autre.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'origine d''une AUTRE clé : même erreur');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k2')), 'https://autre.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'clé révoquée : même erreur');
select throws_ok($$select public.capture_lead(null, 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'empreinte absente : même erreur');
reset role;
update public.projects set status = 'archived' where id = 'cc000000-0000-4000-8000-0000000000a1';
select pg_temp.as_service();
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'projet archivé : même erreur');
select is(public.form_origin_allowed('https://exemple.ma'), false, 'projet archivé : origine plus autorisée');
reset role;
update public.projects set status = 'active' where id = 'cc000000-0000-4000-8000-0000000000a1';

-- 6. Capture : données invalides --------------------------------------------------------------------------------------------
select pg_temp.as_service();
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', null, null, null, null, null, '{}', null)$$, '22023', null, 'ni e-mail ni téléphone : refusé');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'A@x.com', 'incoherent@x.com', null, null, null, '{}', null)$$, '22023', null, 'e-mail normalisé incohérent : refusé');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', null, null, '0612345678', null, null, '{}', null)$$, '22023', null, 'téléphone non E.164 : refusé');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{"cookie": "x"}', null)$$, '22023', null, 'UTM : clé inconnue refusée');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', ' espace', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, '22023', null, 'nom avec espace en bordure refusé');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', '{"channel": "sms"}')$$, '22023', null, 'consentement : canal inconnu refusé');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', '{"channel": "email", "proof": {"cookie": "x"}}')$$, '22023', null, 'consentement : preuve invalide refusée');
reset role;
select is((select count(*)::int from public.contacts where organization_id = 'cb000000-0000-4000-8000-00000000000a'), 2, 'aucune donnée invalide n''a créé de contact');

-- 7. Capture : nouveau contact, lead, consentement, job ----------------------------------------------------------------------
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'Nadia', 'Nadia@Exemple.test', 'nadia@exemple.test', '+212611111111', 'fr', 'MA',
  '{"utm_source": "newsletter", "utm_campaign": "ete", "landing_page_id": "lp-1"}',
  '{"channel": "email", "purpose": "marketing", "proof": {"consent_text": "J''accepte de recevoir des offres.", "consent_version": "v2", "ip": "203.0.113.7", "url": "https://exemple.ma/inscription"}}'))::text,
  '{"lead_created": true, "contact_created": true, "consent_recorded": true}'::jsonb::text, 'première soumission : contact, lead et consentement créés');
reset role;
select is((select count(*)::int from public.contacts where email_normalized = 'nadia@exemple.test' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 1, 'contact créé dans l''entreprise DE LA CLÉ');
select is((select email_raw from public.contacts where email_normalized = 'nadia@exemple.test'), 'Nadia@Exemple.test', 'e-mail saisi conservé');
select is((select source from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'web_form', 'lead : source web_form');
select is((select s.kind::text from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'unassigned', 'lead : étape « non assigné »');
select is((select project_id::text from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'cc000000-0000-4000-8000-0000000000a1', 'lead : projet de la clé');
select is((select utm ->> 'landing_page_id' from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'lp-1', 'UTM et landing_page_id stockés');
select is((select proof ->> 'consent_version' from public.consent_events where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'v2', 'consentement : version stockée');
select is((select proof ->> 'consent_text' from public.consent_events where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'J''accepte de recevoir des offres.', 'consentement : texte stocké');
select is((select source from public.consent_events where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'web_form', 'consentement : source web_form');
select is((select consent_status::text from public.contacts where email_normalized = 'nadia@exemple.test'), 'granted', 'statut dérivé : granted');
select is((select count(*)::int from public.jobs where kind = 'lead.assign' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 1, 'job d''assignation enregistré');
select is((select payload ->> 'lead_id' from public.jobs where kind = 'lead.assign' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), (select id::text from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'job : identifiant du lead seulement');

-- 8. Même soumission : un contact, un lead, un consentement, un job ---------------------------------------------------------
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'Nadia', 'Nadia@Exemple.test', 'nadia@exemple.test', '+212611111111', 'fr', 'MA',
  '{"utm_source": "autre"}',
  '{"channel": "email", "purpose": "marketing", "proof": {"consent_version": "v3"}}'))::text,
  '{"lead_created": false, "contact_created": false, "consent_recorded": false}'::jsonb::text, 'deuxième soumission identique : rien de nouveau');
reset role;
select is((select count(*)::int from public.contacts where email_normalized = 'nadia@exemple.test'), 1, 'toujours UN contact');
select is((select count(*)::int from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 1, 'toujours UN lead');
select is((select count(*)::int from public.consent_events where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 1, 'toujours UN consentement');
select is((select count(*)::int from public.jobs where kind = 'lead.assign' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 1, 'toujours UN job d''assignation');
select is((select utm ->> 'utm_source' from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test')), 'newsletter', 'les données du lead existant ne sont pas écrasées');

-- 9. Déduplication par téléphone, conflit e-mail / téléphone, lead clos, consentement sur une autre adresse -----------------------
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'Autre nom', 'nouvelle@cp.test', 'nouvelle@cp.test', '+212600000022', null, null, '{}', null) ->> 'contact_created'), 'false', 'téléphone connu : le contact existant est réutilisé');
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'Conflit', 'ancien@cp.test', 'ancien@cp.test', '+212600000022', null, null, '{}', null) ->> 'contact_created'), 'false', 'conflit e-mail / téléphone : pas de nouveau contact');
reset role;
select is((select count(*)::int from public.leads where contact_id = 'cd000000-0000-4000-8000-0000000000e1'), 1, 'conflit : le lead est rattaché au contact de l''E-MAIL');
select is((select phone_e164 from public.contacts where id = 'cd000000-0000-4000-8000-0000000000e1'), '+212600000011', 'conflit : le téléphone du contact n''est pas modifié');
select is((select count(*)::int from public.leads where contact_id = 'cd000000-0000-4000-8000-0000000000e2'), 1, 'téléphone connu : lead sur le contact trouvé par le téléphone');
select is((select name from public.contacts where id = 'cd000000-0000-4000-8000-0000000000e2'), 'Existant téléphone', 'aucune fusion : le nom du contact existant est conservé');
update public.leads set stage_id = (select id from public.pipeline_stages where organization_id = 'cb000000-0000-4000-8000-00000000000a' and kind = 'lost')
 where contact_id = 'cd000000-0000-4000-8000-0000000000e1';
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'Retour', 'ancien@cp.test', 'ancien@cp.test', null, null, null, '{}', null) ->> 'lead_created'), 'true', 'lead perdu : un NOUVEAU lead est créé');
reset role;
select is((select count(*)::int from public.leads where contact_id = 'cd000000-0000-4000-8000-0000000000e1'), 2, 'deux leads : l''ancien (perdu) et le nouveau');
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'inconnue@cp.test', 'inconnue@cp.test', '+212600000022', null, null, '{}',
  '{"channel": "email", "proof": {"consent_version": "v1"}}') ->> 'consent_recorded'), 'false', 'consentement e-mail pour une adresse qui n''est pas celle du contact : non enregistré');
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', null, null, '+212600000022', null, null, '{}',
  '{"channel": "whatsapp", "proof": {"consent_version": "v1"}}') ->> 'consent_recorded'), 'true', 'consentement WhatsApp pour le numéro du contact : enregistré');
reset role;

-- 10. Isolation entre entreprises ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.kb')), 'https://beta.ma', 'Nadia chez Beta', 'nadia@exemple.test', 'nadia@exemple.test', null, null, null, '{}', null) ->> 'contact_created'), 'true', 'même e-mail dans une autre entreprise : nouveau contact');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.kb')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, 'P0001', 'form_key_invalid', 'clé de Beta avec l''origine d''Alpha : refusée');
reset role;
select is((select count(*)::int from public.contacts where email_normalized = 'nadia@exemple.test'), 2, 'deux contacts, un par entreprise');
select is((select organization_id::text from public.leads where contact_id = (select id from public.contacts where email_normalized = 'nadia@exemple.test' and organization_id = 'cb000000-0000-4000-8000-00000000000b')), 'cb000000-0000-4000-8000-00000000000b', 'le lead de Beta est dans Beta');

-- 11. Quota « contacts » et abonnement -----------------------------------------------------------------------------------------
insert into public.contacts (organization_id, phone_e164)
  select 'cb000000-0000-4000-8000-00000000000b', '+2127' || lpad(n::text, 8, '0') from generate_series(1, 499) n;
select pg_temp.as_service();
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.kb')), 'https://beta.ma', 'Un de trop', 'trop@cp.test', 'trop@cp.test', null, null, null, '{}', null)$$, 'P0001', 'quota_exceeded', 'quota « contacts » atteint : refus, aucun contact créé');
select is((public.capture_lead(pg_temp.hk(current_setting('t.kb')), 'https://beta.ma', 'Nadia chez Beta', 'nadia@exemple.test', 'nadia@exemple.test', null, null, null, '{}', null) ->> 'contact_created'), 'false', 'quota atteint : un contact existant continue de passer');
reset role;
update public.subscriptions set status = 'suspended' where organization_id = 'cb000000-0000-4000-8000-00000000000a';
select pg_temp.as_service();
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'sus@cp.test', 'sus@cp.test', null, null, null, '{}', null)$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : capture refusée');
reset role;
update public.subscriptions set status = 'active' where organization_id = 'cb000000-0000-4000-8000-00000000000a';

-- 11b. Revue sécurité : pas de re-consentement après révocation, contact « ne plus contacter », finalités, contrôle clé + origine -------
insert into public.consent_events (organization_id, contact_id, channel, purpose, source, revoked_at)
  values ('cb000000-0000-4000-8000-00000000000a', 'cd000000-0000-4000-8000-0000000000e2', 'email', 'marketing', 'manual', now());
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'autre@cp.test', 'autre@cp.test', null, null, null, '{}',
  '{"channel": "email", "purpose": "marketing", "proof": {"consent_version": "forge"}}') ->> 'consent_recorded'), 'false', 'consentement révoqué sur ce canal : la capture publique ne le réactive pas');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'p@cp.test', 'p@cp.test', null, null, null, '{}', '{"channel": "email", "purpose": "transactional"}')$$, '22023', null, 'finalité hors « marketing » / « newsletter » : refusée');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'p@cp.test', 'p@cp.test', null, null, null, '{}', '{"channel": "email", "purpose": "Marketing"}')$$, '22023', null, 'finalité mal formée : refusée');
reset role;
select is((select count(*)::int from public.consent_events where contact_id = 'cd000000-0000-4000-8000-0000000000e2' and channel = 'email' and revoked_at is null), 0, 'aucun consentement e-mail actif n''a été créé par la capture');
update public.contacts set do_not_contact = true where id = 'cd000000-0000-4000-8000-0000000000e2';
select set_config('t.leads_e2', (select count(*)::text from public.leads where contact_id = 'cd000000-0000-4000-8000-0000000000e2'), true);
select set_config('t.jobs_before', (select count(*)::text from public.jobs where kind = 'lead.assign'), true);
select pg_temp.as_service();
select is((public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'autre@cp.test', 'autre@cp.test', null, null, null, '{}',
  '{"channel": "email", "purpose": "marketing", "proof": {"consent_version": "v9"}}'))::text, '{"lead_created": false, "contact_created": false, "consent_recorded": false}'::jsonb::text, 'contact « ne plus contacter » : rien d''écrit (ni lead, ni consentement)');
reset role;
select is((select count(*)::text from public.leads where contact_id = 'cd000000-0000-4000-8000-0000000000e2'), current_setting('t.leads_e2'), 'contact « ne plus contacter » : aucun nouveau lead');
select is((select count(*)::text from public.jobs where kind = 'lead.assign'), current_setting('t.jobs_before'), 'contact « ne plus contacter » : aucun job d''assignation');
select pg_temp.as_service();
select is(public.form_key_origin_ok(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma'), true, 'clé active et origine de CETTE clé : valide');
select is(public.form_key_origin_ok(pg_temp.hk(current_setting('t.k1')), 'https://beta.ma'), false, 'origine d''une AUTRE clé : refusée');
select is(public.form_key_origin_ok(pg_temp.hk('flk_inconnue'), 'https://exemple.ma'), false, 'clé inconnue : refusée');
select is(public.form_key_origin_ok(pg_temp.hk(current_setting('t.k2')), 'https://autre.ma'), false, 'clé révoquée : refusée');
select is(public.form_key_origin_ok(null, 'https://exemple.ma'), false, 'empreinte absente : refusée');
reset role;
select ok(not has_function_privilege('anon', 'public.form_key_origin_ok(text, text)', 'execute'), 'anon : form_key_origin_ok non exécutable');
select ok(not has_function_privilege('authenticated', 'public.form_key_origin_ok(text, text)', 'execute'), 'authenticated : form_key_origin_ok non exécutable');

-- 12. Droits d'appel et audit ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ca000000-0000-4000-8000-000000000001');
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, '42501', null, 'un utilisateur connecté (owner) ne peut pas appeler capture_lead');
reset role;
set local role anon;
select throws_ok($$select public.capture_lead(pg_temp.hk(current_setting('t.k1')), 'https://exemple.ma', 'X', 'x@cp.test', 'x@cp.test', null, null, null, '{}', null)$$, '42501', null, 'anon ne peut pas appeler capture_lead');
reset role;
select ok(exists (select 1 from public.audit_logs where action = 'contact.created' and actor_kind = 'system' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 'audit : contact.created par le système');
select ok(exists (select 1 from public.audit_logs where action = 'lead.created' and actor_kind = 'system' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 'audit : lead.created par le système');
select ok(exists (select 1 from public.audit_logs where action = 'consent.recorded' and actor_kind = 'system' and organization_id = 'cb000000-0000-4000-8000-00000000000a'), 'audit : consent.recorded par le système');
select ok(not exists (
  select 1 from public.audit_logs
   where organization_id = 'cb000000-0000-4000-8000-00000000000a' and entity_type in ('contact', 'lead', 'consent_event', 'form_key')
     and (coalesce(before::text, '') || coalesce(after::text, '')) ~* '(nadia|@cp\.test|exemple\.test|\+2126|203\.0\.113|J''accepte|flk_[0-9a-f]{20})'
), 'audit : ni identité, ni e-mail, ni téléphone, ni IP, ni preuve, ni clé');

select * from finish();
rollback;
