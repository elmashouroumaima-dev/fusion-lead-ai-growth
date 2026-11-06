-- J6 — Fonctions d'aide RLS private.is_member / private.has_role (ADR 005 §4, §5).
-- Chaque cas s'exécute sous le rôle `authenticated` avec un JWT de test dont seul `sub` compte :
-- le rôle est lu dans organization_members, jamais dans les métadonnées du JWT.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- Utilisateurs et entreprises du seed
-- shared (Owner Alpha / Sales Agent Beta) = …0001 ; alpha-sales = …0004 ; alpha-analyst = …0005
-- beta-owner = …0006 ; Alpha = a0…a1 ; Beta = b0…b1

-- ---------------------------------------------------------------------------
-- Utilisateur commun à deux entreprises, deux rôles différents
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select ok(private.is_member('a0000000-0000-4000-8000-0000000000a1'), 'shared est membre d''Alpha');
select ok(private.is_member('b0000000-0000-4000-8000-0000000000b1'), 'shared est membre de Beta');
select ok(private.has_role('a0000000-0000-4000-8000-0000000000a1', array['company_owner']::public.app_role[]), 'shared est owner chez Alpha');
select ok(not private.has_role('b0000000-0000-4000-8000-0000000000b1', array['company_owner']::public.app_role[]), 'shared n''est PAS owner chez Beta');
select ok(private.has_role('b0000000-0000-4000-8000-0000000000b1', array['sales_agent', 'analyst']::public.app_role[]), 'shared est sales_agent chez Beta');
select ok(not private.has_role('a0000000-0000-4000-8000-0000000000a1', array['company_admin', 'marketing_manager']::public.app_role[]), 'pas de rôle étranger à son rôle réel');
select ok(not private.has_role('a0000000-0000-4000-8000-0000000000a1', array[]::public.app_role[]), 'liste de rôles vide : refus');
select ok(not private.is_member('c0000000-0000-4000-8000-0000000000c1'), 'entreprise inexistante : refus');
reset role;

-- ---------------------------------------------------------------------------
-- Utilisateur d'une seule entreprise : aucune fuite vers l'autre
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
set local role authenticated;
select ok(private.is_member('a0000000-0000-4000-8000-0000000000a1'), 'alpha-analyst est membre d''Alpha');
select ok(not private.is_member('b0000000-0000-4000-8000-0000000000b1'), 'alpha-analyst n''est pas membre de Beta');
select ok(private.has_role('a0000000-0000-4000-8000-0000000000a1', array['analyst']::public.app_role[]), 'alpha-analyst a le rôle analyst');
select ok(
  not private.has_role('a0000000-0000-4000-8000-0000000000a1',
    array['company_owner', 'company_admin', 'marketing_manager', 'sales_agent']::public.app_role[]),
  'alpha-analyst n''a aucun rôle d''écriture'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
set local role authenticated;
select ok(not private.is_member('a0000000-0000-4000-8000-0000000000a1'), 'beta-owner n''est pas membre d''Alpha');
reset role;

-- ---------------------------------------------------------------------------
-- Le rôle vient de la base, pas du JWT : un JWT qui prétend un rôle ne change rien (ADR 005 §5)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated","user_metadata":{"role":"company_owner"},"app_metadata":{"role":"company_owner"}}', true);
set local role authenticated;
select ok(
  not private.has_role('a0000000-0000-4000-8000-0000000000a1', array['company_owner']::public.app_role[]),
  'user_metadata / app_metadata du JWT ignorés : analyst reste analyst'
);
reset role;

-- ---------------------------------------------------------------------------
-- Statuts non actifs : aucun accès
-- ---------------------------------------------------------------------------
update public.organization_members set status = 'suspended'
 where organization_id = 'a0000000-0000-4000-8000-0000000000a1' and user_id = '00000000-0000-4000-8000-000000000004';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select ok(not private.is_member('a0000000-0000-4000-8000-0000000000a1'), 'membre suspendu : refus');
select ok(not private.has_role('a0000000-0000-4000-8000-0000000000a1', array['sales_agent']::public.app_role[]), 'membre suspendu : aucun rôle');
reset role;

update public.organization_members set status = 'invited'
 where organization_id = 'a0000000-0000-4000-8000-0000000000a1' and user_id = '00000000-0000-4000-8000-000000000004';
set local role authenticated;
select ok(not private.is_member('a0000000-0000-4000-8000-0000000000a1'), 'membre seulement invité : refus');
reset role;

-- ---------------------------------------------------------------------------
-- Sans identité : aucun accès
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select ok(not private.is_member('a0000000-0000-4000-8000-0000000000a1'), 'sans sub dans le JWT : refus');
reset role;

set local role anon;
select throws_ok(
  $$select private.is_member('a0000000-0000-4000-8000-0000000000a1')$$,
  '42501', null, 'anon ne peut pas appeler les fonctions du schéma private'
);
reset role;

-- ---------------------------------------------------------------------------
-- Lecture directe sous RLS (J7) : filtrée par les politiques ; matrice complète dans test:rls
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.organization_members), 6, 'shared : 5 adhésions Alpha (owner) + sa ligne Beta');
select is((select count(*)::int from public.organizations), 2, 'shared voit ses deux entreprises');
reset role;

select * from finish();
rollback;
