-- J34 — Validation d'une intégration : `integration_set_validation` (service_role seulement) passe l'intégration à « active » ou « error » (code court),
-- audite sans donnée du fournisseur, refuse les intégrations déconnectées, sans jeton ou d'une autre entreprise. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea400000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@iv.test', now()
    from generate_series(1, 2) n;
insert into public.organizations (id, name, slug) values
  ('eb400000-0000-4000-8000-00000000000a', 'IV Alpha', 'iv-alpha-test'),
  ('eb400000-0000-4000-8000-00000000000b', 'IV Beta', 'iv-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb400000-0000-4000-8000-00000000000a', 'ea400000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb400000-0000-4000-8000-00000000000b', 'ea400000-0000-4000-8000-000000000002', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb400000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb400000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
-- secrets factices (la validation ne lit pas le contenu : seulement l'existence de secret_ref)
insert into private.secrets (id, organization_id, purpose, ciphertext, nonce, key_version) values
  ('ed400000-0000-4000-8000-000000000001', 'eb400000-0000-4000-8000-00000000000a', 'integration', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAA', 1),
  ('ed400000-0000-4000-8000-000000000002', 'eb400000-0000-4000-8000-00000000000a', 'integration', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAA', 1),
  ('ed400000-0000-4000-8000-000000000003', 'eb400000-0000-4000-8000-00000000000b', 'integration', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAA', 1);
insert into private.secrets (id, organization_id, purpose, ciphertext, nonce, key_version) values
  ('ed400000-0000-4000-8000-000000000011', 'eb400000-0000-4000-8000-00000000000a', 'integration_webhook', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAA', 1),
  ('ed400000-0000-4000-8000-000000000012', 'eb400000-0000-4000-8000-00000000000a', 'integration_webhook', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAA', 1);
insert into public.integrations (id, organization_id, provider, status, external_account_id, secret_ref) values
  ('ee400000-0000-4000-8000-000000000001', 'eb400000-0000-4000-8000-00000000000a', 'whatsapp', 'pending', '100000000000001', 'ed400000-0000-4000-8000-000000000001'),
  ('ee400000-0000-4000-8000-000000000002', 'eb400000-0000-4000-8000-00000000000a', 'whatsapp', 'disconnected', '100000000000002', null),
  ('ee400000-0000-4000-8000-000000000003', 'eb400000-0000-4000-8000-00000000000a', 'whatsapp', 'pending', '100000000000003', null),
  ('ee400000-0000-4000-8000-000000000004', 'eb400000-0000-4000-8000-00000000000b', 'whatsapp', 'pending', '100000000000004', 'ed400000-0000-4000-8000-000000000003'),
  ('ee400000-0000-4000-8000-000000000005', 'eb400000-0000-4000-8000-00000000000a', 'whatsapp', 'pending', '100000000000005', 'ed400000-0000-4000-8000-000000000002');

update public.integrations set webhook_secret_ref = 'ed400000-0000-4000-8000-000000000011' where id = 'ee400000-0000-4000-8000-000000000001';
update public.integrations set webhook_secret_ref = 'ed400000-0000-4000-8000-000000000012' where id = 'ee400000-0000-4000-8000-000000000005';
insert into private.secrets (id, organization_id, purpose, ciphertext, nonce, key_version) values
  ('ed400000-0000-4000-8000-000000000013', 'eb400000-0000-4000-8000-00000000000a', 'integration', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAA', 1);
insert into public.integrations (id, organization_id, provider, status, external_account_id, secret_ref) values
  ('ee400000-0000-4000-8000-000000000006', 'eb400000-0000-4000-8000-00000000000a', 'whatsapp', 'pending', '100000000000006', 'ed400000-0000-4000-8000-000000000013');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end $f$;
grant execute on function pg_temp.as_user(text), pg_temp.as_service(), pg_temp.as_anon() to public;

-- droits
select is(has_function_privilege('service_role', 'public.integration_set_validation(uuid, uuid, boolean, text, uuid)', 'execute'), true, 'service_role peut exécuter');
select is(has_function_privilege('authenticated', 'public.integration_set_validation(uuid, uuid, boolean, text, uuid)', 'execute'), false, 'authenticated ne peut pas');
select is(has_function_privilege('anon', 'public.integration_set_validation(uuid, uuid, boolean, text, uuid)', 'execute'), false, 'anon ne peut pas');
select is((select prosecdef from pg_proc where oid = 'private.integration_set_validation(uuid, uuid, boolean, text, uuid)'::regprocedure), true, 'fonction privée SECURITY DEFINER');
select pg_temp.as_user('ea400000-0000-4000-8000-000000000001');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', true, null, 'ea400000-0000-4000-8000-000000000001')$$, '42501', null, 'un owner connecté ne peut pas se déclarer « actif »');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', true, null, 'ea400000-0000-4000-8000-000000000001')$$, '42501', null, 'anon non plus');
reset role;
select is((select status from public.integrations where id = 'ee400000-0000-4000-8000-000000000001'), 'pending', 'le statut n''a pas bougé après les refus');

-- entrées invalides
select pg_temp.as_service();
select throws_ok($$select public.integration_set_validation(null, null, true, null, 'ea400000-0000-4000-8000-000000000001')$$, '22023', null, 'entrées nulles');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', true, 'provider_auth', 'ea400000-0000-4000-8000-000000000001')$$, '22023', null, 'succès avec un code : refusé');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', false, null, 'ea400000-0000-4000-8000-000000000001')$$, '22023', null, 'échec sans code : refusé');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', false, 'Token EAAG-secret expired', 'ea400000-0000-4000-8000-000000000001')$$, '22023', null, 'un texte libre du fournisseur est refusé (liste fermée de codes)');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000b', 'ee400000-0000-4000-8000-000000000001', true, null, 'ea400000-0000-4000-8000-000000000001')$$, 'PT404', null, 'l''intégration d''une autre entreprise est introuvable');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', gen_random_uuid(), true, null, 'ea400000-0000-4000-8000-000000000001')$$, 'PT404', null, 'intégration inconnue');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000002', true, null, 'ea400000-0000-4000-8000-000000000001')$$, 'P0001', null, 'intégration déconnectée : non validable');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000003', true, null, 'ea400000-0000-4000-8000-000000000001')$$, 'P0001', null, 'intégration sans jeton : non validable');
reset role;

-- application
select pg_temp.as_service();
select is(public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', true, null, 'ea400000-0000-4000-8000-000000000001'), 'active', 'succès : active');
reset role;
select is((select status from public.integrations where id = 'ee400000-0000-4000-8000-000000000001'), 'active', 'statut enregistré : active');
select is((select last_error from public.integrations where id = 'ee400000-0000-4000-8000-000000000001'), null, 'aucune erreur');
select pg_temp.as_service();
select is(public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000005', false, 'provider_auth', 'ea400000-0000-4000-8000-000000000001'), 'error', 'échec : error');
reset role;
select is((select last_error from public.integrations where id = 'ee400000-0000-4000-8000-000000000005'), 'provider_auth', 'code court enregistré');
select pg_temp.as_service();
select is(public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000005', true, null, 'ea400000-0000-4000-8000-000000000001'), 'active', 'une intégration en erreur redevient active après une validation réussie');
reset role;
select is((select last_error from public.integrations where id = 'ee400000-0000-4000-8000-000000000005'), null, 'l''erreur est effacée');
select is((select status from public.integrations where id = 'ee400000-0000-4000-8000-000000000004'), 'pending', 'l''intégration de l''autre entreprise n''a pas bougé');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb400000-0000-4000-8000-00000000000a' and action in ('integration.validated', 'integration.validation_failed')), 3, 'trois événements d''audit');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb400000-0000-4000-8000-00000000000a' and action like 'integration.validat%' and (after::text ~* 'EAAG|token|100000000000')), 0, 'ni jeton ni numéro dans l''audit');

-- le secret d'app est exigé pour activer une intégration WhatsApp ; un échec reste enregistrable ; l'acteur est dans l'audit
select pg_temp.as_service();
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000006', true, null, 'ea400000-0000-4000-8000-000000000001')$$, 'P0001', null, 'WhatsApp sans secret d''app : non activable');
select throws_ok($$select public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000001', true, null, null)$$, '22023', null, 'acteur obligatoire');
select is(public.integration_set_validation('eb400000-0000-4000-8000-00000000000a', 'ee400000-0000-4000-8000-000000000006', false, 'provider_account', 'ea400000-0000-4000-8000-000000000001'), 'error', 'un échec reste enregistrable sans secret d''app');
reset role;
select is((select status from public.integrations where id = 'ee400000-0000-4000-8000-000000000006'), 'error', 'statut enregistré : error');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb400000-0000-4000-8000-00000000000a' and action like 'integration.validat%' and after ->> 'actor' = 'ea400000-0000-4000-8000-000000000001'), 4, 'l''acteur est tracé dans l''audit');

select * from finish();
rollback;
