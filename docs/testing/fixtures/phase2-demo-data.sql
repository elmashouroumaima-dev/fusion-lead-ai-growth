-- Données de démonstration pour les tests fonctionnels des phases 2 et 3 (voir docs/testing/phase2-3-functional-tests.md).
-- Crée, dans l'entreprise Alpha et AU NOM de son propriétaire (shared@seed.test), 8 contacts, 8 leads (2 non assignés) et 4 deals :
-- tout passe par les fonctions de l'application (droits, quotas, audit), exactement comme depuis l'API. Données de test uniquement (domaine .test).
--
-- Chargement (base locale démarrée avec `pnpm db:start`, jeu de départ `pnpm db:reset`) :
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 < docs/testing/fixtures/phase2-demo-data.sql
-- Ne le charger qu'UNE FOIS après un `pnpm db:reset` (un second chargement refuse les doublons d'e-mail).

begin;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;

do $demo$
declare
  org constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  project constant uuid := 'a1000000-0000-4000-8000-000000000001';
  sales constant uuid := '00000000-0000-4000-8000-000000000004';
  s_new uuid;
  s_qualified uuid;
  s_proposal uuid;
  s_won uuid;
  c uuid;
  l uuid;
  d uuid;
  i integer;
  names text[] := array['Nadia Benali', 'Karim Alaoui', 'Salma Idrissi', 'Youssef Tazi', 'Imane Chraibi', 'Omar Berrada', 'Lina Fassi', 'Hamid Zniber'];
  slugs text[] := array['nadia', 'karim', 'salma', 'youssef', 'imane', 'omar', 'lina', 'hamid'];
  sources text[] := array['web_form', 'web_form', 'csv_import', 'manual', 'web_form', 'csv_import', 'manual', 'web_form'];
begin
  -- étapes ouvertes du pipeline par défaut d'Alpha (dans l'ordre) et étape « gagné »
  select ps.id into s_new from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.organization_id = ps.organization_id
   where ps.organization_id = org and p.is_default and ps.kind = 'open' order by ps.position limit 1;
  select ps.id into s_qualified from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.organization_id = ps.organization_id
   where ps.organization_id = org and p.is_default and ps.kind = 'open' order by ps.position offset 1 limit 1;
  select ps.id into s_proposal from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.organization_id = ps.organization_id
   where ps.organization_id = org and p.is_default and ps.kind = 'open' order by ps.position offset 2 limit 1;
  select ps.id into s_won from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.organization_id = ps.organization_id
   where ps.organization_id = org and p.is_default and ps.kind = 'won' limit 1;

  for i in 1..8 loop
    c := public.create_contact(org, names[i], slugs[i] || '@demo.test', slugs[i] || '@demo.test', '+21261234560' || i, 'fr', 'MA', null, null, '{}'::jsonb);
    -- leads 1 à 6 : assignés au commercial ; leads 7 et 8 : non assignés (file « Non assignés »)
    l := public.create_lead(org, c, project, sources[i], case when i <= 6 then sales else null end, 10 * i, null, '{}'::jsonb, null, null);
    -- 4 deals : étapes différentes, dont un gagné
    if i = 1 then d := public.create_deal(org, l, s_new, 2000, 'MAD', null);
    elsif i = 2 then d := public.create_deal(org, l, s_qualified, 6500, 'MAD', null);
    elsif i = 3 then d := public.create_deal(org, l, s_proposal, 12000, 'MAD', null);
    elsif i = 4 then
      d := public.create_deal(org, l, s_proposal, 3200, 'MAD', null);
      perform public.move_deal_stage(org, d, s_won);
    end if;
  end loop;
end
$demo$;

commit;

select 'contacts: ' || count(*) from public.contacts where email_normalized like '%@demo.test'
union all select 'leads: ' || count(*) from public.leads l join public.contacts c on c.organization_id = l.organization_id and c.id = l.contact_id where c.email_normalized like '%@demo.test'
union all select 'deals: ' || count(*) from public.deals d join public.leads l on l.organization_id = d.organization_id and l.id = d.lead_id join public.contacts c on c.organization_id = l.organization_id and c.id = l.contact_id where c.email_normalized like '%@demo.test';
