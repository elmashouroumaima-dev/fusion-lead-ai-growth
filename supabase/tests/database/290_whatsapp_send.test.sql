-- J36 — Envoi WhatsApp conforme : modèles de message (`message_templates`, synchronisés par service_role, versionnés), modèle rattaché AVANT l'approbation, approbation par
-- numéro, réclamation (fenêtre de 24 h, modèle, destinataire du canal), statut reçu avant l'enregistrement de l'envoi réessayé. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(57);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea600000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@ws.test', now()
    from generate_series(1, 6) n;
-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U5 analyste A · U6 owner B
insert into public.organizations (id, name, slug) values
  ('eb600000-0000-4000-8000-00000000000a', 'WS Alpha', 'ws-alpha-test'),
  ('eb600000-0000-4000-8000-00000000000b', 'WS Beta', 'ws-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb600000-0000-4000-8000-00000000000a', 'ea600000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('eb600000-0000-4000-8000-00000000000b', 'ea600000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb600000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb600000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec600000-0000-4000-8000-0000000000a1', 'eb600000-0000-4000-8000-00000000000a', 'K1', 'k1@ws.test', 'k1@ws.test', '+212600000001'),
  ('ec600000-0000-4000-8000-0000000000a2', 'eb600000-0000-4000-8000-00000000000a', 'K2 sans numéro', 'k2@ws.test', 'k2@ws.test', null),
  ('ec600000-0000-4000-8000-0000000000b1', 'eb600000-0000-4000-8000-00000000000b', 'KB', 'kb@ws.test', 'kb@ws.test', '+212600000009');
insert into public.integrations (id, organization_id, provider, status, external_account_id) values
  ('ee600000-0000-4000-8000-000000000001', 'eb600000-0000-4000-8000-00000000000a', 'whatsapp', 'active', '800000000000001'),
  ('ee600000-0000-4000-8000-000000000002', 'eb600000-0000-4000-8000-00000000000a', 'email', 'active', 'ws-mail-a'),
  ('ee600000-0000-4000-8000-000000000003', 'eb600000-0000-4000-8000-00000000000b', 'whatsapp', 'active', '800000000000003');
insert into public.channels (id, organization_id, type, integration_id, sender_identity, status) values
  ('ef600000-0000-4000-8000-000000000001', 'eb600000-0000-4000-8000-00000000000a', 'whatsapp', 'ee600000-0000-4000-8000-000000000001', '+15550000001', 'active'),
  ('ef600000-0000-4000-8000-000000000002', 'eb600000-0000-4000-8000-00000000000a', 'whatsapp', 'ee600000-0000-4000-8000-000000000001', '+15550000002', 'active'),
  ('ef600000-0000-4000-8000-000000000003', 'eb600000-0000-4000-8000-00000000000a', 'email', 'ee600000-0000-4000-8000-000000000002', 'ventes@ws.test', 'active'),
  ('ef600000-0000-4000-8000-000000000004', 'eb600000-0000-4000-8000-00000000000b', 'whatsapp', 'ee600000-0000-4000-8000-000000000003', '+15550000004', 'active');

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

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------
select is(has_function_privilege('service_role', 'public.message_templates_sync(uuid, uuid, jsonb)', 'execute'), true, 'sync : service_role peut');
select is(has_function_privilege('authenticated', 'public.message_templates_sync(uuid, uuid, jsonb)', 'execute'), false, 'sync : authenticated ne peut pas');
select is(has_function_privilege('anon', 'public.message_attach_template(uuid, uuid, uuid, jsonb)', 'execute'), false, 'attach : anon ne peut pas');
select is(has_function_privilege('authenticated', 'public.message_attach_template(uuid, uuid, uuid, jsonb)', 'execute'), true, 'attach : authenticated peut (le rôle est revérifié dans la fonction)');
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', '[]'::jsonb)$$, '42501', null, 'un owner connecté ne peut pas synchroniser les modèles');
select throws_ok($$insert into public.message_templates (organization_id, channel_id, name, language, category, status) values ('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', 'x', 'fr', 'marketing', 'approved')$$, '42501', null, 'aucune écriture directe');
reset role;
select pg_temp.as_service();
select throws_ok($$insert into public.message_templates (organization_id, channel_id, name, language, category, status) values ('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', 'x', 'fr', 'marketing', 'approved')$$, '42501', null, 'même service_role n''écrit pas directement');
reset role;

-- ---------------------------------------------------------------------------
-- Synchronisation
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
create temp table res (k text, r jsonb);
grant all on res to public;
insert into res select 'first', public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', $j$[
  {"name": "offre_ete", "language": "fr", "category": "marketing", "status": "approved", "components": [{"type": "BODY", "text": "Bonjour {{1}}"}]},
  {"name": "rappel", "language": "fr", "category": "utility", "status": "pending", "components": []}
]$j$::jsonb);
insert into res select 'again', public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', $j$[
  {"name": "offre_ete", "language": "fr", "category": "marketing", "status": "approved", "components": [{"type": "BODY", "text": "Bonjour {{1}}"}]}
]$j$::jsonb);
insert into res select 'status', public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', $j$[
  {"name": "rappel", "language": "fr", "category": "utility", "status": "approved", "components": []}
]$j$::jsonb);
insert into res select 'version', public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', $j$[
  {"name": "offre_ete", "language": "fr", "category": "marketing", "status": "approved", "components": [{"type": "BODY", "text": "Bonjour {{1}}, offre limitée"}]}
]$j$::jsonb);
reset role;
select is((select r ->> 'inserted' from res where k = 'first'), '2', 'première synchronisation : 2 modèles créés (version 1)');
select is((select r ->> 'unchanged' from res where k = 'again'), '1', 'même liste : inchangé');
select is((select r ->> 'updated' from res where k = 'status'), '1', 'statut changé : mis à jour (pas de nouvelle version)');
select is((select status from public.message_templates where name = 'rappel' and organization_id = 'eb600000-0000-4000-8000-00000000000a'), 'approved', 'le statut est celui de Meta');
select is((select r ->> 'inserted' from res where k = 'version'), '1', 'composants changés : nouvelle VERSION');
select is((select array_agg(version order by version)::text from public.message_templates where name = 'offre_ete' and organization_id = 'eb600000-0000-4000-8000-00000000000a'), '{1,2}', 'l''ancienne version est conservée (historique)');

select pg_temp.as_service();
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000003', '[]'::jsonb)$$, 'PT404', null, 'un canal e-mail n''a pas de modèles');
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000b', 'ef600000-0000-4000-8000-000000000001', '[]'::jsonb)$$, 'PT404', null, 'le canal d''une autre entreprise est introuvable');
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', '[{"name": "Nom Invalide", "language": "fr", "category": "marketing", "status": "approved"}]'::jsonb)$$, '22023', null, 'nom invalide refusé');
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', '[{"name": "x", "language": "fr", "category": "autre", "status": "approved"}]'::jsonb)$$, '22023', null, 'catégorie inconnue refusée');
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', '[{"name": "x", "language": "fr", "category": "marketing", "status": "approved", "components": "pas un tableau"}]'::jsonb)$$, '22023', null, 'composants non tableau refusés');
select throws_ok($$select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', (select jsonb_agg(jsonb_build_object('name', 't' || n, 'language', 'fr', 'category', 'marketing', 'status', 'approved')) from generate_series(1, 201) n))$$, '22023', null, 'plus de 200 éléments refusés');
reset role;

-- lecture : owner, admin, marketing ; pas commercial, analyste, ni autre entreprise
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.message_templates), 3, 'owner : lit les modèles de son entreprise');
reset role;
select pg_temp.as_user('ea600000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.message_templates), 3, 'marketing : lit les modèles');
reset role;
select pg_temp.as_user('ea600000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.message_templates), 0, 'commercial : ne lit rien');
reset role;
select pg_temp.as_user('ea600000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.message_templates), 0, 'autre entreprise : ne lit rien');
reset role;

-- ---------------------------------------------------------------------------
-- Messages et rattachement d'un modèle
-- ---------------------------------------------------------------------------
select private.conversation_get_or_create('eb600000-0000-4000-8000-00000000000a', 'ec600000-0000-4000-8000-0000000000a1', 'ef600000-0000-4000-8000-000000000001');
select private.conversation_get_or_create('eb600000-0000-4000-8000-00000000000a', 'ec600000-0000-4000-8000-0000000000a2', 'ef600000-0000-4000-8000-000000000001');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
insert into fx select 'conv1', id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a1';
insert into fx select 'conv2', id from public.conversations where contact_id = 'ec600000-0000-4000-8000-0000000000a2';
insert into fx select 'tpl_v2', id from public.message_templates where name = 'offre_ete' and version = 2;
insert into fx select 'tpl_rappel', id from public.message_templates where name = 'rappel';
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M1', 'envoi-ws-0001', null);
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'outbound', null, 'M2', 'envoi-ws-0002', null);
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv2'), 'outbound', null, 'M3', 'envoi-ws-0003', null);
insert into fx select 'm' || right(idempotency_key, 1), id from public.messages where idempotency_key ~ 'envoi-ws-000[1-3]$';
-- un modèle d'un autre canal et un modèle en attente
select pg_temp.as_service();
select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000002', '[{"name": "autre_canal", "language": "fr", "category": "marketing", "status": "approved", "components": []}, {"name": "en_attente", "language": "fr", "category": "marketing", "status": "pending", "components": []}]'::jsonb);
reset role;
insert into fx select 'tpl_other', id from public.message_templates where name = 'autre_canal';
insert into fx select 'tpl_pending', id from public.message_templates where name = 'en_attente';

select pg_temp.as_user('ea600000-0000-4000-8000-000000000004');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), '["Nadia"]'::jsonb)$$, '42501', null, 'un commercial ne rattache pas de modèle');
reset role;
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_other'), '[]'::jsonb)$$, 'P0001', null, 'modèle d''un AUTRE canal : refusé');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_pending'), '[]'::jsonb)$$, 'P0001', null, 'modèle non approuvé : refusé');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), '[1, 2]'::jsonb)$$, '22023', null, 'variables non textuelles refusées');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), (select jsonb_agg('v'::text) from generate_series(1, 11)))$$, '22023', null, 'plus de 10 variables refusées');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000b', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), '[]'::jsonb)$$, '42501', null, 'owner d''une autre entreprise : interdit');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), jsonb_build_array(E'ligne 1
ligne 2'))$$, '22023', null, 'variable avec retour à la ligne refusée (Meta la refuse)');
select lives_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), '["Nadia", "20 %"]'::jsonb)$$, 'owner : rattache un modèle approuvé du canal');
reset role;
select is((select template_id from public.messages where id = (select v from fx where k = 'm1')), (select v from fx where k = 'tpl_v2'), 'modèle enregistré (donc nom, langue et version)');
select is((select template_variables::text from public.messages where id = (select v from fx where k = 'm1')), '["Nadia", "20 %"]', 'variables enregistrées');
select is((select count(*)::int from public.audit_logs where organization_id = 'eb600000-0000-4000-8000-00000000000a' and action = 'message.template_attached' and (after::text ~* 'Nadia|20 %')), 0, 'aucune variable (donnée personnelle) dans l''audit');

select is((select template_text from public.messages where id = (select v from fx where k = 'm1')), 'Bonjour Nadia, offre limitée', 'texte RENDU enregistré (corps du modèle + variables) : ce que l''approbateur relit');
-- approbation : l'adresse approuvée est le NUMÉRO pour un canal WhatsApp
select pg_temp.as_user('ea600000-0000-4000-8000-000000000001');
select lives_ok($$select public.message_approve('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), 'marketing')$$, 'approbation d''un message WhatsApp');
select throws_ok($$select public.message_approve('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm3'), 'marketing')$$, 'P0001', null, 'contact sans numéro : non approuvable');
select throws_ok($$select public.message_attach_template('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'), (select v from fx where k = 'tpl_v2'), '[]'::jsonb)$$, 'P0001', null, 'après l''approbation : plus de rattachement');
reset role;
select is((select approved_recipient from public.messages where id = (select v from fx where k = 'm1')), '+212600000001', 'adresse approuvée : le numéro (E.164)');
select throws_ok($$update public.messages set template_variables = '["Autre"]'::jsonb where id = (select v from fx where k = 'm1')$$, '23514', null, 'modèle et variables immuables après l''approbation');

-- ---------------------------------------------------------------------------
-- Réclamation : fenêtre, modèle, destinataire du canal
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
create temp table cl (r jsonb);
grant all on cl to public;
insert into cl select public.message_send_claim('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'));
reset role;
select is((select r ->> 'status' from cl), 'claimed', 'réclamation posée');
select is((select (r ->> 'window_open')::boolean from cl), false, 'fenêtre fermée : le contact n''a jamais écrit');
select is((select r #>> '{template,name}' from cl), 'offre_ete', 'modèle : nom');
select is((select r #>> '{template,version}' from cl), '2', 'modèle : version');
select is((select r #>> '{template,variables}' from cl), '["Nadia", "20 %"]', 'modèle : variables');
select is((select r #>> '{contact,phone}' from cl), '+212600000001', 'destinataire : le numéro du contact');
select is((select r #>> '{channel,account}' from cl), '800000000000001', 'compte du fournisseur : identifiant du numéro de l''intégration');
select is((select (r ->> 'suppressed')::boolean from cl), false, 'pas supprimé');
-- fenêtre ouverte par un message reçu il y a moins de 24 h ; fermée si le dernier remonte à plus de 24 h
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'inbound', 'wamid.WS1', 'Bonjour', null, now() - interval '30 hours');
select pg_temp.as_service();
delete from cl;
insert into cl select public.message_send_claim('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm2'));
reset role;
select is((select (r ->> 'window_open')::boolean from cl), false, 'dernier message reçu il y a 30 h : fenêtre fermée');
update public.messages set send_claimed_at = null where id = (select v from fx where k = 'm2');
select private.message_record('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'conv1'), 'inbound', 'wamid.WS2', 'Encore moi', null, now() - interval '2 hours');
select pg_temp.as_service();
delete from cl;
insert into cl select public.message_send_claim('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm2'));
reset role;
select is((select (r ->> 'window_open')::boolean from cl), true, 'message reçu il y a 2 h : fenêtre ouverte');
select ok((select r -> 'template' = 'null'::jsonb from cl), 'sans modèle rattaché : aucun modèle');

-- statut reçu avant l'enregistrement de l'envoi : réessayé ; plus de 5 minutes : ignoré
update public.messages set approved_by = 'ea600000-0000-4000-8000-000000000001', approved_at = now(), approved_purpose = 'marketing', approved_recipient = '+212600000001', send_claimed_at = now()
 where id = (select v from fx where k = 'm2');
select pg_temp.as_service();
select throws_ok($$select public.whatsapp_status_apply('eb600000-0000-4000-8000-00000000000a', 'ee600000-0000-4000-8000-000000000001', 'wamid.PAS_ENCORE', 'delivered', null, null)$$, 'P0001', 'retry_later', 'envoi en cours : le statut est réessayé, pas perdu');
reset role;
update public.messages set send_claimed_at = now() - interval '10 minutes' where id in (select v from fx where k in ('m1', 'm2'));
select pg_temp.as_service();
select is((select (public.whatsapp_status_apply('eb600000-0000-4000-8000-00000000000a', 'ee600000-0000-4000-8000-000000000001', 'wamid.PAS_ENCORE', 'delivered', null, null)) ->> 'reason'), 'message_not_found', 'tentative de plus de 5 minutes : ignoré');
reset role;

-- une version plus récente du modèle rend la version approuvée obsolète : la réclamation la voit « superseded » (l'envoi serait refusé)
select pg_temp.as_service();
select public.message_templates_sync('eb600000-0000-4000-8000-00000000000a', 'ef600000-0000-4000-8000-000000000001', '[{"name": "offre_ete", "language": "fr", "category": "marketing", "status": "approved", "components": [{"type": "BODY", "text": "Texte entièrement nouveau {{1}}"}]}]'::jsonb);
reset role;
select is((select max(version) from public.message_templates where name = 'offre_ete' and organization_id = 'eb600000-0000-4000-8000-00000000000a'), 3, 'une version 3 est créée');
update public.messages set send_claimed_at = null where id = (select v from fx where k = 'm1');
select pg_temp.as_service();
delete from cl;
insert into cl select public.message_send_claim('eb600000-0000-4000-8000-00000000000a', (select v from fx where k = 'm1'));
reset role;
select is((select r #>> '{template,status}' from cl), 'superseded', 'modèle remplacé par une version plus récente : superseded');
select is((select r #>> '{template,text}' from cl), 'Bonjour Nadia, offre limitée', 'le texte rendu approuvé est celui de la version approuvée');
select throws_ok($$update public.messages set template_text = 'Autre texte' where id = (select v from fx where k = 'm1')$$, '23514', null, 'le texte rendu est immuable après l''approbation');

select * from finish();
rollback;
