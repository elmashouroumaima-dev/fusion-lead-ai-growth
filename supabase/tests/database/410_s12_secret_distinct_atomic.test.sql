-- S-12 : le secret de webhook doit différer du jeton d'envoi, contrôlé par la BASE dans la transaction qui écrit (empreintes HMAC fournies par le serveur), dans les deux sens
-- (secret de webhook = jeton, jeton = secret de webhook). Un secret sans empreinte (ancien) reste accepté. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  values ('eac00000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o@s12.test', now());
insert into public.organizations (id, name, slug) values ('ebc00000-0000-4000-8000-00000000001a', 'S12 Alpha', 's12-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values ('ebc00000-0000-4000-8000-00000000001a', 'eac00000-0000-4000-8000-000000000012', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('ebc00000-0000-4000-8000-00000000001a', (select id from public.plans where code = 'growth'), 'active');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- empreintes de test : A (jeton d'envoi), B (secret de webhook), C (autre jeton)
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select public.create_provider_integration('ebc00000-0000-4000-8000-00000000001a', 'email', 's12-mail', '{}', 'edc00000-0000-4000-8000-000000000101', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'meta', repeat('a', 64));
reset role;
select is((select s.fingerprint from private.secrets s where s.id = 'edc00000-0000-4000-8000-000000000101'), repeat('a', 64), 'S-12 : l''empreinte du jeton est enregistrée avec le secret');

-- secret de webhook différent : accepté
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select public.set_integration_webhook_secret('ebc00000-0000-4000-8000-00000000001a', (select id from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000102', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, repeat('b', 64));
reset role;
select is((select webhook_secret_ref from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000102'::uuid, 'S-12 : un secret de webhook différent du jeton est accepté');

-- secret de webhook = jeton d'envoi (même empreinte) : refusé par la base
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select throws_ok($$select public.set_integration_webhook_secret('ebc00000-0000-4000-8000-00000000001a', (select id from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000103', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, repeat('a', 64))$$,
  '22023', 'validation_failed', 'S-12 : un secret de webhook de même empreinte que le jeton d''envoi est refusé par la base');
reset role;
select is((select webhook_secret_ref from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000102'::uuid, 'S-12 : le refus n''écrit rien : l''ancien secret de webhook reste en place');

-- jeton d'envoi = secret de webhook (sens inverse) : refusé
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select throws_ok($$select public.set_integration_secret('ebc00000-0000-4000-8000-00000000001a', (select id from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000104', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, repeat('b', 64))$$,
  '22023', 'validation_failed', 'S-12 : un nouveau jeton de même empreinte que le secret de webhook est refusé');

-- jeton différent : accepté
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select public.set_integration_secret('ebc00000-0000-4000-8000-00000000001a', (select id from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000105', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, repeat('c', 64));
reset role;
select is((select secret_ref from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000105'::uuid, 'S-12 : un jeton différent est accepté');

-- un secret écrit sans empreinte (ancien appel) reste accepté : la base ne le compare pas
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select lives_ok($$select public.set_integration_secret('ebc00000-0000-4000-8000-00000000001a', (select id from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000106', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$,
  'S-12 : un appel sans empreinte (ancienne signature) reste accepté');
reset role;

-- une empreinte mal formée est refusée par la contrainte
select pg_temp.as_user('eac00000-0000-4000-8000-000000000012');
select throws_ok($$select public.set_integration_secret('ebc00000-0000-4000-8000-00000000001a', (select id from public.integrations where external_account_id = 's12-mail'), 'edc00000-0000-4000-8000-000000000107', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'pas-une-empreinte')$$,
  '23514', null, 'S-12 : une empreinte mal formée est refusée');
reset role;

select * from finish();
rollback;
