-- J30b — Recherche paginée des contacts (`search_contacts`) : droits (RLS de l'appelant : owner, admin, marketing ; commercial limité à
-- ses leads ; analyste rien), recherche (nom, e-mail, téléphone, caractères spéciaux échappés), pagination, isolation entre entreprises,
-- validation. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('fa100000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@sc.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('fb100000-0000-4000-8000-00000000000a', 'SC Alpha', 'sc-alpha-test'),
  ('fb100000-0000-4000-8000-00000000000b', 'SC Beta', 'sc-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('fb100000-0000-4000-8000-00000000000a', 'fa100000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('fb100000-0000-4000-8000-00000000000a', 'fa100000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('fb100000-0000-4000-8000-00000000000a', 'fa100000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('fb100000-0000-4000-8000-00000000000a', 'fa100000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('fb100000-0000-4000-8000-00000000000a', 'fa100000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('fb100000-0000-4000-8000-00000000000b', 'fa100000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('fb100000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('fb100000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('fd100000-0000-4000-8000-000000000001', 'fb100000-0000-4000-8000-00000000000a', 'Nadia Benali', 'Nadia@sc.test', 'nadia@sc.test', '+212612345678'),
  ('fd100000-0000-4000-8000-000000000002', 'fb100000-0000-4000-8000-00000000000a', 'Youssef Alami', 'youssef@sc.test', 'youssef@sc.test', '+966501234567'),
  ('fd100000-0000-4000-8000-000000000003', 'fb100000-0000-4000-8000-00000000000a', 'Remise 100% Club', 'remise@sc.test', 'remise@sc.test', null),
  ('fd100000-0000-4000-8000-000000000004', 'fb100000-0000-4000-8000-00000000000a', 'Jean_Pierre Dupont', 'jean@sc.test', 'jean@sc.test', null),
  ('fd100000-0000-4000-8000-0000000000b1', 'fb100000-0000-4000-8000-00000000000b', 'Nadia Beta', 'nadiab@sc.test', 'nadiab@sc.test', '+212612345600');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- owner : voit les 4 contacts d'Alpha, jamais ceux de Beta
select pg_temp.as_user('fa100000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a')), 4, 'owner : 4 contacts');
select is((select max(total_count)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a')), 4, 'le total accompagne chaque ligne');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000b')), 0, 'owner A : rien dans Beta');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a', 'nadia')), 1, 'recherche par nom (insensible à la casse, pas Beta)');
select is((select name from public.search_contacts('fb100000-0000-4000-8000-00000000000a', 'YOUSSEF@sc')), 'Youssef Alami', 'recherche par e-mail');
select is((select name from public.search_contacts('fb100000-0000-4000-8000-00000000000a', '06 12-34')), 'Nadia Benali', 'recherche par numéro national (zéro de tête ignoré)');
select is((select name from public.search_contacts('fb100000-0000-4000-8000-00000000000a', '+966 50')), 'Youssef Alami', 'recherche par numéro international');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a', '%')), 1, '« % » est un caractère, pas un joker : seul le contact qui en contient un répond');
select is((select name from public.search_contacts('fb100000-0000-4000-8000-00000000000a', '100%')), 'Remise 100% Club', '« % » littéral retrouvé');
select is((select name from public.search_contacts('fb100000-0000-4000-8000-00000000000a', 'jean_pierre')), 'Jean_Pierre Dupont', '« _ » littéral retrouvé');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a', 'jean-pierre')), 0, '« _ » n''est pas un joker d''un caractère quelconque');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a', null, 2, 0)), 2, 'pagination : première page');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a', null, 2, 3)), 1, 'pagination : dernière page partielle');
select throws_ok($$select * from public.search_contacts('fb100000-0000-4000-8000-00000000000a', null, 0, 0)$$, '22023', 'validation_failed', 'limite 0 refusée');
select throws_ok($$select * from public.search_contacts('fb100000-0000-4000-8000-00000000000a', null, 25, -1)$$, '22023', 'validation_failed', 'décalage négatif refusé');

-- marketing : même vue que l'owner
select pg_temp.as_user('fa100000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a')), 4, 'marketing : 4 contacts');

-- commercial (aucun lead) et analyste : aucun contact (RLS)
select pg_temp.as_user('fa100000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a')), 0, 'commercial sans lead : aucun contact');
select pg_temp.as_user('fa100000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a')), 0, 'analyste : aucun contact');

-- owner de Beta : ne voit pas Alpha
select pg_temp.as_user('fa100000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.search_contacts('fb100000-0000-4000-8000-00000000000a')), 0, 'owner B : rien dans Alpha');

select * from finish();
rollback;
