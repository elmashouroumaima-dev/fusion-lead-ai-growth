-- Crée une clé de formulaire (J21) pour le projet « Site vitrine Alpha » avec l'origine autorisée https://demo.test, au nom du propriétaire d'Alpha.
-- La clé est affichée UNE SEULE FOIS (la base ne garde que son empreinte) : la copier tout de suite.
--   docker exec -i supabase_db_fusion-leap psql -U postgres -t -A < docs/testing/fixtures/create-form-key.sql
begin;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;
select 'CLE=' || (public.create_form_key('a0000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', array['https://demo.test']) ->> 'key');
commit;
