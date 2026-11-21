-- Désinscription WhatsApp annoncée par Kapso (ADR 017) : `whatsapp_marketing_preference_apply` (service_role seulement). Refus d'abord (appelants sans droit, valeurs invalides, intégration
-- d'une autre entreprise), puis « stopped » = désinscription complète (consentements révoqués, numéro supprimé, envois en file annulés), numéro sans contact (suppression seule),
-- « resumed » sans effet, rejeu sans effet. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea700000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@mp.test', now()
    from generate_series(1, 2) n;
insert into public.organizations (id, name, slug) values
  ('eb700000-0000-4000-8000-00000000000a', 'MP Alpha', 'mp-alpha-test'),
  ('eb700000-0000-4000-8000-00000000000b', 'MP Beta', 'mp-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb700000-0000-4000-8000-00000000000a', 'ea700000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb700000-0000-4000-8000-00000000000b', 'ea700000-0000-4000-8000-000000000002', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb700000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb700000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec700000-0000-4000-8000-0000000000a1', 'eb700000-0000-4000-8000-00000000000a', 'MP C1', null, null, '+212600000071'),
  ('ec700000-0000-4000-8000-0000000000a2', 'eb700000-0000-4000-8000-00000000000a', 'MP C2', null, null, '+212600000072');

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
grant execute on function pg_temp.as_user(text), pg_temp.as_service() to public;

select pg_temp.as_user('ea700000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb700000-0000-4000-8000-00000000000a', 'whatsapp', '900000000000001', '{}', 'ed700000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'kapso');
reset role;
update public.integrations set status = 'active' where external_account_id = '900000000000001';
select pg_temp.as_user('ea700000-0000-4000-8000-000000000001');
select public.create_channel('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), 'whatsapp', '+212600000091', '{}');
reset role;
-- le contact C1 a un consentement WhatsApp et un message en file, non réclamé
insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('eb700000-0000-4000-8000-00000000000a', 'ec700000-0000-4000-8000-0000000000a1', 'whatsapp', 'service', 'manual');
select private.conversation_get_or_create('eb700000-0000-4000-8000-00000000000a', 'ec700000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = '+212600000091'));
select private.message_record('eb700000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec700000-0000-4000-8000-0000000000a1'), 'outbound', null, 'Message en file', 'mp-queued-key-1', null);

-- ---------------------------------------------------------------------------
-- Refus
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea700000-0000-4000-8000-000000000001');
select throws_ok($$select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000071', 'stopped')$$, '42501', null, 'un owner ne peut pas appeler la fonction (service_role seulement)');
reset role;
set local role anon;
select throws_ok($$select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', gen_random_uuid(), '+212600000071', 'stopped')$$, '42501', null, 'sans rôle (anon) : refusé');
reset role;

select pg_temp.as_service();
select throws_ok($$select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '212600000071', 'stopped')$$, '22023', 'validation_failed', 'numéro sans « + » : refusé');
select throws_ok($$select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000071', 'autre')$$, '22023', 'validation_failed', 'statut inconnu : refusé');
select throws_ok($$select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000b', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000071', 'stopped')$$, 'PT404', null, 'intégration d''une autre entreprise : introuvable');
reset role;
select is((select count(*)::int from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a'), 0, 'aucun refus ne supprime rien');

-- ---------------------------------------------------------------------------
-- « resumed » : rien n'est réactivé, rien n'est écrit
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select is((select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000071', 'resumed') ->> 'outcome'), 'ignored', '« resumed » : ignoré');
reset role;
select is((select count(*)::int from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a'), 0, '« resumed » ne supprime rien');
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000a1' and revoked_at is null), 1, '« resumed » ne révoque rien');

-- ---------------------------------------------------------------------------
-- « stopped » : désinscription complète
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select is((select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000071', 'stopped') ->> 'outcome'), 'applied', '« stopped » : appliqué');
reset role;
select is((select count(*)::int from public.consent_events where contact_id = 'ec700000-0000-4000-8000-0000000000a1' and channel = 'whatsapp' and revoked_at is null), 0, 'consentements WhatsApp révoqués');
select is((select count(*)::int from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a' and channel = 'whatsapp' and value_normalized = '+212600000071'), 1, 'numéro supprimé');
select is((select status::text from public.messages where idempotency_key = 'mp-queued-key-1'), 'cancelled', 'envoi en file annulé');
select is((select do_not_contact from public.contacts where id = 'ec700000-0000-4000-8000-0000000000a1'), false, '« ne plus contacter » inchangé (comme un STOP)');
select is((select count(*)::int from public.audit_logs where action = 'whatsapp.opt_out' and organization_id = 'eb700000-0000-4000-8000-00000000000a'), 1, 'audité (identifiants seulement)');

-- rejeu : même résultat, aucun doublon
select pg_temp.as_service();
select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000071', 'stopped');
reset role;
select is((select count(*)::int from public.suppressions where organization_id = 'eb700000-0000-4000-8000-00000000000a' and value_normalized = '+212600000071'), 1, 'rejeu : une seule suppression');

-- numéro sans contact : la suppression du numéro seule
select pg_temp.as_service();
select is((select public.whatsapp_marketing_preference_apply('eb700000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = '900000000000001'), '+212600000099', 'stopped') ->> 'reason'), 'no_contact', 'numéro sans contact : suppression du numéro seule');
reset role;

select * from finish();
rollback;
