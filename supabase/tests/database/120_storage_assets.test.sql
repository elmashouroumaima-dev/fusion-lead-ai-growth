-- J17 (partie 2) — Storage : bucket privé `assets`, politiques par entreprise, chemins, rôles, projet archivé.
-- Les objets sont insérés sous le propriétaire (fixtures) ; les contrôles se font sous les rôles concernés. La suppression
-- passe par l'API Storage (Storage interdit le DELETE SQL direct) : elle est testée dans `supabase/tests/rls`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyst A · U6 owner B · U7 sans adhésion · U8 retiré de A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('7e000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@sa.test', now()
    from generate_series(1, 8) n;
insert into public.organizations (id, name, slug) values
  ('7f000000-0000-4000-8000-00000000000a', 'SA Alpha', 'sa-alpha-test'),
  ('7f000000-0000-4000-8000-00000000000b', 'SA Beta', 'sa-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('7f000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('7f000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('7f000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('7f000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('7f000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('7f000000-0000-4000-8000-00000000000a', '7e000000-0000-4000-8000-000000000008', 'analyst', 'removed'),
  ('7f000000-0000-4000-8000-00000000000b', '7e000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('7f000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('7f000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
-- A1 actif et A2 archivé chez Alpha, B1 actif chez Beta
insert into public.projects (id, organization_id, type, name, status) values
  ('7c100000-0000-4000-8000-0000000000a1', '7f000000-0000-4000-8000-00000000000a', 'custom', 'A1', 'active'),
  ('7c100000-0000-4000-8000-0000000000a2', '7f000000-0000-4000-8000-00000000000a', 'custom', 'A2', 'archived'),
  ('7c100000-0000-4000-8000-0000000000b1', '7f000000-0000-4000-8000-00000000000b', 'custom', 'B1', 'active');
-- Objets de fixture (un par projet) et un second bucket sans politique
insert into storage.buckets (id, name, public) values ('autre', 'autre', false);
insert into storage.objects (bucket_id, name) values
  ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/logo.png'),
  ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a2/7d100000-0000-4000-8000-000000000002/ancien.pdf'),
  ('assets', '7f000000-0000-4000-8000-00000000000b/7c100000-0000-4000-8000-0000000000b1/7d100000-0000-4000-8000-000000000003/beta.png'),
  ('autre', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000004/x.png');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Bucket et droits -----------------------------------------------------------------------------------------------------
select is((select public from storage.buckets where id = 'assets'), false, 'bucket assets : privé');
select is((select file_size_limit from storage.buckets where id = 'assets'), 10485760::bigint, 'bucket assets : 10 Mo au plus');
select is((select allowed_mime_types from storage.buckets where id = 'assets'), array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], 'bucket assets : png, jpeg, webp, pdf seulement');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'assets\_%'), 3, 'trois politiques : lecture, insertion, suppression (aucune mise à jour)');
select is((select array_agg(cmd order by cmd) from pg_policies where schemaname = 'storage' and policyname like 'assets\_%'), array['DELETE', 'INSERT', 'SELECT'], 'commandes couvertes : DELETE, INSERT, SELECT');
select ok(not (select 'anon' = any (roles::text[]) or 'public' = any (roles::text[]) from pg_policies where schemaname = 'storage' and policyname = 'assets_select'), 'aucune politique pour anon ni PUBLIC');
select ok(not has_function_privilege('anon', 'private.can_read_asset(text)', 'execute'), 'anon : can_read_asset non exécutable');
select ok(not has_function_privilege('service_role', 'private.can_write_asset(text)', 'execute'), 'service_role : can_write_asset non exécutable');

-- 2. Forme du chemin ------------------------------------------------------------------------------------------------------
select is(private.asset_path_ok('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/logo.png'), true, 'chemin valide');
select is(private.asset_path_ok('7F000000-0000-4000-8000-00000000000A/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/logo.png'), false, 'majuscules refusées');
select is(private.asset_path_ok('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/logo.png'), false, 'identifiant de fichier manquant refusé');
select is(private.asset_path_ok('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/../x.png'), false, 'traversée « .. » refusée');
select is(private.asset_path_ok('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/a b.png'), false, 'espace dans le nom refusé');
select is(private.asset_path_ok('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/sous/x.png'), false, 'sous-dossier refusé');
select is(private.asset_path_ok('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/' || repeat('a', 121)), false, 'nom de plus de 120 caractères refusé');
select is(private.asset_path_ok(null), false, 'chemin NULL refusé');

-- 3. Lecture par rôle et entreprise -----------------------------------------------------------------------------------------
select pg_temp.as_user('7e000000-0000-4000-8000-000000000005');
select is((select count(*)::int from storage.objects where bucket_id = 'assets'), 2, 'analyste d''Alpha : voit les 2 objets d''Alpha (projet actif et archivé), aucun de Beta');
select is((select count(*)::int from storage.objects where bucket_id = 'autre'), 0, 'analyste : rien dans un autre bucket');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000004');
select is((select count(*)::int from storage.objects where bucket_id = 'assets'), 2, 'commercial d''Alpha : lecture autorisée');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000006');
select is((select array_agg(name) from storage.objects where bucket_id = 'assets'), array['7f000000-0000-4000-8000-00000000000b/7c100000-0000-4000-8000-0000000000b1/7d100000-0000-4000-8000-000000000003/beta.png'], 'propriétaire de Beta : uniquement l''objet de Beta');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000007');
select is((select count(*)::int from storage.objects where bucket_id = 'assets'), 0, 'sans adhésion : rien');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000008');
select is((select count(*)::int from storage.objects where bucket_id = 'assets'), 0, 'membre retiré : rien');
reset role;
set local role anon;
select is((select count(*)::int from storage.objects where bucket_id = 'assets'), 0, 'anonyme : rien');
reset role;

-- 4. Insertion (écriture) ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('7e000000-0000-4000-8000-000000000001');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000010/nouveau.png')$$, 'owner : insère sous un projet actif de son entreprise');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000b/7c100000-0000-4000-8000-0000000000b1/7d100000-0000-4000-8000-000000000011/x.png')$$, '42501', null, 'owner d''Alpha : insertion dans le dossier de Beta refusée');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000b1/7d100000-0000-4000-8000-000000000012/x.png')$$, '42501', null, 'projet d''une AUTRE entreprise rangé sous son organisation : refusé');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a2/7d100000-0000-4000-8000-000000000013/x.png')$$, '42501', null, 'projet archivé : insertion refusée');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000ff/7d100000-0000-4000-8000-000000000014/x.png')$$, '42501', null, 'projet inexistant : insertion refusée');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', 'logo.png')$$, '42501', null, 'chemin sans entreprise ni projet refusé');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000015/../../x.png')$$, '42501', null, 'traversée refusée');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('autre', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000016/x.png')$$, '42501', null, 'autre bucket : aucune politique, insertion refusée');
select is((select count(*)::int from storage.objects where bucket_id = 'assets'), 3, 'l''owner voit ses 3 objets (2 + le nouveau)');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000002');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000020/admin.png')$$, 'admin : insère');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000003');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000021/m.png')$$, '42501', null, 'marketing : insertion refusée');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000004');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000022/s.png')$$, '42501', null, 'commercial : insertion refusée');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000005');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000023/a.png')$$, '42501', null, 'analyste : insertion refusée');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000006');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000024/b.png')$$, '42501', null, 'owner de Beta : insertion refusée chez Alpha');
reset role;
select pg_temp.as_user('7e000000-0000-4000-8000-000000000007');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000025/o.png')$$, '42501', null, 'sans adhésion : insertion refusée');
reset role;
set local role anon;
select throws_ok($$insert into storage.objects (bucket_id, name) values ('assets', '7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000026/anon.png')$$, '42501', null, 'anonyme : insertion refusée');
reset role;

-- 5. Écriture : fonction (la suppression suit la même règle) et pas de mise à jour --------------------------------------
select pg_temp.as_user('7e000000-0000-4000-8000-000000000001');
select is(private.can_write_asset('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/logo.png'), true, 'owner : peut écrire / supprimer sous un projet actif');
select is(private.can_write_asset('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a2/7d100000-0000-4000-8000-000000000002/ancien.pdf'), false, 'owner : pas d''écriture ni de suppression sous un projet archivé');
select is(private.can_read_asset('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a2/7d100000-0000-4000-8000-000000000002/ancien.pdf'), true, 'owner : lecture possible sous un projet archivé');
select lives_ok($$update storage.objects set name = name || 'x' where bucket_id = 'assets'$$, 'une mise à jour est sans effet (aucune politique : zéro ligne)');
reset role;
select is((select count(*)::int from storage.objects where name like '%x'), 0, 'aucun objet renommé : pas d''écrasement ni de renommage');
select pg_temp.as_user('7e000000-0000-4000-8000-000000000005');
select is(private.can_write_asset('7f000000-0000-4000-8000-00000000000a/7c100000-0000-4000-8000-0000000000a1/7d100000-0000-4000-8000-000000000001/logo.png'), false, 'analyste : pas d''écriture ni de suppression');
reset role;

select * from finish();
rollback;
