-- S-04 et S-05 (revue de sécurité de la Phase 3) : une réponse ne passe plus sur un consentement révoqué ; la révocation annule les envois en file ; la reprise de
-- l'arrêt d'urgence est réservée à owner et admin ; settings.send_paused ne se modifie que par la fonction. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('ea900000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o@s4.test', now()),
  ('ea900000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm@s4.test', now()),
  ('ea900000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@s4.test', now());
insert into public.organizations (id, name, slug) values ('eb900000-0000-4000-8000-00000000000a', 'S4 Alpha', 's4-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb900000-0000-4000-8000-00000000000a', 'ea900000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb900000-0000-4000-8000-00000000000a', 'ea900000-0000-4000-8000-000000000002', 'marketing_manager', 'active'),
  ('eb900000-0000-4000-8000-00000000000a', 'ea900000-0000-4000-8000-000000000003', 'company_admin', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('eb900000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('ec900000-0000-4000-8000-0000000000a1', 'eb900000-0000-4000-8000-00000000000a', 'S4 revoque tout', 'a1@s4.test', 'a1@s4.test'),
  ('ec900000-0000-4000-8000-0000000000a2', 'eb900000-0000-4000-8000-00000000000a', 'S4 revoque marketing', 'a2@s4.test', 'a2@s4.test'),
  ('ec900000-0000-4000-8000-0000000000a3', 'eb900000-0000-4000-8000-00000000000a', 'S4 sans consentement', 'a3@s4.test', 'a3@s4.test'),
  ('ec900000-0000-4000-8000-0000000000a4', 'eb900000-0000-4000-8000-00000000000a', 'S4 envoi en file', 'a4@s4.test', 'a4@s4.test');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

select pg_temp.as_user('ea900000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb900000-0000-4000-8000-00000000000a', 'email', 's4-mail', '{}', 'ed900000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
update public.integrations set status = 'active' where external_account_id = 's4-mail';
select pg_temp.as_user('ea900000-0000-4000-8000-000000000001');
select public.create_channel('eb900000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's4-mail'), 'email', 'ventes@s4.test', '{}');
reset role;

select private.conversation_get_or_create('eb900000-0000-4000-8000-00000000000a', c.id, (select id from public.channels where sender_identity = 'ventes@s4.test'))
  from public.contacts c where c.organization_id = 'eb900000-0000-4000-8000-00000000000a';
-- un message entrant d'il y a 1 jour pour chacun (couvre une réponse pendant 7 jours)
select private.message_record('eb900000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = c.id), 'inbound', 's4.in.' || c.email_normalized, 'Bonjour', null, now() - interval '1 day')
  from public.contacts c where c.organization_id = 'eb900000-0000-4000-8000-00000000000a';

-- consentements : a1 marketing ; a2 marketing + service
select pg_temp.as_user('ea900000-0000-4000-8000-000000000001');
select public.record_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'manual', '{}');
select public.record_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a2', 'email', 'marketing', 'manual', '{}');
select public.record_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a2', 'email', 'service', 'manual', '{}');
reset role;

-- ---------------------------------------------------------------------------
-- S-04 : réponse et révocation
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea900000-0000-4000-8000-000000000001');
-- a1 : le contact a écrit, puis TOUT son consentement est révoqué ; a2 : seul « marketing » est révoqué (« service » reste actif)
select is((select public.revoke_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a1', 'email', null, false)), 1, 'a1 : tout le consentement e-mail révoqué (une ligne)');
select is((select public.revoke_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a2', 'email', 'marketing', false)), 1, 'a2 : seul « marketing » révoqué');
select public.conversation_reply('eb900000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec900000-0000-4000-8000-0000000000a1'), 'Réponse a1', 's4-key-000001');
select public.conversation_reply('eb900000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec900000-0000-4000-8000-0000000000a2'), 'Réponse a2', 's4-key-000002');
select public.conversation_reply('eb900000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec900000-0000-4000-8000-0000000000a3'), 'Réponse a3', 's4-key-000003');
reset role;

select is((select private.message_send_claim('eb900000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's4-key-000001')) ->> 'consent'), 'false',
  'S-04 : le contact a écrit il y a 1 jour mais tout son consentement a été révoqué depuis : la réponse n''est plus couverte');
select is((select private.message_send_claim('eb900000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's4-key-000002')) ->> 'consent'), 'true',
  'S-04 : seul « marketing » révoqué, « service » reste actif : la réponse reste couverte');
select is((select private.message_send_claim('eb900000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's4-key-000003')) ->> 'consent'), 'true',
  'S-04 : jamais de consentement enregistré, a écrit il y a 1 jour : la réponse reste couverte (consentement conversationnel inchangé)');

-- révocation : les envois en file, non réclamés, sont annulés avec leur job
select pg_temp.as_user('ea900000-0000-4000-8000-000000000001');
select public.conversation_reply('eb900000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec900000-0000-4000-8000-0000000000a4'), 'En file a4', 's4-key-000004');
select public.record_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a4', 'email', 'marketing', 'manual', '{}');
reset role;
select is((select status::text from public.messages where idempotency_key = 's4-key-000004'), 'queued', 'a4 : réponse en file avant la révocation');
select pg_temp.as_user('ea900000-0000-4000-8000-000000000001');
select public.revoke_consent('eb900000-0000-4000-8000-00000000000a', 'ec900000-0000-4000-8000-0000000000a4', 'email', null, false);
reset role;
select is((select status::text from public.messages where idempotency_key = 's4-key-000004'), 'cancelled', 'S-04 : la révocation annule l''envoi en file du contact sur ce canal');
select is((select count(*)::int from public.jobs j where j.kind = 'send_message' and j.status = 'cancelled' and (j.payload ->> 'message_id') = (select id::text from public.messages where idempotency_key = 's4-key-000004')), 1, 'S-04 : son job send_message est annulé aussi');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb900000-0000-4000-8000-00000000000a' and action = 'message.cancelled' and (after ->> 'reason') = 'consent_revoked'), 'S-04 : audit message.cancelled (motif consent_revoked)');

-- ---------------------------------------------------------------------------
-- S-05 : reprise de l'arrêt d'urgence et garde de settings.send_paused
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea900000-0000-4000-8000-000000000002');
select lives_ok($$select public.set_send_emergency_stop('eb900000-0000-4000-8000-00000000000a', true)$$, 'S-05 : le marketing peut ARRÊTER les envois');
select throws_ok($$select public.set_send_emergency_stop('eb900000-0000-4000-8000-00000000000a', false)$$, '42501', null, 'S-05 : le marketing ne peut PAS reprendre');
select pg_temp.as_user('ea900000-0000-4000-8000-000000000003');
select lives_ok($$select public.set_send_emergency_stop('eb900000-0000-4000-8000-00000000000a', false)$$, 'S-05 : un administrateur peut reprendre');
reset role;
select throws_ok($$update public.organizations set settings = pg_catalog.jsonb_set(settings, '{send_paused}', 'true'::jsonb, true) where id = 'eb900000-0000-4000-8000-00000000000a'$$, '42501', null,
  'S-05 : écrire settings.send_paused hors de la fonction est refusé (le déclencheur ne dépend pas du rôle)');

select * from finish();
rollback;
