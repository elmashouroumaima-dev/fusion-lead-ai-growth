-- J19 — Pipelines, leads et deals : structure, droits, étapes par défaut, contraintes, déclencheurs, rôles, lecture « own »,
-- assignation, étapes, deals, libération des leads, contacts du commercial, audit. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(182);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyst A · U6 owner B · U7 sans adhésion · U8 sales A (second)
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('9a000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@ld.test', now()
    from generate_series(1, 8) n;
insert into public.organizations (id, name, slug) values
  ('9b000000-0000-4000-8000-00000000000a', 'LD Alpha', 'ld-alpha-test'),
  ('9b000000-0000-4000-8000-00000000000b', 'LD Beta', 'ld-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('9b000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('9b000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('9b000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('9b000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('9b000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('9b000000-0000-4000-8000-00000000000a', '9a000000-0000-4000-8000-000000000008', 'sales_agent', 'active'),
  ('9b000000-0000-4000-8000-00000000000b', '9a000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status)
  select o, (select id from public.plans where code = 'growth'), 'active'
  from unnest(array['9b000000-0000-4000-8000-00000000000a', '9b000000-0000-4000-8000-00000000000b']::uuid[]) as o;
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('9c000000-0000-4000-8000-0000000000a1', '9b000000-0000-4000-8000-00000000000a', 'website_sales', 'LD site', 'active', '{}'),
  ('9c000000-0000-4000-8000-0000000000a2', '9b000000-0000-4000-8000-00000000000a', 'custom', 'LD archivé', 'archived', '{}'),
  ('9c000000-0000-4000-8000-0000000000b1', '9b000000-0000-4000-8000-00000000000b', 'custom', 'LD beta', 'active', '{}');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('9d000000-0000-4000-8000-0000000000c1', '9b000000-0000-4000-8000-00000000000a', 'C1', 'c1@ld.test', 'c1@ld.test', '+212600000001'),
  ('9d000000-0000-4000-8000-0000000000c2', '9b000000-0000-4000-8000-00000000000a', 'C2', 'c2@ld.test', 'c2@ld.test', '+212600000002'),
  ('9d000000-0000-4000-8000-0000000000c3', '9b000000-0000-4000-8000-00000000000a', 'C3', 'c3@ld.test', 'c3@ld.test', '+212600000003'),
  ('9d000000-0000-4000-8000-0000000000cb', '9b000000-0000-4000-8000-00000000000b', 'CB', 'cb@ld.test', 'cb@ld.test', '+212600000009');
-- consentement actif sur C1 (pour les révocations du commercial)
insert into public.consent_events (organization_id, contact_id, channel, purpose, source)
  values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', 'email', 'marketing', 'manual');

-- Identifiants des étapes d'Alpha (pipeline par défaut) et de Beta, gardés dans des réglages de transaction
select set_config('t.sa_un', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a' and kind = 'unassigned'), true);
select set_config('t.sa_new', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a' and position = 10), true);
select set_config('t.sa_qual', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a' and position = 20), true);
select set_config('t.sa_prop', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a' and position = 30), true);
select set_config('t.sa_won', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a' and kind = 'won'), true);
select set_config('t.sa_lost', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a' and kind = 'lost'), true);
select set_config('t.sb_un', (select id::text from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000b' and kind = 'unassigned'), true);
select set_config('t.pa', (select id::text from public.pipelines where organization_id = '9b000000-0000-4000-8000-00000000000a'), true);

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'pipelines', 'pipelines existe');
select has_table('public', 'pipeline_stages', 'pipeline_stages existe');
select has_table('public', 'leads', 'leads existe');
select has_table('public', 'deals', 'deals existe');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.pipelines'::regclass, 'public.pipeline_stages'::regclass, 'public.leads'::regclass, 'public.deals'::regclass)), 'RLS activée sur les quatre tables');
select is(enum_range(null::public.stage_kind)::text[], array['open', 'won', 'lost', 'unassigned'], 'genres d''étape : open, won, lost, unassigned');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('pipelines', 'pipeline_stages', 'leads', 'deals')), 4, 'une seule politique (lecture) par table');
select ok(not has_table_privilege('authenticated', 'public.leads', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur leads');
select ok(not has_table_privilege('authenticated', 'public.deals', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur deals');
select ok(not has_table_privilege('authenticated', 'public.pipelines', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur pipelines');
select ok(not has_table_privilege('authenticated', 'public.pipeline_stages', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur pipeline_stages');
select ok(not has_table_privilege('service_role', 'public.leads', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur leads');
select ok(not has_table_privilege('service_role', 'public.deals', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur deals');
select ok(not has_table_privilege('anon', 'public.leads', 'select,insert,update,delete'), 'anon : aucun droit sur leads');
select ok(not has_table_privilege('anon', 'public.pipeline_stages', 'select,insert,update,delete'), 'anon : aucun droit sur pipeline_stages');
select ok(not has_function_privilege('anon', 'public.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text)', 'execute'), 'anon : create_lead non exécutable');
select ok(not has_function_privilege('service_role', 'public.move_deal_stage(uuid, uuid, uuid)', 'execute'), 'service_role : move_deal_stage non exécutable');
select ok(not has_function_privilege('authenticated', 'private.lock_lead_for_write(uuid, uuid)', 'execute'), 'authenticated : lock_lead_for_write non exécutable');

-- 2. Étapes par défaut -------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.pipelines where organization_id = '9b000000-0000-4000-8000-00000000000a' and is_default), 1, 'une entreprise : un pipeline par défaut');
select is((select array_agg(kind::text order by position) from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a'), array['unassigned', 'open', 'open', 'open', 'won', 'lost'], 'étapes par défaut : unassigned, 3 ouvertes, won, lost');
select is((select array_agg(name order by position) from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000a'), array['Non assigné', 'Nouveau', 'Qualifié', 'Proposition', 'Gagné', 'Perdu'], 'noms par défaut en français');
insert into public.organizations (id, name, slug, locale) values
  ('9b000000-0000-4000-8000-0000000000e1', 'LD English', 'ld-english-test', 'en'),
  ('9b000000-0000-4000-8000-0000000000e2', 'LD Arabic', 'ld-arabic-test', 'ar');
select is((select array_agg(name order by position) from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-0000000000e1'), array['Unassigned', 'New', 'Qualified', 'Proposal', 'Won', 'Lost'], 'entreprise anglaise : noms en anglais');
select is((select name from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-0000000000e2' and kind = 'won'), 'مكسوب', 'entreprise arabe : noms en arabe');
select is((select count(*)::int from public.audit_logs where action in ('pipeline.created', 'stage.created') and organization_id in ('9b000000-0000-4000-8000-00000000000a', '9b000000-0000-4000-8000-0000000000e1')), 0, 'création système des étapes : aucune entrée d''audit');

-- 3. Contraintes (sous le propriétaire : seule la base juge) ------------------------------------------------------------
select throws_ok($$insert into public.pipelines (organization_id, name, is_default) values ('9b000000-0000-4000-8000-00000000000a', 'Autre', true)$$, '23505', null, 'deux pipelines par défaut : refusé');
select throws_ok($$insert into public.pipelines (organization_id, name) values ('9b000000-0000-4000-8000-00000000000a', 'Pipeline commercial')$$, '23505', null, 'nom de pipeline en double : refusé');
select throws_ok($$insert into public.pipeline_stages (organization_id, pipeline_id, name, position, kind) values ('9b000000-0000-4000-8000-00000000000a', current_setting('t.pa')::uuid, 'Seconde système', 5, 'unassigned')$$, '23505', null, 'deux étapes système dans un pipeline : refusé');
select throws_ok($$insert into public.pipeline_stages (organization_id, pipeline_id, name, position, kind) values ('9b000000-0000-4000-8000-00000000000a', current_setting('t.pa')::uuid, 'Nouveau', 5, 'open')$$, '23505', null, 'nom d''étape en double : refusé');
select throws_ok($$insert into public.pipeline_stages (organization_id, pipeline_id, name, position, kind) values ('9b000000-0000-4000-8000-00000000000a', current_setting('t.pa')::uuid, 'Hors borne', 2000000, 'open')$$, '23514', null, 'position hors borne : refusée');
select throws_ok($$insert into public.pipeline_stages (organization_id, pipeline_id, name, position, kind) values ('9b000000-0000-4000-8000-00000000000b', current_setting('t.pa')::uuid, 'Autre entreprise', 5, 'open')$$, '23503', null, 'étape visant le pipeline d''une autre entreprise : refusée (FK composite)');
select throws_ok($$update public.pipeline_stages set kind = 'won' where id = current_setting('t.sa_new')::uuid$$, '23514', null, 'le genre d''une étape est immuable');
select throws_ok($$delete from public.pipeline_stages where id = current_setting('t.sa_un')::uuid$$, '23514', null, 'l''étape système ne se supprime pas');
select lives_ok($$insert into public.leads (id, organization_id, contact_id, project_id, source, stage_id) values ('9e000000-0000-4000-8000-0000000000f1', '9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_un')::uuid)$$, 'lead valide inséré (fixture directe)');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000b1', 'manual', current_setting('t.sa_un')::uuid)$$, '23503', null, 'lead visant le projet d''une autre entreprise : refusé');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000cb', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_un')::uuid)$$, '23503', null, 'lead visant le contact d''une autre entreprise : refusé');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sb_un')::uuid)$$, '23503', null, 'lead visant l''étape d''une autre entreprise : refusé');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id, assignee_id) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_new')::uuid, '9a000000-0000-4000-8000-000000000006')$$, '23503', null, 'responsable membre d''une autre entreprise : refusé');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id, assignee_id) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_un')::uuid, '9a000000-0000-4000-8000-000000000004')$$, '23514', null, 'étape « non assigné » avec un responsable : refusé');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id, score) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_un')::uuid, 101)$$, '23514', null, 'score hors 0 à 100 : refusé');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'Web Form', current_setting('t.sa_un')::uuid)$$, '23514', null, 'source mal formée : refusée');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id, utm) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_un')::uuid, '{"cookie": "x"}')$$, '23514', null, 'UTM : clé inconnue refusée');
select throws_ok($$insert into public.leads (organization_id, contact_id, project_id, source, stage_id, utm) values ('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'manual', current_setting('t.sa_un')::uuid, '{"utm_source": 5}')$$, '23514', null, 'UTM : valeur non textuelle refusée');
select throws_ok($$update public.leads set contact_id = '9d000000-0000-4000-8000-0000000000c2' where id = '9e000000-0000-4000-8000-0000000000f1'$$, '23514', null, 'le contact d''un lead est immuable');
select throws_ok($$update public.leads set project_id = '9c000000-0000-4000-8000-0000000000a2' where id = '9e000000-0000-4000-8000-0000000000f1'$$, '23514', null, 'le projet d''un lead est immuable');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) values ('9b000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-0000000000f1', current_setting('t.sa_new')::uuid, -1, 'MAD')$$, '23514', null, 'valeur négative : refusée');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) values ('9b000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-0000000000f1', current_setting('t.sa_new')::uuid, 10, 'mad')$$, '23514', null, 'devise en minuscules : refusée');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) values ('9b000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-0000000000f1', current_setting('t.sa_un')::uuid, 10, 'MAD')$$, '23514', null, 'deal dans l''étape système : refusé');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) values ('9b000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-0000000000f1', current_setting('t.sa_won')::uuid, 10, 'MAD')$$, '23514', null, 'deal gagné sans date de gain : refusé');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency, won_at) values ('9b000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-0000000000f1', current_setting('t.sa_new')::uuid, 10, 'MAD', now())$$, '23514', null, 'deal ouvert avec une date de gain : refusé');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency, won_at, lost_at) values ('9b000000-0000-4000-8000-00000000000a', '9e000000-0000-4000-8000-0000000000f1', current_setting('t.sa_won')::uuid, 10, 'MAD', now(), now())$$, '23514', null, 'gagné ET perdu : refusé');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) values ('9b000000-0000-4000-8000-00000000000b', '9e000000-0000-4000-8000-0000000000f1', (select id from public.pipeline_stages where organization_id = '9b000000-0000-4000-8000-00000000000b' and kind = 'open' limit 1), 10, 'MAD')$$, '23503', null, 'deal visant le lead d''une autre entreprise : refusé (FK composite)');
delete from public.leads where id = '9e000000-0000-4000-8000-0000000000f1';

-- 4. Création de leads : rôles, projet, responsable, étape initiale ------------------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select lives_ok($$select set_config('t.l1', public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'web_form', null, 40, '{"raison": "budget"}', '{"utm_source": "newsletter", "landing_page_id": "lp-1"}', null, null)::text, true)$$, 'marketing : crée un lead sans responsable');
select is((select stage_id::text from public.leads where id = current_setting('t.l1')::uuid), current_setting('t.sa_un'), 'sans responsable : étape « non assigné »');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000002');
select lives_ok($$select set_config('t.l2', public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c2', '9c000000-0000-4000-8000-0000000000a1', 'manual', '9a000000-0000-4000-8000-000000000004', null, '{}', '{}', null, null)::text, true)$$, 'admin : crée un lead avec un commercial responsable');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select is((select stage_id::text from public.leads where id = current_setting('t.l2')::uuid), current_setting('t.sa_new'), 'avec responsable : première étape ouverte');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000002');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', '9a000000-0000-4000-8000-000000000003', null, '{}', '{}', null, null)$$, 'P0001', 'assignee_invalid', 'responsable marketing : refusé');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', '9a000000-0000-4000-8000-000000000006', null, '{}', '{}', null, null)$$, 'P0001', 'assignee_invalid', 'responsable d''une autre entreprise : refusé');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a2', 'manual', null, null, '{}', '{}', null, null)$$, 'P0001', 'project_archived', 'projet archivé : refusé');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000b1', 'manual', null, null, '{}', '{}', null, null)$$, 'PT404', null, 'projet d''une autre entreprise : introuvable');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000cb', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, 'PT404', null, 'contact d''une autre entreprise : introuvable');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, 150, '{}', '{}', null, null)$$, '23514', null, 'score invalide : refusé par la base');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select lives_ok($$select set_config('t.l3', public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'csv_import', null, null, '{}', '{}', 'salla', '42')::text, true)$$, 'owner : crée un lead (identifiant externe)');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', '9c000000-0000-4000-8000-0000000000a1', 'csv_import', null, null, '{}', '{}', 'salla', '42')$$, '23505', null, 'identifiant externe en double : refusé');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000002');
select lives_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, 'admin : crée un lead');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, '42501', null, 'commercial : création refusée (J21)');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000005');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, '42501', null, 'analyste : création refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, '42501', null, 'owner de Beta : création chez Alpha refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000007');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, '42501', null, 'sans adhésion : création refusée');
reset role;

-- 5. Lecture : owner / admin / marketing partout, commercial sur SES leads, analyste rien ---------------------------------
-- Leads d'Alpha : l1 (non assigné), l2 (commercial U4), l3 (non assigné), + un lead créé par l'admin = 4
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.leads), 4, 'owner : voit les 4 leads d''Alpha');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.leads), 4, 'marketing : voit les 4 leads');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select is((select array_agg(id::text) from public.leads), array[current_setting('t.l2')], 'commercial : voit uniquement SON lead');
select is((select array_agg(id::text) from public.contacts), array['9d000000-0000-4000-8000-0000000000c2'], 'commercial : ne voit que le contact de son lead');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000008');
select is((select count(*)::int from public.leads), 0, 'second commercial : aucun lead assigné, aucun lead visible');
select is((select count(*)::int from public.contacts), 0, 'second commercial : aucun contact');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.leads), 0, 'analyste : aucun lead');
select is((select count(*)::int from public.pipeline_stages), 6, 'analyste : voit tout de même les étapes (membre)');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.leads), 0, 'owner de Beta : aucun lead d''Alpha');
select is((select count(*)::int from public.pipeline_stages), 6, 'owner de Beta : uniquement les étapes de Beta');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000007');
select is((select count(*)::int from public.pipelines), 0, 'sans adhésion : aucun pipeline');
reset role;

-- 6. Modification d'un lead -------------------------------------------------------------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select lives_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, 'manual', 70, '{"raison": "demande de démo"}', '{"utm_medium": "email"}')$$, 'commercial : modifie SON lead');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'manual', 70, '{}', '{}')$$, 'PT404', null, 'commercial : le lead d''un autre est introuvable');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000008');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, 'manual', 1, '{}', '{}')$$, 'PT404', null, 'second commercial : lead du premier introuvable');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'manual', 70, '{}', '{}')$$, '42501', null, 'marketing : modification refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000005');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'manual', 70, '{}', '{}')$$, '42501', null, 'analyste : modification refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'manual', 70, '{}', '{}')$$, '42501', null, 'owner de Beta : modification chez Alpha refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'web_form', 55, '{}', '{"utm_source": "newsletter"}')$$, 'owner : modifie un lead');
select is((select score from public.leads where id = current_setting('t.l1')::uuid), 55, 'le score a changé');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'Web Form', 55, '{}', '{}')$$, '23514', null, 'source mal formée refusée');
reset role;

-- 7. Assignation ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, '9a000000-0000-4000-8000-000000000008')$$, 'owner : assigne un lead non assigné');
select is((select stage_id::text from public.leads where id = current_setting('t.l1')::uuid), current_setting('t.sa_new'), 'l''assignation sort le lead de l''étape « non assigné »');
select throws_ok($$select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, '9a000000-0000-4000-8000-000000000005')$$, 'P0001', 'assignee_invalid', 'assignation à un analyste : refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000002');
select lives_ok($$select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, null)$$, 'admin : retire le responsable');
select is((select stage_id::text from public.leads where id = current_setting('t.l1')::uuid), current_setting('t.sa_un'), 'sans responsable : retour à l''étape « non assigné »');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, '9a000000-0000-4000-8000-000000000004')$$, '42501', null, 'marketing : assignation refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, '9a000000-0000-4000-8000-000000000008')$$, '42501', null, 'commercial : ne se dessaisit pas d''un lead (assignation = owner / admin)');
reset role;

-- 8. Changement d'étape ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select lives_ok($$select public.move_lead_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sa_qual')::uuid)$$, 'commercial : change l''étape de SON lead');
select is((select stage_id::text from public.leads where id = current_setting('t.l2')::uuid), current_setting('t.sa_qual'), 'étape « Qualifié »');
select throws_ok($$select public.move_lead_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sa_un')::uuid)$$, '23514', null, 'lead assigné vers l''étape « non assigné » : refusé');
select throws_ok($$select public.move_lead_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sb_un')::uuid)$$, 'PT404', null, 'étape d''une autre entreprise : introuvable');
select throws_ok($$select public.move_lead_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, current_setting('t.sa_new')::uuid)$$, 'PT404', null, 'lead d''un autre commercial : introuvable');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.move_lead_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, current_setting('t.sa_new')::uuid)$$, '42501', null, 'marketing : changement d''étape refusé');
reset role;

-- 9. Deals ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select lives_ok($$select set_config('t.d1', public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, null, 1500.50, 'MAD', '2026-12-31T00:00:00Z')::text, true)$$, 'commercial : crée un deal sur SON lead');
select is((select stage_id::text from public.deals where id = current_setting('t.d1')::uuid), current_setting('t.sa_new'), 'étape par défaut du deal : première étape ouverte');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, null, 10, 'MAD', null)$$, 'PT404', null, 'commercial : deal sur le lead d''un autre introuvable');
select lives_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_won')::uuid)$$, 'commercial : déplace son deal vers « Gagné »');
select ok((select won_at is not null and lost_at is null from public.deals where id = current_setting('t.d1')::uuid), 'gagné : won_at renseigné, lost_at vide');
select lives_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_lost')::uuid)$$, 'deal gagné puis perdu');
select ok((select won_at is null and lost_at is not null from public.deals where id = current_setting('t.d1')::uuid), 'perdu : lost_at renseigné, won_at effacé');
select lives_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_prop')::uuid)$$, 'réouverture du deal');
select ok((select won_at is null and lost_at is null from public.deals where id = current_setting('t.d1')::uuid), 'réouvert : aucune date de clôture');
select throws_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_un')::uuid)$$, '23514', null, 'deal vers l''étape système : refusé');
select lives_ok($$select public.update_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, 2000, 'SAR', null)$$, 'commercial : modifie son deal');
select throws_ok($$select public.update_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, -5, 'SAR', null)$$, '23514', null, 'valeur négative refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000008');
select throws_ok($$select public.update_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, 1, 'MAD', null)$$, 'PT404', null, 'second commercial : deal d''un autre introuvable');
select is((select count(*)::int from public.deals), 0, 'second commercial : aucun deal visible');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, null, 10, 'MAD', null)$$, '42501', null, 'marketing : création de deal refusée');
select is((select count(*)::int from public.deals), 1, 'marketing : voit le deal');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000005');
select throws_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_won')::uuid)$$, '42501', null, 'analyste : refusé');
select is((select count(*)::int from public.deals), 0, 'analyste : aucun deal');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_won')::uuid)$$, '42501', null, 'owner de Beta : refusé');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select lives_ok($$select set_config('t.d2', public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sa_won')::uuid, 99.99, 'EUR', null)::text, true)$$, 'owner : crée un deal directement gagné');
select ok((select won_at is not null from public.deals where id = current_setting('t.d2')::uuid), 'deal créé dans « Gagné » : won_at renseigné');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sb_un')::uuid, 1, 'MAD', null)$$, '22023', null, 'étape d''un autre pipeline / entreprise : refusée');
reset role;

-- 10. Projet archivé : lecture seule ---------------------------------------------------------------------------------------------
update public.projects set status = 'archived' where id = '9c000000-0000-4000-8000-0000000000a1';
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.update_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'manual', 1, '{}', '{}')$$, 'P0001', 'project_archived', 'projet archivé : lead non modifiable');
select throws_ok($$select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, '9a000000-0000-4000-8000-000000000004')$$, 'P0001', 'project_archived', 'projet archivé : assignation refusée');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, null, 1, 'MAD', null)$$, 'P0001', 'project_archived', 'projet archivé : deal non créé');
select throws_ok($$select public.move_deal_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_won')::uuid)$$, 'P0001', 'project_archived', 'projet archivé : deal non déplacé');
reset role;
update public.projects set status = 'active' where id = '9c000000-0000-4000-8000-0000000000a1';

-- 11. Pipelines et étapes configurables (owner / admin) ---------------------------------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000002');
select lives_ok($$select set_config('t.p2', public.create_pipeline('9b000000-0000-4000-8000-00000000000a', 'Partenaires')::text, true)$$, 'admin : crée un pipeline');
select is((select count(*)::int from public.pipeline_stages where pipeline_id = current_setting('t.p2')::uuid), 6, 'un nouveau pipeline reçoit les étapes par défaut');
select throws_ok($$select public.create_pipeline('9b000000-0000-4000-8000-00000000000a', 'Partenaires')$$, '23505', null, 'nom de pipeline en double refusé');
select lives_ok($$select public.rename_pipeline('9b000000-0000-4000-8000-00000000000a', current_setting('t.p2')::uuid, 'Partenaires 2027')$$, 'admin : renomme un pipeline');
select lives_ok($$select set_config('t.s_extra', public.create_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.p2')::uuid, 'Négociation', 'open', null)::text, true)$$, 'admin : ajoute une étape (position par défaut)');
select is((select position from public.pipeline_stages where id = current_setting('t.s_extra')::uuid), 60, 'position par défaut : après la dernière étape');
select lives_ok($$select public.update_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.s_extra')::uuid, 'Négociation finale', 25)$$, 'admin : renomme et repositionne une étape');
select throws_ok($$select public.create_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.p2')::uuid, 'Système bis', 'unassigned', null)$$, '22023', null, 'création d''une étape système : refusée');
select throws_ok($$select public.create_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.p2')::uuid, 'Négociation finale', 'open', null)$$, '23505', null, 'nom d''étape en double refusé');
select throws_ok($$select public.create_stage('9b000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'Fantôme', 'open', null)$$, 'PT404', null, 'pipeline inconnu : introuvable');
select lives_ok($$select public.delete_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.s_extra')::uuid)$$, 'admin : supprime une étape inutilisée');
select throws_ok($$select public.delete_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.sa_qual')::uuid)$$, 'P0001', 'stage_in_use', 'étape utilisée par un lead : suppression refusée');
select throws_ok($$select public.delete_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.sa_un')::uuid)$$, 'P0001', 'system_stage', 'étape système : suppression refusée');
select lives_ok($$select public.delete_stage('9b000000-0000-4000-8000-00000000000a', s.id) from public.pipeline_stages s where s.pipeline_id = current_setting('t.p2')::uuid and s.position in (10, 20)$$, 'admin : supprime deux des trois étapes ouvertes');
select throws_ok($$select public.delete_stage('9b000000-0000-4000-8000-00000000000a', s.id) from public.pipeline_stages s where s.pipeline_id = current_setting('t.p2')::uuid and s.position = 30$$, 'P0001', 'last_open_stage', 'dernière étape ouverte : suppression refusée');
select lives_ok($$select public.set_default_pipeline('9b000000-0000-4000-8000-00000000000a', current_setting('t.p2')::uuid)$$, 'admin : change le pipeline par défaut');
select is((select array_agg(is_default order by is_default) from public.pipelines where organization_id = '9b000000-0000-4000-8000-00000000000a'), array[false, true], 'un seul pipeline par défaut');
select lives_ok($$select public.set_default_pipeline('9b000000-0000-4000-8000-00000000000a', current_setting('t.pa')::uuid)$$, 'retour au pipeline d''origine');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_pipeline('9b000000-0000-4000-8000-00000000000a', 'Marketing')$$, '42501', null, 'marketing : création de pipeline refusée');
select throws_ok($$select public.create_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.pa')::uuid, 'X', 'open', null)$$, '42501', null, 'marketing : création d''étape refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.update_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.sa_new')::uuid, 'Piraté', 10)$$, '42501', null, 'commercial : modification d''étape refusée');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.delete_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.sa_prop')::uuid)$$, '42501', null, 'owner de Beta : suppression chez Alpha refusée');
reset role;

-- 12. Contacts du commercial : révocation / ne-plus-contacter sur SES contacts ----------------------------------------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.contacts), 1, 'commercial : un seul contact visible');
select lives_ok($$select public.set_do_not_contact('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c2', true)$$, 'commercial : pose « ne plus contacter » sur le contact de son lead');
select throws_ok($$select public.set_do_not_contact('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c2', false)$$, '42501', null, 'commercial : ne le retire pas');
select throws_ok($$select public.set_do_not_contact('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', true)$$, '42501', null, 'commercial : refusé sur le contact d''un lead qui n''est pas à lui');
select throws_ok($$select public.revoke_consent('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', 'email', null, true)$$, '42501', null, 'commercial : révocation refusée sur un contact étranger');
reset role;
-- le lead l1 passe au second commercial : il peut alors révoquer le consentement du contact C1
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select public.assign_lead('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, '9a000000-0000-4000-8000-000000000008');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000008');
select is((select public.revoke_consent('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', 'email', null, false)), 1, 'second commercial : révoque le consentement du contact de son lead');
select throws_ok($$select public.record_consent('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c1', 'email', 'marketing', 'manual', '{}')$$, '42501', null, 'commercial : n''enregistre pas de consentement');
reset role;

-- 13. Libération des leads d'un membre retiré --------------------------------------------------------------------------------
update public.organization_members set status = 'removed' where organization_id = '9b000000-0000-4000-8000-00000000000a' and user_id = '9a000000-0000-4000-8000-000000000008';
select is((select assignee_id from public.leads where id = current_setting('t.l1')::uuid), null, 'membre retiré : son lead n''a plus de responsable');
select is((select stage_id::text from public.leads where id = current_setting('t.l1')::uuid), current_setting('t.sa_un'), 'membre retiré : lead ouvert renvoyé à l''étape « non assigné »');

-- 13b. Revue sécurité : responsable à la création, NaN, dates infinies, pipeline du lead, retraits, abonnement -----------------
select pg_temp.as_user('9a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', '9a000000-0000-4000-8000-000000000004', null, '{}', '{}', null, null)$$, '42501', null, 'marketing : ne choisit pas le responsable à la création');
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, null, 'NaN'::numeric, 'MAD', null)$$, '22023', null, 'create_deal : valeur NaN refusée');
select throws_ok($$select public.update_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, 'NaN'::numeric, 'MAD', null)$$, '22023', null, 'update_deal : valeur NaN refusée');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, null, 5, 'MAD', 'infinity'::timestamptz)$$, '23514', null, 'échéance infinie refusée');
select throws_ok($$select public.move_lead_stage('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, (select id from public.pipeline_stages where pipeline_id = current_setting('t.p2')::uuid and kind = 'won'))$$, '22023', null, 'un lead ne change pas de pipeline');
reset role;
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) values ('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sa_new')::uuid, 'NaN'::numeric, 'MAD')$$, '23514', null, 'valeur NaN refusée par la contrainte');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency, expected_close_at) values ('9b000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, current_setting('t.sa_new')::uuid, 1, 'MAD', '-infinity'::timestamptz)$$, '23514', null, 'échéance -infini refusée par la contrainte');

-- rétrogradation de rôle : l'admin U2 reçoit un lead puis devient analyste
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select set_config('t.l5', public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', '9a000000-0000-4000-8000-000000000002', null, '{}', '{}', null, null)::text, true);
reset role;
update public.organization_members set role = 'analyst' where organization_id = '9b000000-0000-4000-8000-00000000000a' and user_id = '9a000000-0000-4000-8000-000000000002';
select is((select assignee_id from public.leads where id = current_setting('t.l5')::uuid), null, 'rôle rétrogradé : le lead est libéré');
select is((select stage_id::text from public.leads where id = current_setting('t.l5')::uuid), current_setting('t.sa_un'), 'rôle rétrogradé : retour à l''étape « non assigné »');
-- suppression de la ligne d'un membre (et non changement de statut) : le lead du commercial U4 est libéré
select ok((select assignee_id is not null from public.leads where id = current_setting('t.l2')::uuid), 'avant retrait : le lead l2 a un responsable');
delete from public.organization_members where organization_id = '9b000000-0000-4000-8000-00000000000a' and user_id = '9a000000-0000-4000-8000-000000000004';
select is((select assignee_id from public.leads where id = current_setting('t.l2')::uuid), null, 'ligne de membre supprimée : le lead est libéré');
select is((select stage_id::text from public.leads where id = current_setting('t.l2')::uuid), current_setting('t.sa_un'), 'ligne de membre supprimée : retour à l''étape « non assigné »');

-- abonnement suspendu : plus de création de pipeline, lead ni deal
update public.subscriptions set status = 'suspended' where organization_id = '9b000000-0000-4000-8000-00000000000a';
select pg_temp.as_user('9a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_lead('9b000000-0000-4000-8000-00000000000a', '9d000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : lead non créé');
select throws_ok($$select public.create_deal('9b000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, null, 5, 'MAD', null)$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : deal non créé');
select throws_ok($$select public.create_pipeline('9b000000-0000-4000-8000-00000000000a', 'Suspendu')$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : pipeline non créé');
reset role;
update public.subscriptions set status = 'active' where organization_id = '9b000000-0000-4000-8000-00000000000a';

-- 14. Audit : identifiants seulement ------------------------------------------------------------------------------------------
select ok((select count(*) from public.audit_logs where action = 'lead.created' and organization_id = '9b000000-0000-4000-8000-00000000000a') >= 4, 'audit : lead.created');
select ok(exists (select 1 from public.audit_logs where action = 'lead.assigned' and entity_id = current_setting('t.l1')::uuid), 'audit : lead.assigned');
select ok(exists (select 1 from public.audit_logs where action = 'lead.stage_changed' and entity_id = current_setting('t.l2')::uuid), 'audit : lead.stage_changed');
select is((select (after -> 'changed') from public.audit_logs where action = 'lead.updated' and entity_id = current_setting('t.l1')::uuid order by created_at desc limit 1), '["score", "score_reason", "utm"]'::jsonb, 'audit : lead.updated ne liste que les NOMS des champs');
select ok(exists (select 1 from public.audit_logs where action = 'deal.won' and entity_id = current_setting('t.d1')::uuid), 'audit : deal.won');
select ok(exists (select 1 from public.audit_logs where action = 'deal.lost' and entity_id = current_setting('t.d1')::uuid), 'audit : deal.lost');
select ok(exists (select 1 from public.audit_logs where action = 'pipeline.created' and entity_id = current_setting('t.p2')::uuid), 'audit : pipeline.created');
select ok(exists (select 1 from public.audit_logs where action = 'stage.deleted' and organization_id = '9b000000-0000-4000-8000-00000000000a'), 'audit : stage.deleted');
select ok(not exists (
  select 1 from public.audit_logs
   where entity_type in ('lead', 'deal') and organization_id = '9b000000-0000-4000-8000-00000000000a'
     and (coalesce(before::text, '') || coalesce(after::text, '')) ~* '(1500|2000|99\.99|newsletter|budget|demande de démo|utm_)'
), 'audit : ni valeur de deal, ni score, ni raison, ni UTM');

select * from finish();
rollback;
