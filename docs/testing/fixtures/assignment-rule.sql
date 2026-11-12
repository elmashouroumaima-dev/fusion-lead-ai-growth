-- Règle d'assignation par défaut d'Alpha (J22) : « chacun son tour » entre le commercial de test (alpha-sales) et l'administrateur (alpha-admin).
-- Au nom du propriétaire d'Alpha. À charger UNE fois ; un second chargement est refusé (une seule règle active par défaut).
--   docker exec -i supabase_db_fusion-leap psql -U postgres -t -A < docs/testing/fixtures/assignment-rule.sql
begin;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;
select 'REGLE=' || public.create_assignment_rule('a0000000-0000-4000-8000-0000000000a1', null, 'round_robin',
  array['00000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000002'::uuid]);
commit;
