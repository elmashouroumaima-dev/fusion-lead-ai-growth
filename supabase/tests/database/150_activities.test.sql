-- J20 — Activités : structure, droits, contenu par type, immutabilité, journal automatique, rôles, tâches, lecture « own »,
-- projet archivé, abonnement, plafond, audit. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(107);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B · U7 sans adhésion · U8 sales A (second)
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ba000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@ac.test', now()
    from generate_series(1, 8) n;
insert into public.organizations (id, name, slug) values
  ('bb000000-0000-4000-8000-00000000000a', 'AC Alpha', 'ac-alpha-test'),
  ('bb000000-0000-4000-8000-00000000000b', 'AC Beta', 'ac-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('bb000000-0000-4000-8000-00000000000a', 'ba000000-0000-4000-8000-000000000008', 'sales_agent', 'active'),
  ('bb000000-0000-4000-8000-00000000000b', 'ba000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status)
  select o, (select id from public.plans where code = 'growth'), 'active'
  from unnest(array['bb000000-0000-4000-8000-00000000000a', 'bb000000-0000-4000-8000-00000000000b']::uuid[]) as o;
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('bc000000-0000-4000-8000-0000000000a1', 'bb000000-0000-4000-8000-00000000000a', 'website_sales', 'AC site', 'active', '{}'),
  ('bc000000-0000-4000-8000-0000000000a2', 'bb000000-0000-4000-8000-00000000000a', 'custom', 'AC archivé', 'active', '{}'),
  ('bc000000-0000-4000-8000-0000000000b1', 'bb000000-0000-4000-8000-00000000000b', 'custom', 'AC beta', 'active', '{}');
insert into public.contacts (id, organization_id, name, phone_e164) values
  ('bd000000-0000-4000-8000-0000000000c1', 'bb000000-0000-4000-8000-00000000000a', 'C1', '+212600000001'),
  ('bd000000-0000-4000-8000-0000000000c2', 'bb000000-0000-4000-8000-00000000000a', 'C2', '+212600000002'),
  ('bd000000-0000-4000-8000-0000000000c3', 'bb000000-0000-4000-8000-00000000000a', 'C3', '+212600000003'),
  ('bd000000-0000-4000-8000-0000000000c4', 'bb000000-0000-4000-8000-00000000000a', 'C4', '+212600000004'),
  ('bd000000-0000-4000-8000-0000000000cb', 'bb000000-0000-4000-8000-00000000000b', 'CB', '+212600000009');

select set_config('t.sa_un', (select id::text from public.pipeline_stages where organization_id = 'bb000000-0000-4000-8000-00000000000a' and kind = 'unassigned'), true);
select set_config('t.sa_new', (select id::text from public.pipeline_stages where organization_id = 'bb000000-0000-4000-8000-00000000000a' and position = 10), true);
select set_config('t.sa_qual', (select id::text from public.pipeline_stages where organization_id = 'bb000000-0000-4000-8000-00000000000a' and position = 20), true);
select set_config('t.sa_won', (select id::text from public.pipeline_stages where organization_id = 'bb000000-0000-4000-8000-00000000000a' and kind = 'won'), true);

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- Leads : l1 (commercial U4), l2 (non assigné), l3 (commercial U8), l4 (U4, projet qui sera archivé), l5 (U4, 500 activités), lb (Beta)
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select set_config('t.l1', public.create_lead('bb000000-0000-4000-8000-00000000000a', 'bd000000-0000-4000-8000-0000000000c1', 'bc000000-0000-4000-8000-0000000000a1', 'manual', 'ba000000-0000-4000-8000-000000000004', null, '{}', '{}', null, null)::text, true);
select set_config('t.l2', public.create_lead('bb000000-0000-4000-8000-00000000000a', 'bd000000-0000-4000-8000-0000000000c2', 'bc000000-0000-4000-8000-0000000000a1', 'manual', null, null, '{}', '{}', null, null)::text, true);
select set_config('t.l3', public.create_lead('bb000000-0000-4000-8000-00000000000a', 'bd000000-0000-4000-8000-0000000000c3', 'bc000000-0000-4000-8000-0000000000a1', 'manual', 'ba000000-0000-4000-8000-000000000008', null, '{}', '{}', null, null)::text, true);
select set_config('t.l4', public.create_lead('bb000000-0000-4000-8000-00000000000a', 'bd000000-0000-4000-8000-0000000000c1', 'bc000000-0000-4000-8000-0000000000a2', 'manual', 'ba000000-0000-4000-8000-000000000004', null, '{}', '{}', null, null)::text, true);
select set_config('t.l5', public.create_lead('bb000000-0000-4000-8000-00000000000a', 'bd000000-0000-4000-8000-0000000000c4', 'bc000000-0000-4000-8000-0000000000a1', 'manual', 'ba000000-0000-4000-8000-000000000004', null, '{}', '{}', null, null)::text, true);
reset role;
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select set_config('t.lb', public.create_lead('bb000000-0000-4000-8000-00000000000b', 'bd000000-0000-4000-8000-0000000000cb', 'bc000000-0000-4000-8000-0000000000b1', 'manual', null, null, '{}', '{}', null, null)::text, true);
reset role;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'activities', 'activities existe');
select ok((select relrowsecurity from pg_class where oid = 'public.activities'::regclass), 'RLS activée sur activities');
select is(enum_range(null::public.activity_type)::text[], array['note', 'call', 'email', 'task', 'meeting', 'stage_change', 'assignment'], '7 types d''activité (ADR 007)');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'activities'), 1, 'une seule politique (lecture)');
select ok(not has_table_privilege('authenticated', 'public.activities', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe');
select ok(not has_table_privilege('service_role', 'public.activities', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe');
select ok(not has_table_privilege('anon', 'public.activities', 'select,insert,update,delete'), 'anon : aucun droit');
select ok(not has_function_privilege('anon', 'public.create_activity(uuid, uuid, public.activity_type, jsonb, timestamptz, uuid)', 'execute'), 'anon : create_activity non exécutable');
select ok(not has_function_privilege('service_role', 'public.complete_task(uuid, uuid, boolean)', 'execute'), 'service_role : complete_task non exécutable');
select ok(not has_function_privilege('authenticated', 'private.lock_activity_for_write(uuid, uuid)', 'execute'), 'authenticated : lock_activity_for_write non exécutable');

-- 2. Contenu par type et contraintes (sous le propriétaire : seule la base juge) --------------------------------------
select lives_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', '{"text": "Premier contact"}')$$, 'note valide');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', '{}')$$, '23514', null, 'note sans texte : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', '{"text": "x", "autre": 1}')$$, '23514', null, 'note avec clé inconnue : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', jsonb_build_object('text', 'a' || chr(8238) || 'b'))$$, '23514', null, 'note avec caractère de direction : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', jsonb_build_object('text', repeat('a', 2001)))$$, '23514', null, 'note de plus de 2000 caractères : refusée');
select lives_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'call', '{"outcome": "no_answer", "duration_minutes": 0}')$$, 'appel sans réponse valide');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'call', '{"duration_minutes": 5}')$$, '23514', null, 'appel sans texte ni issue : refusé');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'call', '{"outcome": "inconnue"}')$$, '23514', null, 'issue d''appel inconnue : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'call', '{"outcome": "busy", "duration_minutes": 601}')$$, '23514', null, 'durée d''appel de 601 minutes : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'call', '{"outcome": "busy", "duration_minutes": 1.5}')$$, '23514', null, 'durée d''appel non entière : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'email', '{"text": "sans objet"}')$$, '23514', null, 'e-mail sans objet : refusé');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'task', '{"text": "sans titre"}')$$, '23514', null, 'tâche sans titre : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'stage_change', '{"from_stage_id": "x", "to_stage_id": "y"}')$$, '23514', null, 'changement d''étape : identifiants mal formés refusés');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'assignment', '{"to_assignee_id": null}')$$, '23514', null, 'assignation sans « de » : refusée');
select lives_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'assignment', '{"from_assignee_id": null, "to_assignee_id": "ba000000-0000-4000-8000-000000000004"}')$$, 'assignation valide (identifiants ou null)');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, due_at, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', now(), '{"text": "x"}')$$, '23514', null, 'échéance sur une note : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, completed_at, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'note', now(), '{"text": "x"}')$$, '23514', null, 'date de fin sur une note : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, due_at, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'task', 'infinity'::timestamptz, '{"title": "x"}')$$, '23514', null, 'échéance infinie : refusée');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c2', 'note', '{"text": "x"}')$$, '23514', null, 'contact différent de celui du lead : refusé');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, metadata) values ('bb000000-0000-4000-8000-00000000000b', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000cb', 'note', '{"text": "x"}')$$, '23514', null, 'lead d''une autre entreprise : refusé');
select throws_ok($$insert into public.activities (organization_id, lead_id, contact_id, type, owner_id, metadata) values ('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'bd000000-0000-4000-8000-0000000000c1', 'task', 'ba000000-0000-4000-8000-000000000006', '{"title": "x"}')$$, '23503', null, 'responsable membre d''une autre entreprise : refusé');
select throws_ok($$update public.activities set metadata = '{"text": "modifié"}' where type = 'note' and lead_id = current_setting('t.l1')::uuid$$, '23514', null, 'une note ne se modifie pas');
select throws_ok($$update public.activities set type = 'task', metadata = '{"title": "t"}' where type = 'note' and lead_id = current_setting('t.l1')::uuid$$, '23514', null, 'le type ne change pas');
select throws_ok($$delete from public.activities where lead_id = current_setting('t.l1')::uuid$$, '23514', null, 'aucune suppression');
delete from public.activities where false;

-- 3. Journal automatique -----------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.activities where type in ('stage_change', 'assignment') and lead_id = current_setting('t.l2')::uuid), 0, 'création d''un lead : aucune entrée automatique');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000002');
select public.assign_lead('bb000000-0000-4000-8000-00000000000a', current_setting('t.l2')::uuid, 'ba000000-0000-4000-8000-000000000004');
reset role;
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l2')::uuid and type = 'assignment'), 1, 'assignation : une entrée « assignment »');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l2')::uuid and type = 'stage_change'), 1, 'assignation : sortie de l''étape « non assigné » journalisée');
select is((select metadata ->> 'to_assignee_id' from public.activities where lead_id = current_setting('t.l2')::uuid and type = 'assignment'), 'ba000000-0000-4000-8000-000000000004', 'assignation : responsable d''arrivée enregistré');
select is((select owner_id::text from public.activities where lead_id = current_setting('t.l2')::uuid and type = 'assignment'), 'ba000000-0000-4000-8000-000000000002', 'assignation : l''acteur (admin) est l''auteur de l''entrée');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select public.move_lead_stage('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, current_setting('t.sa_qual')::uuid);
select is((select metadata ->> 'to_stage_id' from public.activities where lead_id = current_setting('t.l1')::uuid and type = 'stage_change'), current_setting('t.sa_qual'), 'changement d''étape : étape d''arrivée enregistrée');
select is((select owner_id::text from public.activities where lead_id = current_setting('t.l1')::uuid and type = 'stage_change'), 'ba000000-0000-4000-8000-000000000004', 'changement d''étape par le commercial : il en est l''auteur');
select set_config('t.d1', public.create_deal('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, null, 100, 'MAD', null)::text, true);
select public.move_deal_stage('bb000000-0000-4000-8000-00000000000a', current_setting('t.d1')::uuid, current_setting('t.sa_won')::uuid);
reset role;
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l1')::uuid and type = 'stage_change' and metadata ->> 'deal_id' = current_setting('t.d1')), 1, 'changement d''étape d''un deal : entrée avec deal_id');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l1')::uuid and type = 'stage_change'), 2, 'lead + deal : deux entrées « stage_change » sur ce lead');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'stage_change', '{"from_stage_id": "bd000000-0000-4000-8000-0000000000c1", "to_stage_id": "bd000000-0000-4000-8000-0000000000c1"}', null, null)$$, '22023', null, 'stage_change ne se crée pas à la main');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'assignment', '{"from_assignee_id": null, "to_assignee_id": null}', null, null)$$, '22023', null, 'assignment ne se crée pas à la main');
reset role;

-- 4. Création manuelle : rôles et règles ----------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select lives_ok($$select set_config('t.a_note', public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l3')::uuid, 'note', '{"text": "Note de l''owner SECRET-TEXTE"}', null, null)::text, true)$$, 'owner : crée une note sur n''importe quel lead');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000002');
select lives_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l3')::uuid, 'call', '{"outcome": "answered", "duration_minutes": 12, "text": "Intéressé"}', null, null)$$, 'admin : journalise un appel');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select lives_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'email', '{"subject": "Offre envoyée", "text": "Compte rendu"}', null, null)$$, 'commercial : journalise un e-mail sur SON lead');
select lives_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'meeting', '{"title": "Démo"}', '2026-12-15T10:00:00Z', null)$$, 'commercial : planifie un rendez-vous');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l3')::uuid, 'note', '{"text": "intrus"}', null, null)$$, 'PT404', null, 'commercial : lead d''un autre commercial introuvable');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', gen_random_uuid(), 'note', '{"text": "x"}', null, null)$$, 'PT404', null, 'lead inconnu : introuvable (comme un lead étranger)');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', '2026-12-15T10:00:00Z', null)$$, '22023', null, 'échéance sur une note : refusée');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, 'ba000000-0000-4000-8000-000000000004')$$, '22023', null, 'responsable sur une note : refusé');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": ""}', null, null)$$, '22023', null, 'contenu invalide : refusé avant insertion');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000003');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, null)$$, '42501', null, 'marketing : création refusée');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l3')::uuid), 2, 'marketing : voit les activités (lecture)');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000005');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, null)$$, '42501', null, 'analyste : création refusée');
select is((select count(*)::int from public.activities), 0, 'analyste : aucune activité visible');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, null)$$, '42501', null, 'owner de Beta : création chez Alpha refusée');
select is((select count(*)::int from public.activities where organization_id = 'bb000000-0000-4000-8000-00000000000a'), 0, 'owner de Beta : aucune activité d''Alpha');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000007');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, null)$$, '42501', null, 'sans adhésion : création refusée');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, null)$$, '28000', null, 'sans identité : unauthenticated');

-- 5. Lecture « own » ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select ok((select count(*) from public.activities) >= 10, 'owner : voit toutes les activités d''Alpha');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l3')::uuid), 0, 'commercial : aucune activité du lead d''un autre');
select ok((select count(*) from public.activities where lead_id = current_setting('t.l1')::uuid) >= 4, 'commercial : voit les activités de SON lead');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000008');
select is((select array_agg(distinct lead_id::text) from public.activities), array[current_setting('t.l3')], 'second commercial : uniquement son lead');
reset role;

-- 6. Tâches ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ba000000-0000-4000-8000-000000000004');
select lives_ok($$select set_config('t.t1', public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'task', '{"title": "Relancer le client"}', '2026-12-10T09:00:00Z', null)::text, true)$$, 'commercial : crée une tâche (responsable = lui)');
select is((select owner_id::text from public.activities where id = current_setting('t.t1')::uuid), 'ba000000-0000-4000-8000-000000000004', 'responsable par défaut : l''auteur');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'task', '{"title": "Pour un collègue"}', null, 'ba000000-0000-4000-8000-000000000008')$$, '42501', null, 'commercial : ne confie pas une tâche à un autre');
select lives_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'task', '{"title": "Pour moi"}', null, 'ba000000-0000-4000-8000-000000000004')$$, 'commercial : peut se désigner lui-même');
select lives_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, '{"title": "Relancer le client (devis)"}', '2026-12-12T09:00:00Z', null)$$, 'commercial : modifie sa tâche');
select is((select metadata ->> 'title' from public.activities where id = current_setting('t.t1')::uuid), 'Relancer le client (devis)', 'tâche : titre modifié');
select is((select owner_id::text from public.activities where id = current_setting('t.t1')::uuid), 'ba000000-0000-4000-8000-000000000004', 'tâche : responsable inchangé quand il n''est pas précisé');
select throws_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.a_note')::uuid, '{"title": "x"}', null, null)$$, 'PT404', null, 'tâche / note d''un lead étranger : introuvable pour le commercial');
select lives_ok($$select public.complete_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, true)$$, 'commercial : termine sa tâche');
select set_config('t.done_at', (select completed_at::text from public.activities where id = current_setting('t.t1')::uuid), true);
select ok(current_setting('t.done_at') <> '', 'la date de fin est posée par la base');
select lives_ok($$select public.complete_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, true)$$, 'terminer deux fois est sans effet');
select is((select completed_at::text from public.activities where id = current_setting('t.t1')::uuid), current_setting('t.done_at'), 'la date de fin ne bouge pas');
select lives_ok($$select public.complete_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, false)$$, 'tâche rouverte');
select is((select completed_at from public.activities where id = current_setting('t.t1')::uuid), null, 'tâche rouverte : date de fin effacée');
select throws_ok($$select public.complete_task('bb000000-0000-4000-8000-00000000000a', (select id from public.activities where type = 'note' and lead_id = current_setting('t.l1')::uuid limit 1), true)$$, '22023', null, 'terminer une note : refusé');
select throws_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', (select id from public.activities where type = 'email' and lead_id = current_setting('t.l1')::uuid limit 1), '{"title": "x"}', null, null)$$, '22023', null, 'modifier un e-mail comme une tâche : refusé');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, '{"title": "x"}', null, 'ba000000-0000-4000-8000-000000000008')$$, 'P0001', 'assignee_invalid', 'tâche confiée à un commercial qui n''est pas responsable du lead : refusée');
select lives_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, '{"title": "Relancer le client (devis)"}', '2026-12-12T09:00:00Z', 'ba000000-0000-4000-8000-000000000002')$$, 'owner : confie la tâche à l''admin');
select is((select owner_id::text from public.activities where id = current_setting('t.t1')::uuid), 'ba000000-0000-4000-8000-000000000002', 'tâche : nouveau responsable');
select throws_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, '{"title": "x"}', null, 'ba000000-0000-4000-8000-000000000005')$$, 'P0001', 'assignee_invalid', 'tâche confiée à un analyste : refusée');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'task', '{"title": "Hors entreprise"}', null, 'ba000000-0000-4000-8000-000000000006')$$, 'P0001', 'assignee_invalid', 'tâche confiée à un membre d''une autre entreprise : refusée');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000003');
select throws_ok($$select public.complete_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, true)$$, '42501', null, 'marketing : ne termine pas une tâche');
select pg_temp.as_user('ba000000-0000-4000-8000-000000000006');
select throws_ok($$select public.update_task('bb000000-0000-4000-8000-00000000000a', current_setting('t.t1')::uuid, '{"title": "x"}', null, null)$$, '42501', null, 'owner de Beta : refusé');
reset role;

-- 7. Projet archivé, abonnement, plafond ------------------------------------------------------------------------------------------------
update public.projects set status = 'archived' where id = 'bc000000-0000-4000-8000-0000000000a2';
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l4')::uuid, 'note', '{"text": "x"}', null, null)$$, 'P0001', 'project_archived', 'projet archivé : aucune activité ajoutée');
reset role;
update public.subscriptions set status = 'suspended' where organization_id = 'bb000000-0000-4000-8000-00000000000a';
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l1')::uuid, 'note', '{"text": "x"}', null, null)$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : aucune activité ajoutée');
reset role;
update public.subscriptions set status = 'active' where organization_id = 'bb000000-0000-4000-8000-00000000000a';
insert into public.activities (organization_id, lead_id, contact_id, type, metadata)
  select 'bb000000-0000-4000-8000-00000000000a', current_setting('t.l5')::uuid, 'bd000000-0000-4000-8000-0000000000c4', 'note', jsonb_build_object('text', 'n' || n) from generate_series(1, 500) n;
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select throws_ok($$select public.create_activity('bb000000-0000-4000-8000-00000000000a', current_setting('t.l5')::uuid, 'note', '{"text": "501e"}', null, null)$$, 'P0001', 'too_many_activities', 'plafond de 500 activités manuelles par lead');
reset role;
-- le journal automatique ne compte pas dans le plafond manuel et a le sien (1000)
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select public.move_lead_stage('bb000000-0000-4000-8000-00000000000a', current_setting('t.l5')::uuid, current_setting('t.sa_qual')::uuid);
reset role;
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l5')::uuid and type = 'stage_change'), 1, 'lead au plafond manuel : le journal automatique continue');
insert into public.activities (organization_id, lead_id, contact_id, type, metadata)
  select 'bb000000-0000-4000-8000-00000000000a', current_setting('t.l5')::uuid, 'bd000000-0000-4000-8000-0000000000c4', 'stage_change',
         jsonb_build_object('from_stage_id', current_setting('t.sa_new'), 'to_stage_id', current_setting('t.sa_qual')) from generate_series(1, 999) n;
select pg_temp.as_user('ba000000-0000-4000-8000-000000000001');
select public.move_lead_stage('bb000000-0000-4000-8000-00000000000a', current_setting('t.l5')::uuid, current_setting('t.sa_new')::uuid);
reset role;
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l5')::uuid and type in ('stage_change', 'assignment')), 1000, 'journal automatique plafonné à 1000 entrées par lead');
select ok(exists (select 1 from public.audit_logs where action = 'lead.stage_changed' and entity_id = current_setting('t.l5')::uuid and after ->> 'stage_id' = current_setting('t.sa_new')), 'au-delà du plafond, l''audit lead.* garde la trace');

-- 8. Libération automatique d'un membre : journal ---------------------------------------------------------------------------------
update public.organization_members set status = 'suspended' where organization_id = 'bb000000-0000-4000-8000-00000000000a' and user_id = 'ba000000-0000-4000-8000-000000000008';
select is((select metadata ->> 'to_assignee_id' from public.activities where lead_id = current_setting('t.l3')::uuid and type = 'assignment' order by created_at desc, id limit 1), null, 'membre suspendu : l''assignation à « personne » est journalisée');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l3')::uuid and type = 'stage_change'), 1, 'membre suspendu : retour à l''étape « non assigné » journalisé');

-- 8b. Suppression de la ligne d'un membre : ses entrées gardent leur contenu, seul l'auteur est effacé ------------------------------
select ok((select count(*) from public.activities where lead_id = current_setting('t.l1')::uuid and type in ('email', 'meeting') and owner_id = 'ba000000-0000-4000-8000-000000000004') = 2, 'avant retrait : e-mail et rendez-vous écrits par le commercial U4');
select lives_ok($$delete from public.organization_members where organization_id = 'bb000000-0000-4000-8000-00000000000a' and user_id = 'ba000000-0000-4000-8000-000000000004'$$, 'ligne de membre supprimée malgré ses entrées de chronologie');
select is((select count(*)::int from public.activities where lead_id = current_setting('t.l1')::uuid and type in ('email', 'meeting') and owner_id is null and (metadata ? 'subject' or metadata ? 'title')), 2, 'entrées conservées avec leur contenu, auteur effacé');
select throws_ok($$update public.activities set owner_id = null, metadata = '{"text": "falsifié"}' where type = 'note' and lead_id = current_setting('t.l1')::uuid$$, '23514', null, 'effacer l''auteur ne permet pas de modifier le contenu');

-- 9. Audit : jamais le contenu -----------------------------------------------------------------------------------------------------------
select ok((select count(*) from public.audit_logs where action = 'activity.created' and organization_id = 'bb000000-0000-4000-8000-00000000000a') >= 6, 'audit : activity.created');
select is((select count(*)::int from public.audit_logs where action = 'activity.created' and after ->> 'type' in ('stage_change', 'assignment')), 0, 'audit : pas de doublon pour le journal automatique');
select ok(exists (select 1 from public.audit_logs where action = 'activity.completed' and entity_id = current_setting('t.t1')::uuid), 'audit : activity.completed');
select ok(exists (select 1 from public.audit_logs where action = 'activity.reopened' and entity_id = current_setting('t.t1')::uuid), 'audit : activity.reopened');
select ok(exists (select 1 from public.audit_logs where action = 'activity.updated' and entity_id = current_setting('t.t1')::uuid and after -> 'changed' = '["owner_id"]'::jsonb), 'audit : activity.updated ne liste que les NOMS des champs');
select ok(not exists (
  select 1 from public.audit_logs
   where entity_type = 'activity' and organization_id = 'bb000000-0000-4000-8000-00000000000a'
     and (coalesce(before::text, '') || coalesce(after::text, '')) ~* '(SECRET-TEXTE|Relancer|Offre envoy|Démo|Intéressé|Compte rendu)'
), 'audit : ni texte, ni titre, ni objet');

select * from finish();
rollback;
