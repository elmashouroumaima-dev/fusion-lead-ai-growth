-- J31 — Envoi d'e-mail derrière la chaîne de contrôles : approbation humaine (owner / admin, une finalité, une fois), garde-fous de base
-- (pas d'envoi accepté sans approbation, statuts qui ne reculent pas), tentative unique par message, fonctions du worker réservées à
-- service_role, table suppressions en lecture seule. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(94);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea100000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@sc.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('eb100000-0000-4000-8000-00000000000a', 'SC Alpha', 'sc-alpha-test'),
  ('eb100000-0000-4000-8000-00000000000b', 'SC Beta', 'sc-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb100000-0000-4000-8000-00000000000a', 'ea100000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb100000-0000-4000-8000-00000000000b', 'ea100000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb100000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb100000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('ec100000-0000-4000-8000-0000000000a1', 'eb100000-0000-4000-8000-00000000000a', 'Contact A1', 'a1@sc.test', 'a1@sc.test'),
  ('ec100000-0000-4000-8000-0000000000a2', 'eb100000-0000-4000-8000-00000000000a', 'Contact A2', 'a2@sc.test', 'a2@sc.test');
insert into public.contacts (id, organization_id, name, phone_e164) values
  ('ec100000-0000-4000-8000-0000000000a3', 'eb100000-0000-4000-8000-00000000000a', 'Contact A3 sans e-mail', '+212600000099');
-- intégration et canal e-mail actifs de A (insertion directe : aucune fonction n'active encore un canal)
insert into public.integrations (id, organization_id, provider, status, external_account_id)
  values ('ee100000-0000-4000-8000-000000000001', 'eb100000-0000-4000-8000-00000000000a', 'email', 'active', 'sc-mail-a');
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status)
  values ('ef100000-0000-4000-8000-000000000001', 'eb100000-0000-4000-8000-00000000000a', 'email', 'ee100000-0000-4000-8000-000000000001', 'ventes@sc.test', 'active');

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

-- conversations et messages (via les fonctions du J30)
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000a', 'ec100000-0000-4000-8000-0000000000a1', 'ef100000-0000-4000-8000-000000000001');
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000a', 'ec100000-0000-4000-8000-0000000000a2', 'ef100000-0000-4000-8000-000000000001');
select private.conversation_get_or_create('eb100000-0000-4000-8000-00000000000a', 'ec100000-0000-4000-8000-0000000000a3', 'ef100000-0000-4000-8000-000000000001');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
insert into fx select 'conv1', id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a1';
insert into fx select 'conv2', id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a2';
insert into fx select 'conv3', id from public.conversations where contact_id = 'ec100000-0000-4000-8000-0000000000a3';
-- m1..m6 sortants (corps « SECRET-CORPS-n »), in1 entrant
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'SECRET-CORPS-1 bonjour', 'envoi-sc-0001', null);
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'SECRET-CORPS-2 bonjour', 'envoi-sc-0002', null);
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'SECRET-CORPS-3 bonjour', 'envoi-sc-0003', null);
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv2'), 'outbound', null, 'SECRET-CORPS-4 bonjour', 'envoi-sc-0004', null);
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv3'), 'outbound', null, 'SECRET-CORPS-5 bonjour', 'envoi-sc-0005', null);
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'inbound', 'wamid.SC1', 'Bonjour entrant', null, null);
select private.message_record('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'SECRET-CORPS-R' || n || ' bonjour', 'envoi-sc-001' || n, null) from generate_series(1, 5) n;
insert into fx select 'r' || right(idempotency_key, 1), id from public.messages where idempotency_key like 'envoi-sc-001_';
insert into fx select 'm' || right(idempotency_key, 1), id from public.messages where idempotency_key like 'envoi-sc-000_';
insert into fx select 'in1', id from public.messages where provider_message_id = 'wamid.SC1';

-- ---------------------------------------------------------------------------
-- Structure et droits
-- ---------------------------------------------------------------------------
select has_table('public', 'suppressions', 'la table suppressions existe');
select ok((select relrowsecurity from pg_class where oid = 'public.suppressions'::regclass), 'RLS activée sur suppressions');
select ok(has_table_privilege('authenticated', 'public.suppressions', 'select') and not has_table_privilege('authenticated', 'public.suppressions', 'insert')
  and not has_table_privilege('service_role', 'public.suppressions', 'insert') and not has_table_privilege('anon', 'public.suppressions', 'select'), 'suppressions : lecture seulement, aucune écriture directe');
select has_column('public', 'messages', 'approved_by', 'messages.approved_by existe');
select has_column('public', 'messages', 'send_claimed_at', 'messages.send_claimed_at existe');
select ok(has_function_privilege('service_role', 'public.message_send_claim(uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.message_send_claim(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.message_send_claim(uuid, uuid)', 'execute'), 'message_send_claim : service_role seulement');
select ok(has_function_privilege('authenticated', 'public.message_approve(uuid, uuid, text)', 'execute') and not has_function_privilege('service_role', 'public.message_approve(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.message_approve(uuid, uuid, text)', 'execute'), 'message_approve : utilisateurs authentifiés seulement (jamais le worker)');

-- ---------------------------------------------------------------------------
-- Approbation humaine
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea100000-0000-4000-8000-000000000004');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, '42501', null, 'le commercial ne peut pas approuver');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000003');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, '42501', null, 'marketing ne peut pas approuver');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000006');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, '42501', null, 'l''owner d''une AUTRE entreprise ne peut pas approuver');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, '42501', null, 'anonyme : refusé');
reset role;
select pg_temp.as_service();
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, '42501', null, 'service_role ne peut pas approuver (l''approbation est humaine)');
reset role;

select pg_temp.as_user('ea100000-0000-4000-8000-000000000001');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'Pas valide')$$, '22023', null, 'finalité mal formée : refusée');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), null)$$, '22023', null, 'finalité absente : refusée');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', gen_random_uuid(), 'marketing')$$, 'PT404', null, 'message inconnu : introuvable');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'in1'), 'marketing')$$, 'P0001', 'message_not_approvable', 'un message entrant ne s''approuve pas');
select lives_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, 'owner approuve m1');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'service')$$, 'P0001', 'message_not_approvable', 'une seconde approbation (autre finalité) est refusée');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000002');
select lives_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm2'), 'marketing')$$, 'admin approuve m2');
select lives_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm4'), 'marketing')$$, 'admin approuve m4');
reset role;
select is((select approved_by from public.messages where id = (select v from fx where k = 'm1')), 'ea100000-0000-4000-8000-000000000001'::uuid, 'approved_by = celui qui a approuvé (auth.uid())');
select is((select approved_purpose from public.messages where id = (select v from fx where k = 'm1')), 'marketing', 'finalité enregistrée');
select ok((select approved_at is not null from public.messages where id = (select v from fx where k = 'm1')), 'approved_at posé');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb100000-0000-4000-8000-00000000000a' and action = 'message.approved'), 'audit : message.approved');
select is((select count(*)::int from public.jobs where kind = 'send_message' and organization_id = 'eb100000-0000-4000-8000-00000000000a'), 3, 'chaque approbation met UN job send_message en file (m1, m2, m4)');
select is((select payload from public.jobs where kind = 'send_message' and idempotency_key = 'send-message:' || (select v from fx where k = 'm1')::text), jsonb_build_object('message_id', (select v from fx where k = 'm1')), 'la charge utile du job ne porte que l''identifiant du message (ni corps ni adresse)');
select is((select count(*)::int from public.jobs where kind = 'send_message' and organization_id = 'eb100000-0000-4000-8000-00000000000b'), 0, 'aucun job dans une autre entreprise');

-- ---------------------------------------------------------------------------
-- Garde-fous de base : approbation figée, statuts qui ne reculent pas, pas d'envoi accepté sans approbation
-- ---------------------------------------------------------------------------
select throws_ok($$update public.messages set approved_by = 'ea100000-0000-4000-8000-000000000002' where id = (select v from fx where k = 'm1')$$, '23514', 'message_approval_immutable', 'approved_by ne change plus');
select throws_ok($$update public.messages set approved_purpose = 'service' where id = (select v from fx where k = 'm1')$$, '23514', 'message_approval_immutable', 'la finalité approuvée ne change plus');
select throws_ok($$update public.messages set approved_by = null, approved_at = null, approved_purpose = null where id = (select v from fx where k = 'm1')$$, '23514', 'message_approval_immutable', 'l''approbation ne s''efface pas');
select throws_ok($$update public.messages set status = 'accepted', provider_message_id = 'pm-sans-approbation' where id = (select v from fx where k = 'm3')$$, '23514', 'message_not_approved', 'm3 (non approuvé) ne peut pas passer à accepted, même par une écriture directe');
select throws_ok($$update public.messages set approved_by = 'ea100000-0000-4000-8000-000000000001', approved_at = now() where id = (select v from fx where k = 'm3')$$, '23514', null, 'approbation sans finalité : refusée par le CHECK');
select throws_ok($$update public.messages set approved_by = 'ea100000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing' where id = (select v from fx where k = 'in1')$$, '23514', null, 'un message entrant ne porte pas d''approbation');
select throws_ok($$update public.messages set send_claimed_at = now() where id = (select v from fx where k = 'in1')$$, '23514', null, 'un message entrant ne porte pas de tentative d''envoi');
select throws_ok($$update public.messages set status = 'sent' where id = (select v from fx where k = 'm1')$$, '23514', 'message_status_invalid', 'queued -> sent : refusé (il faut passer par accepted)');
select throws_ok($$update public.messages set status = 'delivered' where id = (select v from fx where k = 'm1')$$, '23514', 'message_status_invalid', 'queued -> delivered : refusé (delivered vient d''un événement du fournisseur)');

-- ---------------------------------------------------------------------------
-- Worker : tentative unique, relecture de l'état
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea100000-0000-4000-8000-000000000001');
select throws_ok($$select public.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'))$$, '42501', null, 'un utilisateur ne peut pas réclamer un envoi');
reset role;
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', gen_random_uuid()) ->> 'status'), 'missing', 'message inconnu : missing');
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000b', (select v from fx where k = 'm1')) ->> 'status'), 'missing', 'message d''une autre entreprise : missing (aucune fuite)');
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'in1')) ->> 'status'), 'not_queued', 'message entrant : not_queued');
create temp table claim1 as select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1')) as r;
grant all on claim1 to public;
select is((select r ->> 'status' from claim1), 'claimed', 'm1 : claimed');
select is((select r -> 'message' ->> 'approved' from claim1), 'true', 'm1 : approuvé');
select is((select r -> 'message' ->> 'purpose' from claim1), 'marketing', 'm1 : finalité approuvée');
select is((select r -> 'contact' ->> 'email' from claim1), 'a1@sc.test', 'm1 : destinataire = e-mail du contact du fil (jamais un champ libre)');
select is((select r -> 'channel' ->> 'sender' from claim1), 'ventes@sc.test', 'm1 : expéditeur = identité du canal');
select is((select r -> 'message' ->> 'approver_valid' from claim1), 'true', 'm1 : approbateur toujours owner / admin actif');
select ok((select (r -> 'message' ->> 'approval_age_seconds')::int between 0 and 600 from claim1), 'm1 : âge de l''approbation fourni (secondes)');
select is((select r -> 'message' ->> 'recipient_unchanged' from claim1), 'true', 'm1 : adresse inchangée depuis l''approbation');
select is((select r ->> 'organization_active' from claim1), 'true', 'm1 : entreprise et abonnement actifs');
select is((select r ->> 'consent' from claim1), 'false', 'm1 : aucun consentement enregistré');
select is((select r ->> 'suppressed' from claim1), 'false', 'm1 : adresse non supprimée');
select is((select r ->> 'organization_send_paused' from claim1), 'false', 'm1 : entreprise non en pause');
select is((select r -> 'channel' ->> 'integration_status' from claim1), 'active', 'm1 : intégration active');
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1')) ->> 'status'), 'in_progress', 'seconde réclamation dans les 5 minutes : in_progress (jamais renvoyé à l''aveugle)');
select ok((select (private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1')) ->> 'message') is null), 'in_progress : aucun corps renvoyé');
-- m3 n'est pas approuvé : la lecture le dit, la décision revient au domaine
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm3')) -> 'message' ->> 'approved'), 'false', 'm3 : non approuvé, signalé');
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm2')) ->> 'sent_last_hour'), '2', 'fenêtre d''une heure : les 2 tentatives déjà posées sur le canal (m1 et m3) sont comptées, pas la sienne');
reset role;

-- ---------------------------------------------------------------------------
-- Résultats : accepted, failed, release
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select throws_ok($$select private.message_mark_accepted('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm4'), 'pm-0004')$$, 'PT404', null, 'accepted sans tentative réclamée : refusé');
select throws_ok($$select private.message_mark_accepted('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'id invalide avec espace')$$, '22023', null, 'identifiant du fournisseur mal formé : refusé');
select lives_ok($$select private.message_mark_accepted('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'pm-0001')$$, 'm1 : accepted');
select throws_ok($$select private.message_mark_accepted('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'pm-0001-bis')$$, 'PT404', null, 'm1 : une seconde acceptation est refusée');
select throws_ok($$select private.message_mark_failed('eb100000-0000-4000-8000-00000000000b', (select v from fx where k = 'm3'), 'refused_not_approved')$$, 'PT404', null, 'échec : autre entreprise refusée');
select throws_ok($$select private.message_mark_failed('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm3'), 'Pas Valide')$$, '22023', null, 'code d''échec mal formé : refusé');
select lives_ok($$select private.message_mark_failed('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm3'), 'refused_not_approved')$$, 'm3 : failed');
select lives_ok($$select private.message_release_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm2'))$$, 'm2 : tentative libérée (réponse « non accepté » du fournisseur)');
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm2')) ->> 'status'), 'claimed', 'm2 : une nouvelle tentative est permise après libération');
reset role;
select is((select status from public.messages where id = (select v from fx where k = 'm1')), 'accepted', 'm1 est « accepted », pas « delivered »');
select is((select provider_message_id from public.messages where id = (select v from fx where k = 'm1')), 'pm-0001', 'identifiant du fournisseur stocké');
select ok((select sent_at is not null from public.messages where id = (select v from fx where k = 'm1')), 'sent_at posé à l''acceptation');
select is((select error_code from public.messages where id = (select v from fx where k = 'm3')), 'refused_not_approved', 'code d''échec stocké (code seulement)');
select throws_ok($$update public.messages set status = 'accepted' where id = (select v from fx where k = 'm3')$$, '23514', 'message_status_invalid', 'failed est terminal');
select throws_ok($$update public.messages set status = 'queued' where id = (select v from fx where k = 'm1')$$, '23514', 'message_status_invalid', 'accepted -> queued : refusé');
select lives_ok($$update public.messages set status = 'delivered' where id = (select v from fx where k = 'm1')$$, 'accepted -> delivered : permis (événement du fournisseur, J32)');
select throws_ok($$update public.messages set status = 'sent' where id = (select v from fx where k = 'm1')$$, '23514', 'message_status_invalid', 'delivered -> sent : refusé');

-- ---------------------------------------------------------------------------
-- Revalidation à l'envoi (revue adverse) : approbateur, adresse, entreprise, abonnement ; envoi en cours ; accepted tardif
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea100000-0000-4000-8000-000000000001');
select throws_ok($$select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm5'), 'marketing')$$, 'P0001', 'message_not_approvable', 'contact sans adresse e-mail : rien à approuver');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000002');
select public.message_approve('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r' || n), 'marketing') from generate_series(1, 5) n;
reset role;
select is((select count(*)::int from public.messages where approved_by = 'ea100000-0000-4000-8000-000000000002' and idempotency_key like 'envoi-sc-001_'), 5, 'l''admin a approuvé r1 à r5');
select is((select approved_recipient from public.messages where id = (select v from fx where k = 'r1')), 'a1@sc.test', 'l''approbation fige l''adresse du destinataire');
select throws_ok($$update public.messages set approved_recipient = 'autre@sc.test' where id = (select v from fx where k = 'r1')$$, '23514', 'message_approval_immutable', 'l''adresse approuvée ne change plus');

select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r1')) -> 'message' ->> 'recipient_unchanged'), 'true', 'r1 : adresse inchangée');
reset role;
update public.contacts set email_raw = 'change@sc.test', email_normalized = 'change@sc.test' where id = 'ec100000-0000-4000-8000-0000000000a1';
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r2')) -> 'message' ->> 'recipient_unchanged'), 'false', 'r2 : adresse du contact modifiée depuis l''approbation, signalé');
reset role;
update public.contacts set email_raw = 'a1@sc.test', email_normalized = 'a1@sc.test' where id = 'ec100000-0000-4000-8000-0000000000a1';

update public.organization_members set role = 'sales_agent' where user_id = 'ea100000-0000-4000-8000-000000000002';
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r3')) -> 'message' ->> 'approver_valid'), 'false', 'r3 : l''approbateur a été rétrogradé : approbation invalide, signalé');
reset role;
update public.organization_members set role = 'company_admin' where user_id = 'ea100000-0000-4000-8000-000000000002';

update public.organizations set status = 'suspended' where id = 'eb100000-0000-4000-8000-00000000000a';
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r4')) ->> 'organization_active'), 'false', 'r4 : entreprise suspendue, signalé');
reset role;
update public.organizations set status = 'active' where id = 'eb100000-0000-4000-8000-00000000000a';
update public.subscriptions set status = 'suspended' where organization_id = 'eb100000-0000-4000-8000-00000000000a';
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r5')) ->> 'organization_active'), 'false', 'r5 : abonnement suspendu, signalé');
reset role;
update public.subscriptions set status = 'active' where organization_id = 'eb100000-0000-4000-8000-00000000000a';

-- tentative de plus de 5 minutes sans résultat : ambiguous ; puis le fournisseur avait bien accepté : accepted tardif
update public.messages set send_claimed_at = now() - interval '10 minutes' where id = (select v from fx where k = 'r1');
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r1')) ->> 'status'), 'ambiguous', 'r1 : tentative de plus de 5 minutes sans résultat : ambiguous');
select lives_ok($$select private.message_mark_failed('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r1'), 'send_outcome_unknown')$$, 'r1 : déclaré « résultat inconnu »');
select lives_ok($$select private.message_mark_accepted('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'r1'), 'pm-late-r1')$$, 'r1 : le fournisseur avait accepté : accepted tardif permis');
select throws_ok($$select private.message_mark_accepted('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm3'), 'pm-late-m3')$$, 'PT404', null, 'm3 (failed pour une autre raison) ne peut pas devenir accepted');
reset role;
select is((select status || ':' || coalesce(error_code, 'null') from public.messages where id = (select v from fx where k = 'r1')), 'accepted:null', 'r1 est « accepted », code d''échec effacé');

-- ---------------------------------------------------------------------------
-- Suppressions : lecture par rôle, aucune écriture directe
-- ---------------------------------------------------------------------------
insert into public.suppressions (organization_id, channel, value_normalized, reason) values ('eb100000-0000-4000-8000-00000000000a', 'email', 'a2@sc.test', 'bounce');
select pg_temp.as_user('ea100000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.suppressions), 1, 'marketing lit les suppressions de son entreprise');
select throws_ok($$insert into public.suppressions (organization_id, channel, value_normalized, reason) values ('eb100000-0000-4000-8000-00000000000a', 'email', 'x@sc.test', 'manual')$$, '42501', null, 'aucune écriture directe');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.suppressions), 0, 'le commercial ne lit pas les suppressions');
reset role;
select pg_temp.as_user('ea100000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.suppressions), 0, 'une autre entreprise ne lit rien');
reset role;
select pg_temp.as_service();
select is((select private.message_send_claim('eb100000-0000-4000-8000-00000000000a', (select v from fx where k = 'm4')) ->> 'suppressed'), 'true', 'm4 : adresse supprimée, signalée');
reset role;

-- aucun corps de message, identifiant fournisseur ni clé d'envoi dans l'audit
select is((select count(*)::int from public.audit_logs a where a.organization_id = 'eb100000-0000-4000-8000-00000000000a' and a.action like 'message.%'
  and to_jsonb(a)::text ~* '(SECRET-CORPS|pm-0001|envoi-sc-)'), 0, 'aucun corps de message, identifiant fournisseur ni clé d''envoi dans l''audit');

select * from finish();
rollback;
