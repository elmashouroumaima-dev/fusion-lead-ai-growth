-- J10 — Invitations : table, RLS, GRANT, fonctions create/revoke/accept/transfer (menace B6, ADR 014).
-- Les appels de fonction s'exécutent sous le rôle `authenticated` avec un JWT de test (seul `sub` compte) ;
-- les vérifications d'état s'exécutent sous le propriétaire (sans RLS). Tout est annulé en fin de test.
-- Jetons : on ne manipule que des « hash » factices (64 hexadécimaux) ; aucun jeton réel n'existe en base.
begin;
create extension if not exists pgtap with schema extensions;
select plan(223);

-- ---------------------------------------------------------------------------
-- Données de test
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o1@inv.test', now()),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a1@inv.test', now()),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1@inv.test', now()),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's1@inv.test', now()),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n1@inv.test', now()),
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ob@inv.test', now()),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'invitee@inv.test', now()),
  ('10000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unconf@inv.test', null),
  ('10000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@inv.test', now()),
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'removed@inv.test', now()),
  ('10000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'suspended@inv.test', now()),
  ('10000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'Mixed.Case@Inv.Test', now()),
  ('10000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pending-status@inv.test', now()),
  ('10000000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'co@inv.test', now()),
  ('10000000-0000-4000-8000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ca@inv.test', now()),
  ('10000000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cs@inv.test', now()),
  ('10000000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cx@inv.test', now()),
  ('10000000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cr@inv.test', now()),
  ('10000000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cm@inv.test', now()),
  ('10000000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'revme@inv.test', now());

insert into public.organizations (id, name, slug) values
  ('20000000-0000-4000-8000-000000000001', 'Inv Alpha', 'inv-alpha-test'),
  ('20000000-0000-4000-8000-000000000002', 'Inv Beta', 'inv-beta-test'),
  ('20000000-0000-4000-8000-000000000003', 'Inv Gamma', 'inv-gamma-test');
-- Abonnement de test : limite d'utilisateurs très haute (ces tests ne portent pas sur les quotas, voir 090).
insert into public.subscriptions (organization_id, plan_id, limits_override)
  select o.id, (select id from public.plans where code = 'growth'), '{"users": 100000}'::jsonb from public.organizations o
   where not exists (select 1 from public.subscriptions s where s.organization_id = o.id);

insert into public.organization_members (organization_id, user_id, role, status) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000a', 'sales_agent', 'removed'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000b', 'sales_agent', 'suspended'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000d', 'analyst', 'invited'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000006', 'company_owner', 'active'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-00000000000e', 'company_owner', 'active'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-00000000000f', 'company_admin', 'active'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000010', 'sales_agent', 'active'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000011', 'sales_agent', 'suspended'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000012', 'sales_agent', 'removed'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000013', 'marketing_manager', 'active');

-- ---------------------------------------------------------------------------
-- 1. Structure de la table
-- ---------------------------------------------------------------------------
select has_table('public', 'invitations', 'public.invitations existe');
select col_not_null('public', 'invitations', 'organization_id', 'organization_id NOT NULL');
select col_not_null('public', 'invitations', 'email_normalized', 'email_normalized NOT NULL');
select col_not_null('public', 'invitations', 'role', 'role NOT NULL');
select col_not_null('public', 'invitations', 'token_hash', 'token_hash NOT NULL');
select col_not_null('public', 'invitations', 'expires_at', 'expires_at NOT NULL');
select col_type_is('public', 'invitations', 'role', 'public.app_role', 'role est de type app_role');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.invitations'::regclass),
  'RLS activée sur invitations'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.invitations'::regclass
            and contype = 'f' and confdeltype = 'r'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'public.invitations'::regclass and attname = 'organization_id')]::int2[]),
  'FK organization_id -> organizations ON DELETE RESTRICT'
);
select ok(
  exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
           where i.indrelid = 'public.invitations'::regclass and a.attname = 'organization_id'),
  'organization_id est première colonne d''un index'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'invitations'
            and indexname = 'invitations_org_email_pending_key'
            and indexdef like '%UNIQUE%' and indexdef like '%(organization_id, email_normalized)%'
            and indexdef like '%accepted_at IS NULL%' and indexdef like '%revoked_at IS NULL%'),
  'index unique PARTIEL (organization_id, email_normalized) pour les invitations en attente'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.invitations'::regclass
            and conname = 'invitations_token_hash_key' and contype = 'u'),
  'token_hash est unique'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.invitations'::regclass
            and conname = 'invitations_org_id_key' and contype = 'u'),
  'unique (organization_id, id) pour les FK composites'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'set_updated_at' and not tgisinternal),
  'trigger set_updated_at'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'prevent_organization_id_change' and not tgisinternal),
  'trigger anti-changement d''organization_id'
);

-- ---------------------------------------------------------------------------
-- 2. Politiques et GRANT
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(policyname || ':' || cmd order by policyname) from pg_policies where schemaname = 'public' and tablename = 'invitations'),
  array['invitations_select:SELECT'],
  'une seule politique : SELECT'
);
select is(
  (select roles from pg_policies where schemaname = 'public' and tablename = 'invitations'),
  array['authenticated']::name[],
  'la politique cible authenticated uniquement'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'invitations') ~ 'has_role'
    and (select qual from pg_policies where schemaname = 'public' and tablename = 'invitations') !~* 'metadata',
  'la politique passe par private.has_role (jamais user_metadata)'
);
select ok(not has_table_privilege('authenticated', 'public.invitations', 'insert'), 'authenticated : pas d''INSERT');
select ok(not has_table_privilege('authenticated', 'public.invitations', 'update'), 'authenticated : pas d''UPDATE (table)');
select ok(not has_table_privilege('authenticated', 'public.invitations', 'delete'), 'authenticated : pas de DELETE');
select ok(not has_table_privilege('authenticated', 'public.invitations', 'truncate'), 'authenticated : pas de TRUNCATE');
select ok(not has_any_column_privilege('authenticated', 'public.invitations', 'insert'), 'authenticated : aucune colonne en INSERT');
select ok(not has_any_column_privilege('authenticated', 'public.invitations', 'update'), 'authenticated : aucune colonne en UPDATE');
select ok(has_column_privilege('authenticated', 'public.invitations', 'email_normalized', 'select'), 'authenticated : SELECT sur email_normalized');
select ok(not has_column_privilege('authenticated', 'public.invitations', 'token_hash', 'select'), 'authenticated : token_hash illisible');
select ok(
  not has_table_privilege('anon', 'public.invitations', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('anon', 'public.invitations', 'select,insert,update,references'),
  'anon : aucun privilège'
);

-- ---------------------------------------------------------------------------
-- 3. Fonctions : existence, sécurité, privilèges
-- ---------------------------------------------------------------------------
select has_function('private', 'create_invitation', array['uuid', 'text', 'app_role', 'text'], 'private.create_invitation');
select has_function('private', 'revoke_invitation', array['uuid', 'uuid'], 'private.revoke_invitation');
select has_function('private', 'accept_invitation', array['text'], 'private.accept_invitation');
select has_function('private', 'transfer_ownership', array['uuid', 'uuid'], 'private.transfer_ownership');
select has_function('public', 'create_invitation', array['uuid', 'text', 'app_role', 'text'], 'public.create_invitation');
select has_function('public', 'revoke_invitation', array['uuid', 'uuid'], 'public.revoke_invitation');
select has_function('public', 'accept_invitation', array['text'], 'public.accept_invitation');
select has_function('public', 'transfer_ownership', array['uuid', 'uuid'], 'public.transfer_ownership');

create temporary table inv_fns on commit drop as
select pr.oid as fn, n.nspname::text as schema_name, pr.proname::text as fn_name, pr.prosecdef, pr.proconfig, pr.proargnames
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
 where n.nspname in ('public', 'private')
   and pr.proname in ('create_invitation', 'revoke_invitation', 'accept_invitation', 'transfer_ownership');

select is((select count(*)::int from inv_fns), 8, 'huit fonctions (4 privées + 4 wrappers)');
select is(
  (select array_agg(fn_name order by fn_name) from inv_fns where schema_name = 'private' and prosecdef and proconfig @> array['search_path=""']),
  array['accept_invitation', 'create_invitation', 'revoke_invitation', 'transfer_ownership'],
  'fonctions privées : SECURITY DEFINER avec search_path vide'
);
select is(
  (select count(*)::int from inv_fns where schema_name = 'public' and prosecdef),
  0,
  'wrappers publics : SECURITY INVOKER'
);
select is(
  (select count(*)::int from inv_fns where schema_name = 'public' and proconfig @> array['search_path=""']),
  4,
  'wrappers publics : search_path vide'
);
select is(
  (select count(*)::int from inv_fns where exists (select 1 from unnest(proargnames) a where a ~* '(user|uid|actor|caller|member_id)')
      and fn_name <> 'transfer_ownership'),
  0,
  'aucune fonction ne prend de paramètre identité (sauf la cible du transfert)'
);
select is(
  (select proargnames from inv_fns where schema_name = 'private' and fn_name = 'transfer_ownership'),
  array['p_org', 'p_new_owner'],
  'transfer_ownership : seule la CIBLE est un paramètre ; l''appelant vient de auth.uid()'
);
select is(
  coalesce((select array_agg(schema_name || '.' || fn_name || ':' || r order by schema_name, fn_name, r)
              from inv_fns
             cross join (values ('anon'), ('public'), ('service_role')) as roles (r)
             where has_function_privilege(roles.r, fn, 'execute')), '{}'::text[]),
  '{}'::text[],
  'anon, PUBLIC et service_role ne peuvent exécuter aucune de ces fonctions'
);
select is(
  (select count(*)::int from inv_fns where has_function_privilege('authenticated', fn, 'execute')),
  8,
  'authenticated peut exécuter les huit fonctions'
);

-- ---------------------------------------------------------------------------
-- 4. Contraintes de la table (insertions directes en superuser)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', 'c1@inv.test', 'analyst', 'abc', now() + interval '1 day')$$,
  '23514', null, 'token_hash trop court refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', 'c1@inv.test', 'analyst', repeat('A', 64), now() + interval '1 day')$$,
  '23514', null, 'token_hash en majuscules refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', 'C1@Inv.Test', 'analyst', repeat('b', 64), now() + interval '1 day')$$,
  '23514', null, 'e-mail non normalisé refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', 'sans-arobase', 'analyst', repeat('b', 64), now() + interval '1 day')$$,
  '23514', null, 'e-mail sans arobase refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', repeat('a', 250) || '@b.cd', 'analyst', repeat('b', 64), now() + interval '1 day')$$,
  '23514', null, 'e-mail de plus de 254 caractères refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, accepted_at, revoked_at)
    values ('20000000-0000-4000-8000-000000000001', 'c1@inv.test', 'analyst', repeat('b', 64), now() + interval '1 day', now(), now())$$,
  '23514', null, 'acceptée ET révoquée refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-0000000000ff', 'c1@inv.test', 'analyst', repeat('b', 64), now() + interval '1 day')$$,
  '23503', null, 'organisation inexistante refusée (FK)'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values (null, 'c1@inv.test', 'analyst', repeat('b', 64), now() + interval '1 day')$$,
  '23502', null, 'organization_id NULL refusé'
);
insert into public.invitations (id, organization_id, email_normalized, role, token_hash, expires_at)
values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'c1@inv.test', 'analyst', repeat('b', 64), now() + interval '1 day');
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000003', 'other@inv.test', 'analyst', repeat('b', 64), now() + interval '1 day')$$,
  '23505', null, 'token_hash dupliqué refusé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000003', 'c1@inv.test', 'sales_agent', repeat('c', 64), now() + interval '1 day')$$,
  '23505', null, 'deux invitations en attente pour le même (org, e-mail) refusées'
);
select lives_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000002', 'c1@inv.test', 'sales_agent', repeat('c', 64), now() + interval '1 day')$$,
  'le même e-mail peut être invité dans une autre organisation'
);
update public.invitations set revoked_at = now() where id = '30000000-0000-4000-8000-000000000001';
select lives_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000003', 'c1@inv.test', 'sales_agent', repeat('d', 64), now() + interval '1 day')$$,
  'après révocation, une nouvelle invitation en attente est possible'
);
select throws_ok(
  $$update public.invitations set organization_id = '20000000-0000-4000-8000-000000000002'
     where id = '30000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'organization_id est immuable'
);
select throws_ok(
  $$delete from public.organizations where id = '20000000-0000-4000-8000-000000000003'$$,
  '23503', null, 'une organisation ayant des invitations ne peut pas être supprimée (RESTRICT)'
);
delete from public.invitations where organization_id in
  ('20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------------
-- 5. create_invitation
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', null, 'create_invitation : anon refusé'
);
reset role;

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '28000', 'unauthenticated', 'create_invitation : JWT sans sub => unauthenticated'
);
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '28000', 'unauthenticated', 'create_invitation : sans revendication => unauthenticated'
);

-- Rôles non habilités : marketing, sales, analyst, outsider (aucune adhésion), owner d'une AUTRE entreprise
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : marketing_manager refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : sales_agent refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : analyst refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : utilisateur sans adhésion refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : owner d''une autre entreprise refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : membre suspendu refusé'
);

-- Admin : jamais company_owner
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'company_owner', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : un admin ne peut pas inviter company_owner'
);

-- Owner : organisation falsifiée / nulle, validations
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000002', 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : owner d''Alpha ne peut pas inviter dans Beta'
);
select throws_ok(
  $$select public.create_invitation(null, 'x1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '42501', 'forbidden', 'create_invitation : organisation NULL refusée'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'sans-arobase', 'analyst', lpad('1', 64, '0'))$$,
  '22023', 'validation_failed', 'create_invitation : e-mail sans arobase'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', '', 'analyst', lpad('1', 64, '0'))$$,
  '22023', 'validation_failed', 'create_invitation : e-mail vide'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', null, 'analyst', lpad('1', 64, '0'))$$,
  '22023', 'validation_failed', 'create_invitation : e-mail NULL'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'a b@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  '22023', 'validation_failed', 'create_invitation : e-mail avec espace interne'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', repeat('a', 250) || '@b.cd', 'analyst', lpad('1', 64, '0'))$$,
  '22023', 'validation_failed', 'create_invitation : e-mail de plus de 254 caractères'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', null::public.app_role, lpad('1', 64, '0'))$$,
  '22023', 'validation_failed', 'create_invitation : rôle NULL'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', 'abc')$$,
  '22023', 'validation_failed', 'create_invitation : token_hash trop court'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', repeat('G', 64))$$,
  '22023', 'validation_failed', 'create_invitation : token_hash non hexadécimal minuscule'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'x1@inv.test', 'analyst', null)$$,
  '22023', 'validation_failed', 'create_invitation : token_hash NULL'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', ' A1@INV.Test ', 'analyst', lpad('1', 64, '0'))$$,
  'P0001', 'already_member', 'create_invitation : e-mail d''un membre actif (casse/espaces ignorés)'
);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'o1@inv.test', 'analyst', lpad('1', 64, '0'))$$,
  'P0001', 'already_member', 'create_invitation : l''owner lui-même est déjà membre'
);
reset role;
select is(
  (select count(*)::int from public.invitations where organization_id = '20000000-0000-4000-8000-000000000001'),
  0,
  'aucun des appels refusés n''a créé de ligne'
);

-- Succès : e-mail normalisé, rôle, expiration 7 jours, invited_by
set local role authenticated;
select set_config('t.inv1', public.create_invitation('20000000-0000-4000-8000-000000000001', '  Invitee@Inv.Test ', 'sales_agent', lpad('1', 64, '0'))::text, true);
reset role;
select is(
  (select email_normalized from public.invitations where id = current_setting('t.inv1')::uuid),
  'invitee@inv.test',
  'e-mail stocké en minuscules, sans espaces'
);
select ok(
  (select role = 'sales_agent' and token_hash = lpad('1', 64, '0') and accepted_at is null and revoked_at is null
     and accepted_by is null
     and invited_by = '10000000-0000-4000-8000-000000000001'
     and organization_id = '20000000-0000-4000-8000-000000000001'
    from public.invitations where id = current_setting('t.inv1')::uuid),
  'invitation en attente : rôle, hash, inviteur, organisation'
);
select ok(
  (select expires_at = now() + interval '7 days' from public.invitations where id = current_setting('t.inv1')::uuid),
  'expiration = maintenant + 7 jours'
);

-- Admin peut inviter un rôle non-owner ; owner peut inviter company_owner
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'second@inv.test', 'marketing_manager', lpad('2', 64, '0'))$$,
  'create_invitation : un admin invite un marketing_manager'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'ownerinv@inv.test', 'company_owner', lpad('3', 64, '0'))$$,
  'create_invitation : un owner invite un company_owner'
);

-- Ré-invitation : atomique, l'ancien jeton cesse de fonctionner
select set_config('t.inv1b', public.create_invitation('20000000-0000-4000-8000-000000000001', 'invitee@inv.test', 'sales_agent', lpad('4', 64, '0'))::text, true);
reset role;
select ok(
  (select revoked_at is not null from public.invitations where id = current_setting('t.inv1')::uuid),
  'ré-invitation : l''invitation précédente est révoquée'
);
select is(
  (select count(*)::int from public.invitations
    where organization_id = '20000000-0000-4000-8000-000000000001' and email_normalized = 'invitee@inv.test'
      and accepted_at is null and revoked_at is null),
  1,
  'ré-invitation : une seule invitation en attente'
);
select is(
  (select token_hash from public.invitations where id = current_setting('t.inv1b')::uuid),
  lpad('4', 64, '0'),
  'ré-invitation : la nouvelle invitation porte le nouveau hash'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select throws_ok(
  $$select public.accept_invitation(lpad('1', 64, '0'))$$,
  'P0001', 'invitation_invalid', 'ancien jeton (révoqué par la ré-invitation) : refusé'
);

-- Atomicité : un échec de l'insertion (hash déjà utilisé) n'annule pas seulement l'insertion, il laisse
-- l'invitation précédente intacte (la révocation est annulée avec la transaction de l'appel).
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000001', 'invitee@inv.test', 'sales_agent', lpad('2', 64, '0'))$$,
  '23505', null, 'ré-invitation avec un hash déjà pris : échec'
);
reset role;
select ok(
  (select revoked_at is null from public.invitations where id = current_setting('t.inv1b')::uuid),
  'atomicité : l''invitation en attente n''a PAS été révoquée par l''appel échoué'
);

-- ---------------------------------------------------------------------------
-- 6. Visibilité (RLS)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select lives_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000002', 'bee@inv.test', 'analyst', lpad('6', 64, '0'))$$,
  'owner Beta invite dans Beta'
);

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.invitations),
  4,
  'owner Alpha voit les 4 invitations d''Alpha (2 + ancienne révoquée + 1 owner) et aucune de Beta'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.invitations where organization_id = '20000000-0000-4000-8000-000000000001'),
  4,
  'admin Alpha voit les invitations d''Alpha'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*)::int from public.invitations), 0, 'marketing_manager ne voit aucune invitation');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is((select count(*)::int from public.invitations), 0, 'sales_agent ne voit aucune invitation');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select is((select count(*)::int from public.invitations), 0, 'analyst ne voit aucune invitation');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select is((select count(*)::int from public.invitations), 0, 'utilisateur sans adhésion ne voit aucune invitation');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.invitations), 0, 'membre suspendu ne voit aucune invitation');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.invitations where organization_id = '20000000-0000-4000-8000-000000000001'),
  0,
  'owner Beta ne voit aucune invitation d''Alpha'
);
select is((select count(*)::int from public.invitations), 1, 'owner Beta voit sa seule invitation');

-- Écritures directes et colonne token_hash refusées
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select token_hash from public.invitations$$, '42501', null, 'owner : token_hash illisible (privilège de colonne)');
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', 'direct@inv.test', 'analyst', repeat('e', 64), now() + interval '1 day')$$,
  '42501', null, 'owner : INSERT direct refusé'
);
select throws_ok($$update public.invitations set revoked_at = now()$$, '42501', null, 'owner : UPDATE direct refusé');
select throws_ok($$delete from public.invitations$$, '42501', null, 'owner : DELETE direct refusé');
reset role;

set local role anon;
select throws_ok($$select count(*) from public.invitations$$, '42501', null, 'anon : lecture refusée');
reset role;

-- ---------------------------------------------------------------------------
-- 7. revoke_invitation
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select set_config('t.rev', public.create_invitation('20000000-0000-4000-8000-000000000001', 'revme@inv.test', 'analyst', lpad('5', 64, '0'))::text, true);
reset role;
select set_config('t.ownerinv', (select id::text from public.invitations where token_hash = lpad('3', 64, '0')), true);
select set_config('t.secondinv', (select id::text from public.invitations where token_hash = lpad('2', 64, '0')), true);
select set_config('t.beeinv', (select id::text from public.invitations where token_hash = lpad('6', 64, '0')), true);

set local role anon;
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.rev')),
  '42501', null, 'revoke_invitation : anon refusé'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.rev')),
  '28000', 'unauthenticated', 'revoke_invitation : non authentifié'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.rev')),
  '42501', 'forbidden', 'revoke_invitation : sales_agent refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.rev')),
  '42501', 'forbidden', 'revoke_invitation : owner d''une autre entreprise refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.ownerinv')),
  '42501', 'forbidden', 'revoke_invitation : un admin ne peut pas révoquer une invitation company_owner'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.beeinv')),
  'P0001', 'invitation_invalid', 'revoke_invitation : invitation d''une autre organisation => invitation_invalid'
);
select throws_ok(
  $$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'invitation_invalid', 'revoke_invitation : identifiant inconnu'
);
select throws_ok(
  format($$select public.revoke_invitation(null, %L)$$, current_setting('t.rev')),
  '42501', 'forbidden', 'revoke_invitation : organisation NULL'
);
select lives_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.rev')),
  'revoke_invitation : l''owner révoque une invitation en attente'
);
select throws_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.rev')),
  'P0001', 'invitation_invalid', 'revoke_invitation : déjà révoquée'
);
select lives_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.ownerinv')),
  'revoke_invitation : l''owner révoque une invitation company_owner'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok(
  format($$select public.revoke_invitation('20000000-0000-4000-8000-000000000001', %L)$$, current_setting('t.secondinv')),
  'revoke_invitation : un admin révoque une invitation non-owner'
);
reset role;
select ok(
  (select revoked_at is not null from public.invitations where token_hash = lpad('5', 64, '0')),
  'revoked_at renseigné après révocation'
);
select ok(
  (select revoked_at is null from public.invitations where id = current_setting('t.beeinv')::uuid),
  'l''invitation de l''autre organisation est intacte'
);

-- ---------------------------------------------------------------------------
-- 8. accept_invitation
-- ---------------------------------------------------------------------------
-- Pré-requis : invitations de test (insérées en superuser quand create_invitation les refuserait)
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by) values
  ('20000000-0000-4000-8000-000000000001', 'stranger@inv.test', 'analyst', lpad('7', 64, '0'), now() - interval '1 second', '10000000-0000-4000-8000-000000000001'), -- expirée
  ('20000000-0000-4000-8000-000000000001', 'unconf@inv.test', 'analyst', lpad('8', 64, '0'), now() + interval '1 day', '10000000-0000-4000-8000-000000000001'), -- e-mail non confirmé
  ('20000000-0000-4000-8000-000000000001', 's1@inv.test', 'analyst', lpad('c', 64, '0'), now() + interval '1 day', '10000000-0000-4000-8000-000000000001'); -- déjà membre actif

set local role anon;
select throws_ok($$select public.accept_invitation(lpad('4', 64, '0'))$$, '42501', null, 'accept_invitation : anon refusé');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{}', true);
select throws_ok($$select public.accept_invitation(lpad('4', 64, '0'))$$, '28000', 'unauthenticated', 'accept_invitation : non authentifié');

-- Toutes les causes d'échec produisent EXACTEMENT la même erreur (SQLSTATE, message, detail, hint)
select set_config('t.sigs', '', true);
do $$
declare
  v_causes text[][] := array[
    array['10000000-0000-4000-8000-000000000007', lpad('f', 64, '0')],  -- jeton inconnu
    array['10000000-0000-4000-8000-000000000007', 'zz'],                 -- format invalide
    array['10000000-0000-4000-8000-000000000009', lpad('4', 64, '0')],  -- e-mail différent
    array['10000000-0000-4000-8000-000000000008', lpad('8', 64, '0')],  -- e-mail non confirmé
    array['10000000-0000-4000-8000-000000000009', lpad('7', 64, '0')],  -- expirée
    array['10000000-0000-4000-8000-000000000014', lpad('5', 64, '0')],  -- révoquée
    array['10000000-0000-4000-8000-000000000004', lpad('c', 64, '0')]   -- déjà membre actif
  ];
  i int;
  v_state text; v_msg text; v_detail text; v_hint text;
  v_sigs text[] := '{}';
  v_sig text;
begin
  for i in 1 .. array_length(v_causes, 1) loop
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', v_causes[i][1]), true);
    begin
      perform public.accept_invitation(v_causes[i][2]);
      v_sig := 'NO ERROR';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
        v_detail = pg_exception_detail, v_hint = pg_exception_hint;
      v_sig := v_state || '|' || v_msg || '|' || coalesce(v_detail, '') || '|' || coalesce(v_hint, '');
    end;
    if not (v_sig = any (v_sigs)) then v_sigs := v_sigs || v_sig; end if;
  end loop;
  perform set_config('t.sigs', array_to_string(v_sigs, ' ## '), true);
end $$;
select is(
  current_setting('t.sigs'),
  'P0001|invitation_invalid||',
  'accept_invitation : jeton inconnu, format invalide, e-mail différent, non confirmé, expiré, révoqué, déjà membre => MÊME erreur'
);

-- Chaque cause isolée (messages et SQLSTATE)
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('4', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : e-mail du compte différent de l''invitation');
select throws_ok($$select public.accept_invitation(lpad('7', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : invitation expirée');
select throws_ok($$select public.accept_invitation(null)$$, 'P0001', 'invitation_invalid', 'accept : hash NULL');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('8', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : e-mail non confirmé');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('c', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : déjà membre actif');
reset role;
select ok(
  (select role = 'sales_agent' and status = 'active' from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000004'),
  'membre actif : son rôle n''a pas changé'
);
select ok(
  (select accepted_at is null from public.invitations where token_hash = lpad('c', 64, '0')),
  'invitation refusée : accepted_at reste NULL (atomicité)'
);

-- Succès : l'invité (e-mail confirmé identique) devient membre avec le rôle invité
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select is(
  public.accept_invitation(lpad('4', 64, '0')),
  '20000000-0000-4000-8000-000000000001'::uuid,
  'accept_invitation : renvoie l''identifiant de l''organisation'
);
select throws_ok($$select public.accept_invitation(lpad('4', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : seconde acceptation (usage unique)');
reset role;
select ok(
  (select role = 'sales_agent' and status = 'active'
      and invited_by = '10000000-0000-4000-8000-000000000001'
    from public.organization_members
   where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000007'),
  'adhésion créée : active, rôle invité, invited_by = inviteur'
);
select ok(
  (select accepted_at is not null and accepted_by = '10000000-0000-4000-8000-000000000007' and revoked_at is null
     from public.invitations where token_hash = lpad('4', 64, '0')),
  'accepted_at et accepted_by renseignés dans la même transaction'
);
select is(
  (select count(*)::int from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000007'),
  1,
  'une seule adhésion après deux tentatives'
);

-- E-mail du compte en casse mixte : la comparaison se fait en minuscules
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('20000000-0000-4000-8000-000000000001', 'mixed.case@inv.test', 'marketing_manager', lpad('9', 64, '0'), now() + interval '1 day', '10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select lives_ok($$select public.accept_invitation(lpad('9', 64, '0'))$$, 'accept : e-mail du compte en casse mixte accepté');
reset role;

-- Membre retiré : ré-activation avec le NOUVEAU rôle (même ligne d'adhésion)
select set_config('t.removed_member', (select id::text from public.organization_members
   where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-00000000000a'), true);
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('20000000-0000-4000-8000-000000000001', 'removed@inv.test', 'marketing_manager', lpad('a', 64, '0'), now() + interval '1 day', '10000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.accept_invitation(lpad('a', 64, '0'))$$, 'accept : un membre retiré est ré-activé');
reset role;
select ok(
  (select id = current_setting('t.removed_member')::uuid and role = 'marketing_manager' and status = 'active'
      and invited_by = '10000000-0000-4000-8000-000000000002'
    from public.organization_members
   where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-00000000000a'),
  'ré-activation : même ligne, rôle de la nouvelle invitation, statut actif'
);
select is(
  (select count(*)::int from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-00000000000a'),
  1,
  'ré-activation : aucune ligne dupliquée'
);

-- Membre suspendu : refusé, rien ne change
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('20000000-0000-4000-8000-000000000001', 'suspended@inv.test', 'analyst', lpad('b', 64, '0'), now() + interval '1 day', '10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('b', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : un membre suspendu ne peut pas se ré-activer par invitation');
reset role;
select ok(
  (select status = 'suspended' and role = 'sales_agent' from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-00000000000b')
  and (select accepted_at is null from public.invitations where token_hash = lpad('b', 64, '0')),
  'suspendu : adhésion inchangée et invitation non consommée'
);

-- Statut « invited » : activé avec le rôle de l'invitation
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('20000000-0000-4000-8000-000000000001', 'pending-status@inv.test', 'marketing_manager', lpad('d', 64, '0'), now() + interval '1 day', '10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
select lives_ok($$select public.accept_invitation(lpad('d', 64, '0'))$$, 'accept : une adhésion au statut invited est activée');
reset role;
select ok(
  (select status = 'active' and role = 'marketing_manager' from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-00000000000d'),
  'statut invited : active avec le rôle invité'
);

-- Un utilisateur qui accepte devient membre : il peut ensuite (rôle sales) lire son entreprise
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.organizations where id = '20000000-0000-4000-8000-000000000001'),
  1,
  'le nouveau membre voit son entreprise (RLS)'
);
select is((select count(*)::int from public.invitations), 0, 'le nouveau membre (sales_agent) ne voit toujours aucune invitation');
reset role;

-- ---------------------------------------------------------------------------
-- 9. transfer_ownership (entreprise Gamma)
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000010')$$,
  '42501', null, 'transfer_ownership : anon refusé'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000010')$$,
  '28000', 'unauthenticated', 'transfer_ownership : non authentifié'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000f","role":"authenticated"}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000010')$$,
  '42501', 'forbidden', 'transfer_ownership : un company_admin ne peut pas transférer la propriété'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000013","role":"authenticated"}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000013')$$,
  '42501', 'forbidden', 'transfer_ownership : un marketing_manager ne peut pas se promouvoir'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009')$$,
  '42501', 'forbidden', 'transfer_ownership : un utilisateur sans adhésion refusé'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000010')$$,
  '42501', 'forbidden', 'transfer_ownership : owner d''une autre entreprise refusé'
);
select throws_ok(
  $$select public.transfer_ownership(null, '10000000-0000-4000-8000-000000000010')$$,
  '42501', 'forbidden', 'transfer_ownership : organisation NULL'
);

-- L'owner de Gamma : cibles invalides
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009')$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible sans adhésion'
);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004')$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible membre d''une AUTRE entreprise'
);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000011')$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible suspendue'
);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000012')$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible retirée'
);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-00000000000e')$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible = soi-même'
);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', null)$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible NULL'
);
reset role;
select is(
  (select array_agg(user_id::text || ':' || role::text order by user_id) filter (where role in ('company_owner', 'company_admin'))
     from public.organization_members where organization_id = '20000000-0000-4000-8000-000000000003'),
  array['10000000-0000-4000-8000-00000000000e:company_owner', '10000000-0000-4000-8000-00000000000f:company_admin'],
  'échecs : rôles de Gamma inchangés'
);

-- Invariant du dernier owner (trigger protect_last_owner) : toujours actif, non contourné
select throws_ok(
  $$update public.organization_members set role = 'company_admin'
     where organization_id = '20000000-0000-4000-8000-000000000003' and user_id = '10000000-0000-4000-8000-00000000000e'$$,
  '23514', null, 'le dernier owner ne peut pas être rétrogradé directement (trigger)'
);

-- Cible déjà owner : refusée
insert into public.organization_members (organization_id, user_id, role, status)
values ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009', 'company_owner', 'active');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000009')$$,
  'P0001', 'invalid_target', 'transfer_ownership : cible déjà owner'
);
reset role;
delete from public.organization_members
 where organization_id = '20000000-0000-4000-8000-000000000003' and user_id = '10000000-0000-4000-8000-000000000009';

-- Succès : sales_agent actif => owner ; ancien owner => admin
set local role authenticated;
select lives_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000010')$$,
  'transfer_ownership : l''owner transfère à un membre actif'
);
reset role;
select is(
  (select role::text || ':' || status::text from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000003' and user_id = '10000000-0000-4000-8000-000000000010'),
  'company_owner:active',
  'la cible est promue company_owner'
);
select is(
  (select role::text || ':' || status::text from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000003' and user_id = '10000000-0000-4000-8000-00000000000e'),
  'company_admin:active',
  'l''ancien owner est rétrogradé company_admin (toujours actif)'
);
select is(
  (select count(*)::int from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000003' and role = 'company_owner' and status = 'active'),
  1,
  'exactement un owner actif après le transfert'
);
set local role authenticated;
select throws_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-00000000000e')$$,
  '42501', 'forbidden', 'l''ancien owner (devenu admin) ne peut plus transférer'
);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000010","role":"authenticated"}', true);
select lives_ok(
  $$select public.transfer_ownership('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-00000000000e')$$,
  'le nouvel owner peut à son tour transférer'
);
reset role;

-- ---------------------------------------------------------------------------
-- 10. accept_invitation : ré-vérification de l'inviteur AU MOMENT de l'acceptation (ADR 014)
--     Entreprise Delta ; inviteurs 1..11 (ids 11…), invités 1..11 (ids 12…), owner permanent 13…01.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
select ('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated', 'authenticated', 'inviter' || n || '@d.test', now()
  from generate_series(1, 11) n
union all
select ('12000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated', 'authenticated', 'invitee' || n || '@d.test', now()
  from generate_series(1, 11) n
union all
select '13000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated', 'authenticated', 'downer@d.test', now();

insert into public.organizations (id, name, slug) values
  ('20000000-0000-4000-8000-000000000004', 'Inv Delta', 'inv-delta-test');
-- Abonnement de test : limite d'utilisateurs très haute (ces tests ne portent pas sur les quotas, voir 090).
insert into public.subscriptions (organization_id, plan_id, limits_override)
  select o.id, (select id from public.plans where code = 'growth'), '{"users": 100000}'::jsonb from public.organizations o
   where not exists (select 1 from public.subscriptions s where s.organization_id = o.id);

insert into public.organization_members (organization_id, user_id, role, status)
select '20000000-0000-4000-8000-000000000004'::uuid, ('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
       (case when n in (8, 10) then 'company_owner' else 'company_admin' end)::public.app_role, 'active'::public.member_status
  from generate_series(1, 11) n
union all
select '20000000-0000-4000-8000-000000000004'::uuid, '13000000-0000-4000-8000-000000000001'::uuid, 'company_owner'::public.app_role, 'active'::public.member_status;

-- Invitation n (hash 'e' || n en hexa) : rôle company_owner pour 8, 10, 11 ; invited_by NULL pour 7.
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
select '20000000-0000-4000-8000-000000000004'::uuid, 'invitee' || n || '@d.test',
       (case when n in (8, 10, 11) then 'company_owner' else 'analyst' end)::public.app_role,
       lpad('e' || to_hex(n), 64, '0'), now() + interval '1 day',
       case when n = 7 then null else ('11000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid end
  from generate_series(1, 11) n;

-- L'état des inviteurs change APRÈS la création des invitations (cas d'une fenêtre de 7 jours).
update public.organization_members set status = 'removed'
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000001';
update public.organization_members set status = 'suspended'
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000002';
update public.organization_members set role = 'marketing_manager'
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000003';
update public.organization_members set role = 'sales_agent'
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000004';
update public.organization_members set role = 'analyst'
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000005';
delete from public.organization_members
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000006';
-- 7 : invited_by NULL (déjà). 8 : owner rétrogradé admin (il reste d'autres owners actifs).
update public.organization_members set role = 'company_admin'
 where organization_id = '20000000-0000-4000-8000-000000000004' and user_id = '11000000-0000-4000-8000-000000000008';
-- 11 : un admin a invité le rôle company_owner (jamais permis) => invalide à l'acceptation.

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e1', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : inviteur retiré => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e2', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : inviteur suspendu => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e3', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : inviteur rétrogradé marketing_manager => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e4', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : inviteur rétrogradé sales_agent => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e5', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : inviteur rétrogradé analyst => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e6', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : ligne d''adhésion de l''inviteur supprimée => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e7', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : invited_by NULL => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('e8', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : invitation company_owner dont l''inviteur est devenu admin => invitation_invalid');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select throws_ok($$select public.accept_invitation(lpad('eb', 64, '0'))$$, 'P0001', 'invitation_invalid', 'accept : invitation company_owner émise par un admin => invitation_invalid');

-- Toutes ces causes produisent EXACTEMENT la même signature d'erreur (SQLSTATE, message, detail, hint).
select set_config('t.sigs2', '', true);
do $$
declare
  i int;
  v_state text; v_msg text; v_detail text; v_hint text;
  v_sigs text[] := '{}';
  v_sig text;
begin
  foreach i in array array[1, 2, 3, 4, 5, 6, 7, 8, 11] loop
    perform set_config('request.jwt.claims',
      format('{"sub":"12000000-0000-4000-8000-%s","role":"authenticated"}', lpad(to_hex(i), 12, '0')), true);
    begin
      perform public.accept_invitation(lpad('e' || to_hex(i), 64, '0'));
      v_sig := 'NO ERROR';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
        v_detail = pg_exception_detail, v_hint = pg_exception_hint;
      v_sig := v_state || '|' || v_msg || '|' || coalesce(v_detail, '') || '|' || coalesce(v_hint, '');
    end;
    if not (v_sig = any (v_sigs)) then v_sigs := v_sigs || v_sig; end if;
  end loop;
  perform set_config('t.sigs2', array_to_string(v_sigs, ' ## '), true);
end $$;
select is(current_setting('t.sigs2'), 'P0001|invitation_invalid||',
  'accept : toutes les causes « inviteur invalide » renvoient la MÊME erreur générique');
reset role;
select is(
  (select count(*)::int from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000004'
      and user_id in (select ('12000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid from unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 11]) n)),
  0,
  'inviteur invalide : aucune adhésion créée pour les invités'
);
select is(
  (select count(*)::int from public.invitations
    where organization_id = '20000000-0000-4000-8000-000000000004' and accepted_at is not null),
  0,
  'inviteur invalide : aucune invitation consommée (atomicité)'
);

-- Contrôles positifs : inviteur admin toujours actif => ok ; owner qui invite un owner => ok.
update public.invitations set invited_by = '11000000-0000-4000-8000-000000000009', role = 'analyst'
 where token_hash = lpad('e9', 64, '0');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
select lives_ok($$select public.accept_invitation(lpad('e9', 64, '0'))$$, 'accept : inviteur admin toujours actif => accepté');
select set_config('request.jwt.claims', '{"sub":"12000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select lives_ok($$select public.accept_invitation(lpad('ea', 64, '0'))$$, 'accept : owner actif invitant un company_owner => accepté');
reset role;
select is(
  (select array_agg(user_id::text || ':' || role::text || ':' || status::text order by user_id) from public.organization_members
    where organization_id = '20000000-0000-4000-8000-000000000004'
      and user_id in ('12000000-0000-4000-8000-000000000009', '12000000-0000-4000-8000-00000000000a')),
  array['12000000-0000-4000-8000-000000000009:analyst:active', '12000000-0000-4000-8000-00000000000a:company_owner:active'],
  'contrôles positifs : adhésions actives avec le rôle invité'
);

-- ---------------------------------------------------------------------------
-- 11. Hygiène de l'e-mail : ASCII imprimable sans espace uniquement (RPC directe + CHECK de table)
-- ---------------------------------------------------------------------------
select set_config('t.inv_before', (select count(*)::text from public.invitations), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"13000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  format($$select public.create_invitation('20000000-0000-4000-8000-000000000004', %L, 'analyst', %L)$$, v.email, lpad('1', 64, '0')),
  '22023', 'validation_failed', 'create_invitation : ' || v.label)
from (values
  ('U+202E (bidi) dans la partie locale', 'a' || chr(8238) || 'b@inv.test'),
  ('U+202E (bidi) en fin de saisie', 'x1@inv.test' || chr(8238)),
  ('U+200B (largeur nulle)', 'a' || chr(8203) || 'b@inv.test'),
  ('U+0085 (NEL) dans la saisie', 'a' || chr(133) || 'b@inv.test'),
  ('U+0085 (NEL) en fin de saisie', 'x1@inv.test' || chr(133)),
  ('espace insécable U+00A0 interne', 'a' || chr(160) || 'b@inv.test'),
  ('espace insécable U+00A0 en tête', chr(160) || 'x1@inv.test'),
  ('lettre pleine chasse U+FF21', chr(65313) || 'bc@inv.test'),
  ('arobase pleine chasse U+FF20', 'abc' || chr(65312) || 'inv.test'),
  ('domaine IDN (u tréma)', 'user@b' || chr(252) || 'cher.test'),
  ('signe Kelvin U+212A (devient k par lower())', chr(8490) || 'x@inv.test'),
  ('tabulation interne', 'a' || chr(9) || 'b@inv.test'),
  ('tabulation finale', 'x1@inv.test' || chr(9)),
  ('saut de ligne interne', 'a' || chr(10) || 'b@inv.test'),
  ('CRLF final', 'x1@inv.test' || chr(13) || chr(10)),
  ('DEL (U+007F)', 'a' || chr(127) || 'b@inv.test'),
  ('255 caractères', repeat('a', 250) || '@b.cd')
) as v (label, email);
reset role;
select is(
  (select count(*)::text from public.invitations), current_setting('t.inv_before'),
  'e-mail invalide : aucune invitation stockée par les appels rejetés'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"13000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000004', 'Upper.Case@INV.TEST', 'analyst', lpad('ab1', 64, '0'))$$,
  'create_invitation : majuscules acceptées');
select lives_ok(
  $$select public.create_invitation('20000000-0000-4000-8000-000000000004', 'plus+tag@inv.test', 'analyst', lpad('ab2', 64, '0'))$$,
  'create_invitation : adressage plus accepté');
select lives_ok(
  format($$select public.create_invitation('20000000-0000-4000-8000-000000000004', %L, 'analyst', %L)$$, repeat('a', 249) || '@b.cd', lpad('ab3', 64, '0')),
  'create_invitation : 254 caractères acceptés');
reset role;
select is(
  (select array_agg(email_normalized order by token_hash) from public.invitations where token_hash in (lpad('ab1', 64, '0'), lpad('ab2', 64, '0'))),
  array['upper.case@inv.test', 'plus+tag@inv.test'],
  'majuscules normalisées en minuscules, +tag conservé'
);
select is(
  (select char_length(email_normalized) from public.invitations where token_hash = lpad('ab3', 64, '0')),
  254,
  'l''e-mail de 254 caractères est stocké tel quel'
);

-- CHECK de table (insertion directe, superuser) : mêmes familles de caractères
select throws_ok(
  format($$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
           values ('20000000-0000-4000-8000-000000000004', %L, 'analyst', %L, now() + interval '1 day')$$, v.email, lpad('1', 64, '0')),
  '23514', null, 'CHECK de table : ' || v.label)
from (values
  ('U+202E (bidi) interne', 'a' || chr(8238) || 'b@inv.test'),
  ('U+202E (bidi) final', 'x1@inv.test' || chr(8238)),
  ('U+200B (largeur nulle)', 'a' || chr(8203) || 'b@inv.test'),
  ('U+0085 (NEL)', 'a' || chr(133) || 'b@inv.test'),
  ('espace insécable U+00A0', 'a' || chr(160) || 'b@inv.test'),
  ('lettre pleine chasse minuscule U+FF41', chr(65345) || 'bc@inv.test'),
  ('arobase pleine chasse U+FF20', 'abc' || chr(65312) || 'inv.test'),
  ('domaine IDN', 'user@b' || chr(252) || 'cher.test'),
  ('signe Kelvin U+212A', chr(8490) || 'x@inv.test'),
  ('tabulation interne', 'a' || chr(9) || 'b@inv.test'),
  ('tabulation finale', 'x1@inv.test' || chr(9)),
  ('saut de ligne interne', 'a' || chr(10) || 'b@inv.test'),
  ('CRLF final', 'x1@inv.test' || chr(13) || chr(10)),
  ('DEL (U+007F)', 'a' || chr(127) || 'b@inv.test'),
  ('255 caractères', repeat('a', 250) || '@b.cd')
) as v (label, email);
select lives_ok(
  format($$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
           values ('20000000-0000-4000-8000-000000000004', %L, 'analyst', %L, now() + interval '1 day')$$, repeat('c', 249) || '@b.cd', lpad('ab4', 64, '0')),
  'CHECK de table : 254 caractères acceptés'
);
select is(
  (select count(*)::int from public.invitations where token_hash in (lpad('ab1', 64, '0'), lpad('ab2', 64, '0'), lpad('ab3', 64, '0'), lpad('ab4', 64, '0'))),
  4,
  'seules les quatre lignes valides ont été stockées par les sections 11'
);

select * from finish();
rollback;
