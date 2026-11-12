-- J12b — platform_config : aucun droit direct, lecture par fonction réservée à service_role, écriture réservée aux
-- owner / admin ACTIFS d'une organisation, validation de la palette. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

-- U1 owner Alpha · U2 admin Alpha · U3 sales Alpha · U4 sans adhésion · U5 owner suspendu Alpha
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('72000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@pc.test', now()),
  ('72000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@pc.test', now()),
  ('72000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u3@pc.test', now()),
  ('72000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u4@pc.test', now()),
  ('72000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u5@pc.test', now());
insert into public.organizations (id, name, slug) values ('73000000-0000-4000-8000-000000000001', 'PC Alpha', 'pc-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000003', 'sales_agent', 'active'),
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000005', 'company_owner', 'suspended');

-- On repart d'une table vide (la palette locale éventuelle ne doit pas fausser les comptes).
delete from public.platform_config;

create function pg_temp.pal(p_primary text default '#1d4ed8') returns jsonb
language sql immutable as $f$
  select jsonb_build_object('light', jsonb_build_object('primary', p_primary, 'background', '#ffffff'))
$f$;
grant execute on function pg_temp.pal(text) to public;

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Structure
select has_table('public', 'platform_config', 'platform_config existe');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.platform_config'::regclass), 'RLS activée');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'platform_config'), 0, 'aucune politique : aucun accès direct');
select ok(not has_table_privilege('anon', 'public.platform_config', 'select,insert,update,delete'), 'anon : aucun droit direct');
select ok(not has_table_privilege('authenticated', 'public.platform_config', 'select,insert,update,delete'), 'authenticated : aucun droit direct');
select ok(not has_table_privilege('service_role', 'public.platform_config', 'select,insert,update,delete'), 'service_role : aucun droit direct');
select hasnt_table('public', 'platform_admins', 'pas de table platform_admins publique (le rôle Platform Admin viendra en J14, schéma private)');

-- 2. Écriture directe impossible, même pour un owner
select pg_temp.as_user('72000000-0000-4000-8000-000000000001');
select throws_ok($$insert into public.platform_config (key, value) values ('appearance.palette', '{}'::jsonb)$$, '42501', null, 'INSERT direct refusé (même owner)');

-- 3. can_manage_platform_config
select is(public.can_manage_platform_config(), true, 'owner actif : true');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000002');
select is(public.can_manage_platform_config(), true, 'admin actif : true');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000003');
select is(public.can_manage_platform_config(), false, 'sales_agent : false');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000004');
select is(public.can_manage_platform_config(), false, 'sans adhésion : false');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000005');
select is(public.can_manage_platform_config(), false, 'owner suspendu : false');
reset role;

-- 4. Écriture par owner et admin
select pg_temp.as_user('72000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal())$$, 'owner : set_platform_config');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000002');
select lives_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('#6d28d9'))$$, 'admin : upsert');
reset role;
select is((select count(*)::int from public.platform_config), 1, 'une seule ligne');
select is((select updated_by from public.platform_config), '72000000-0000-4000-8000-000000000002'::uuid, 'updated_by = auth.uid()');

-- 5. Lecture : service_role seulement
set local role service_role;
select is((public.get_platform_config('appearance.palette')) #>> '{light,primary}', '#6d28d9', 'service_role (serveur) : lit la palette');
select is(public.get_platform_config('other.key'), null, 'clé hors liste blanche : null');
reset role;
set local role anon;
select throws_ok($$select public.get_platform_config('appearance.palette')$$, '42501', null, 'anon : get_platform_config refusé');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000003');
select throws_ok($$select public.get_platform_config('appearance.palette')$$, '42501', null, 'authenticated : get_platform_config refusé (lecture serveur seulement)');

-- 6. Refus : sales, sans adhésion, suspendu, anon
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('#c2410c'))$$, '42501', 'forbidden', 'sales_agent : refusé');
select throws_ok($$select public.reset_platform_config('appearance.palette')$$, '42501', 'forbidden', 'sales_agent : reset refusé');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000004');
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('#c2410c'))$$, '42501', 'forbidden', 'sans adhésion : refusé');
reset role;
select pg_temp.as_user('72000000-0000-4000-8000-000000000005');
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('#c2410c'))$$, '42501', 'forbidden', 'owner suspendu : refusé');
reset role;
set local role anon;
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal())$$, '42501', null, 'anon : EXECUTE refusé');
reset role;
select is((select value #>> '{light,primary}' from public.platform_config), '#6d28d9', 'aucune tentative refusée n''a modifié la valeur');

-- 7. Validation (owner)
select pg_temp.as_user('72000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_platform_config('other.key', pg_temp.pal())$$, '22023', 'validation_failed', 'clé hors liste blanche refusée');
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('red'))$$, '22023', 'validation_failed', 'couleur non hex refusée');
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('#FFFFFF'))$$, '22023', 'validation_failed', 'majuscules refusées');
select throws_ok($$select public.set_platform_config('appearance.palette', pg_temp.pal('#fff;}body{x:y'))$$, '22023', 'validation_failed', 'injection CSS refusée');
select throws_ok($$select public.set_platform_config('appearance.palette', '{"light":{"evil":"#000000"}}'::jsonb)$$, '22023', 'validation_failed', 'jeton inconnu refusé');
select throws_ok($$select public.set_platform_config('appearance.palette', '[]'::jsonb)$$, '22023', 'validation_failed', 'valeur non objet refusée');

-- 8. Reset
select lives_ok($$select public.reset_platform_config('appearance.palette')$$, 'owner : reset');
reset role;
select is((select count(*)::int from public.platform_config), 0, 'reset : ligne supprimée');

select * from finish();
rollback;
