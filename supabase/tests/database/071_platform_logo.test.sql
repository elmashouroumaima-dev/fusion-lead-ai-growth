-- J12b — logo de la plateforme dans platform_config : droits, validation (type, signature, base64, taille),
-- date de version. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

-- U1 owner · U2 sales
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('74000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@pl.test', now()),
  ('74000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@pl.test', now());
insert into public.organizations (id, name, slug) values ('75000000-0000-4000-8000-000000000001', 'PL Alpha', 'pl-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000002', 'sales_agent', 'active');
delete from public.platform_config;

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- PNG 1x1 valide (base64).
create function pg_temp.png() returns jsonb language sql immutable as $f$
  select jsonb_build_object('mime', 'image/png', 'data', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==')
$f$;
grant execute on function pg_temp.png() to public;

select pg_temp.as_user('74000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_platform_config('appearance.logo', pg_temp.png())$$, 'owner : enregistre un PNG valide');
reset role;
select is((select value ->> 'mime' from public.platform_config where key = 'appearance.logo'), 'image/png', 'logo enregistré');

set local role service_role;
select is((public.get_platform_config('appearance.logo')) ->> 'mime', 'image/png', 'service_role : lit le logo');
select isnt(public.get_platform_config_updated_at('appearance.logo'), null, 'service_role : date de version disponible');
reset role;
select pg_temp.as_user('74000000-0000-4000-8000-000000000002');
select throws_ok($$select public.get_platform_config_updated_at('appearance.logo')$$, '42501', null, 'authenticated : date de version refusée (lecture serveur)');
select throws_ok($$select public.set_platform_config('appearance.logo', pg_temp.png())$$, '42501', 'forbidden', 'sales_agent : refusé');
reset role;

select pg_temp.as_user('74000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_platform_config('appearance.logo', jsonb_build_object('mime', 'image/png', 'data', encode('<svg><script>1</script></svg>'::bytea, 'base64')))$$,
  '22023', 'validation_failed', 'SVG déguisé en PNG : refusé (signature)');
select throws_ok($$select public.set_platform_config('appearance.logo', jsonb_build_object('mime', 'image/svg+xml', 'data', (pg_temp.png()) ->> 'data'))$$,
  '22023', 'validation_failed', 'type SVG annoncé : refusé');
select throws_ok($$select public.set_platform_config('appearance.logo', jsonb_build_object('mime', 'image/jpeg', 'data', (pg_temp.png()) ->> 'data'))$$,
  '22023', 'validation_failed', 'PNG annoncé JPEG : refusé');
select throws_ok($$select public.set_platform_config('appearance.logo', (pg_temp.png()) || '{"extra": 1}'::jsonb)$$,
  '22023', 'validation_failed', 'clé en trop : refusée');
select throws_ok($$select public.set_platform_config('appearance.logo', jsonb_build_object('mime', 'image/png', 'data', 'pas du base64 !!'))$$,
  '22023', 'validation_failed', 'base64 invalide : refusé');
select throws_ok($$select public.set_platform_config('appearance.logo', jsonb_build_object('mime', 'image/png',
  'data', replace(encode('\x89504e470d0a1a0a'::bytea || decode(repeat('00', 131073), 'hex'), 'base64'), E'\n', '')))$$,
  '22023', 'validation_failed', 'image décodée > 128 Ko : refusée');
select lives_ok($$select public.reset_platform_config('appearance.logo')$$, 'owner : reset du logo');
reset role;
select is((select count(*)::int from public.platform_config where key = 'appearance.logo'), 0, 'reset : ligne supprimée');
select pg_temp.as_user('74000000-0000-4000-8000-000000000001');
select throws_ok($$insert into public.platform_config (key, value) values ('appearance.logo', '{}'::jsonb)$$, '42501', null, 'INSERT direct refusé');
reset role;

select * from finish();
rollback;
