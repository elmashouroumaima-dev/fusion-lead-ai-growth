-- J30 — Conversations et messages : un fil par contact et canal, cohérence d'entreprise imposée par la base (clé composite), unicité
-- du message fournisseur et de la clé d'idempotence, déclencheurs d'immuabilité, assignation et état par rôle, lecture (owner et admin tout,
-- commercial SES conversations, marketing et analyste rien), fonctions de réception et d'envoi réservées à service_role, libération à la
-- perte d'accès, audit sans corps de message. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(126);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U5 analyste A · U6 owner B · U7 second commercial A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@cv.test', now()
    from generate_series(1, 7) n;
insert into public.organizations (id, name, slug) values
  ('eb000000-0000-4000-8000-00000000000a', 'CV Alpha', 'cv-alpha-test'),
  ('eb000000-0000-4000-8000-00000000000b', 'CV Beta', 'cv-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('eb000000-0000-4000-8000-00000000000b', 'ea000000-0000-4000-8000-000000000006', 'company_owner', 'active'),
  ('eb000000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-000000000007', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('ec000000-0000-4000-8000-0000000000a1', 'eb000000-0000-4000-8000-00000000000a', 'Contact A1', 'a1@cv.test', 'a1@cv.test'),
  ('ec000000-0000-4000-8000-0000000000a2', 'eb000000-0000-4000-8000-00000000000a', 'Contact A2', 'a2@cv.test', 'a2@cv.test'),
  ('ec000000-0000-4000-8000-0000000000a3', 'eb000000-0000-4000-8000-00000000000a', 'Contact A3', 'a3@cv.test', 'a3@cv.test'),
  ('ec000000-0000-4000-8000-0000000000b1', 'eb000000-0000-4000-8000-00000000000b', 'Contact B1', 'b1@cv.test', 'b1@cv.test');

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

-- canaux : e-mail et WhatsApp chez A, WhatsApp chez B (créés par leurs owners avec les fonctions du J28)
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb000000-0000-4000-8000-00000000000a', 'email', 'cv-mail-a', '{}', 'ed000000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb000000-0000-4000-8000-00000000000a', 'whatsapp', 'cv-wa-a', '{}', 'ed000000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_channel('eb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cv-mail-a'), 'email', 'ventes@cv.test', '{}');
select public.create_channel('eb000000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'cv-wa-a'), 'whatsapp', '+212600000010', '{}');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select public.create_provider_integration('eb000000-0000-4000-8000-00000000000b', 'whatsapp', 'cv-wa-b', '{}', 'ed000000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_channel('eb000000-0000-4000-8000-00000000000b', (select id from public.integrations where external_account_id = 'cv-wa-b'), 'whatsapp', '+212600000011', '{}');
reset role;

-- ---------------------------------------------------------------------------
-- Structure et droits
-- ---------------------------------------------------------------------------
select has_table('public', 'conversations', 'la table conversations existe');
select has_table('public', 'messages', 'la table messages existe');
select ok((select relrowsecurity from pg_class where oid = 'public.conversations'::regclass) and (select relrowsecurity from pg_class where oid = 'public.messages'::regclass), 'RLS activée sur les deux tables');
select ok(has_table_privilege('authenticated', 'public.conversations', 'select') and has_table_privilege('authenticated', 'public.messages', 'select'), 'authenticated lit les deux tables (la RLS filtre)');
select ok(not has_table_privilege('authenticated', 'public.messages', 'insert') and not has_table_privilege('authenticated', 'public.conversations', 'update'), 'authenticated n''écrit pas');
select ok(not has_table_privilege('service_role', 'public.messages', 'insert') and not has_table_privilege('service_role', 'public.conversations', 'insert') and not has_table_privilege('service_role', 'public.messages', 'update'), 'service_role n''écrit pas directement');
select ok(not has_table_privilege('anon', 'public.messages', 'select') and not has_table_privilege('anon', 'public.conversations', 'select'), 'anon ne lit rien');
select ok(has_function_privilege('service_role', 'public.conversation_get_or_create(uuid,uuid,uuid)', 'execute') and has_function_privilege('service_role', 'public.message_record(uuid,uuid,text,text,text,text,timestamptz)', 'execute'), 'service_role exécute la réception et l''envoi');
select ok(not has_function_privilege('authenticated', 'public.conversation_get_or_create(uuid,uuid,uuid)', 'execute') and not has_function_privilege('authenticated', 'public.message_record(uuid,uuid,text,text,text,text,timestamptz)', 'execute') and not has_function_privilege('anon', 'public.message_record(uuid,uuid,text,text,text,text,timestamptz)', 'execute'), 'ni authenticated ni anon n''enregistrent un message');
select ok(has_function_privilege('authenticated', 'public.assign_conversation(uuid,uuid,uuid)', 'execute') and has_function_privilege('authenticated', 'public.set_conversation_state(uuid,uuid,text)', 'execute') and not has_function_privilege('anon', 'public.assign_conversation(uuid,uuid,uuid)', 'execute'), 'authenticated assigne et change l''état ; anon non');

-- ---------------------------------------------------------------------------
-- Ouverture d'un fil (service_role) : idempotente, cohérente avec l'entreprise
-- ---------------------------------------------------------------------------
select is((select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = 'ventes@cv.test')) ->> 'created'), 'true', 'premier appel : fil créé');
select is((select state || ':' || coalesce(assignee_id::text, 'null') || ':' || handled_by from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1'), 'to_triage:null:human', 'un nouveau fil attend le tri, sans responsable');
select is((select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = 'ventes@cv.test')) ->> 'created'), 'false', 'second appel : le même fil');
select is((select count(*)::int from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1'), 1, 'un seul fil par contact et canal');
select is((select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = '+212600000010')) ->> 'created'), 'true', 'un autre canal : un autre fil pour le même contact');
select throws_ok($$select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000b1', (select id from public.channels where sender_identity = 'ventes@cv.test'))$$, 'PT404', null, 'contact d''une autre entreprise : introuvable');
select throws_ok($$select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = '+212600000011'))$$, 'PT404', null, 'canal d''une autre entreprise : introuvable');
select throws_ok($$select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000b', 'ec000000-0000-4000-8000-0000000000b1', (select id from public.channels where sender_identity = 'ventes@cv.test'))$$, 'PT404', null, 'l''entreprise B avec un canal d''Alpha : introuvable');
select throws_ok($$select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), (select id from public.channels where sender_identity = 'ventes@cv.test'))$$, 'PT404', null, 'contact inconnu : introuvable');
select throws_ok($$select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', null, null)$$, '22023', null, 'paramètres absents : refusé');
select throws_ok($$insert into public.conversations (organization_id, contact_id, channel_id) values ('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = 'ventes@cv.test'))$$, '23505', null, 'garde-fou base : un seul fil par contact et canal');
select throws_ok($$update public.conversations set contact_id = 'ec000000-0000-4000-8000-0000000000a2' where contact_id = 'ec000000-0000-4000-8000-0000000000a1' and channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')$$, '23514', 'conversation_identity_immutable', 'le contact d''un fil ne change jamais');
select throws_ok($$update public.conversations set channel_id = (select id from public.channels where sender_identity = '+212600000010') where contact_id = 'ec000000-0000-4000-8000-0000000000a1' and channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')$$, '23514', 'conversation_identity_immutable', 'le canal d''un fil ne change jamais');
select throws_ok($$update public.conversations set lock_owner = 'ea000000-0000-4000-8000-000000000001'$$, '23514', null, 'verrou : propriétaire sans échéance refusé');

-- un fil de plus par entreprise pour la suite : contact A2 sur l'e-mail (commercial 1), contact A3 (commercial 2), contact B1 chez B
select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a2', (select id from public.channels where sender_identity = 'ventes@cv.test'));
select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000a', 'ec000000-0000-4000-8000-0000000000a3', (select id from public.channels where sender_identity = 'ventes@cv.test'));
select private.conversation_get_or_create('eb000000-0000-4000-8000-00000000000b', 'ec000000-0000-4000-8000-0000000000b1', (select id from public.channels where sender_identity = '+212600000011'));

-- ---------------------------------------------------------------------------
-- Enregistrement d'un message : entrant dédupliqué, sortant idempotent
-- ---------------------------------------------------------------------------
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'inbound', 'wamid.CV1', 'Bonjour, je veux un devis', null, '2026-11-10 10:00:00+00') ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), 'false', 'message entrant enregistré');
select is((select m.direction || ':' || m.status || ':' || (m.received_at is not null)::text || ':' || (m.sent_at is null)::text from public.messages m where m.provider_message_id = 'wamid.CV1'), 'inbound:received:true:true', 'entrant : statut received, date de réception');
select is((select c.last_message_at from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), '2026-11-10 10:00:00+00'::timestamptz, 'last_message_at mis à jour');
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'inbound', 'wamid.CV1', 'Bonjour, je veux un devis', null, '2026-11-10 10:00:00+00') ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), 'true', 'rejeu du même message fournisseur : duplicate');
select is((select count(*)::int from public.messages where provider_message_id = 'wamid.CV1'), 1, 'un seul message après le rejeu');
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'inbound', 'wamid.CV0', 'Message plus ancien', null, '2026-11-10 09:00:00+00') ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), 'false', 'un message plus ancien (reçu en retard) est enregistré');
select is((select c.last_message_at from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), '2026-11-10 10:00:00+00'::timestamptz, 'last_message_at ne recule jamais');
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'outbound', null, 'Voici le devis', 'envoi-cv-0001', null) ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), 'false', 'message sortant mis en file');
select is((select m.direction || ':' || m.status || ':' || (m.received_at is null)::text from public.messages m where m.idempotency_key = 'envoi-cv-0001'), 'outbound:queued:true', 'sortant : statut queued');
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'outbound', null, 'Voici le devis', 'envoi-cv-0001', null) ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')), 'true', 'rejeu du même envoi (clé d''idempotence) : duplicate');
select is((select count(*)::int from public.messages where idempotency_key = 'envoi-cv-0001'), 1, 'un seul message sortant');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = 'ventes@cv.test'), 'outbound', null, 'Un AUTRE corps', 'envoi-cv-0001', null)$$, 'P0001', 'idempotency_conflict', 'même clé d''envoi avec un autre corps : conflit, jamais un duplicate silencieux');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'outbound', null, 'Voici le devis', 'envoi-cv-0001', null)$$, 'P0001', 'idempotency_conflict', 'même clé d''envoi pour une AUTRE conversation : conflit (l''envoi destiné à l''autre fil n''est pas perdu en silence)');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'inbound', 'wamid.CV1', 'Bonjour, je veux un devis', null, null)$$, 'P0001', 'idempotency_conflict', 'même identifiant fournisseur pour une AUTRE conversation du même canal : conflit');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = 'ventes@cv.test'), 'inbound', 'wamid.CV1', 'Un corps différent', null, null)$$, 'P0001', 'idempotency_conflict', 'même identifiant fournisseur avec un autre corps : conflit');
select is((select body from public.messages where idempotency_key = 'envoi-cv-0001'), 'Voici le devis', 'le corps du premier envoi est conservé');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'inbound', null, 'x', null, null)$$, '22023', null, 'entrant sans identifiant du fournisseur : refusé');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'outbound', null, 'x', null, null)$$, '22023', null, 'sortant sans clé d''idempotence : refusé');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'autre', 'x', 'x', null, null)$$, '22023', null, 'sens inconnu : refusé');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'inbound', 'wamid.VIDE', '', null, null)$$, '22023', null, 'corps vide : refusé');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'inbound', 'wamid.GROS', repeat('a', 100001), null, null)$$, '22023', null, 'corps de plus de 100 000 caractères : refusé');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'inbound', 'identifiant avec espace', 'x', null, null)$$, '22023', null, 'identifiant du fournisseur mal formé : refusé');
select lives_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'inbound', 'wamid.100K', repeat('a', 100000), null, null)$$, 'corps de 100 000 caractères : accepté');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000b', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'inbound', 'wamid.CROISE', 'x', null, null)$$, 'PT404', null, 'l''entreprise B avec une conversation d''Alpha : introuvable (aucun mélange)');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'inbound', 'wamid.INCONNU', 'x', null, null)$$, 'PT404', null, 'conversation inconnue : introuvable');
select is((select count(*)::int from public.messages where provider_message_id in ('wamid.VIDE', 'wamid.GROS', 'wamid.CROISE', 'wamid.INCONNU')), 0, 'aucun message partiel après les refus');
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'inbound', 'wamid.CV1', 'Même identifiant, autre canal', null, null) ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and c.channel_id = (select id from public.channels where sender_identity = '+212600000010')), 'false', 'même identifiant fournisseur sur un AUTRE canal : message distinct');

-- cohérence d'entreprise et de canal imposée par la clé composite (insertion directe, en superutilisateur)
select throws_ok($$insert into public.messages (organization_id, conversation_id, channel_id, direction, body, status, idempotency_key)
  select 'eb000000-0000-4000-8000-00000000000b', c.id, c.channel_id, 'outbound', 'x', 'queued', 'cle-organisation-1' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1$$, '23503', null, 'un message ne peut pas porter une autre entreprise que sa conversation');
select throws_ok($$insert into public.messages (organization_id, conversation_id, channel_id, direction, body, status, idempotency_key)
  select c.organization_id, c.id, (select id from public.channels where sender_identity = '+212600000011'), 'outbound', 'x', 'queued', 'cle-canal-0001' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1$$, '23503', null, 'ni un autre canal que sa conversation');
select throws_ok($$insert into public.messages (organization_id, conversation_id, channel_id, direction, body, status, provider_message_id, received_at)
  select c.organization_id, c.id, c.channel_id, 'inbound', 'x', 'queued', 'wamid.INCOH', now() from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1$$, '23514', null, 'un message entrant ne peut pas avoir le statut queued');
select throws_ok($$insert into public.messages (organization_id, conversation_id, channel_id, direction, body, status)
  select c.organization_id, c.id, c.channel_id, 'outbound', 'x', 'queued' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1$$, '23514', null, 'un sortant sans clé d''idempotence est refusé par la base');

-- aucune fuite du corps dans les erreurs (le DETAIL d'une violation de CHECK recopierait la ligne entière)
create function pg_temp.err_text(p_sql text) returns text language plpgsql as $f$
declare
  v_detail text;
begin
  execute p_sql;
  return 'aucune erreur';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return coalesce(sqlerrm, '') || ' | ' || coalesce(v_detail, '');
end $f$;
select is((select pg_temp.err_text($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = 'ventes@cv.test'), 'inbound', 'wamid.FUITE', repeat('SECRET-CORPS-', 8000), null, null)$$) ~* 'SECRET-CORPS'), false, 'corps trop long : l''erreur ne contient pas le corps');
select is((select pg_temp.err_text($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = 'ventes@cv.test'), 'inbound', 'id invalide', 'SECRET-CORPS-2', null, null)$$) ~* 'SECRET-CORPS'), false, 'identifiant mal formé : l''erreur ne contient pas le corps');
select is((select pg_temp.err_text($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = 'ventes@cv.test'), 'outbound', null, 'SECRET-CORPS-3', 'envoi-cv-0001', null)$$) ~* 'SECRET-CORPS'), false, 'conflit d''idempotence : l''erreur ne contient pas le corps');

-- canal déconnecté : aucun message ; horodatage d'un fournisseur limité à maintenant + 5 minutes
update public.channels set status = 'disconnected' where sender_identity = '+212600000010';
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = '+212600000010'), 'inbound', 'wamid.DECONNECTE', 'x', null, null)$$, 'PT404', null, 'canal déconnecté : aucun message enregistré');
update public.channels set status = 'pending' where sender_identity = '+212600000010';
select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = '+212600000010'), 'inbound', 'wamid.FUTUR', 'Message daté de 2099', null, '2099-01-01 00:00:00+00');
select ok((select c.last_message_at <= now() + interval '6 minutes' from public.conversations c where c.id = (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = '+212600000010')), 'un horodatage dans le futur lointain est ramené à maintenant + 5 minutes (le fil n''est pas épinglé en tête)');
select ok((select m.received_at <= now() + interval '6 minutes' from public.messages m where m.provider_message_id = 'wamid.FUTUR'), 'idem pour la date de réception du message');

-- plafond technique : 10 000 messages par conversation
insert into public.messages (organization_id, conversation_id, channel_id, direction, provider_message_id, body, status, received_at)
  select c.organization_id, c.id, c.channel_id, 'inbound', 'bulk-' || n, 'x', 'received', now()
    from generate_series(1, 10000) n, public.conversations c where c.id = (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = '+212600000010');
select throws_ok($$select private.message_record('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = '+212600000010'), 'inbound', 'wamid.APRES-PLAFOND', 'x', null, null)$$, 'P0001', 'too_many_messages', 'plafond de 10 000 messages par conversation : too_many_messages');
delete from public.messages where provider_message_id like 'bulk-%';

-- cohérence état / responsable par CHECK (en plus des fonctions)
select throws_ok($$update public.conversations set state = 'to_triage', assignee_id = 'ea000000-0000-4000-8000-000000000004' where contact_id = 'ec000000-0000-4000-8000-0000000000a1' and channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')$$, '23514', null, 'garde-fou base : « to_triage » avec un responsable est refusé');
select throws_ok($$update public.conversations set state = 'open', assignee_id = null where contact_id = 'ec000000-0000-4000-8000-0000000000a3'$$, '23514', null, 'garde-fou base : « open » sans responsable est refusé');
select throws_ok($$update public.conversations set state = 'pending', assignee_id = null where contact_id = 'ec000000-0000-4000-8000-0000000000a3'$$, '23514', null, 'garde-fou base : « pending » sans responsable est refusé');

-- immuabilité
select throws_ok($$update public.messages set body = 'modifié' where idempotency_key = 'envoi-cv-0001'$$, '23514', 'message_immutable', 'le corps d''un message ne change pas');
select throws_ok($$update public.messages set conversation_id = (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1) where idempotency_key = 'envoi-cv-0001'$$, '23514', 'message_immutable', 'un message ne change pas de conversation');
select throws_ok($$update public.messages set provider_message_id = 'wamid.AUTRE' where provider_message_id = 'wamid.CV1' and channel_id = (select id from public.channels where sender_identity = 'ventes@cv.test')$$, '23514', 'message_immutable', 'l''identifiant du fournisseur ne change plus une fois connu');
select lives_ok($$update public.messages set provider_message_id = 'wamid.ACCEPTE', status = 'accepted' where idempotency_key = 'envoi-cv-0001'$$, 'l''identifiant du fournisseur se renseigne une fois (envoi accepté)');
select throws_ok($$update public.messages set organization_id = 'eb000000-0000-4000-8000-00000000000b' where idempotency_key = 'envoi-cv-0001'$$, '23514', null, 'l''entreprise d''un message ne change jamais');

-- ---------------------------------------------------------------------------
-- Assignation (owner et admin) et état
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select lives_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'ea000000-0000-4000-8000-000000000004')$$, 'owner assigne le fil de A2 au commercial 1');
select is((select state || ':' || assignee_id::text from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'open:ea000000-0000-4000-8000-000000000004', 'assigner sort le fil de la file de tri (open)');
select lives_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1), 'ea000000-0000-4000-8000-000000000007')$$, 'owner assigne le fil de A3 au commercial 2');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'ea000000-0000-4000-8000-000000000003')$$, 'P0001', 'assignee_invalid', 'un marketing n''est pas assignable');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a1' limit 1), 'ea000000-0000-4000-8000-000000000006')$$, 'P0001', 'assignee_invalid', 'un membre d''une autre entreprise n''est pas assignable');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'ea000000-0000-4000-8000-000000000004')$$, 'PT404', null, 'conversation inconnue : introuvable');
select lives_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select c.id from public.conversations c join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id where c.contact_id = 'ec000000-0000-4000-8000-0000000000a1' and ch.sender_identity = 'ventes@cv.test'), 'ea000000-0000-4000-8000-000000000004')$$, 'le fil e-mail de A1 va aussi au commercial 1 (le fil WhatsApp reste en file de tri)');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select lives_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'ea000000-0000-4000-8000-000000000007')$$, 'admin réassigne');
select lives_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'ea000000-0000-4000-8000-000000000004')$$, 'et réassigne au commercial 1');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'ea000000-0000-4000-8000-000000000004')$$, '42501', null, 'marketing n''assigne pas');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'ea000000-0000-4000-8000-000000000004')$$, '42501', null, 'commercial n''assigne pas');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'ea000000-0000-4000-8000-000000000004')$$, '42501', null, 'analyste n''assigne pas');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'ea000000-0000-4000-8000-000000000006')$$, '42501', null, 'owner de B n''assigne rien chez A');
reset role;
select pg_temp.as_anon();
select throws_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), null)$$, '42501', null, 'anonyme : refusé');
reset role;

select set_config('cv.a3', (select id::text from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1), true);
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select lives_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'pending')$$, 'le commercial met en attente SON fil');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', current_setting('cv.a3')::uuid, 'closed')$$, 'PT404', null, 'le commercial 1 ne touche pas le fil du commercial 2 (introuvable)');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'to_triage')$$, '22023', null, 'la file de tri n''existe que sans responsable');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'archivé')$$, '22023', null, 'état inconnu : refusé');
select lives_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2' limit 1), 'closed')$$, 'le commercial ferme SON fil');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'closed')$$, '42501', null, 'marketing ne change pas l''état');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'closed')$$, '42501', null, 'analyste ne change pas l''état');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select lives_ok($$select public.assign_conversation('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1), null)$$, 'owner désassigne le fil de A3');
select is((select state || ':' || coalesce(assignee_id::text, 'null') from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3'), 'to_triage:null', 'désassigner remet le fil en file de tri');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1), 'pending')$$, '22023', null, '« pending » exige un responsable (un fil sans responsable reste dans la file de tri ou fermé)');
select lives_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1), 'closed')$$, 'owner ferme un fil sans responsable');
select throws_ok($$select public.set_conversation_state('eb000000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1), 'open')$$, '22023', null, '« open » exige un responsable');
reset role;

-- un message entrant rouvre un fil fermé
select is((select state from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'closed', 'le fil de A2 est fermé');
select is((select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'inbound', 'wamid.REOUVRE', 'Re-bonjour', null, null) ->> 'duplicate' from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'false', 'message entrant sur un fil fermé');
select is((select state from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'open', 'il rouvre le fil (avec responsable : open)');
update public.conversations set state = 'closed', assignee_id = null where contact_id = 'ec000000-0000-4000-8000-0000000000a2';
select private.message_record('eb000000-0000-4000-8000-00000000000a', c.id, 'inbound', 'wamid.REOUVRE2', 'Encore', null, null) from public.conversations c where c.contact_id = 'ec000000-0000-4000-8000-0000000000a2';
select is((select state from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'to_triage', 'sans responsable, il le remet en file de tri');
update public.conversations set state = 'open', assignee_id = 'ea000000-0000-4000-8000-000000000004' where contact_id = 'ec000000-0000-4000-8000-0000000000a2';

-- ---------------------------------------------------------------------------
-- Lecture par rôle
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.conversations), 4, 'owner A voit les 4 fils d''Alpha');
select is((select count(*)::int from public.messages), 8, 'owner A voit les 8 messages d''Alpha');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.conversations), 4, 'admin A voit les 4 fils');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.conversations), 2, 'commercial 1 ne voit que SES fils (A1 e-mail et A2), ni le fil WhatsApp de A1 ni celui de A3');
select is((select count(*)::int from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3'), 0, 'il ne voit pas le fil de A3 (non assigné)');
select is((select count(*)::int from public.messages), 5, 'il lit les 5 messages de SES conversations (pas ceux du fil WhatsApp, qui n''est pas le sien)');
select is((select count(*)::int from public.messages m where m.conversation_id = (select id from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a3' limit 1)), 0, 'et aucun message d''un fil qui n''est pas le sien');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000007');
select is((select count(*)::int from public.conversations), 0, 'commercial 2 : aucun fil (le fil de A3 est maintenant en file de tri)');
select is((select count(*)::int from public.messages), 0, 'commercial 2 : aucun message');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.conversations) + (select count(*)::int from public.messages), 0, 'marketing ne lit ni conversations ni messages');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.conversations) + (select count(*)::int from public.messages), 0, 'analyste ne lit ni conversations ni messages');
reset role;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.conversations), 1, 'owner B ne voit que son fil');
select is((select count(*)::int from public.conversations where organization_id = 'eb000000-0000-4000-8000-00000000000a'), 0, 'owner B ne voit rien d''Alpha');
select is((select count(*)::int from public.messages), 0, 'owner B ne voit aucun message d''Alpha');
select throws_ok($$insert into public.messages (organization_id, conversation_id, channel_id, direction, body, status, idempotency_key) values ('eb000000-0000-4000-8000-00000000000b', gen_random_uuid(), gen_random_uuid(), 'outbound', 'x', 'queued', 'cle-directe-001')$$, '42501', null, 'INSERT direct refusé');
select throws_ok($$update public.conversations set state = 'closed'$$, '42501', null, 'UPDATE direct refusé');
select throws_ok($$delete from public.messages$$, '42501', null, 'DELETE direct refusé');
reset role;
select pg_temp.as_anon();
select throws_ok($$select id from public.conversations$$, '42501', null, 'anonyme : refusé');
reset role;

-- ---------------------------------------------------------------------------
-- Libération à la perte d'accès (comme les leads)
-- ---------------------------------------------------------------------------
update public.organization_members set status = 'suspended' where user_id = 'ea000000-0000-4000-8000-000000000004';
select is((select count(*)::int from public.conversations where assignee_id = 'ea000000-0000-4000-8000-000000000004'), 0, 'suspendre le commercial 1 libère tous ses fils');
select is((select state from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'to_triage', 'un fil ouvert retourne en file de tri');
update public.organization_members set status = 'active' where user_id = 'ea000000-0000-4000-8000-000000000004';
update public.conversations set assignee_id = 'ea000000-0000-4000-8000-000000000004', state = 'closed' where contact_id = 'ec000000-0000-4000-8000-0000000000a2';
update public.organization_members set role = 'analyst' where user_id = 'ea000000-0000-4000-8000-000000000004';
select is((select state || ':' || coalesce(assignee_id::text, 'null') from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'closed:null', 'rétrograder libère aussi ; un fil fermé reste fermé');
update public.conversations set assignee_id = 'ea000000-0000-4000-8000-000000000007', state = 'open' where contact_id = 'ec000000-0000-4000-8000-0000000000a2';
delete from public.organization_members where user_id = 'ea000000-0000-4000-8000-000000000007';
select is((select state || ':' || coalesce(assignee_id::text, 'null') from public.conversations where contact_id = 'ec000000-0000-4000-8000-0000000000a2'), 'to_triage:null', 'supprimer l''adhésion libère le fil');

-- ---------------------------------------------------------------------------
-- Audit : identifiants et états, jamais le corps d'un message
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb000000-0000-4000-8000-00000000000a' and action = 'conversation.created'), 'audit : conversation.created');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb000000-0000-4000-8000-00000000000a' and action = 'conversation.assigned'), 'audit : conversation.assigned');
select ok(exists (select 1 from public.audit_logs where organization_id = 'eb000000-0000-4000-8000-00000000000a' and action = 'conversation.state_changed'), 'audit : conversation.state_changed');
select is((select count(*)::int from public.audit_logs a where a.organization_id = 'eb000000-0000-4000-8000-00000000000a' and a.action like 'conversation.%'
  and to_jsonb(a)::text ~* '(devis|Re-bonjour|Encore|wamid\.|envoi-cv)'), 0, 'aucun corps de message, identifiant fournisseur ni clé d''envoi dans l''audit');

select * from finish();
rollback;
