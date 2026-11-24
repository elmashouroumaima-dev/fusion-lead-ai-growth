-- S-03 : un consentement saisi par le formulaire public (source « web_form », adresse non vérifiée) n'est EFFECTIF pour un envoi (finalité marketing) que s'il est prouvé :
-- message ENTRANT du contact sur ce canal postérieur à la saisie, ou consentement humain (hors formulaire) actif. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  values ('eaa00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o@s3.test', now());
insert into public.organizations (id, name, slug) values ('ebb00000-0000-4000-8000-00000000000a', 'S3 Alpha', 's3-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values ('ebb00000-0000-4000-8000-00000000000a', 'eaa00000-0000-4000-8000-000000000001', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('ebb00000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('ecb00000-0000-4000-8000-0000000000a1', 'ebb00000-0000-4000-8000-00000000000a', 'S3 formulaire seul', 'c1@s3.test', 'c1@s3.test'),
  ('ecb00000-0000-4000-8000-0000000000a2', 'ebb00000-0000-4000-8000-00000000000a', 'S3 formulaire puis reponse', 'c2@s3.test', 'c2@s3.test'),
  ('ecb00000-0000-4000-8000-0000000000a3', 'ebb00000-0000-4000-8000-00000000000a', 'S3 reponse avant formulaire', 'c3@s3.test', 'c3@s3.test'),
  ('ecb00000-0000-4000-8000-0000000000a4', 'ebb00000-0000-4000-8000-00000000000a', 'S3 consentement humain', 'c4@s3.test', 'c4@s3.test'),
  ('ecb00000-0000-4000-8000-0000000000a5', 'ebb00000-0000-4000-8000-00000000000a', 'S3 formulaire et humain', 'c5@s3.test', 'c5@s3.test');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

select pg_temp.as_user('eaa00000-0000-4000-8000-000000000001');
select public.create_provider_integration('ebb00000-0000-4000-8000-00000000000a', 'email', 's3-mail', '{}', 'edb00000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
update public.integrations set status = 'active' where external_account_id = 's3-mail';
select pg_temp.as_user('eaa00000-0000-4000-8000-000000000001');
select public.create_channel('ebb00000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 's3-mail'), 'email', 'ventes@s3.test', '{}');
reset role;

select private.conversation_get_or_create('ebb00000-0000-4000-8000-00000000000a', c.id, (select id from public.channels where sender_identity = 'ventes@s3.test'))
  from public.contacts c where c.organization_id = 'ebb00000-0000-4000-8000-00000000000a';

-- consentements marketing (saisis il y a 2 jours) : formulaire pour c1, c2, c3 et c5 ; humain (source manuelle) pour c4 et c5
insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof, captured_at)
select 'ebb00000-0000-4000-8000-00000000000a', c.id, 'email', 'marketing', 'web_form', '{}'::jsonb, now() - interval '2 days'
  from public.contacts c where c.email_normalized in ('c1@s3.test', 'c2@s3.test', 'c3@s3.test', 'c5@s3.test');
insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof, captured_at)
select 'ebb00000-0000-4000-8000-00000000000a', c.id, 'email', 'marketing', 'manual', '{}'::jsonb, now() - interval '1 day'
  from public.contacts c where c.email_normalized in ('c4@s3.test', 'c5@s3.test');

-- messages entrants : c2 écrit APRÈS la saisie (il y a 1 jour) ; c3 avait écrit AVANT (il y a 3 jours)
select private.message_record('ebb00000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ecb00000-0000-4000-8000-0000000000a2'), 'inbound', 's3.in.c2', 'Bonjour', null, now() - interval '1 day');
select private.message_record('ebb00000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ecb00000-0000-4000-8000-0000000000a3'), 'inbound', 's3.in.c3', 'Bonjour', null, now() - interval '3 days');

-- un envoi marketing en file par contact, approuvé par le propriétaire
select private.message_record('ebb00000-0000-4000-8000-00000000000a', cv.id, 'outbound', null, 'Offre ' || c.email_normalized, 's3-key-' || split_part(c.email_normalized, '@', 1), null)
  from public.contacts c join public.conversations cv on cv.contact_id = c.id where c.organization_id = 'ebb00000-0000-4000-8000-00000000000a';
select pg_temp.as_user('eaa00000-0000-4000-8000-000000000001');
select public.message_approve('ebb00000-0000-4000-8000-00000000000a', m.id, 'marketing') from public.messages m where m.idempotency_key like 's3-key-%';
reset role;

select is((select private.message_send_claim('ebb00000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's3-key-c1')) ->> 'consent'), 'false',
  'S-03 : consentement du formulaire seul, jamais prouvé : pas effectif pour un envoi marketing');
select is((select private.message_send_claim('ebb00000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's3-key-c2')) ->> 'consent'), 'true',
  'S-03 : formulaire puis message entrant du contact : effectif (adresse prouvée)');
select is((select private.message_send_claim('ebb00000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's3-key-c3')) ->> 'consent'), 'false',
  'S-03 : le message entrant est ANTÉRIEUR à la saisie : ne prouve rien');
select is((select private.message_send_claim('ebb00000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's3-key-c4')) ->> 'consent'), 'true',
  'S-03 : consentement enregistré par un humain (source manuelle) : effectif tel quel');
select is((select private.message_send_claim('ebb00000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 's3-key-c5')) ->> 'consent'), 'true',
  'S-03 : formulaire ET consentement humain : effectif');

-- la règle elle-même, et sa surface
select is((select private.consent_is_effective('ebb00000-0000-4000-8000-00000000000a', 'ecb00000-0000-4000-8000-0000000000a1', 'email', 'marketing')), false, 'consent_is_effective : formulaire non prouvé = faux');
update public.consent_events set revoked_at = now() where contact_id = 'ecb00000-0000-4000-8000-0000000000a2' and source = 'web_form';
select is((select private.consent_is_effective('ebb00000-0000-4000-8000-00000000000a', 'ecb00000-0000-4000-8000-0000000000a2', 'email', 'marketing')), false, 'consent_is_effective : consentement révoqué = faux, même avec une réponse');
select ok(not has_function_privilege('authenticated', 'private.consent_is_effective(uuid, uuid, public.channel_type, text)', 'execute') and not has_function_privilege('anon', 'private.consent_is_effective(uuid, uuid, public.channel_type, text)', 'execute')
  and not has_function_privilege('service_role', 'private.consent_is_effective(uuid, uuid, public.channel_type, text)', 'execute'), 'consent_is_effective : exécutable par aucun rôle d''API');

select * from finish();
rollback;
