-- J24 — Recherche de leads et audit des exports : droits, RLS de l'appelant (owner, admin, marketing, commercial « own », analyste),
-- filtres, recherche (nom, e-mail, téléphone, caractères spéciaux échappés), tri, pagination, isolation entre entreprises, `log_export`
-- (rôles, validation, audit sans valeur de filtre). Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(63);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyste A · U6 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('fa000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@cs.test', now()
    from generate_series(1, 6) n;
insert into public.organizations (id, name, slug) values
  ('fb000000-0000-4000-8000-00000000000a', 'CS Alpha', 'cs-alpha-test'),
  ('fb000000-0000-4000-8000-00000000000b', 'CS Beta', 'cs-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('fb000000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('fb000000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('fb000000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('fb000000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('fb000000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('fb000000-0000-4000-8000-00000000000b', 'fa000000-0000-4000-8000-000000000006', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('fb000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('fb000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
insert into public.projects (id, organization_id, type, name, status, settings) values
  ('fc000000-0000-4000-8000-0000000000a1', 'fb000000-0000-4000-8000-00000000000a', 'website_sales', 'CS site', 'active', '{}'),
  ('fc000000-0000-4000-8000-0000000000a2', 'fb000000-0000-4000-8000-00000000000a', 'custom', 'CS autre', 'active', '{}'),
  ('fc000000-0000-4000-8000-0000000000b1', 'fb000000-0000-4000-8000-00000000000b', 'custom', 'CS beta', 'active', '{}');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('fd000000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-00000000000a', 'Nadia Benali', 'Nadia@cs.test', 'nadia@cs.test', '+212612345678'),
  ('fd000000-0000-4000-8000-000000000002', 'fb000000-0000-4000-8000-00000000000a', 'Youssef Alami', 'youssef@cs.test', 'youssef@cs.test', '+966501234567'),
  ('fd000000-0000-4000-8000-000000000003', 'fb000000-0000-4000-8000-00000000000a', 'Remise 100% Club', 'remise@cs.test', 'remise@cs.test', null),
  ('fd000000-0000-4000-8000-000000000004', 'fb000000-0000-4000-8000-00000000000a', 'Jean_Pierre Dupont', 'jean@cs.test', 'jean@cs.test', null),
  ('fd000000-0000-4000-8000-000000000005', 'fb000000-0000-4000-8000-00000000000a', 'Sarah Zahra', 'sarah@cs.test', 'sarah@cs.test', '+212698765432'),
  ('fd000000-0000-4000-8000-000000000006', 'fb000000-0000-4000-8000-00000000000a', 'Karim Slash\Back', 'karim@cs.test', 'karim@cs.test', null),
  ('fd000000-0000-4000-8000-0000000000b1', 'fb000000-0000-4000-8000-00000000000b', 'Nadia Beta', 'nadiab@cs.test', 'nadiab@cs.test', '+212612345600');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;
-- lead du contact n (non assigné si p_assignee est nul, sinon première étape ouverte)
create function pg_temp.mk_lead(p_org text, p_contact text, p_project text, p_source text, p_assignee text, p_age int) returns uuid language plpgsql as $f$
declare
  v_id uuid;
  v_stage uuid;
begin
  select s.id into v_stage from public.pipeline_stages s join public.pipelines p on p.organization_id = s.organization_id and p.id = s.pipeline_id
   where p.organization_id = p_org::uuid and p.is_default and s.kind = case when p_assignee is null then 'unassigned' else 'open' end::public.stage_kind
   order by s.position limit 1;
  insert into public.leads (organization_id, contact_id, project_id, source, stage_id, assignee_id, created_at, updated_at)
  values (p_org::uuid, p_contact::uuid, p_project::uuid, p_source, v_stage, p_assignee::uuid, now() - (p_age || ' days')::interval, now() - (p_age || ' days')::interval)
  returning id into v_id;
  return v_id;
end $f$;
grant execute on function pg_temp.mk_lead(text, text, text, text, text, int) to public;

select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000a', 'fd000000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-0000000000a1', 'web_form', 'fa000000-0000-4000-8000-000000000004', 6);
select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000a', 'fd000000-0000-4000-8000-000000000002', 'fc000000-0000-4000-8000-0000000000a1', 'csv_import', null, 5);
select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000a', 'fd000000-0000-4000-8000-000000000003', 'fc000000-0000-4000-8000-0000000000a2', 'web_form', 'fa000000-0000-4000-8000-000000000001', 4);
select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000a', 'fd000000-0000-4000-8000-000000000004', 'fc000000-0000-4000-8000-0000000000a2', 'manual', null, 3);
select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000a', 'fd000000-0000-4000-8000-000000000005', 'fc000000-0000-4000-8000-0000000000a1', 'web_form', 'fa000000-0000-4000-8000-000000000004', 2);
select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000a', 'fd000000-0000-4000-8000-000000000006', 'fc000000-0000-4000-8000-0000000000a1', 'csv_import', null, 1);
select pg_temp.mk_lead('fb000000-0000-4000-8000-00000000000b', 'fd000000-0000-4000-8000-0000000000b1', 'fc000000-0000-4000-8000-0000000000b1', 'web_form', null, 1);

-- 1. Droits ----------------------------------------------------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer)', 'execute'), 'authenticated : search_leads exécutable');
select ok(not has_function_privilege('anon', 'public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer)', 'execute'), 'anon : search_leads non exécutable');
select ok(not has_function_privilege('service_role', 'public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer)', 'execute'), 'service_role : search_leads non exécutable');
select ok(not has_function_privilege('anon', 'public.log_export(uuid, text, integer, jsonb)', 'execute'), 'anon : log_export non exécutable');
select ok(not has_function_privilege('service_role', 'public.log_export(uuid, text, integer, jsonb)', 'execute'), 'service_role : log_export non exécutable');
select is((select prosecdef from pg_proc where oid = 'public.search_leads(uuid, uuid, uuid, text, uuid, boolean, text, text, integer, integer)'::regprocedure), false, 'search_leads : SECURITY INVOKER (la RLS de l''appelant s''applique)');

-- 2. RLS : qui voit quels leads -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('fa000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a')), 6, 'owner : tous les leads de l''entreprise');
select is((select total_count::int from public.search_leads('fb000000-0000-4000-8000-00000000000a') limit 1), 6, 'total renvoyé avec chaque ligne');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a')), 6, 'admin : tous les leads');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a')), 6, 'marketing : tous les leads (lecture)');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a')), 2, 'commercial : ses 2 leads seulement');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_unassigned => true)), 0, 'commercial : voit aucun lead non assigné');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => 'youssef')), 0, 'commercial : la recherche ne trouve pas le lead d''un autre');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a')), 0, 'analyste : aucun lead (PII)');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a')), 0, 'owner d''une AUTRE entreprise : rien en passant l''entreprise d''Alpha');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000b')), 1, 'owner de Beta : son seul lead');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000b', p_query => 'nadia')), 1, 'recherche « nadia » dans Beta : seulement « Nadia Beta »');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000b')), 0, 'owner d''Alpha : rien dans Beta');

-- 3. Filtres --------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_project => 'fc000000-0000-4000-8000-0000000000a2')), 2, 'filtre projet');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_source => 'csv_import')), 2, 'filtre source');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_assignee => 'fa000000-0000-4000-8000-000000000004')), 2, 'filtre responsable');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_unassigned => true)), 3, 'filtre « non assignés » (file)');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_stage => (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id where p.organization_id = 'fb000000-0000-4000-8000-00000000000a' and p.is_default and s.kind = 'unassigned'))), 3, 'filtre étape');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_project => 'fc000000-0000-4000-8000-0000000000a1', p_source => 'web_form')), 2, 'filtres combinés');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_project => 'fc000000-0000-4000-8000-0000000000b1')), 0, 'projet d''une autre entreprise : aucun résultat');

-- 4. Recherche ---------------------------------------------------------------------------------------------------------------------------
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => 'NADIA')), 'Nadia Benali', 'nom : insensible à la casse, partiel');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => 'youssef@cs')), 1, 'e-mail : partiel');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => '06 12-34')), 'Nadia Benali', 'téléphone : chiffres seulement, séparateurs ignorés');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => '+966 50')), 'Youssef Alami', 'téléphone saoudien');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => '%')), 1, '« % » est cherché littéralement (un seul nom en contient un)');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => '100%')), 'Remise 100% Club', '« 100% » trouve le nom qui le contient');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => 'jean_pierre')), 'Jean_Pierre Dupont', '« _ » est littéral');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => 'jean pierre')), 0, '« _ » ne remplace pas un espace');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => E'slash\\back')), E'Karim Slash\\Back', 'antislash littéral');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => 'zzz-introuvable')), 0, 'aucun résultat');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => '   ')), 6, 'recherche vide : tous les leads');
select throws_ok($$select * from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_query => repeat('a', 101))$$, '22023', null, 'recherche de plus de 100 caractères : refusée');

-- 5. Tri et pagination --------------------------------------------------------------------------------------------------------------------------
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_sort => 'created_desc') limit 1), 'Karim Slash\Back', 'tri : plus récent d''abord');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_sort => 'created_asc') limit 1), 'Nadia Benali', 'tri : plus ancien d''abord');
select is((select contact_name from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_sort => 'name_asc') limit 1), 'Jean_Pierre Dupont', 'tri : nom croissant');
select throws_ok($$select * from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_sort => 'password')$$, '22023', null, 'tri inconnu : refusé');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_limit => 2, p_offset => 2)), 2, 'pagination : 2 lignes à partir de la 3e');
select is((select total_count::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_limit => 2, p_offset => 2) limit 1), 6, 'pagination : le total reste 6');
select is((select count(*)::int from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_limit => 2, p_offset => 100)), 0, 'au-delà de la dernière page : vide');
select throws_ok($$select * from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_limit => 0)$$, '22023', null, 'limite nulle refusée');
select throws_ok($$select * from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_limit => 10001)$$, '22023', null, 'limite de plus de 10 000 refusée');
select throws_ok($$select * from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_offset => -1)$$, '22023', null, 'décalage négatif refusé');
select throws_ok($$select * from public.search_leads('fb000000-0000-4000-8000-00000000000a', p_source => 'Web Form; drop table leads')$$, '22023', null, 'source mal formée refusée');

-- 5b. Revue sécurité : un deal ne se place jamais dans l'étape « non assigné » ------------------------------------------------------------
reset role;
insert into public.deals (id, organization_id, lead_id, stage_id, value, currency)
  select 'fe000000-0000-4000-8000-000000000001', l.organization_id, l.id, l.stage_id, 100, 'MAD'
    from public.leads l join public.contacts c on c.id = l.contact_id where c.name = 'Nadia Benali';
select is((select s.kind::text from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = 'fe000000-0000-4000-8000-000000000001'), 'open', 'deal créé dans une étape ouverte');
select throws_ok($$update public.deals set stage_id = (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id where p.organization_id = 'fb000000-0000-4000-8000-00000000000a' and p.is_default and s.kind = 'unassigned') where id = 'fe000000-0000-4000-8000-000000000001'$$, '23514', null, 'deal déplacé vers « non assigné » : refusé (garde du J19 : dates et genre d''étape)');
select throws_ok($$insert into public.deals (organization_id, lead_id, stage_id, value, currency) select l.organization_id, l.id, (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id where p.organization_id = 'fb000000-0000-4000-8000-00000000000a' and p.is_default and s.kind = 'unassigned'), 1, 'MAD' from public.leads l join public.contacts c on c.id = l.contact_id where c.name = 'Karim Slash\Back'$$, '23514', null, 'deal créé dans « non assigné » : refusé (garde du J19)');

-- 6. log_export ----------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('fa000000-0000-4000-8000-000000000001');
select ok(public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 6, '{"query": "nadia@cs.test", "project": "x", "unassigned": true}') is not null, 'owner : enregistre un export');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000002');
select ok(public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 0, '{}') is not null, 'admin : enregistre un export');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000003');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 1, '{}')$$, '42501', null, 'marketing : export refusé (ADR 014)');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000004');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 1, '{}')$$, '42501', null, 'commercial : export refusé');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000005');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 1, '{}')$$, '42501', null, 'analyste : export refusé');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000006');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 1, '{}')$$, '42501', null, 'owner d''une autre entreprise : refusé');
select pg_temp.as_user('fa000000-0000-4000-8000-000000000001');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'contacts', 1, '{}')$$, '22023', null, 'type d''export inconnu refusé');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 10001, '{}')$$, '22023', null, 'plus de 10 000 lignes refusé');
select throws_ok($$select public.log_export('fb000000-0000-4000-8000-00000000000a', 'leads', 1, '{"password": "x"}')$$, '22023', null, 'nom de filtre inconnu refusé');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'export.created' and organization_id = 'fb000000-0000-4000-8000-00000000000a'), 2, 'audit : deux exports enregistrés');
select ok(exists (select 1 from public.audit_logs where action = 'export.created' and actor_id = 'fa000000-0000-4000-8000-000000000001' and (after ->> 'rows')::int = 6 and after -> 'filters' = '["project", "query", "unassigned"]'::jsonb), 'audit : nombre de lignes et NOMS des filtres, acteur = l''utilisateur');
select is((select count(*)::int from public.audit_logs where action = 'export.created' and (after::text like '%nadia%' or after::text like '%@%')), 0, 'audit : aucune valeur de filtre ni donnée de contact');

select * from finish();
rollback;
