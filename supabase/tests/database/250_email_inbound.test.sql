-- J32 — E-mail entrant et statuts : secret de webhook (second secret par intégration, jamais lisible, supprimé à la déconnexion), statuts du fournisseur
-- (delivered, rebond dur, plainte) appliqués dans l'entreprise ET l'intégration authentifiées, réception d'un e-mail (canal par l'adresse destinataire, contact par
-- l'adresse expéditrice, jamais de contact créé), file des cas ambigus lisible owner et admin. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(114);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea200000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@ei.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('eb200000-0000-4000-8000-00000000000a', 'EI Alpha', 'ei-alpha-test'),
  ('eb200000-0000-4000-8000-00000000000b', 'EI Beta', 'ei-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb200000-0000-4000-8000-00000000000b', 'ea200000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb200000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb200000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('ec200000-0000-4000-8000-0000000000a1', 'eb200000-0000-4000-8000-00000000000a', 'K1', 'k1@ei.test', 'k1@ei.test'),
  ('ec200000-0000-4000-8000-0000000000a2', 'eb200000-0000-4000-8000-00000000000a', 'K2', 'k2@ei.test', 'k2@ei.test'),
  ('ec200000-0000-4000-8000-0000000000a3', 'eb200000-0000-4000-8000-00000000000a', 'K3', 'k3@ei.test', 'k3@ei.test'),
  ('ec200000-0000-4000-8000-0000000000b1', 'eb200000-0000-4000-8000-00000000000b', 'KB', 'kb@ei.test', 'kb@ei.test');
-- intégrations et canaux e-mail actifs (insertion directe : aucun flux n'active encore un canal)
insert into public.integrations (id, organization_id, provider, status, external_account_id) values
  ('ee200000-0000-4000-8000-000000000001', 'eb200000-0000-4000-8000-00000000000a', 'email', 'active', 'ei-mail-a'),
  ('ee200000-0000-4000-8000-000000000002', 'eb200000-0000-4000-8000-00000000000b', 'email', 'active', 'ei-mail-b');
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status) values
  ('ef200000-0000-4000-8000-000000000001', 'eb200000-0000-4000-8000-00000000000a', 'email', 'ee200000-0000-4000-8000-000000000001', 'ventes@ei.test', 'active'),
  ('ef200000-0000-4000-8000-000000000002', 'eb200000-0000-4000-8000-00000000000a', 'email', 'ee200000-0000-4000-8000-000000000001', 'support@ei.test', 'active'),
  ('ef200000-0000-4000-8000-000000000003', 'eb200000-0000-4000-8000-00000000000b', 'email', 'ee200000-0000-4000-8000-000000000002', 'ventes-b@ei.test', 'active');

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

-- messages sortants (via les fonctions du J30) ; m1 accepté (k1), m2 accepté (k2), m3 en cours d'envoi (k3), m4 « résultat inconnu » (k3), m5 jamais envoyé (k3), mb de B
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000a', ('ec200000-0000-4000-8000-0000000000a' || n)::uuid, 'ef200000-0000-4000-8000-000000000001') from generate_series(1, 3) n;
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000b', 'ec200000-0000-4000-8000-0000000000b1', 'ef200000-0000-4000-8000-000000000003');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
insert into fx select 'conv' || right(contact_id::text, 1), id from public.conversations where organization_id = 'eb200000-0000-4000-8000-00000000000a';
insert into fx select 'convb', id from public.conversations where organization_id = 'eb200000-0000-4000-8000-00000000000b';
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M1 bonjour', 'envoi-ei-0001', null);
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv2'), 'outbound', null, 'M2 bonjour', 'envoi-ei-0002', null);
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv3'), 'outbound', null, 'M3 bonjour', 'envoi-ei-0003', null);
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv3'), 'outbound', null, 'M4 bonjour', 'envoi-ei-0004', null);
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv3'), 'outbound', null, 'M5 bonjour', 'envoi-ei-0005', null);
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv3'), 'outbound', null, 'M6 bonjour', 'envoi-ei-0006', null);
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv3'), 'outbound', null, 'M7 bonjour', 'envoi-ei-0007', null);
select private.message_record('eb200000-0000-4000-8000-00000000000b', (select v from fx where k = 'convb'), 'outbound', null, 'MB bonjour', 'envoi-ei-000b', null);
insert into fx select 'm' || right(idempotency_key, 1), id from public.messages where idempotency_key ~ 'envoi-ei-000[1-7b]$';
-- approbations posées directement (l'approbation elle-même est testée dans 240) puis statuts
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@ei.test',
  status = 'accepted', provider_message_id = 'pm-1', send_claimed_at = now(), sent_at = now() where id = (select v from fx where k = 'm1');
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k2@ei.test',
  status = 'accepted', provider_message_id = 'pm-2', send_claimed_at = now(), sent_at = now() where id = (select v from fx where k = 'm2');
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k3@ei.test',
  send_claimed_at = now() where id = (select v from fx where k = 'm3');
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k3@ei.test',
  send_claimed_at = now(), status = 'failed', error_code = 'send_outcome_unknown' where id = (select v from fx where k = 'm4');
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k3@ei.test'
  where id = (select v from fx where k = 'm5');
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k3@ei.test',
  send_claimed_at = now() - interval '10 minutes' where id in (select v from fx where k in ('m6', 'm7'));
update public.messages set approved_by = 'ea200000-0000-4000-8000-000000000006', approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'kb@ei.test',
  status = 'accepted', provider_message_id = 'pm-b', send_claimed_at = now(), sent_at = now() where id = (select v from fx where k = 'mb');

-- ---------------------------------------------------------------------------
-- Structure et droits
-- ---------------------------------------------------------------------------
select has_table('public', 'inbound_unmatched', 'la table inbound_unmatched existe');
select ok((select relrowsecurity from pg_class where oid = 'public.inbound_unmatched'::regclass), 'RLS activée sur inbound_unmatched');
select ok(has_table_privilege('authenticated', 'public.inbound_unmatched', 'select') and not has_table_privilege('authenticated', 'public.inbound_unmatched', 'insert')
  and not has_table_privilege('service_role', 'public.inbound_unmatched', 'insert') and not has_table_privilege('anon', 'public.inbound_unmatched', 'select'), 'inbound_unmatched : lecture seulement, aucune écriture directe');
select has_column('public', 'integrations', 'has_webhook_secret', 'integrations.has_webhook_secret existe');
select ok(not has_column_privilege('authenticated', 'public.integrations', 'webhook_secret_ref', 'select') and has_column_privilege('authenticated', 'public.integrations', 'has_webhook_secret', 'select'),
  'webhook_secret_ref illisible, seul l''indicateur est lisible');
select ok(has_function_privilege('service_role', 'public.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.email_status_apply(uuid, uuid, text, boolean, text, text, timestamptz)', 'execute'), 'email_status_apply : service_role seulement');
select ok(has_function_privilege('service_role', 'public.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.email_inbound_apply(uuid, uuid, text, text[], text, text, text, timestamptz, boolean, boolean)', 'execute'), 'email_inbound_apply : service_role seulement');
select ok(has_function_privilege('service_role', 'public.get_integration_webhook_secret(uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.get_integration_webhook_secret(uuid, uuid)', 'execute'),
  'get_integration_webhook_secret : service_role seulement');
select ok(has_function_privilege('authenticated', 'public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer)', 'execute') and not has_function_privilege('service_role', 'public.set_integration_webhook_secret(uuid, uuid, uuid, text, text, integer)', 'execute'),
  'set_integration_webhook_secret : utilisateurs seulement (owner et admin)');

-- ---------------------------------------------------------------------------
-- Secret de webhook
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000004');
select throws_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'le commercial ne peut pas enregistrer un secret de webhook');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'marketing ne peut pas enregistrer un secret de webhook');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000006');
select throws_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'l''owner d''une autre entreprise ne peut pas');
select throws_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000b', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, 'PT404', null, 'intégration d''une autre entreprise : introuvable');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, '42501', null, 'anonyme : refusé');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', null, 'QUJDREVGR0hJSktM', 1)$$, '22023', null, 'chiffré absent : refusé');
select lives_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, 'l''owner enregistre le secret de webhook');
select is((select has_webhook_secret from public.integrations where id = 'ee200000-0000-4000-8000-000000000001'), true, 'has_webhook_secret = true (seul indicateur lisible)');
select throws_ok($$select webhook_secret_ref from public.integrations$$, '42501', null, 'webhook_secret_ref n''est lisible par personne via l''API');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000002');
select lives_ok($$select public.set_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'ed200000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1)$$, 'l''admin remplace le secret (rotation)');
reset role;
select is((select count(*)::int from private.secrets where organization_id = 'eb200000-0000-4000-8000-00000000000a' and purpose = 'integration_webhook'), 1, 'rotation : l''ancien secret est supprimé, un seul reste');
select throws_ok($$update public.integrations set secret_ref = webhook_secret_ref where id = 'ee200000-0000-4000-8000-000000000001'$$, '23514', null, 'le secret de webhook est distinct du jeton d''envoi (contrainte)');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb200000-0000-4000-8000-00000000000a' and action = 'integration.webhook_secret_set')
  and exists (select 1 from public.audit_logs where organization_id = 'eb200000-0000-4000-8000-00000000000a' and action = 'integration.webhook_secret_rotated'), 'audit : secret posé puis remplacé');
select is((select count(*)::int from public.audit_logs a where a.action like 'integration.webhook_secret%' and to_jsonb(a)::text ~* '(QUJDREVG|ed200000)'), 0, 'aucun chiffré ni identifiant de secret dans l''audit');

select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select throws_ok($$select public.get_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001')$$, '42501', null, 'un utilisateur ne lit pas le secret de webhook, même owner');
reset role;
select pg_temp.as_service();
select ok((private.get_integration_webhook_secret('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001') ->> 'ciphertext') is not null, 'le service lit le chiffré (jamais le clair)');
select is(private.get_integration_webhook_secret('eb200000-0000-4000-8000-00000000000b', 'ee200000-0000-4000-8000-000000000001'), null::jsonb, 'autre entreprise : rien');
select is(private.get_integration_webhook_secret('eb200000-0000-4000-8000-00000000000b', 'ee200000-0000-4000-8000-000000000002'), null::jsonb, 'intégration sans secret de webhook : rien');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select lives_ok($$select public.disconnect_integration('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001')$$, 'déconnexion de l''intégration');
reset role;
select is((select count(*)::int from private.secrets where organization_id = 'eb200000-0000-4000-8000-00000000000a' and purpose = 'integration_webhook'), 0, 'la déconnexion supprime AUSSI le secret de webhook');
select is((select has_webhook_secret from public.integrations where id = 'ee200000-0000-4000-8000-000000000001'), false, 'has_webhook_secret = false après déconnexion');
update public.integrations set status = 'active' where id = 'ee200000-0000-4000-8000-000000000001';
update public.channels set status = 'active', send_paused = false where integration_id = 'ee200000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Statuts du fournisseur
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select throws_ok($$select public.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-1', null, null)$$, '42501', null, 'un utilisateur ne peut pas appliquer un statut');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-1', null, null)$$, '42501', null, 'anonyme : refusé');
reset role;
select pg_temp.as_service();
select throws_ok($$select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'opened', false, 'pm-1', null, null)$$, '22023', null, 'événement inconnu : refusé');
select throws_ok($$select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, null, null, null)$$, '22023', null, 'ni identifiant du fournisseur ni référence : refusé');
select throws_ok($$select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-1', 'pas-un-uuid', null)$$, '22023', null, 'référence mal formée : refusée');
select throws_ok($$select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000002', 'delivered', false, 'pm-1', null, null)$$, 'PT404', null, 'intégration d''une AUTRE entreprise : introuvable');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000b', 'ee200000-0000-4000-8000-000000000002', 'delivered', false, 'pm-1', null, null) ->> 'reason', 'message_not_found', 'le message d''A est introuvable depuis l''entreprise B (aucune fuite)');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-inconnu', null, null) ->> 'reason', 'message_not_found', 'identifiant du fournisseur inconnu : ignoré');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-x', (select v::text from fx where k = 'mb'), null) ->> 'reason', 'message_not_found', 'référence vers un message d''une AUTRE entreprise : introuvable');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-autre', (select v::text from fx where k = 'm1'), null) ->> 'reason', 'message_mismatch', 'référence et identifiant du fournisseur qui se contredisent : ignoré');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-1', null, null) ->> 'outcome', 'applied', 'delivered appliqué (par l''identifiant du fournisseur)');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-1', null, null) ->> 'reason', 'already_applied', 'delivered rejoué : sans effet');
reset role;
select is((select status from public.messages where id = (select v from fx where k = 'm1')), 'delivered', 'm1 est « delivered » (événement du fournisseur)');

select pg_temp.as_service();
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'bounced', false, 'pm-2', null, null) ->> 'reason', 'soft_bounce', 'rebond doux : ignoré');
reset role;
select is((select count(*)::int from public.suppressions where organization_id = 'eb200000-0000-4000-8000-00000000000a'), 0, 'rebond doux : aucune suppression');
select pg_temp.as_service();
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'bounced', true, null, (select v::text from fx where k = 'm2'), null) ->> 'outcome', 'applied', 'rebond dur appliqué (message retrouvé par la référence de NOTRE message)');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'bounced', true, 'pm-2', null, null) ->> 'reason', 'already_applied', 'rebond dur rejoué : sans second effet');
reset role;
select is((select status from public.messages where id = (select v from fx where k = 'm2')), 'bounced', 'm2 est « bounced »');
select is((select reason || ':' || value_normalized from public.suppressions where organization_id = 'eb200000-0000-4000-8000-00000000000a'), 'bounce:k2@ei.test', 'rebond dur : l''adresse où le message est parti est supprimée (bounce)');
select is((select do_not_contact from public.contacts where id = 'ec200000-0000-4000-8000-0000000000a2'), false, 'rebond dur : do_not_contact N''EST PAS modifié (adresse invalide ≠ refus)');

select pg_temp.as_service();
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'complaint', false, 'pm-1', null, null) ->> 'outcome', 'applied', 'plainte appliquée');
reset role;
select is((select reason from public.suppressions where value_normalized = 'k1@ei.test' and organization_id = 'eb200000-0000-4000-8000-00000000000a'), 'complaint', 'plainte : adresse supprimée (complaint)');
select is((select do_not_contact from public.contacts where id = 'ec200000-0000-4000-8000-0000000000a1'), true, 'plainte : do_not_contact = true');
select is((select status from public.messages where id = (select v from fx where k = 'm1')), 'delivered', 'plainte : le statut du message ne change pas');
select pg_temp.as_service();
select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'complaint', false, 'pm-2', null, null);
reset role;
select is((select reason from public.suppressions where value_normalized = 'k2@ei.test' and organization_id = 'eb200000-0000-4000-8000-00000000000a'), 'complaint', 'plainte après rebond : la raison passe à complaint (plus forte)');
select is((select do_not_contact from public.contacts where id = 'ec200000-0000-4000-8000-0000000000a2'), true, 'plainte après rebond : do_not_contact = true');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb200000-0000-4000-8000-00000000000a' and action = 'contact.do_not_contact_changed'), 'audit : do_not_contact modifié par la plainte');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb200000-0000-4000-8000-00000000000a' and action in ('message.delivered', 'message.bounced', 'message.complaint', 'suppression.added')), 'audit : événements de statut tracés');
select is((select count(*)::int from public.audit_logs a where a.organization_id = 'eb200000-0000-4000-8000-00000000000a' and a.action in ('message.delivered', 'message.bounced', 'message.complaint', 'suppression.added', 'message.reconciled')
  and to_jsonb(a)::text ~* '(k1@ei|k2@ei|k3@ei|pm-1|pm-2)'), 0, 'aucune adresse ni identifiant du fournisseur dans l''audit');

-- une plainte ne remplace qu'un « bounce » : la provenance d'un « manual » ou d'un « unsubscribe » est conservée
insert into public.suppressions (organization_id, channel, value_normalized, reason) values ('eb200000-0000-4000-8000-00000000000a', 'email', 'k3@ei.test', 'manual');
select pg_temp.as_service();
select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'complaint', false, 'pm-7', (select v::text from fx where k = 'm7'), null);
reset role;
select is((select reason from public.suppressions where value_normalized = 'k3@ei.test' and organization_id = 'eb200000-0000-4000-8000-00000000000a'), 'manual', 'plainte sur une suppression « manual » : la provenance est conservée');
delete from public.suppressions where value_normalized = 'k3@ei.test' and organization_id = 'eb200000-0000-4000-8000-00000000000a';
update public.contacts set do_not_contact = false where id = 'ec200000-0000-4000-8000-0000000000a3';

-- envoi encore en cours (tentative posée, acceptation pas encore enregistrée) : rejoué plus tard ; jamais envoyé : ignoré
select pg_temp.as_service();
select throws_ok($$select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-3', (select v::text from fx where k = 'm3'), null)$$, 'P0001', 'retry_later', 'envoi en cours : retry_later (le job est rejoué)');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, null, (select v::text from fx where k = 'm5'), null) ->> 'reason', 'not_sent', 'message jamais envoyé : ignoré');
-- tentative posée il y a plus de 5 minutes (worker mort avant l'enregistrement) : l'événement du fournisseur la réconcilie ; sans identifiant du fournisseur : on rejoue
select throws_ok($$select private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, null, (select v::text from fx where k = 'm6'), null)$$, 'P0001', 'retry_later', 'réclamation ancienne mais sans identifiant du fournisseur : retry_later');
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-6', (select v::text from fx where k = 'm6'), null) ->> 'outcome', 'applied', 'réclamation de plus de 5 minutes confirmée par le fournisseur : réconciliée puis livrée');
-- envoi déclaré « résultat inconnu » : le fournisseur confirme, le message est réconcilié puis livré
select is(private.email_status_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'delivered', false, 'pm-4', (select v::text from fx where k = 'm4'), null) ->> 'outcome', 'applied', 'résultat inconnu : réconcilié par la référence puis livré');
reset role;
select is((select status || ':' || provider_message_id || ':' || coalesce(error_code, 'null') from public.messages where id = (select v from fx where k = 'm4')), 'delivered:pm-4:null', 'm4 : identifiant du fournisseur retrouvé, code d''échec effacé');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb200000-0000-4000-8000-00000000000a' and action = 'message.reconciled'), 'audit : message.reconciled');
select is((select status || ':' || provider_message_id from public.messages where id = (select v from fx where k = 'm6')), 'delivered:pm-6', 'm6 : réconciliée, identifiant du fournisseur stocké');

-- ---------------------------------------------------------------------------
-- E-mail entrant
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select throws_ok($$select public.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-0', array['ventes@ei.test'], 'k1@ei.test', 'Re', 'Bonjour', null, true, false)$$, '42501', null, 'un utilisateur ne peut pas enregistrer un entrant');
reset role;
select pg_temp.as_service();
select throws_ok($$select private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-0', array['ventes@ei.test'], 'k1@ei.test', 'Re', '', null, true, false)$$, '22023', null, 'corps vide : refusé');
select throws_ok($$select private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-0', array['ventes@ei.test'], 'k1 @ei.test', 'Re', 'x', null, true, false)$$, '22023', null, 'expéditeur avec espace : refusé');
select throws_ok($$select private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-0', array[]::text[], 'k1@ei.test', 'Re', 'x', null, true, false)$$, '22023', null, 'sans destinataire : refusé');
select throws_ok($$select private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'identifiant invalide', array['ventes@ei.test'], 'k1@ei.test', 'Re', 'x', null, true, false)$$, '22023', null, 'identifiant du fournisseur mal formé : refusé');
select throws_ok($$select private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000002', 'in-0', array['ventes@ei.test'], 'k1@ei.test', 'Re', 'x', null, true, false)$$, 'PT404', null, 'intégration d''une autre entreprise : introuvable');

select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-1', array['ventes@ei.test'], 'k3@ei.test', 'Re: devis', 'SECRET-ENTRANT bonjour', null, true, false) ->> 'outcome', 'recorded', 'réponse d''un contact connu : rattachée');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-1', array['ventes@ei.test'], 'k3@ei.test', 'Re: devis', 'SECRET-ENTRANT bonjour', null, true, false) ->> 'outcome', 'duplicate', 'même e-mail rejoué : duplicate');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-1', array['ventes@ei.test'], 'k3@ei.test', 'Re: devis', 'Un AUTRE corps', null, true, false) ->> 'reason', 'id_conflict', 'même identifiant du fournisseur avec un autre corps : jamais un second message, tracé dans la file (id_conflict)');
reset role;
select is((select count(*)::int from public.messages where provider_message_id = 'in-1' and direction = 'inbound' and conversation_id = (select v from fx where k = 'conv3')), 1, 'un seul message entrant, dans le fil du contact et du canal');
select is((select status from public.messages where provider_message_id = 'in-1'), 'received', 'statut « received »');
select is((select count(*)::int from public.contacts where organization_id = 'eb200000-0000-4000-8000-00000000000a'), 3, 'aucun contact créé');

-- un fil fermé se rouvre ; un contact « ne plus contacter » ou supprimé peut quand même répondre
update public.conversations set state = 'closed', assignee_id = null where id = (select v from fx where k = 'conv1');
select pg_temp.as_service();
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-2', array['ventes@ei.test'], 'k1@ei.test', 'STOP', 'Arrêtez', null, true, false) ->> 'outcome', 'recorded', 'k1 (do_not_contact + suppression) peut répondre : le message est enregistré');
reset role;
select is((select state from public.conversations where id = (select v from fx where k = 'conv1')), 'to_triage', 'le fil fermé se rouvre (file de tri)');

-- cas ambigus : file inbound_unmatched
select pg_temp.as_service();
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u1', array['ventes@ei.test'], 'inconnu@ei.test', 'Bonjour', 'Je suis nouveau', null, true, false) ->> 'reason', 'unknown_sender', 'expéditeur inconnu : file des cas ambigus');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u1', array['ventes@ei.test'], 'inconnu@ei.test', 'Bonjour', 'Je suis nouveau', null, true, false) ->> 'outcome', 'duplicate', 'cas ambigu rejoué : un seul enregistrement');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u2', array['ventes@ei.test'], 'k2@ei.test', 'Re', 'Usurpation', null, false, false) ->> 'reason', 'sender_unverified', 'expéditeur NON authentifié (SPF) : jamais rattaché au contact');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u3', array['ventes@ei.test'], 'k2@ei.test', 'Promo', 'Achetez', null, true, true) ->> 'reason', 'spam', 'spam : file des cas ambigus');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u4', array['autre@ei.test'], 'k2@ei.test', 'Re', 'Mauvaise adresse', null, true, false) ->> 'reason', 'no_channel', 'adresse destinataire qui n''est celle d''aucun canal : file des cas ambigus');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u5', array['ventes-b@ei.test'], 'k2@ei.test', 'Re', 'Canal de B', null, true, false) ->> 'reason', 'no_channel', 'le canal d''une AUTRE entreprise n''est pas atteignable');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-u6', array['ventes@ei.test', 'support@ei.test'], 'k2@ei.test', 'Re', 'Deux canaux', null, true, false) ->> 'reason', 'ambiguous_channel', 'deux canaux visés : cas ambigu');
reset role;
select is((select count(*)::int from public.inbound_unmatched where organization_id = 'eb200000-0000-4000-8000-00000000000a'), 7, 'sept cas ambigus en file (dont le conflit d''identifiant)');
select is((select channel_id from public.inbound_unmatched where provider_message_id = 'in-u1'), 'ef200000-0000-4000-8000-000000000001'::uuid, 'le canal est conservé quand il est certain');
select is((select channel_id from public.inbound_unmatched where provider_message_id = 'in-u4'), null::uuid, 'canal introuvable : aucun canal');
select is((select count(*)::int from public.contacts where organization_id = 'eb200000-0000-4000-8000-00000000000a'), 3, 'toujours aucun contact créé (expéditeur inconnu)');
select is((select count(*)::int from public.messages where provider_message_id in ('in-u2', 'in-u3', 'in-u4')), 0, 'aucun message entrant créé pour ces cas');

-- plafond d'un fil et plafond de la file
insert into public.messages (organization_id, conversation_id, channel_id, direction, provider_message_id, body, status, received_at)
  select c.organization_id, c.id, c.channel_id, 'inbound', 'bulk-' || n, 'x', 'received', now()
    from generate_series(1, 10000) n, public.conversations c where c.id = (select v from fx where k = 'conv2');
select pg_temp.as_service();
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-full', array['ventes@ei.test'], 'k2@ei.test', 'Re', 'Fil plein', null, true, false) ->> 'reason', 'conversation_full', 'fil plein : cas ambigu (conversation_full)');
reset role;
delete from public.messages where provider_message_id like 'bulk-%';
insert into public.inbound_unmatched (organization_id, integration_id, provider_message_id, from_normalized, body, reason)
  select 'eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'cap-' || n, 'x@ei.test', 'x', 'unknown_sender' from generate_series(1, 9993) n;
select pg_temp.as_service();
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-cap', array['ventes@ei.test'], 'nouveau@ei.test', 'Re', 'Trop', null, true, false) ->> 'reason', 'queue_full', 'file pleine (10 000 en attente) : résultat « dropped / queue_full » (le worker échoue visiblement, jamais une exception réessayable)');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-cap', array['ventes@ei.test'], 'nouveau@ei.test', 'Re', 'Trop', null, true, false) ->> 'outcome', 'dropped', 'file pleine : outcome = dropped');
reset role;
delete from public.inbound_unmatched where provider_message_id like 'cap-%';

-- plafond par expéditeur (20 en attente), corps tronqué à 2 000 caractères
select pg_temp.as_service();
select private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'sl-' || n, array['ventes@ei.test'], 'spammeur@ei.test', 'Promo', repeat('x', 50000), null, true, false) from generate_series(1, 20) n;
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'sl-21', array['ventes@ei.test'], 'spammeur@ei.test', 'Promo', 'x', null, true, false) ->> 'reason', 'sender_limit', 'plus de 20 messages en attente du même expéditeur : sender_limit');
reset role;
select is((select max(char_length(body)) from public.inbound_unmatched where from_normalized = 'spammeur@ei.test'), 2000, 'corps d''un cas ambigu tronqué à 2 000 caractères');
delete from public.inbound_unmatched where from_normalized = 'spammeur@ei.test';

-- canal : adresse exacte d'abord, sans l'étiquette +xxx à défaut
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status)
  values ('ef200000-0000-4000-8000-000000000004', 'eb200000-0000-4000-8000-00000000000a', 'email', 'ee200000-0000-4000-8000-000000000001', 'ventes+promo@ei.test', 'active');
select pg_temp.as_service();
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-tag-1', array['ventes+promo@ei.test'], 'k3@ei.test', 'Re', 'Canal à étiquette', null, true, false) ->> 'outcome', 'recorded', 'adresse exacte « ventes+promo@ » : un seul canal, pas d''ambiguïté avec « ventes@ »');
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-tag-2', array['ventes+autre@ei.test'], 'k3@ei.test', 'Re', 'Étiquette inconnue', null, true, false) ->> 'outcome', 'recorded', 'étiquette inconnue : repli sur l''adresse sans étiquette « ventes@ »');
reset role;
select is((select c.channel_id from public.messages m join public.conversations c on c.id = m.conversation_id where m.provider_message_id = 'in-tag-1'), 'ef200000-0000-4000-8000-000000000004'::uuid, 'rattaché au canal à étiquette');
select is((select c.channel_id from public.messages m join public.conversations c on c.id = m.conversation_id where m.provider_message_id = 'in-tag-2'), 'ef200000-0000-4000-8000-000000000001'::uuid, 'rattaché au canal « ventes@ »');

-- même identifiant du fournisseur avec un AUTRE contenu : tracé (id_conflict), jamais un second message ni un abandon silencieux
select pg_temp.as_service();
select is(private.email_inbound_apply('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'in-tag-1', array['ventes+promo@ei.test'], 'k3@ei.test', 'Re', 'Un tout AUTRE corps', null, true, false) ->> 'reason', 'id_conflict', 'même identifiant, autre contenu : file des cas ambigus (id_conflict)');
reset role;
select is((select count(*)::int from public.messages where provider_message_id = 'in-tag-1'), 1, 'toujours un seul message pour cet identifiant');

-- lecture de la file : owner et admin seulement
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.inbound_unmatched), 9, 'owner : lit la file de son entreprise');
select throws_ok($$insert into public.inbound_unmatched (organization_id, integration_id, provider_message_id, from_normalized, body, reason) values ('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'x', 'a@b.test', 'x', 'spam')$$, '42501', null, 'aucune écriture directe, même owner');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.inbound_unmatched), 9, 'admin : lit la file');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.inbound_unmatched), 0, 'marketing : ne lit pas la file (données personnelles)');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.inbound_unmatched), 0, 'le commercial ne lit pas la file');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.inbound_unmatched), 0, 'une autre entreprise ne lit rien');
reset role;
select pg_temp.as_service();
select throws_ok($$insert into public.inbound_unmatched (organization_id, integration_id, provider_message_id, from_normalized, body, reason) values ('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'y', 'a@b.test', 'x', 'spam')$$, '42501', null, 'aucune écriture directe pour service_role');
reset role;
select throws_ok($$insert into public.inbound_unmatched (organization_id, integration_id, provider_message_id, from_normalized, body, reason) values ('eb200000-0000-4000-8000-00000000000a', 'ee200000-0000-4000-8000-000000000001', 'z', 'a@b.test', 'x', 'inconnue')$$, '23514', null, 'raison hors liste refusée par la contrainte');

-- aucun corps de message ni adresse dans l'audit des entrants
select is((select count(*)::int from public.audit_logs a where a.organization_id = 'eb200000-0000-4000-8000-00000000000a' and to_jsonb(a)::text ~* '(SECRET-ENTRANT|Je suis nouveau|Usurpation|inconnu@ei)'), 0, 'aucun corps ni adresse d''entrant dans l''audit');

select * from finish();
rollback;
