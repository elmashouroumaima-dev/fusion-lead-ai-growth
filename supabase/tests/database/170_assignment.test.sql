-- J22 — Assignation : règles (rôles, validation, unicité, priorité projet / entreprise), auto_assign_lead (round-robin, rejeu sans
-- double assignation, membre suspendu, aucun éligible, aucune règle, isolation entre entreprises), notifications (une par
-- destinataire, déduplication, lecture limitée au destinataire), audit sans donnée personnelle. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(86);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 sales A · U6 owner B · U7 analyste A · U8 sales A (suspendu plus loin)
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('da000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@as.test', now()
    from generate_series(1, 8) n;
insert into public.organizations (id, name, slug) values
  ('db000000-0000-4000-8000-00000000000a', 'AS Alpha', 'as-alpha-test'),
  ('db000000-0000-4000-8000-00000000000b', 'AS Beta', 'as-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000005', 'sales_agent', 'active'),
  ('db000000-0000-4000-8000-00000000000b', 'da000000-0000-4000-8000-000000000006', 'company_owner', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000007', 'analyst', 'active'),
  ('db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000008', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('db000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('db000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('dc000000-0000-4000-8000-0000000000a1', 'db000000-0000-4000-8000-00000000000a', 'website_sales', 'AS site', 'active', '{}'),
  ('dc000000-0000-4000-8000-0000000000a2', 'db000000-0000-4000-8000-00000000000a', 'custom', 'AS archivé', 'archived', '{}'),
  ('dc000000-0000-4000-8000-0000000000a3', 'db000000-0000-4000-8000-00000000000a', 'custom', 'AS autre', 'active', '{}'),
  ('dc000000-0000-4000-8000-0000000000b1', 'db000000-0000-4000-8000-00000000000b', 'custom', 'AS beta', 'active', '{}');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized)
  select ('dd000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'db000000-0000-4000-8000-00000000000a', 'Contact ' || n, 'c' || n || '@as.test', 'c' || n || '@as.test'
    from generate_series(1, 12) n;
insert into public.contacts (id, organization_id, name, email_raw, email_normalized) values
  ('dd000000-0000-4000-8000-0000000000b1', 'db000000-0000-4000-8000-00000000000b', 'Contact B', 'cb@as.test', 'cb@as.test');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
grant execute on function pg_temp.as_service() to public;
-- lead « non assigné » (comme la capture publique) pour le contact n du projet donné
create function pg_temp.mk_lead(p_contact int, p_project text) returns uuid language plpgsql as $f$
declare
  v_id uuid;
  v_stage uuid;
begin
  select s.id into v_stage from public.pipeline_stages s
    join public.pipelines p on p.organization_id = s.organization_id and p.id = s.pipeline_id
   where p.organization_id = 'db000000-0000-4000-8000-00000000000a' and p.is_default and s.kind = 'unassigned';
  insert into public.leads (organization_id, contact_id, project_id, source, stage_id)
  values ('db000000-0000-4000-8000-00000000000a', ('dd000000-0000-4000-8000-0000000000' || lpad(p_contact::text, 2, '0'))::uuid, p_project::uuid, 'web_form', v_stage)
  returning id into v_id;
  return v_id;
end $f$;
grant execute on function pg_temp.mk_lead(int, text) to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'assignment_rules', 'assignment_rules existe');
select has_table('public', 'notifications', 'notifications existe');
select ok((select relrowsecurity from pg_class where oid = 'public.assignment_rules'::regclass), 'RLS activée sur assignment_rules');
select ok((select relrowsecurity from pg_class where oid = 'public.notifications'::regclass), 'RLS activée sur notifications');
select ok(not has_table_privilege('authenticated', 'public.assignment_rules', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur les règles');
select ok(not has_table_privilege('authenticated', 'public.notifications', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur les notifications');
select ok(not has_table_privilege('service_role', 'public.assignment_rules', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur les règles');
select ok(not has_table_privilege('service_role', 'public.notifications', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur les notifications');
select ok(not has_table_privilege('anon', 'public.assignment_rules', 'select,insert,update,delete'), 'anon : aucun droit sur les règles');
select ok(not has_table_privilege('anon', 'public.notifications', 'select,insert,update,delete'), 'anon : aucun droit sur les notifications');
select ok(has_function_privilege('service_role', 'public.auto_assign_lead(uuid, uuid)', 'execute'), 'service_role : auto_assign_lead exécutable');
select ok(not has_function_privilege('authenticated', 'public.auto_assign_lead(uuid, uuid)', 'execute'), 'authenticated : auto_assign_lead non exécutable');
select ok(not has_function_privilege('anon', 'public.auto_assign_lead(uuid, uuid)', 'execute'), 'anon : auto_assign_lead non exécutable');
select ok(not has_function_privilege('authenticated', 'public.flag_lead_unassigned(uuid, uuid)', 'execute'), 'authenticated : flag_lead_unassigned non exécutable');
select ok(not has_function_privilege('service_role', 'public.create_assignment_rule(uuid, uuid, text, uuid[])', 'execute'), 'service_role : create_assignment_rule non exécutable');
select ok(not has_function_privilege('anon', 'public.mark_notification_read(uuid, uuid)', 'execute'), 'anon : mark_notification_read non exécutable');

-- 2. Règles : rôles et validation ------------------------------------------------------------------------------------
select pg_temp.as_user('da000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, '42501', null, 'commercial : ne crée pas de règle');
select pg_temp.as_user('da000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, '42501', null, 'marketing : ne crée pas de règle');
select pg_temp.as_user('da000000-0000-4000-8000-000000000007');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, '42501', null, 'analyste : ne crée pas de règle');
select pg_temp.as_user('da000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000006']::uuid[])$$, '42501', null, 'owner d''une AUTRE entreprise : refusé');
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000003']::uuid[])$$, 'P0001', null, 'membre marketing : pas assignable');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000006']::uuid[])$$, 'P0001', null, 'membre d''une autre entreprise : pas assignable');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000004']::uuid[])$$, '22023', null, 'doublons refusés');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'fixed', array['da000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000005']::uuid[])$$, '22023', null, 'fixed : un seul membre');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array[array['da000000-0000-4000-8000-000000000004'], array['da000000-0000-4000-8000-000000000005']]::uuid[])$$, '22023', null, 'tableau à deux dimensions : refusé (validation, pas erreur interne)');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000004', null]::uuid[])$$, '22023', null, 'NULL dans la liste : refusé');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'random', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, '22023', null, 'stratégie inconnue refusée');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array[]::uuid[])$$, '22023', null, 'aucun membre : refusé');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', 'dc000000-0000-4000-8000-0000000000b1', 'fixed', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, 'PT404', null, 'projet d''une autre entreprise : introuvable');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', 'dc000000-0000-4000-8000-0000000000a2', 'fixed', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, 'P0001', null, 'projet archivé : refusé');
-- règle par défaut round-robin [U4, U5] créée par l'owner
select set_config('t.rule_default', public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'round_robin', array['da000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000005']::uuid[])::text, true);
select ok(current_setting('t.rule_default')::uuid is not null, 'owner : crée la règle par défaut');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'fixed', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, 'P0001', null, 'une seule règle par défaut active');
select pg_temp.as_user('da000000-0000-4000-8000-000000000002');
select set_config('t.rule_a1', public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', 'dc000000-0000-4000-8000-0000000000a1', 'fixed', array['da000000-0000-4000-8000-000000000005']::uuid[])::text, true);
select ok(current_setting('t.rule_a1')::uuid is not null, 'admin : crée la règle du projet A1 (fixed U5)');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', 'dc000000-0000-4000-8000-0000000000a1', 'fixed', array['da000000-0000-4000-8000-000000000004']::uuid[])$$, 'P0001', null, 'une seule règle active par projet');
reset role;

-- 3. Lecture des règles ----------------------------------------------------------------------------------------------
select pg_temp.as_user('da000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.assignment_rules), 2, 'admin : lit les 2 règles');
select pg_temp.as_user('da000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.assignment_rules), 0, 'commercial : ne lit aucune règle');
select pg_temp.as_user('da000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.assignment_rules), 0, 'marketing : ne lit aucune règle');
select pg_temp.as_user('da000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.assignment_rules), 0, 'owner d''une autre entreprise : ne lit aucune règle');
reset role;

-- 4. Assignation : round-robin, rejeu, priorité du projet --------------------------------------------------------------
select set_config('t.l1', pg_temp.mk_lead(1, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
select set_config('t.l2', pg_temp.mk_lead(2, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
select set_config('t.l3', pg_temp.mk_lead(3, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
select set_config('t.l4', pg_temp.mk_lead(4, 'dc000000-0000-4000-8000-0000000000a1')::text, true);
select pg_temp.as_service();
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid) ->> 'outcome'), 'assigned', 'lead 1 (règle par défaut) : assigné');
select is((select assignee_id::text from public.leads where id = current_setting('t.l1')::uuid), 'da000000-0000-4000-8000-000000000004', 'lead 1 : premier membre de la liste (U4)');
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid) ->> 'assignee_id'), 'da000000-0000-4000-8000-000000000005', 'lead 2 : membre suivant (U5)');
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l3')::uuid) ->> 'assignee_id'), 'da000000-0000-4000-8000-000000000004', 'lead 3 : retour au début (U4)');
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l4')::uuid) ->> 'assignee_id'), 'da000000-0000-4000-8000-000000000005', 'lead du projet A1 : la règle du PROJET prime (fixed U5)');
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid) ->> 'outcome'), 'skipped', 'rejeu du lead 1 : ignoré');
select is((select assignee_id::text from public.leads where id = current_setting('t.l1')::uuid), 'da000000-0000-4000-8000-000000000004', 'rejeu : le responsable ne change pas');
reset role;
select is((select cursor from public.assignment_rules where id = current_setting('t.rule_default')::uuid), 1, 'curseur : avancé de trois crans modulo 2, inchangé par le rejeu');
select is((select s.kind::text from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = current_setting('t.l1')::uuid), 'open', 'lead assigné : étape ouverte');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l1')::uuid and type = 'assignment' and owner_id is null), 1, 'journal : une entrée d''assignation, acteur système');

-- 5. Membre suspendu : sauté ---------------------------------------------------------------------------------------------
update public.assignment_rules set cursor = 1 where id = current_setting('t.rule_default')::uuid;
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select public.update_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_default')::uuid, 'round_robin', array['da000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000005']::uuid[], true);
select throws_ok($$select public.update_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_default')::uuid, 'round_robin', array['da000000-0000-4000-8000-000000000003']::uuid[], true)$$, 'P0001', null, 'mise à jour : membre non assignable refusé');
reset role;
select is((select cursor from public.assignment_rules where id = current_setting('t.rule_default')::uuid), 1, 'mise à jour sans changement de stratégie ni de membres : le curseur est conservé');
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select public.update_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_default')::uuid, 'round_robin',
  array['da000000-0000-4000-8000-000000000008', 'da000000-0000-4000-8000-000000000004']::uuid[], true);
reset role;
select is((select cursor from public.assignment_rules where id = current_setting('t.rule_default')::uuid), 0, 'mise à jour : le curseur repart de zéro');
update public.organization_members set status = 'suspended' where organization_id = 'db000000-0000-4000-8000-00000000000a' and user_id = 'da000000-0000-4000-8000-000000000008';
select set_config('t.l5', pg_temp.mk_lead(5, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
select pg_temp.as_service();
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l5')::uuid) ->> 'assignee_id'), 'da000000-0000-4000-8000-000000000004', 'membre suspendu en tête de liste : sauté, le suivant est choisi');
reset role;

-- 6. Aucun éligible : le lead reste dans la file « non assignés », alerte, une seule par lead -----------------------------------
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select public.update_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_default')::uuid, 'fixed',
  array['da000000-0000-4000-8000-000000000004']::uuid[], true);
reset role;
update public.organization_members set status = 'suspended' where organization_id = 'db000000-0000-4000-8000-00000000000a' and user_id = 'da000000-0000-4000-8000-000000000004';
select set_config('t.l6', pg_temp.mk_lead(6, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
select pg_temp.as_service();
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l6')::uuid))::text,
  '{"reason": "no_eligible", "outcome": "unassigned"}'::jsonb::text, 'aucun membre éligible actif : « unassigned / no_eligible »');
reset role;
select is((select count(*)::int from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = current_setting('t.l6')::uuid and s.kind = 'unassigned' and l.assignee_id is null), 1, 'le lead reste dans la file « non assignés »');
select is((select count(*)::int from public.notifications where payload ->> 'lead_id' = current_setting('t.l6') and kind = 'lead.unassigned'), 2, 'alerte : une par owner / admin actif (2)');
select is((select count(*)::int from public.notifications where payload ->> 'lead_id' = current_setting('t.l6') and recipient_id in ('da000000-0000-4000-8000-000000000003', 'da000000-0000-4000-8000-000000000004', 'da000000-0000-4000-8000-000000000005')), 0, 'alerte : ni marketing ni commerciaux');
select pg_temp.as_service();
select public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l6')::uuid);
select public.flag_lead_unassigned('db000000-0000-4000-8000-00000000000a', current_setting('t.l6')::uuid);
reset role;
select is((select count(*)::int from public.notifications where payload ->> 'lead_id' = current_setting('t.l6')), 2, 'rejeu et alerte du worker : aucune notification en double');
select is((select payload::text from public.notifications where payload ->> 'lead_id' = current_setting('t.l6') limit 1), format('{"reason": "no_eligible", "lead_id": "%s"}', current_setting('t.l6')), 'charge utile : identifiant et motif seulement');

-- 7. Aucune règle -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select public.delete_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_default')::uuid);
select public.update_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_a1')::uuid, 'fixed', array['da000000-0000-4000-8000-000000000005']::uuid[], false);
select throws_ok($$select public.delete_assignment_rule('db000000-0000-4000-8000-00000000000a', gen_random_uuid())$$, 'PT404', null, 'règle inconnue : introuvable');
reset role;
select set_config('t.l7', pg_temp.mk_lead(7, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
select set_config('t.l8', pg_temp.mk_lead(8, 'dc000000-0000-4000-8000-0000000000a1')::text, true);
select pg_temp.as_service();
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l7')::uuid) ->> 'reason'), 'no_rule', 'aucune règle (par défaut supprimée) : « no_rule »');
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l8')::uuid) ->> 'reason'), 'no_rule', 'règle du projet désactivée : « no_rule »');
reset role;
select is((select count(*)::int from public.notifications where payload ->> 'lead_id' = current_setting('t.l7')), 2, 'sans règle : alerte aux 2 admins');

-- 8. Isolation entre entreprises ---------------------------------------------------------------------------------------------
select pg_temp.as_service();
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000b', current_setting('t.l7')::uuid) ->> 'reason'), 'not_found', 'lead d''une autre entreprise : introuvable');
select is(public.flag_lead_unassigned('db000000-0000-4000-8000-00000000000b', current_setting('t.l7')::uuid), false, 'alerte pour un lead d''une autre entreprise : refusée');
select is(public.flag_lead_unassigned('db000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid), false, 'alerte pour un lead déjà assigné : refusée');
select is(public.flag_lead_unassigned('db000000-0000-4000-8000-00000000000a', current_setting('t.l7')::uuid), true, 'alerte pour un lead non assigné de l''entreprise : posée');
select throws_ok($$select public.auto_assign_lead(null, null)$$, '22023', null, 'entreprise ou lead absent : refusé');
reset role;
select is((select count(*)::int from public.notifications where organization_id = 'db000000-0000-4000-8000-00000000000b'), 0, 'aucune notification dans l''entreprise B');

-- 9. Projet archivé : lead laissé tel quel ------------------------------------------------------------------------------------
select set_config('t.l9', pg_temp.mk_lead(9, 'dc000000-0000-4000-8000-0000000000a3')::text, true);
update public.projects set status = 'archived' where id = 'dc000000-0000-4000-8000-0000000000a3';
select pg_temp.as_service();
select is((public.auto_assign_lead('db000000-0000-4000-8000-00000000000a', current_setting('t.l9')::uuid) ->> 'reason'), 'project_archived', 'projet archivé : lead ignoré');
reset role;
update public.projects set status = 'active' where id = 'dc000000-0000-4000-8000-0000000000a3';

-- 10. Notifications : lecture limitée au destinataire, marquage « lu » ------------------------------------------------------------
select pg_temp.as_user('da000000-0000-4000-8000-000000000002');
select ok((select count(*)::int from public.notifications) > 0, 'admin : lit ses notifications');
select is((select count(*)::int from public.notifications where recipient_id <> auth.uid()), 0, 'admin : ne lit que les siennes');
select set_config('t.notif', (select id::text from public.notifications order by created_at, id limit 1), true);
select lives_ok($$select public.mark_notification_read('db000000-0000-4000-8000-00000000000a', current_setting('t.notif')::uuid)$$, 'admin : marque sa notification « lue »');
select ok((select read_at is not null from public.notifications where id = current_setting('t.notif')::uuid), 'read_at renseigné');
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select throws_ok($$select public.mark_notification_read('db000000-0000-4000-8000-00000000000a', current_setting('t.notif')::uuid)$$, 'PT404', null, 'owner : ne marque pas la notification de l''admin');
select pg_temp.as_user('da000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.notifications), 0, 'commercial : ne lit aucune notification');
select pg_temp.as_user('da000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.notifications), 0, 'marketing : ne lit aucune notification');
select pg_temp.as_user('da000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.notifications), 0, 'owner d''une autre entreprise : ne lit aucune notification');
reset role;

-- 10b. Abonnement suspendu : création et réactivation refusées ; plafond de notifications : évincement des lues -------------------------
update public.subscriptions set status = 'suspended' where organization_id = 'db000000-0000-4000-8000-00000000000a';
select pg_temp.as_user('da000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_assignment_rule('db000000-0000-4000-8000-00000000000a', null, 'fixed', array['da000000-0000-4000-8000-000000000005']::uuid[])$$, 'P0001', null, 'abonnement suspendu : création refusée');
select throws_ok($$select public.update_assignment_rule('db000000-0000-4000-8000-00000000000a', current_setting('t.rule_a1')::uuid, 'fixed', array['da000000-0000-4000-8000-000000000005']::uuid[], true)$$, 'P0001', null, 'abonnement suspendu : réactivation refusée');
reset role;
update public.subscriptions set status = 'active' where organization_id = 'db000000-0000-4000-8000-00000000000a';
insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key, read_at)
  select 'db000000-0000-4000-8000-00000000000a', 'da000000-0000-4000-8000-000000000001', 'lead.unassigned', '{}'::jsonb, 'fill:' || n, now() - interval '1 day'
    from generate_series(1, 10000) n;
select is(private.notify_lead_unassigned('db000000-0000-4000-8000-00000000000a', current_setting('t.l9')::uuid, 'no_rule'), 2, 'plafond atteint : les notifications lues les plus anciennes sont évincées, la nouvelle alerte est créée');
select ok((select count(*) from public.notifications where organization_id = 'db000000-0000-4000-8000-00000000000a') <= 10000, 'le plafond de 10 000 notifications tient');

-- 11. Audit : identifiants seulement, acteur système pour l'assignation automatique ----------------------------------------------------
select ok((select count(*) from public.audit_logs where action = 'assignment_rule.created' and organization_id = 'db000000-0000-4000-8000-00000000000a') >= 2, 'audit : assignment_rule.created');
select ok(exists (select 1 from public.audit_logs where action = 'assignment_rule.deleted'), 'audit : assignment_rule.deleted');
select ok(exists (select 1 from public.audit_logs where action = 'assignment_rule.updated'), 'audit : assignment_rule.updated');
select ok(exists (select 1 from public.audit_logs where action = 'lead.auto_assigned' and actor_kind = 'system' and entity_id = current_setting('t.l1')::uuid), 'audit : lead.auto_assigned (acteur système)');
select is((select count(*)::int from public.audit_logs where action like 'lead.auto_assigned' and (after::text like '%@%' or after::text like '%Contact%')), 0, 'audit : aucune donnée de contact');

select * from finish();
rollback;
