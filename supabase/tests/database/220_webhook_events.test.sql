-- J29 — Pipeline webhook : webhook_events (métadonnées seules lisibles, payload jamais), fonctions réservées à service_role (résolution du
-- tenant par le COMPTE fournisseur, enregistrement idempotent + job process_webhook dans la même transaction, trace de rejet plafonnée,
-- démarrage et fin côté worker), unicité par entreprise, plafond de la file, isolation entre entreprises. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(78);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('da000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@wh.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('db000000-0000-4000-8000-00000000000a', 'WH Alpha', 'wh-alpha-test'),
  ('db000000-0000-4000-8000-00000000000b', 'WH Beta', 'wh-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('db000000-0000-4000-8000-00000000000b', 'da000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('db000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('db000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');

-- intégrations : whatsapp et e-mail chez A, whatsapp chez B (créées par leurs owners), csv chez A
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

select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select public.create_provider_integration('db000000-0000-4000-8000-00000000000a', 'whatsapp', 'wh-wa-a', '{}', 'dc000000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('db000000-0000-4000-8000-00000000000a', 'email', 'wh-mail-a', '{}', 'dc000000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_integration('db000000-0000-4000-8000-00000000000a', 'csv', 'wh-csv');
reset role;
select pg_temp.as_user('da000000-0000-4000-8000-000000000006');
select public.create_provider_integration('db000000-0000-4000-8000-00000000000b', 'whatsapp', 'wh-wa-b', '{}', 'dc000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;

-- ---------------------------------------------------------------------------
-- Structure et droits
-- ---------------------------------------------------------------------------
select has_table('public', 'webhook_events', 'la table webhook_events existe');
select ok((select relrowsecurity from pg_class where oid = 'public.webhook_events'::regclass), 'RLS activée');
select ok(has_column_privilege('authenticated', 'public.webhook_events', 'status', 'select'), 'authenticated lit le statut');
select ok(not has_column_privilege('authenticated', 'public.webhook_events', 'payload', 'select'), 'authenticated ne lit PAS le payload');
select ok(not has_table_privilege('authenticated', 'public.webhook_events', 'insert') and not has_table_privilege('service_role', 'public.webhook_events', 'insert'), 'aucune insertion directe');
select ok(not has_table_privilege('service_role', 'public.webhook_events', 'update') and not has_table_privilege('service_role', 'public.webhook_events', 'delete'), 'aucune modification directe, même service_role');
select ok(not has_table_privilege('anon', 'public.webhook_events', 'select'), 'anon ne lit rien');
select ok((select bool_and(has_function_privilege('service_role', s, 'execute')) from unnest(array[
  'public.webhook_resolve_integration(text,text)', 'public.webhook_record(uuid,uuid,text,text,jsonb)', 'public.webhook_record_rejection(uuid,uuid,text)',
  'public.webhook_start(uuid,uuid)', 'public.webhook_finish(uuid,uuid,text,text)']) s), 'service_role exécute les 5 fonctions');
select ok((select bool_and(not has_function_privilege('authenticated', s, 'execute') and not has_function_privilege('anon', s, 'execute')) from unnest(array[
  'public.webhook_resolve_integration(text,text)', 'public.webhook_record(uuid,uuid,text,text,jsonb)', 'public.webhook_record_rejection(uuid,uuid,text)',
  'public.webhook_start(uuid,uuid)', 'public.webhook_finish(uuid,uuid,text,text)']) s), 'ni authenticated ni anon n''exécutent aucune des 5');

-- ---------------------------------------------------------------------------
-- Résolution du tenant par le compte fournisseur
-- ---------------------------------------------------------------------------
select is((select private.webhook_resolve_integration('whatsapp', 'wh-wa-a') ->> 'organization_id'), 'db000000-0000-4000-8000-00000000000a', 'compte whatsapp d''Alpha : entreprise Alpha (intégration pending)');
select is((select private.webhook_resolve_integration('whatsapp', 'wh-wa-b') ->> 'organization_id'), 'db000000-0000-4000-8000-00000000000b', 'compte whatsapp de Beta : entreprise Beta');
select is((select private.webhook_resolve_integration('whatsapp', 'inconnu')), null, 'compte inconnu : null');
select is((select private.webhook_resolve_integration('email', 'wh-wa-a')), null, 'mauvais fournisseur pour ce compte : null');
select is((select private.webhook_resolve_integration('csv', 'wh-csv')), null, 'une intégration csv n''est jamais résolue');
update public.integrations set status = 'error' where external_account_id = 'wh-wa-a';
select isnt((select private.webhook_resolve_integration('whatsapp', 'wh-wa-a')), null, 'statut error : encore résolue (pour retenter)');
update public.integrations set status = 'disabled' where external_account_id = 'wh-wa-a';
select is((select private.webhook_resolve_integration('whatsapp', 'wh-wa-a')), null, 'désactivée : comme un compte inconnu');
update public.integrations set status = 'disconnected', secret_ref = null where external_account_id = 'wh-wa-a';
select is((select private.webhook_resolve_integration('whatsapp', 'wh-wa-a')), null, 'déconnectée : comme un compte inconnu');
update public.integrations set status = 'active' where external_account_id = 'wh-wa-a';
select is((select private.webhook_resolve_integration('whatsapp', 'wh-wa-a') ->> 'integration_id'), (select id::text from public.integrations where external_account_id = 'wh-wa-a'), 'active : résolue avec son identifiant d''intégration');

-- ---------------------------------------------------------------------------
-- Enregistrement idempotent + job
-- ---------------------------------------------------------------------------
select is((select (private.webhook_record('db000000-0000-4000-8000-00000000000a', i.id, 'whatsapp', 'wamid.E1', '{"k":"v","nom":"Nadia"}'::jsonb)) ->> 'duplicate' from public.integrations i where i.external_account_id = 'wh-wa-a'), 'false', 'premier enregistrement : nouveau');
select is((select count(*)::int from public.webhook_events where external_event_id = 'wamid.E1'), 1, 'une ligne');
select is((select status || ':' || signature_valid::text || ':' || (payload ->> 'k') from public.webhook_events where external_event_id = 'wamid.E1'), 'received:true:v', 'statut received, signature valide, payload conservé');
select is((select count(*)::int from public.jobs where kind = 'process_webhook' and organization_id = 'db000000-0000-4000-8000-00000000000a'), 1, 'un job process_webhook en file');
select is((select payload ->> 'event_id' from public.jobs where kind = 'process_webhook' and organization_id = 'db000000-0000-4000-8000-00000000000a'), (select id::text from public.webhook_events where external_event_id = 'wamid.E1'), 'le job porte l''identifiant de l''événement seulement');
select is((select (private.webhook_record('db000000-0000-4000-8000-00000000000a', i.id, 'whatsapp', 'wamid.E1', '{"k":"autre"}'::jsonb)) ->> 'duplicate' from public.integrations i where i.external_account_id = 'wh-wa-a'), 'true', 'rejeu : duplicate');
select is((select count(*)::int from public.webhook_events where external_event_id = 'wamid.E1'), 1, 'rejeu : toujours une seule ligne');
select is((select payload ->> 'k' from public.webhook_events where external_event_id = 'wamid.E1'), 'v', 'rejeu : le premier payload est conservé');
select is((select count(*)::int from public.jobs where kind = 'process_webhook' and organization_id = 'db000000-0000-4000-8000-00000000000a'), 1, 'rejeu : aucun second job');
select is((select (private.webhook_record('db000000-0000-4000-8000-00000000000b', i.id, 'whatsapp', 'wamid.E1', '{"k":"beta"}'::jsonb)) ->> 'duplicate' from public.integrations i where i.external_account_id = 'wh-wa-b'), 'false', 'même identifiant d''événement chez Beta : événement distinct (unicité par entreprise)');
select is((select count(*)::int from public.webhook_events where external_event_id = 'wamid.E1'), 2, 'une ligne par entreprise');
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000b', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.X', '{}')$$, 'PT404', null, 'entreprise B avec l''intégration d''Alpha : introuvable (aucun mélange de tenants)');
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'email', 'wamid.X', '{}')$$, 'PT404', null, 'fournisseur différent de celui de l''intégration : introuvable');
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'avec espace', '{}')$$, '23514', null, 'identifiant d''événement mal formé : refusé');
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.NUL', null)$$, '22023', null, 'payload absent : refusé');
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.GROS', jsonb_build_object('x', repeat('a', 4300000)))$$, '23514', null, 'payload de plus de 4 Mo de jsonb : refusé');
select lives_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.TAILLE', jsonb_build_object('x', repeat('a', 3300000)))$$, 'un corps de 3,3 Mo (marge de mise en forme du jsonb) passe');
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.NULCAR', '{"a": "\u0000"}'::jsonb)$$, '22P05', null, 'caractère \u0000 : refusé par jsonb (la route répond 400, pas 503)');
delete from public.webhook_events where external_event_id = 'wamid.TAILLE';
select is((select count(*)::int from public.webhook_events where external_event_id in ('wamid.NUL', 'wamid.GROS', 'wamid.X', 'wamid.NULCAR')), 0, 'aucun événement partiel après les refus');

-- file saturée : 10 000 événements en attente chez Alpha
insert into public.webhook_events (organization_id, integration_id, provider, external_event_id, payload, signature_valid)
  select 'db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'bulk-' || n, '{}', true from generate_series(1, 10000) n;
select throws_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.APRES', '{}')$$, 'P0001', 'too_many_webhooks', 'file saturée : too_many_webhooks (le fournisseur réessaiera)');
update public.webhook_events set received_at = now() - interval '8 days' where external_event_id like 'bulk-%';
select lives_ok($$select private.webhook_record('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'wamid.FENETRE', '{}')$$, 'seuls les événements des 7 derniers jours comptent : des jobs morts n''obstruent pas la file indéfiniment');
delete from public.webhook_events where external_event_id = 'wamid.FENETRE';
delete from public.webhook_events where external_event_id like 'bulk-%';

-- ---------------------------------------------------------------------------
-- Trace d'un rejet : sans payload ni identifiant, plafonnée
-- ---------------------------------------------------------------------------
select is((select private.webhook_record_rejection('db000000-0000-4000-8000-00000000000a', i.id, 'whatsapp') from public.integrations i where i.external_account_id = 'wh-wa-a'), true, 'un rejet est enregistré');
select is((select status || ':' || signature_valid::text || ':' || coalesce(payload::text, 'null') || ':' || coalesce(external_event_id, 'null') || ':' || failure_code from public.webhook_events where status = 'rejected' limit 1),
  'rejected:false:null:null:signature_invalid', 'rejet : sans payload ni identifiant d''événement, code signature_invalid');
select is((select private.webhook_record_rejection('db000000-0000-4000-8000-00000000000b', i.id, 'whatsapp') from public.integrations i where i.external_account_id = 'wh-wa-a'), false, 'rejet avec une entreprise qui n''est pas celle de l''intégration : rien d''écrit');
insert into public.webhook_events (organization_id, integration_id, provider, status, signature_valid, failure_code, received_at)
  select 'db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'rejected', false, 'signature_invalid', now() from generate_series(1, 199) n;
select is((select private.webhook_record_rejection('db000000-0000-4000-8000-00000000000a', i.id, 'whatsapp') from public.integrations i where i.external_account_id = 'wh-wa-a'), false, 'plafond de 200 rejets par heure et par intégration atteint : plus de ligne');
select is((select count(*)::int from public.webhook_events where status = 'rejected'), 200, 'exactement 200 lignes de rejet');
select is((select (private.webhook_record('db000000-0000-4000-8000-00000000000a', i.id, 'whatsapp', 'wamid.APRES-REJETS', '{}'::jsonb)) ->> 'duplicate' from public.integrations i where i.external_account_id = 'wh-wa-a'), 'false', 'les rejets n''empêchent pas un événement authentique (aucun identifiant réservé)');
select throws_ok($$insert into public.webhook_events (organization_id, integration_id, provider, status, signature_valid, payload) values ('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'rejected', false, '{}')$$, '23514', null, 'garde-fou : un rejet ne peut pas porter de payload');
select throws_ok($$insert into public.webhook_events (organization_id, integration_id, provider, external_event_id, status, signature_valid) values ('db000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'wh-wa-a'), 'whatsapp', 'sans-payload', 'received', true)$$, '23514', null, 'garde-fou : un événement valide doit porter son payload');

-- ---------------------------------------------------------------------------
-- Lecture par l'API : métadonnées seulement
-- ---------------------------------------------------------------------------
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.webhook_events where status = 'received'), 2, 'owner A lit les métadonnées de ses 2 événements reçus');
select is((select count(*)::int from public.webhook_events where external_event_id = 'wamid.E1'), 1, 'owner A ne voit que le sien parmi les deux événements de même identifiant');
select throws_ok($$select payload from public.webhook_events$$, '42501', null, 'owner : lire le payload est interdit');
select throws_ok($$select * from public.webhook_events$$, '42501', null, 'owner : select * est interdit (il inclurait le payload)');
select throws_ok($$insert into public.webhook_events (organization_id, integration_id, provider, external_event_id, payload, signature_valid) values ('db000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'whatsapp', 'direct', '{}', true)$$, '42501', null, 'owner : INSERT direct refusé');
select throws_ok($$update public.webhook_events set status = 'processed'$$, '42501', null, 'owner : UPDATE direct refusé');
select throws_ok($$delete from public.webhook_events$$, '42501', null, 'owner : DELETE direct refusé');
select throws_ok($$select public.webhook_record('db000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'whatsapp', 'x', '{}')$$, '42501', null, 'owner : webhook_record refusé');
reset role;
select pg_temp.as_user('da000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.webhook_events where status = 'received'), 2, 'admin A lit les métadonnées');
reset role;
select pg_temp.as_user('da000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.webhook_events), 0, 'marketing ne voit aucun événement');
reset role;
select pg_temp.as_user('da000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.webhook_events), 0, 'commercial ne voit aucun événement');
reset role;
select pg_temp.as_user('da000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.webhook_events), 0, 'analyste ne voit aucun événement');
reset role;
select pg_temp.as_user('da000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.webhook_events where external_event_id is not null), 1, 'owner B ne voit que son événement');
select is((select count(*)::int from public.webhook_events where organization_id = 'db000000-0000-4000-8000-00000000000a'), 0, 'owner B ne voit rien d''Alpha');
reset role;
select pg_temp.as_anon();
select throws_ok($$select id from public.webhook_events$$, '42501', null, 'anonyme : refusé');
reset role;
select pg_temp.as_service();
select throws_ok($$update public.webhook_events set status = 'processed'$$, '42501', null, 'service_role : UPDATE direct refusé');
select throws_ok($$insert into public.webhook_events (organization_id, integration_id, provider, external_event_id, payload, signature_valid) values ('db000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'whatsapp', 'direct', '{}', true)$$, '42501', null, 'service_role : INSERT direct refusé');
reset role;

-- ---------------------------------------------------------------------------
-- Worker : démarrer et terminer
-- ---------------------------------------------------------------------------
select is((select private.webhook_start('db000000-0000-4000-8000-00000000000a', e.id) ->> 'status' from public.webhook_events e where e.external_event_id = 'wamid.E1' and e.organization_id = 'db000000-0000-4000-8000-00000000000a'), 'running', 'start : en cours');
select is((select private.webhook_start('db000000-0000-4000-8000-00000000000a', e.id) -> 'payload' ->> 'nom' from public.webhook_events e where e.external_event_id = 'wamid.E1' and e.organization_id = 'db000000-0000-4000-8000-00000000000a'), 'Nadia', 'start : le payload est rendu au worker');
select is((select private.webhook_start('db000000-0000-4000-8000-00000000000b', e.id) ->> 'status' from public.webhook_events e where e.external_event_id = 'wamid.E1' and e.organization_id = 'db000000-0000-4000-8000-00000000000a'), 'missing', 'start avec l''entreprise d''un autre job : introuvable (jamais le payload d''Alpha pour Beta)');
select is((select private.webhook_start('db000000-0000-4000-8000-00000000000a', gen_random_uuid()) ->> 'status'), 'missing', 'start : événement inconnu');
select throws_ok($$select private.webhook_finish('db000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'received', null)$$, '22023', null, 'finish : statut invalide refusé');
select throws_ok($$select private.webhook_finish('db000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'failed', 'Code Invalide')$$, '22023', null, 'finish : code d''échec mal formé refusé');
select lives_ok($$select private.webhook_finish('db000000-0000-4000-8000-00000000000a', (select id from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000a'), 'processed', null)$$, 'finish : processed');
select is((select status || ':' || (processed_at is not null)::text from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000a'), 'processed:true', 'statut processed et date de traitement');
select is((select private.webhook_start('db000000-0000-4000-8000-00000000000a', e.id) ->> 'status' from public.webhook_events e where e.external_event_id = 'wamid.E1' and e.organization_id = 'db000000-0000-4000-8000-00000000000a'), 'done', 'start d''un événement terminé : done (rejeu sans effet)');
select lives_ok($$select private.webhook_finish('db000000-0000-4000-8000-00000000000a', (select id from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000a'), 'failed', 'x')$$, 'finish sur un événement déjà terminé : sans effet');
select is((select status from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000a'), 'processed', 'un événement terminé ne change plus de statut');
select lives_ok($$select private.webhook_finish('db000000-0000-4000-8000-00000000000b', (select id from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000b'), 'failed', 'no_processor')$$, 'finish : failed avec code');
select is((select status || ':' || failure_code from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000b'), 'failed:no_processor', 'failed et son code (chez Beta)');
select is((select count(*)::int from public.webhook_events where external_event_id = 'wamid.E1' and organization_id = 'db000000-0000-4000-8000-00000000000a' and status = 'processed'), 1, 'le traitement chez Beta n''a pas touché l''événement d''Alpha');

select * from finish();
rollback;
