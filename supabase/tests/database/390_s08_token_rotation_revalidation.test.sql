-- S-08 : remplacer le jeton d'une intégration ACTIVE la repasse en `pending` (et ses canaux actifs) jusqu'à une nouvelle validation ; un résultat de validation obtenu avec un
-- ANCIEN secret est refusé (`stale_validation`). Une intégration désactivée reste désactivée. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  values ('eac00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o@s8.test', now());
insert into public.organizations (id, name, slug) values ('ebc00000-0000-4000-8000-00000000000a', 'S8 Alpha', 's8-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values ('ebc00000-0000-4000-8000-00000000000a', 'eac00000-0000-4000-8000-000000000001', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('ebc00000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

select pg_temp.as_user('eac00000-0000-4000-8000-000000000001');
select public.create_provider_integration('ebc00000-0000-4000-8000-00000000000a', 'email', 's8-mail', '{}', 'edc00000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
update public.integrations set status = 'active' where external_account_id = 's8-mail';
select pg_temp.as_user('eac00000-0000-4000-8000-000000000001');
select public.create_channel('ebc00000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's8-mail'), 'email', 'ventes@s8.test', '{}');
reset role;
select is((select ch.status::text from public.channels ch where ch.sender_identity = 'ventes@s8.test'), 'active', 'départ : intégration active, canal actif');

-- rotation du jeton (nouveau secret edc...02)
select pg_temp.as_user('eac00000-0000-4000-8000-000000000001');
select public.set_integration_secret('ebc00000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's8-mail'), 'edc00000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
select is((select status from public.integrations where external_account_id = 's8-mail'), 'pending', 'S-08 : remplacer le jeton d''une intégration ACTIVE la repasse en « pending » (jeton jamais essayé)');
select is((select ch.status::text from public.channels ch where ch.sender_identity = 'ventes@s8.test'), 'pending', 'S-08 : son canal actif repasse en « pending » : rien ne part avec un jeton non vérifié');

-- un résultat obtenu avec l'ANCIEN secret (edc...01) est refusé ; l'état ne change pas
select throws_ok($$select private.integration_set_validation('ebc00000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's8-mail'), true, null, 'eac00000-0000-4000-8000-000000000001', 'edc00000-0000-4000-8000-000000000001')$$,
  'P0001', 'stale_validation', 'S-08 : un résultat obtenu avec l''ancien secret est refusé (stale_validation)');
select is((select status from public.integrations where external_account_id = 's8-mail'), 'pending', 'S-08 : le refus n''écrit rien : l''intégration reste « pending »');

-- le résultat du secret COURANT (edc...02) active l'intégration et son canal
select is((select private.integration_set_validation('ebc00000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's8-mail'), true, null, 'eac00000-0000-4000-8000-000000000001', 'edc00000-0000-4000-8000-000000000002')), 'active', 'S-08 : le résultat du secret courant active l''intégration');
select is((select ch.status::text from public.channels ch where ch.sender_identity = 'ventes@s8.test'), 'active', 'S-08 : et son canal');

-- une intégration désactivée reste désactivée après un remplacement de jeton
update public.integrations set status = 'disabled' where external_account_id = 's8-mail';
select pg_temp.as_user('eac00000-0000-4000-8000-000000000001');
select public.set_integration_secret('ebc00000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's8-mail'), 'edc00000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
select is((select status from public.integrations where external_account_id = 's8-mail'), 'disabled', 'S-08 : une intégration désactivée reste désactivée');

select * from finish();
rollback;
