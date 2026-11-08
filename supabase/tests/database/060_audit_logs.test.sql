-- J12 — Journal d'audit : table, RLS, GRANT, immuabilité, caviardage, masquage d'e-mail, audit_write,
-- triggers (organisations, membres, invitations), attribution de l'acteur, request_id, atomicité,
-- isolation inter-entreprises et flux J9/J10 (ADR 007 G-D10, ADR 014, menaces D2, G1, G2).
-- Les lectures RLS s'exécutent sous `authenticated` / `anon` avec un JWT de test (seul `sub` compte) ;
-- les mutations de test s'exécutent sous le propriétaire (les triggers d'audit se déclenchent quand même)
-- ou sous authenticated pour les flux. Le journal étant append-only, les assertions portent sur les lignes
-- « fraîches » (créées depuis le dernier repère `pg_temp.step()`). Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(327);

-- ---------------------------------------------------------------------------
-- Aides de test (schéma temporaire)
-- ---------------------------------------------------------------------------
create temporary table seen (id uuid primary key) on commit drop;
grant all on table seen to public;

create function pg_temp.u(n integer) returns uuid language sql immutable
as $f$ select ('70000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $f$;
create function pg_temp.o(n integer) returns uuid language sql immutable
as $f$ select ('80000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $f$;
-- id de la ligne d'adhésion (organisation, utilisateur)
create function pg_temp.mid(p_org uuid, p_user uuid) returns uuid language sql stable
as $f$ select m.id from public.organization_members m where m.organization_id = p_org and m.user_id = p_user $f$;

-- Repère : toutes les lignes d'audit existantes deviennent « vues ».
create function pg_temp.step() returns void language sql
as $f$ insert into pg_temp.seen select a.id from public.audit_logs a where not exists (select 1 from pg_temp.seen s where s.id = a.id) $f$;
create function pg_temp.fresh() returns setof public.audit_logs language sql stable
as $f$ select a.* from public.audit_logs a where not exists (select 1 from pg_temp.seen s where s.id = a.id) $f$;
create function pg_temp.fc() returns integer language sql stable
as $f$ select count(*)::int from pg_temp.fresh() $f$;
-- Forme comparable d'une ligne fraîche (par action) et constructeur de la forme attendue.
create function pg_temp.fa(p_action text) returns jsonb language sql stable
as $f$
  select jsonb_build_object('t', f.entity_type, 'e', f.entity_id, 'o', f.organization_id,
                            'k', f.actor_kind, 'b', f.before, 'a', f.after)
    from pg_temp.fresh() f where f.action = p_action
   order by f.after::text limit 1
$f$;
create function pg_temp.ex(t text, e uuid, o uuid, k text, b jsonb, a jsonb) returns jsonb language sql immutable
as $f$ select jsonb_build_object('t', t, 'e', e, 'o', o, 'k', k, 'b', b, 'a', a) $f$;
create function pg_temp.actor_of(p_action text) returns uuid language sql stable
as $f$ select f.actor_id from pg_temp.fresh() f where f.action = p_action order by f.after::text limit 1 $f$;
create function pg_temp.as_user(n integer) returns void language plpgsql
as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$f$;
-- request_id capturé pour un en-tête simulé (request.headers)
create function pg_temp.rid_for(p_headers text) returns text language plpgsql
as $f$
declare
  v_e uuid := gen_random_uuid();
  v_r text;
begin
  perform set_config('request.headers', p_headers, true);
  perform private.audit_write(pg_temp.o(3), 'test.rid', 'test', v_e, null, null);
  perform set_config('request.headers', '', true);
  select a.request_id into v_r from public.audit_logs a where a.entity_id = v_e;
  return v_r;
end;
$f$;
create function pg_temp.deep(n integer) returns jsonb language plpgsql
as $f$
declare
  j jsonb := '{"password":"LEAKME","v":1}';
begin
  for i in 1..n loop
    j := jsonb_build_object('n', j);
  end loop;
  return j;
end;
$f$;
grant execute on all functions in schema pg_temp to public;

-- ---------------------------------------------------------------------------
-- Données de test (insérées SANS JWT : acteur « système »)
-- u1 owner Alpha · u2 admin Alpha · u3 marketing · u4 sales · u5 analyst · u6 owner Beta · u7 sans adhésion
-- u8 invité (invitee@aud.test) · u9 acteur simple (sans adhésion) · u10 créateur d'organisation
-- u11 admin Alpha SUSPENDU · u12 admin Alpha RETIRÉ · u13 membre « mover » · u14 retiré réinvité (again@aud.test)
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
select pg_temp.u(n), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now()
from (values
  (1, 'o1@aud.test'), (2, 'a1@aud.test'), (3, 'm1@aud.test'), (4, 's1@aud.test'), (5, 'n1@aud.test'),
  (6, 'ob@aud.test'), (7, 'nobody@aud.test'), (8, 'invitee@aud.test'), (9, 'actor@aud.test'),
  (10, 'creator@aud.test'), (11, 'susp@aud.test'), (12, 'gone@aud.test'), (13, 'mover@aud.test'),
  (14, 'again@aud.test')
) as t (n, e);

insert into public.organizations (id, name, slug) values
  (pg_temp.o(1), 'Aud Alpha', 'aud-alpha-test'),
  (pg_temp.o(2), 'Aud Beta', 'aud-beta-test'),
  (pg_temp.o(3), 'Aud Gamma', 'aud-gamma-test');
-- Abonnement de test : limite d'utilisateurs très haute (ces tests ne portent pas sur les quotas, voir 090).
insert into public.subscriptions (organization_id, plan_id, limits_override)
  select o.id, (select id from public.plans where code = 'growth'), '{"users": 100000}'::jsonb from public.organizations o
   where not exists (select 1 from public.subscriptions s where s.organization_id = o.id);

insert into public.organization_members (organization_id, user_id, role, status) values
  (pg_temp.o(1), pg_temp.u(1), 'company_owner', 'active'),
  (pg_temp.o(1), pg_temp.u(2), 'company_admin', 'active'),
  (pg_temp.o(1), pg_temp.u(3), 'marketing_manager', 'active'),
  (pg_temp.o(1), pg_temp.u(4), 'sales_agent', 'active'),
  (pg_temp.o(1), pg_temp.u(5), 'analyst', 'active'),
  (pg_temp.o(1), pg_temp.u(11), 'company_admin', 'suspended'),
  (pg_temp.o(1), pg_temp.u(12), 'company_admin', 'removed'),
  (pg_temp.o(1), pg_temp.u(14), 'sales_agent', 'removed'),
  (pg_temp.o(2), pg_temp.u(6), 'company_owner', 'active');

-- Effectifs de référence (lus par le propriétaire, sans RLS)
select set_config('t.alpha_cnt', (select count(*)::text from public.audit_logs where organization_id = pg_temp.o(1)), true);
select set_config('t.beta_cnt', (select count(*)::text from public.audit_logs where organization_id = pg_temp.o(2)), true);

-- ---------------------------------------------------------------------------
-- 1. Structure de la table
-- ---------------------------------------------------------------------------
select has_table('public', 'audit_logs', 'public.audit_logs existe');
select col_not_null('public', 'audit_logs', 'organization_id', 'organization_id NOT NULL');
select col_type_is('public', 'audit_logs', 'organization_id', 'uuid', 'organization_id est uuid');
select col_not_null('public', 'audit_logs', 'actor_kind', 'actor_kind NOT NULL');
select col_not_null('public', 'audit_logs', 'action', 'action NOT NULL');
select col_not_null('public', 'audit_logs', 'entity_type', 'entity_type NOT NULL');
select col_not_null('public', 'audit_logs', 'created_at', 'created_at NOT NULL');
select col_is_null('public', 'audit_logs', 'actor_id', 'actor_id nullable (acteur système)');
select col_is_null('public', 'audit_logs', 'entity_id', 'entity_id nullable');
select col_is_null('public', 'audit_logs', 'before', 'before nullable');
select col_is_null('public', 'audit_logs', 'after', 'after nullable');
select col_is_null('public', 'audit_logs', 'ip', 'ip nullable');
select col_is_null('public', 'audit_logs', 'request_id', 'request_id nullable');
select col_type_is('public', 'audit_logs', 'ip', 'inet', 'ip est de type inet');
select col_type_is('public', 'audit_logs', 'before', 'jsonb', 'before est jsonb');
select col_has_default('public', 'audit_logs', 'id', 'id a une valeur par défaut');
select col_has_default('public', 'audit_logs', 'created_at', 'created_at a une valeur par défaut');
select ok(
  (select count(*) from pg_constraint where conrelid = 'public.audit_logs'::regclass and contype = 'f') = 1
    and exists (select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass
                  and contype = 'f' and confdeltype = 'r' and confrelid = 'public.organizations'::regclass
                  and conkey = array[(select attnum from pg_attribute where attrelid = 'public.audit_logs'::regclass and attname = 'organization_id')]::int2[]),
  'UNE seule FK : organization_id -> organizations ON DELETE RESTRICT (aucune FK sur actor_id)'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass
            and contype = 'u' and conname = 'audit_logs_org_id_key'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'public.audit_logs'::regclass and attname = 'organization_id'),
                               (select attnum from pg_attribute where attrelid = 'public.audit_logs'::regclass and attname = 'id')]::int2[]),
  'unique (organization_id, id)'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'audit_logs'
            and indexdef like '%(organization_id, created_at DESC)%'),
  'index (organization_id, created_at desc)'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'audit_logs'
            and indexdef like '%(organization_id, entity_type, entity_id)%'),
  'index (organization_id, entity_type, entity_id)'
);
select ok((select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass), 'RLS activée sur audit_logs');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'audit_logs'),
  1, 'audit_logs : UNE seule politique'
);
select ok(
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs'
            and cmd = 'SELECT' and roles = array['authenticated']::name[]
            and qual like '%has_role%company_owner%company_admin%'),
  'la politique est un SELECT pour authenticated, réservé à owner/admin via has_role'
);

-- Contraintes CHECK (insertions directes depuis le propriétaire, sur l'entreprise Gamma)
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'bogus', 'a.b', 'c')$$,
  '23514', null, 'actor_kind hors liste refusé'
);
select lives_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values
      ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c'),
      ('80000000-0000-4000-8000-000000000003', 'system', 'a.b', 'c'),
      ('80000000-0000-4000-8000-000000000003', 'support', 'a.b', 'c')$$,
  'actor_kind user / system / support acceptés'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'Bad.Action', 'c')$$,
  '23514', null, 'action en majuscules refusée'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'nodot', 'c')$$,
  '23514', null, 'action sans point refusée'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b.c', 'c')$$,
  '23514', null, 'action avec deux points refusée'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'a1.b', 'c')$$,
  '23514', null, 'action avec chiffre refusée'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', repeat('a', 33) || '.' || repeat('b', 31), 'c')$$,
  '23514', null, 'action de 65 caractères refusée'
);
select lives_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', repeat('a', 32) || '.' || repeat('b', 31), 'c')$$,
  'action de 64 caractères acceptée'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'x.y')$$,
  '23514', null, 'entity_type avec point refusé'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'Member')$$,
  '23514', null, 'entity_type en majuscules refusé'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', repeat('c', 65))$$,
  '23514', null, 'entity_type de 65 caractères refusé'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, before) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', jsonb_build_object('k', repeat('x', 16376)))$$,
  '23514', null, 'before de plus de 16384 octets refusé'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, after) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', jsonb_build_object('k', repeat('x', 16376)))$$,
  '23514', null, 'after de plus de 16384 octets refusé'
);
select lives_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, before, after) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', jsonb_build_object('k', repeat('x', 16375)), jsonb_build_object('k', repeat('x', 16375)))$$,
  'before / after de 16384 octets pile acceptés'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, request_id) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', 'short')$$,
  '23514', null, 'request_id de 5 caractères refusé'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, request_id) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', 'bad id with spaces')$$,
  '23514', null, 'request_id avec espaces refusé'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, request_id) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', repeat('r', 129))$$,
  '23514', null, 'request_id de 129 caractères refusé'
);
select lives_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, request_id) values
      ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', repeat('r', 8)),
      ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', repeat('r', 128)),
      ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', 'Req.id_1-ok')$$,
  'request_id de 8, 128 caractères et avec . _ - acceptés'
);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-0000000000ff', 'user', 'a.b', 'c')$$,
  '23503', null, 'organization_id inconnu refusé (FK)'
);
select lives_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type, actor_id) values ('80000000-0000-4000-8000-000000000003', 'user', 'a.b', 'c', '70000000-0000-4000-8000-0000000000ee')$$,
  'actor_id sans compte correspondant accepté (aucune FK sur actor_id)'
);
select throws_ok(
  $$delete from public.organizations where id = '80000000-0000-4000-8000-000000000003'$$,
  '23503', null, 'une entreprise ayant des lignes d''audit ne peut pas être supprimée (RESTRICT)'
);

-- ---------------------------------------------------------------------------
-- 2. Privilèges : lecture seule pour authenticated et service_role, rien pour anon
-- ---------------------------------------------------------------------------
select ok(has_table_privilege('authenticated', 'public.audit_logs', 'select'), 'authenticated : SELECT accordé');
select ok(
  not has_table_privilege('authenticated', 'public.audit_logs', 'insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('authenticated', 'public.audit_logs', 'insert,update,references'),
  'authenticated : aucun privilège d''écriture'
);
select ok(has_table_privilege('service_role', 'public.audit_logs', 'select'), 'service_role : SELECT accordé (lecture serveur)');
select ok(
  not has_table_privilege('service_role', 'public.audit_logs', 'insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('service_role', 'public.audit_logs', 'insert,update,references'),
  'service_role : aucun privilège d''écriture'
);
select ok(
  not has_table_privilege('anon', 'public.audit_logs', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('anon', 'public.audit_logs', 'select,insert,update,references'),
  'anon : aucun privilège'
);

select pg_temp.as_user(1);
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000001', 'user', 'a.b', 'c')$$,
  '42501', 'permission denied for table audit_logs', 'INSERT direct refusé à authenticated (même owner)'
);
select throws_ok(
  $$update public.audit_logs set action = 'a.b' where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table audit_logs', 'UPDATE refusé à authenticated par privilège'
);
select throws_ok(
  $$delete from public.audit_logs where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table audit_logs', 'DELETE refusé à authenticated par privilège'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  '42501', 'permission denied for table audit_logs', 'TRUNCATE refusé à authenticated par privilège'
);
reset role;
set local role service_role;
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000001', 'system', 'a.b', 'c')$$,
  '42501', 'permission denied for table audit_logs', 'INSERT direct refusé à service_role'
);
select throws_ok(
  $$update public.audit_logs set action = 'a.b'$$,
  '42501', 'permission denied for table audit_logs', 'UPDATE refusé à service_role par privilège'
);
select throws_ok(
  $$delete from public.audit_logs$$,
  '42501', 'permission denied for table audit_logs', 'DELETE refusé à service_role par privilège'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  '42501', 'permission denied for table audit_logs', 'TRUNCATE refusé à service_role par privilège'
);
reset role;
set local role anon;
select throws_ok(
  $$insert into public.audit_logs (organization_id, actor_kind, action, entity_type) values ('80000000-0000-4000-8000-000000000001', 'system', 'a.b', 'c')$$,
  '42501', 'permission denied for table audit_logs', 'INSERT direct refusé à anon'
);
select throws_ok(
  $$select count(*) from public.audit_logs$$,
  '42501', 'permission denied for table audit_logs', 'SELECT refusé à anon'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. RLS en lecture : owner / admin ACTIFS de l'entreprise uniquement
-- ---------------------------------------------------------------------------
select pg_temp.as_user(1);
select is(
  (select count(*)::int from public.audit_logs where organization_id = pg_temp.o(1)),
  current_setting('t.alpha_cnt')::int, 'owner Alpha : lit toutes les lignes d''audit d''Alpha'
);
select is(
  (select count(*)::int from public.audit_logs where organization_id <> pg_temp.o(1)),
  0, 'owner Alpha : ne lit aucune ligne des autres entreprises'
);
select pg_temp.as_user(2);
select is(
  (select count(*)::int from public.audit_logs where organization_id = pg_temp.o(1)),
  current_setting('t.alpha_cnt')::int, 'admin Alpha : lit toutes les lignes d''audit d''Alpha'
);
select pg_temp.as_user(3);
select is((select count(*)::int from public.audit_logs), 0, 'marketing_manager : ne lit rien');
select pg_temp.as_user(4);
select is((select count(*)::int from public.audit_logs), 0, 'sales_agent : ne lit rien');
select pg_temp.as_user(5);
select is((select count(*)::int from public.audit_logs), 0, 'analyst : ne lit rien');
select pg_temp.as_user(6);
select is(
  (select count(*)::int from public.audit_logs where organization_id = pg_temp.o(2)),
  current_setting('t.beta_cnt')::int, 'owner Beta : lit les lignes d''audit de Beta'
);
select is(
  (select count(*)::int from public.audit_logs where organization_id = pg_temp.o(1)),
  0, 'owner Beta : ne lit rien d''Alpha (isolation inter-entreprises)'
);
select pg_temp.as_user(7);
select is((select count(*)::int from public.audit_logs), 0, 'utilisateur sans adhésion : ne lit rien');
select pg_temp.as_user(11);
select is((select count(*)::int from public.audit_logs), 0, 'admin SUSPENDU : ne lit rien');
select pg_temp.as_user(12);
select is((select count(*)::int from public.audit_logs), 0, 'admin RETIRÉ : ne lit rien');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Attribution de l'acteur (lignes créées sans JWT : système)
-- ---------------------------------------------------------------------------
select ok(
  (select actor_kind = 'system' and actor_id is null from public.audit_logs
    where action = 'organization.created' and entity_id = pg_temp.o(1)),
  'sans JWT : actor_kind = system et actor_id NULL'
);
select is(
  (select count(*)::int from public.audit_logs where actor_kind = 'user' and actor_id is null and entity_type <> 'c'),
  0, 'jamais de ligne « user » sans actor_id'
);
select is(
  (select count(*)::int from public.audit_logs where actor_kind = 'support' and entity_type <> 'c'),
  0, 'les triggers ne produisent jamais actor_kind = support'
);

-- ---------------------------------------------------------------------------
-- 5. Immuabilité : UPDATE, DELETE, TRUNCATE lèvent toujours audit_logs_immutable
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(tgname::text order by tgname) from pg_trigger
    where tgrelid = 'public.audit_logs'::regclass and not tgisinternal and tgenabled = 'A'),
  array['audit_logs_no_truncate', 'audit_logs_no_update_delete'],
  'les deux triggers d''immuabilité sont ENABLE ALWAYS (tgenabled = A)'
);
-- Les trois triggers d'audit des mutations sont aussi ENABLE ALWAYS : session_replication_role = replica
-- (pg_restore, réplication logique, SQL de support) ne doit jamais sauter l'audit silencieusement.
select is(
  (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
    where not t.tgisinternal and t.tgenabled = 'A'
      and t.tgname in ('audit_logs_no_truncate', 'audit_logs_no_update_delete',
                       'audit_organizations', 'audit_organization_members', 'audit_invitations')),
  array['audit_invitations', 'audit_logs_no_truncate', 'audit_logs_no_update_delete',
        'audit_organization_members', 'audit_organizations'],
  'les cinq triggers (3 d''audit + 2 d''immuabilité) sont ENABLE ALWAYS (tgenabled = A)'
);
select throws_ok(
  $$update public.audit_logs set action = 'x.y' where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'propriétaire : UPDATE refusé'
);
select throws_ok(
  $$delete from public.audit_logs where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'propriétaire : DELETE refusé'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  '42501', 'audit_logs_immutable', 'propriétaire : TRUNCATE refusé'
);
select throws_ok(
  $$truncate public.audit_logs, public.organizations cascade$$,
  '42501', 'audit_logs_immutable', 'propriétaire : TRUNCATE en cascade refusé'
);
set local session_replication_role = replica;
select throws_ok(
  $$update public.audit_logs set action = 'x.y' where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'session_replication_role = replica : UPDATE toujours refusé'
);
select throws_ok(
  $$delete from public.audit_logs where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'session_replication_role = replica : DELETE toujours refusé'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  '42501', 'audit_logs_immutable', 'session_replication_role = replica : TRUNCATE toujours refusé'
);
reset session_replication_role;

-- Défense en profondeur : même si un privilège d'écriture était accordé par erreur (et une politique ajoutée),
-- le trigger refuse encore. Les accords sont temporaires et retirés juste après.
grant update, delete, truncate on public.audit_logs to service_role, authenticated;
create policy tmp_audit_update on public.audit_logs for update to authenticated using (true) with check (true);
create policy tmp_audit_delete on public.audit_logs for delete to authenticated using (true);
set local role service_role;
select throws_ok(
  $$update public.audit_logs set action = 'x.y' where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'service_role (privilège accordé par erreur) : UPDATE refusé par le trigger'
);
select throws_ok(
  $$delete from public.audit_logs where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'service_role (privilège accordé par erreur) : DELETE refusé par le trigger'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  '42501', 'audit_logs_immutable', 'service_role (privilège accordé par erreur) : TRUNCATE refusé par le trigger'
);
reset role;
select pg_temp.as_user(1);
select throws_ok(
  $$update public.audit_logs set action = 'x.y' where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'authenticated owner (privilège accordé par erreur) : UPDATE refusé par le trigger'
);
select throws_ok(
  $$delete from public.audit_logs where organization_id = '80000000-0000-4000-8000-000000000001'$$,
  '42501', 'audit_logs_immutable', 'authenticated owner (privilège accordé par erreur) : DELETE refusé par le trigger'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  '42501', 'audit_logs_immutable', 'authenticated owner (privilège accordé par erreur) : TRUNCATE refusé par le trigger'
);
reset role;
drop policy tmp_audit_update on public.audit_logs;
drop policy tmp_audit_delete on public.audit_logs;
revoke update, delete, truncate on public.audit_logs from service_role, authenticated;
select ok(
  not has_table_privilege('authenticated', 'public.audit_logs', 'insert,update,delete,truncate,references,trigger')
    and not has_table_privilege('service_role', 'public.audit_logs', 'insert,update,delete,truncate,references,trigger')
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'audit_logs') = 1,
  'privilèges et politiques de test retirés : retour à l''état de la migration'
);

-- Un rôle non propriétaire ne peut ni désactiver ni supprimer les triggers, ni activer le mode replica
select pg_temp.as_user(1);
select throws_ok(
  $$alter table public.audit_logs disable trigger audit_logs_no_update_delete$$,
  '42501', null, 'authenticated : DISABLE TRIGGER impossible'
);
select throws_ok(
  $$alter table public.audit_logs disable trigger all$$,
  '42501', null, 'authenticated : DISABLE TRIGGER ALL impossible'
);
select throws_ok(
  $$drop trigger audit_logs_no_truncate on public.audit_logs$$,
  '42501', null, 'authenticated : DROP TRIGGER impossible'
);
select throws_ok(
  $$set session_replication_role = replica$$,
  '42501', null, 'authenticated : session_replication_role = replica interdit'
);
reset role;
set local role service_role;
select throws_ok(
  $$alter table public.audit_logs disable trigger audit_logs_no_update_delete$$,
  '42501', null, 'service_role : DISABLE TRIGGER impossible'
);
select throws_ok(
  $$drop trigger audit_logs_no_update_delete on public.audit_logs$$,
  '42501', null, 'service_role : DROP TRIGGER impossible'
);
select throws_ok(
  $$alter table public.audit_logs enable replica trigger audit_logs_no_update_delete$$,
  '42501', null, 'service_role : ENABLE REPLICA TRIGGER impossible'
);
select throws_ok(
  $$drop table public.audit_logs$$,
  '42501', null, 'service_role : DROP TABLE impossible'
);
reset role;

-- ---------------------------------------------------------------------------
-- 6. private.audit_redact (table-driven)
-- ---------------------------------------------------------------------------
create temporary table redact_keys (k text primary key) on commit drop;
insert into redact_keys values
  ('token'), ('access_token'), ('Access_Token'), ('refresh-token'), ('secret'), ('client_secret'), ('CLIENT_SECRET'),
  ('password'), ('Password'), ('new_password'), ('passwd'), ('hash'), ('token_hash'), ('password_hash'),
  ('api_key'), ('apikey'), ('API_KEY'), ('ApiKey'), ('x-api-key'), ('authorization'), ('Authorization'),
  ('cookie'), ('Set-Cookie'), ('credential'), ('credentials'), ('jwt'), ('JWT'), ('id_jwt'),
  ('API.KEY'), ('api key'), ('Api Key'), ('api.key'), ('private_key'), ('privateKey'), ('PRIVATE-KEY'), ('private key'), ('signature'), ('x-hub-signature-256'), ('Signature'), ('otp'), ('OTP'), ('otp_code'), ('totp');
select is(
  private.audit_redact(jsonb_build_object(k, 'valeur-sensible', 'keep', 'ok')),
  '{"keep": "ok"}'::jsonb,
  'clé sensible supprimée : ' || k
) from redact_keys order by k;

create temporary table redact_keep (k text primary key) on commit drop;
insert into redact_keep values ('name'), ('role'), ('status'), ('user_id'), ('email_masked'), ('revoked_at'), ('author'), ('pass'), ('expires_at'), ('pin'), ('public_key'), ('sign'), ('api');
select is(
  private.audit_redact(jsonb_build_object(k, 'v', 'x', 1)),
  jsonb_build_object(k, 'v', 'x', 1),
  'clé non sensible conservée : ' || k
) from redact_keep order by k;

create temporary table redact_cases (n integer primary key, descr text, input jsonb, expected jsonb) on commit drop;
insert into redact_cases values
  (1, 'objets imbriqués', '{"a":{"b":{"password":"x","c":1}},"d":2}', '{"a":{"b":{"c":1}},"d":2}'),
  (2, 'tableau d''objets', '[{"token":"x","n":1},{"n":2}]', '[{"n":1},{"n":2}]'),
  (3, 'tableau dans un objet', '{"list":[{"secret":"s","v":1}],"ok":true}', '{"list":[{"v":1}],"ok":true}'),
  (4, 'tableau de tableaux', '[[{"jwt":"x","v":1}]]', '[[{"v":1}]]'),
  (5, 'chaîne scalaire', '"abc"', '"abc"'),
  (6, 'nombre scalaire', '12', '12'),
  (7, 'booléen scalaire', 'true', 'true'),
  (8, 'null JSON', 'null', 'null'),
  (9, 'objet vide', '{}', '{}'),
  (10, 'tableau vide', '[]', '[]'),
  (11, 'toutes les clés sensibles', '{"token":"a","password":"b"}', '{}'),
  (12, 'ordre d''un tableau de scalaires', '[3,1,2,"a",null]', '[3,1,2,"a",null]'),
  (13, 'la valeur n''est pas analysée', '{"note":"password reset requested"}', '{"note":"password reset requested"}'),
  (14, 'null dans un objet conservé', '{"a":null,"b":1}', '{"a":null,"b":1}'),
  (15, 'clé sensible dans un tableau de tableaux imbriqué', '{"x":[[{"cookie":"c"}],[{"y":1}]]}', '{"x":[[{}],[{"y":1}]]}');
select is(private.audit_redact(input), expected, 'caviardage : ' || descr) from redact_cases order by n;

select is(private.audit_redact(null::jsonb), null::jsonb, 'caviardage : NULL SQL reste NULL');
select is(char_length(private.audit_redact(to_jsonb(repeat('x', 200))) #>> '{}'), 200, 'chaîne de 200 caractères : inchangée');
select is(char_length(private.audit_redact(to_jsonb(repeat('x', 201))) #>> '{}'), 200, 'chaîne de 201 caractères : tronquée à 200');
select is(right(private.audit_redact(to_jsonb(repeat('x', 201))) #>> '{}', 3), '...', 'la troncature est signalée par ...');
select is(char_length(private.audit_redact(to_jsonb(repeat('x', 100000))) #>> '{}'), 200, 'chaîne de 100000 caractères : tronquée à 200');
select is(
  char_length(private.audit_redact(jsonb_build_object('a', jsonb_build_array(repeat('y', 500)))) -> 'a' ->> 0), 200,
  'troncature dans un objet puis un tableau'
);
select is(char_length(private.audit_redact(to_jsonb(repeat('é', 201))) #>> '{}'), 200, 'troncature en caractères (pas en octets)');
select lives_ok($$select private.audit_redact(pg_temp.deep(60))$$, 'imbrication de 60 niveaux : ne lève pas');
select ok(
  private.audit_redact(pg_temp.deep(60))::text like '%[truncated]%',
  'imbrication profonde : remplacée par [truncated]'
);
select ok(
  private.audit_redact(pg_temp.deep(60))::text not like '%LEAKME%',
  'imbrication profonde : la valeur sensible enfouie ne fuit jamais'
);
select is(
  private.audit_redact(pg_temp.deep(10)) #>> (array_fill('n'::text, array[10]) || array['v']),
  '1', 'imbrication de 10 niveaux : conservée, clé password retirée du fond'
);
select lives_ok(
  $$select private.audit_redact((select jsonb_agg(jsonb_build_object('i', g, 'token', 't')) from generate_series(1, 10000) g))$$,
  'tableau de 10000 éléments : ne lève pas'
);

-- Motif des clés sensibles : source unique, comparable au logger TypeScript (test de parité côté application).
select ok(
  position('token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp'
           in pg_get_functiondef('private.audit_redact(jsonb)'::regprocedure)) > 0,
  'audit_redact contient la liste EXACTE des motifs de clés sensibles'
);
select is(
  (select (length(d) - length(replace(d, 'token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp', '')))
          / length('token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp')
     from (select pg_get_functiondef('private.audit_redact(jsonb)'::regprocedure) as d) x),
  1, 'le motif apparaît UNE seule fois dans audit_redact'
);
select ok(
  pg_get_functiondef('private.audit_redact_value(jsonb, integer, text)'::regprocedure) !~* '(token|secret|passwd|credential|jwt)',
  'audit_redact_value ne contient aucune copie du motif (reçu en paramètre)'
);

-- ---------------------------------------------------------------------------
-- 7. private.mask_email
-- ---------------------------------------------------------------------------
select is(private.mask_email('john@example.com'), 'j***@example.com', 'mask_email : cas nominal');
-- Frontières (J12, correctif) : partie locale de 1 ou 2 caractères => masquée entièrement ; dès 3 => 1er caractère conservé.
select is(private.mask_email('a@b.co'), '***@b.co', 'mask_email : partie locale d''1 caractère => masquée entièrement');
select is(private.mask_email('ab@x.com'), '***@x.com', 'mask_email : partie locale de 2 caractères => masquée entièrement');
select is(private.mask_email('abc@x.com'), 'a***@x.com', 'mask_email : partie locale de 3 caractères => 1er caractère conservé');
select is(private.mask_email('éè@x.com'), '***@x.com', 'mask_email : 2 caractères Unicode (4 octets) => masquée entièrement');
select is(private.mask_email('éèà@x.com'), 'é***@x.com', 'mask_email : 3 caractères Unicode => 1er caractère conservé');
select is(private.mask_email('Jean.Dupont+tag@Mail.Example.org'), 'J***@Mail.Example.org', 'mask_email : casse et domaine conservés');
select is(private.mask_email('é@x.com'), '***@x.com', 'mask_email : 1 caractère Unicode => masquée entièrement');
select is(private.mask_email(null), null, 'mask_email : NULL => NULL');
select is(private.mask_email(''), '***', 'mask_email : chaîne vide => ***');
select is(private.mask_email('sans-arobase'), '***', 'mask_email : sans @ => ***');
select is(private.mask_email('@x.com'), '***', 'mask_email : partie locale vide => ***');
select is(private.mask_email('x@'), '***', 'mask_email : domaine vide => ***');
select is(private.mask_email('a@b@c'), '***', 'mask_email : deux @ => ***');
select ok(private.mask_email('secretname@corp.test') not like '%secretname%', 'mask_email : la partie locale n''apparaît jamais');

-- ---------------------------------------------------------------------------
-- 8. Matrice de privilèges des fonctions d'audit
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(pr.proname::text order by pr.proname)
     from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'private'
      and (pr.proname like 'audit\_%' or pr.proname = 'mask_email')
      and (has_function_privilege('anon', pr.oid, 'execute')
           or has_function_privilege('authenticated', pr.oid, 'execute')
           or has_function_privilege('service_role', pr.oid, 'execute')
           or has_function_privilege('public', pr.oid, 'execute'))),
  null, 'aucune fonction d''audit n''est exécutable par anon / authenticated / service_role / PUBLIC'
);
select is(
  (select count(*)::int from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'private' and (pr.proname like 'audit\_%' or pr.proname = 'mask_email')),
  13, 'treize fonctions d''audit dans le schéma private (dont audit_subscriptions, J14, audit_projects et audit_products, J16, audit_contacts et audit_consent_events, J18)'
);
select is(
  (select pr.prosecdef and pr.proconfig = array['search_path=""']::text[]
     from pg_proc pr where pr.oid = 'private.audit_write(uuid, text, text, uuid, jsonb, jsonb)'::regprocedure),
  true, 'audit_write : SECURITY DEFINER avec search_path vide'
);
select is(
  (select bool_and(pr.prosecdef and pr.proconfig = array['search_path=""']::text[])
     from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'private' and pr.proname in ('audit_organizations', 'audit_organization_members', 'audit_invitations')),
  true, 'triggers d''audit : SECURITY DEFINER avec search_path vide'
);
select pg_temp.as_user(1);
select throws_ok(
  $$select private.audit_write('80000000-0000-4000-8000-000000000001', 'a.b', 'c', null, null, null)$$,
  '42501', null, 'authenticated (owner) ne peut pas appeler audit_write'
);
select throws_ok($$select private.audit_redact('{}')$$, '42501', null, 'authenticated ne peut pas appeler audit_redact');
select throws_ok($$select private.mask_email('a@b.c')$$, '42501', null, 'authenticated ne peut pas appeler mask_email');
reset role;
set local role service_role;
select throws_ok(
  $$select private.audit_write('80000000-0000-4000-8000-000000000001', 'a.b', 'c', null, null, null)$$,
  '42501', null, 'service_role ne peut pas appeler audit_write'
);
reset role;
set local role anon;
select throws_ok(
  $$select private.audit_write('80000000-0000-4000-8000-000000000001', 'a.b', 'c', null, null, null)$$,
  '42501', null, 'anon ne peut pas appeler audit_write'
);
reset role;
-- Les mutations des rôles de l'API ne peuvent pas appeler les fonctions trigger directement
select pg_temp.as_user(1);
select throws_ok($$select private.audit_organizations()$$, '42501', null, 'authenticated ne peut pas appeler une fonction trigger d''audit');
reset role;

-- ---------------------------------------------------------------------------
-- 9. private.audit_write : acteur, caviardage, request_id, fail closed
-- ---------------------------------------------------------------------------
select pg_temp.step();
select set_config('request.jwt.claims', '', true);
select private.audit_write(pg_temp.o(3), 'test.manual', 'test', null,
  '{"a":1,"password":"x"}', '{"b":2,"api_key":"k","nested":{"cookie":"c","z":3}}');
select is(
  (select jsonb_build_object('k', actor_kind, 'actor', actor_id, 'b', before, 'a', after, 'ip', ip, 'rid', request_id, 'e', entity_id)
     from pg_temp.fresh() where action = 'test.manual'),
  '{"k":"system","actor":null,"b":{"a":1},"a":{"b":2,"nested":{"z":3}},"ip":null,"rid":null,"e":null}'::jsonb,
  'audit_write sans JWT : système, before/after caviardés, ip et request_id NULL'
);
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(9), 'role', 'authenticated')::text, true);
select private.audit_write(pg_temp.o(3), 'test.actor', 'test', null, null, null);
select is(
  (select jsonb_build_object('k', actor_kind, 'actor', actor_id, 'b', before, 'a', after)
     from pg_temp.fresh() where action = 'test.actor'),
  jsonb_build_object('k', 'user', 'actor', pg_temp.u(9), 'b', null, 'a', null),
  'audit_write avec JWT : actor_kind user et actor_id = auth.uid()'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select private.audit_write(pg_temp.o(3), 'test.svc', 'test', null, null, null);
select is(
  (select actor_kind || ':' || coalesce(actor_id::text, 'null') from pg_temp.fresh() where action = 'test.svc'),
  'system:null', 'JWT service_role sans sub : acteur système'
);
select set_config('request.jwt.claims', '', true);

select is(pg_temp.rid_for('{"x-request-id":"req-12345678"}'), 'req-12345678', 'request_id valide capturé');
select is(pg_temp.rid_for('{"x-request-id":"abcd1234"}'), 'abcd1234', 'request_id de 8 caractères capturé');
select is(pg_temp.rid_for(json_build_object('x-request-id', repeat('k', 128))::text), repeat('k', 128), 'request_id de 128 caractères capturé');
select is(pg_temp.rid_for('{"x-request-id":"a.b_c-d.e1","accept":"*/*"}'), 'a.b_c-d.e1', 'request_id avec . _ - capturé parmi d''autres en-têtes');
select is(pg_temp.rid_for('{"x-request-id":"short"}'), null, 'request_id trop court : NULL');
select is(pg_temp.rid_for(json_build_object('x-request-id', repeat('k', 129))::text), null, 'request_id de 129 caractères : NULL');
select is(pg_temp.rid_for('{"x-request-id":"has space in it"}'), null, 'request_id avec espaces : NULL');
select is(pg_temp.rid_for('{"x-request-id":"bad/slash/chars1"}'), null, 'request_id avec / : NULL');
select is(pg_temp.rid_for('{"x-request-id":"line\nbreak-1234"}'), null, 'request_id avec saut de ligne : NULL');
select is(pg_temp.rid_for('{"x-request-id":"x''; drop table audit_logs;--"}'), null, 'request_id de type injection SQL : NULL');
select is(pg_temp.rid_for('{"x-request-id":null}'), null, 'request_id JSON null : NULL');
select is(pg_temp.rid_for('{"x-request-id":["req-12345678"]}'), null, 'request_id tableau : NULL');
select is(pg_temp.rid_for('{"accept":"*/*"}'), null, 'en-tête absent : NULL');
select is(pg_temp.rid_for('{}'), null, 'en-têtes vides : NULL');
select is(pg_temp.rid_for(''), null, 'request.headers vide : NULL');
select is(pg_temp.rid_for('{not json'), null, 'request.headers non JSON : NULL (ne lève pas)');
select is(pg_temp.rid_for('["x-request-id","req-12345678"]'), null, 'request.headers tableau : NULL');

select throws_ok(
  $$select private.audit_write('80000000-0000-4000-8000-000000000003', 'BAD', 'test', null, null, null)$$,
  '23514', null, 'audit_write avec une action invalide : échoue (fail closed)'
);
select throws_ok(
  $$select private.audit_write('80000000-0000-4000-8000-0000000000ff', 'a.b', 'test', null, null, null)$$,
  '23503', null, 'audit_write pour une entreprise inconnue : échoue'
);
select throws_ok(
  $$select private.audit_write(null, 'a.b', 'test', null, null, null)$$,
  '23502', null, 'audit_write sans entreprise : échoue'
);
select is(
  (select count(*)::int from public.audit_logs where ip is not null),
  0, 'la colonne ip reste NULL partout'
);

-- ---------------------------------------------------------------------------
-- 10. Trigger organisations
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(1), 'role', 'authenticated')::text, true);
select pg_temp.step();
insert into public.organizations (id, name, slug, timezone, locale)
values (pg_temp.o(4), 'Aud Delta', 'aud-delta-test', 'Africa/Casablanca', 'en');
-- Abonnement de test : limite d'utilisateurs très haute (ces tests ne portent pas sur les quotas, voir 090).
insert into public.subscriptions (organization_id, plan_id, limits_override)
  select o.id, (select id from public.plans where code = 'growth'), '{"users": 100000}'::jsonb from public.organizations o
   where not exists (select 1 from public.subscriptions s where s.organization_id = o.id);
select is(pg_temp.fc(), 1, 'insertion d''organisation : une ligne d''audit');
select is(
  pg_temp.fa('organization.created'),
  pg_temp.ex('organization', pg_temp.o(4), pg_temp.o(4), 'user', null,
    '{"name":"Aud Delta","slug":"aud-delta-test","timezone":"Africa/Casablanca","locale":"en","status":"active"}'),
  'organization.created : entity = organisation, organization_id = son propre id, after complet'
);
select is(pg_temp.actor_of('organization.created'), pg_temp.u(1), 'organization.created : acteur = auth.uid()');

select pg_temp.step();
update public.organizations set name = 'Aud Delta 2' where id = pg_temp.o(4);
select is(pg_temp.fc(), 1, 'changement de nom : une ligne');
select is(
  pg_temp.fa('organization.updated'),
  pg_temp.ex('organization', pg_temp.o(4), pg_temp.o(4), 'user', '{"name":"Aud Delta"}', '{"name":"Aud Delta 2"}'),
  'organization.updated : before/after limités à la colonne modifiée'
);
select pg_temp.step();
update public.organizations set timezone = 'UTC', locale = 'ar', status = 'suspended' where id = pg_temp.o(4);
select is(pg_temp.fc(), 1, 'timezone + locale + status : UNE ligne');
select is(
  pg_temp.fa('organization.updated'),
  pg_temp.ex('organization', pg_temp.o(4), pg_temp.o(4), 'user',
    '{"timezone":"Africa/Casablanca","locale":"en","status":"active"}',
    '{"timezone":"UTC","locale":"ar","status":"suspended"}'),
  'organization.updated : les trois colonnes modifiées, et seulement elles'
);
select pg_temp.step();
update public.organizations set settings = '{"approval_policy":"four_eyes","api_key":"zzz"}' where id = pg_temp.o(4);
select is(pg_temp.fc(), 0, 'modification des seuls settings : aucune ligne');
update public.organizations set updated_at = now() + interval '1 second' where id = pg_temp.o(4);
select is(pg_temp.fc(), 0, 'modification du seul updated_at : aucune ligne');
update public.organizations set name = name where id = pg_temp.o(4);
select is(pg_temp.fc(), 0, 'UPDATE sans changement de valeur : aucune ligne');
update public.organizations set name = 'Aud Delta 3', settings = '{"x":1}' where id = pg_temp.o(4);
select is(
  pg_temp.fa('organization.updated'),
  pg_temp.ex('organization', pg_temp.o(4), pg_temp.o(4), 'user', '{"name":"Aud Delta 2"}', '{"name":"Aud Delta 3"}'),
  'nom + settings : seul le nom figure dans l''audit (jamais settings)'
);
select is(pg_temp.fc(), 1, 'nom + settings : une ligne');

-- ---------------------------------------------------------------------------
-- 11. Trigger membres
-- ---------------------------------------------------------------------------
select pg_temp.step();
insert into public.organization_members (organization_id, user_id, role, status)
values (pg_temp.o(1), pg_temp.u(13), 'sales_agent', 'active');
select is(pg_temp.fc(), 1, 'insertion d''un membre : une ligne');
select is(
  pg_temp.fa('member.joined'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user', null,
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'sales_agent', 'status', 'active')),
  'member.joined : after = {user_id, role, status}, entity = la ligne d''adhésion'
);

select pg_temp.step();
update public.organization_members set role = 'analyst' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fc(), 1, 'changement de rôle : une ligne');
select is(
  pg_temp.fa('member.role_changed'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'sales_agent', 'status', 'active'),
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'active')),
  'member.role_changed : before/after exacts'
);

select pg_temp.step();
update public.organization_members set status = 'suspended' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fc(), 1, 'active -> suspended : une ligne');
select is(
  pg_temp.fa('member.suspended'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'active'),
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'suspended')),
  'member.suspended : before/after exacts'
);

select pg_temp.step();
update public.organization_members set status = 'active' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(
  pg_temp.fa('member.reactivated'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'suspended'),
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'active')),
  'suspended -> active : member.reactivated'
);
select is(pg_temp.fc(), 1, 'suspended -> active : une ligne');

select pg_temp.step();
update public.organization_members set status = 'removed' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(
  pg_temp.fa('member.removed'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'active'),
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'removed')),
  'active -> removed : member.removed'
);
select is(pg_temp.fc(), 1, 'active -> removed : une ligne');

select pg_temp.step();
update public.organization_members set status = 'active' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(
  pg_temp.fa('member.reactivated'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'removed'),
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'active')),
  'removed -> active : member.reactivated'
);

select pg_temp.step();
update public.organization_members set status = 'invited' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(
  pg_temp.fa('member.status_changed'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(13)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'active'),
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'analyst', 'status', 'invited')),
  'active -> invited : member.status_changed'
);
select pg_temp.step();
update public.organization_members set status = 'active' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fa('member.status_changed') ->> 't', 'member', 'invited -> active : member.status_changed');
select pg_temp.step();
update public.organization_members set status = 'suspended' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select pg_temp.step();
update public.organization_members set status = 'removed' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fa('member.status_changed') -> 'a' ->> 'status', 'removed', 'suspended -> removed : member.status_changed');
select pg_temp.step();
update public.organization_members set status = 'suspended' where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fa('member.status_changed') -> 'a' ->> 'status', 'suspended', 'removed -> suspended : member.status_changed');

-- rôle ET statut dans la même mise à jour : deux lignes
select pg_temp.step();
update public.organization_members set role = 'marketing_manager', status = 'active'
 where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fc(), 2, 'rôle + statut modifiés ensemble : deux lignes');
select is(
  (select array_agg(action order by action) from pg_temp.fresh()),
  array['member.reactivated', 'member.role_changed'], 'rôle + statut : role_changed et reactivated'
);

select pg_temp.step();
update public.organization_members set updated_at = now() + interval '1 second', invited_by = pg_temp.u(1)
 where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fc(), 0, 'mise à jour sans changement de rôle ni de statut : aucune ligne');

select pg_temp.step();
select set_config('t.mover_id', pg_temp.mid(pg_temp.o(1), pg_temp.u(13))::text, true);
delete from public.organization_members where organization_id = pg_temp.o(1) and user_id = pg_temp.u(13);
select is(pg_temp.fc(), 1, 'suppression d''un membre : une ligne');
select is(
  pg_temp.fa('member.deleted'),
  pg_temp.ex('member', current_setting('t.mover_id')::uuid, pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(13), 'role', 'marketing_manager', 'status', 'active'), null),
  'member.deleted : before = {user_id, role, status}, after NULL'
);

-- ---------------------------------------------------------------------------
-- 12. Trigger invitations (insertions directes)
-- ---------------------------------------------------------------------------
select pg_temp.step();
insert into public.invitations (id, organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('90000000-0000-4000-8000-000000000001', pg_temp.o(1), 'jane.doe@example.com', 'sales_agent',
        repeat('ab', 32), '2030-01-01T00:00:00Z', pg_temp.u(1));
select is(pg_temp.fc(), 1, 'insertion d''invitation : une ligne');
select is(
  pg_temp.fa('invitation.created'),
  pg_temp.ex('invitation', '90000000-0000-4000-8000-000000000001', pg_temp.o(1), 'user', null,
    jsonb_build_object('role', 'sales_agent', 'email_masked', 'j***@example.com', 'expires_at', '2030-01-01T00:00:00Z'::timestamptz)),
  'invitation.created : {role, email_masked, expires_at} et rien d''autre'
);
select ok(
  (select position('jane' in lower(coalesce(f.before::text, '') || coalesce(f.after::text, ''))) = 0
      and position('abab' in coalesce(f.after::text, '')) = 0
      and position('token' in lower(coalesce(f.after::text, ''))) = 0
     from pg_temp.fresh() f where f.action = 'invitation.created'),
  'invitation.created : ni la partie locale de l''e-mail, ni le hash, ni une clé token'
);

select pg_temp.step();
update public.invitations set expires_at = '2031-01-01T00:00:00Z' where id = '90000000-0000-4000-8000-000000000001';
select is(pg_temp.fc(), 0, 'modification de expires_at seule : aucune ligne');
update public.invitations set revoked_at = '2029-05-05T10:00:00Z' where id = '90000000-0000-4000-8000-000000000001';
select is(pg_temp.fc(), 1, 'révocation : une ligne');
select is(
  pg_temp.fa('invitation.revoked'),
  pg_temp.ex('invitation', '90000000-0000-4000-8000-000000000001', pg_temp.o(1), 'user', null,
    jsonb_build_object('revoked_at', '2029-05-05T10:00:00Z'::timestamptz)),
  'invitation.revoked : after = {revoked_at}'
);

select pg_temp.step();
insert into public.invitations (id, organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('90000000-0000-4000-8000-000000000002', pg_temp.o(1), 'bob@example.com', 'analyst',
        repeat('cd', 32), '2030-01-01T00:00:00Z', pg_temp.u(1));
select pg_temp.step();
update public.invitations set accepted_at = '2029-06-06T11:00:00Z', accepted_by = pg_temp.u(9)
 where id = '90000000-0000-4000-8000-000000000002';
select is(pg_temp.fc(), 1, 'acceptation : une ligne');
select is(
  pg_temp.fa('invitation.accepted'),
  pg_temp.ex('invitation', '90000000-0000-4000-8000-000000000002', pg_temp.o(1), 'user', null,
    jsonb_build_object('accepted_by', pg_temp.u(9), 'accepted_at', '2029-06-06T11:00:00Z'::timestamptz)),
  'invitation.accepted : after = {accepted_by, accepted_at}'
);

-- ---------------------------------------------------------------------------
-- 13. Flux J9 / J10 par les fonctions publiques (sous authenticated)
-- ---------------------------------------------------------------------------
select pg_temp.step();
select pg_temp.as_user(10);
select set_config('t.org_new', public.create_organization('Aud Flux', 'en', 'UTC', 'aud-flux-key-0001')::text, true);
reset role;
select is(pg_temp.fc(), 2, 'create_organization : deux lignes (organisation + owner)');
select is(
  pg_temp.fa('organization.created'),
  pg_temp.ex('organization', current_setting('t.org_new')::uuid, current_setting('t.org_new')::uuid, 'user', null,
    jsonb_build_object('name', 'Aud Flux', 'slug', (select slug from public.organizations where id = current_setting('t.org_new')::uuid),
                       'timezone', 'UTC', 'locale', 'en', 'status', 'active')),
  'create_organization : organization.created exact'
);
select is(
  pg_temp.fa('member.joined'),
  pg_temp.ex('member', pg_temp.mid(current_setting('t.org_new')::uuid, pg_temp.u(10)), current_setting('t.org_new')::uuid, 'user', null,
    jsonb_build_object('user_id', pg_temp.u(10), 'role', 'company_owner', 'status', 'active')),
  'create_organization : member.joined (owner) exact'
);
select is(pg_temp.actor_of('member.joined'), pg_temp.u(10), 'create_organization : acteur = le créateur');
-- rejeu idempotent : aucune nouvelle ligne
select pg_temp.step();
select pg_temp.as_user(10);
select public.create_organization('Aud Flux', 'en', 'UTC', 'aud-flux-key-0001');
reset role;
select is(pg_temp.fc(), 0, 'create_organization rejouée (même clé) : aucune nouvelle ligne');

-- create_invitation
select pg_temp.step();
select pg_temp.as_user(1);
select set_config('t.inv1', public.create_invitation(pg_temp.o(1), '  Invitee@Aud.Test ', 'sales_agent', repeat('1a', 32))::text, true);
reset role;
select is(pg_temp.fc(), 1, 'create_invitation : une ligne');
select is(
  pg_temp.fa('invitation.created'),
  pg_temp.ex('invitation', current_setting('t.inv1')::uuid, pg_temp.o(1), 'user', null,
    jsonb_build_object('role', 'sales_agent', 'email_masked', 'i***@aud.test',
                       'expires_at', (select to_jsonb(expires_at) from public.invitations where id = current_setting('t.inv1')::uuid))),
  'create_invitation : e-mail masqué (i***@aud.test) et id de l''invitation'
);
select is(pg_temp.actor_of('invitation.created'), pg_temp.u(1), 'create_invitation : acteur = l''inviteur');
-- ré-invitation : révocation de l'ancienne + création de la nouvelle
select pg_temp.step();
select pg_temp.as_user(1);
select set_config('t.inv2', public.create_invitation(pg_temp.o(1), 'invitee@aud.test', 'sales_agent', repeat('2b', 32))::text, true);
reset role;
select is(pg_temp.fc(), 2, 'ré-invitation : deux lignes (révocation + création)');
select is(
  (select array_agg(action || ':' || entity_id::text order by action) from pg_temp.fresh()),
  array['invitation.created:' || current_setting('t.inv2'), 'invitation.revoked:' || current_setting('t.inv1')],
  'ré-invitation : revoked(ancienne) et created(nouvelle)'
);
-- revoke_invitation
select pg_temp.step();
select pg_temp.as_user(1);
select set_config('t.inv3', public.create_invitation(pg_temp.o(1), 'revme@aud.test', 'analyst', repeat('3c', 32))::text, true);
reset role;
select pg_temp.step();
select pg_temp.as_user(2);
select public.revoke_invitation(pg_temp.o(1), current_setting('t.inv3')::uuid);
reset role;
select is(pg_temp.fc(), 1, 'revoke_invitation : une ligne');
select is(
  pg_temp.fa('invitation.revoked') ->> 'e', current_setting('t.inv3'),
  'revoke_invitation : invitation.revoked sur la bonne invitation'
);
select is(pg_temp.actor_of('invitation.revoked'), pg_temp.u(2), 'revoke_invitation : acteur = l''admin qui révoque');
-- accept_invitation : nouveau membre
select pg_temp.step();
select pg_temp.as_user(8);
select public.accept_invitation(repeat('2b', 32));
reset role;
select is(pg_temp.fc(), 2, 'accept_invitation : deux lignes (membre + invitation)');
select is(
  (select array_agg(action order by action) from pg_temp.fresh()),
  array['invitation.accepted', 'member.joined'], 'accept_invitation : member.joined et invitation.accepted'
);
select is(pg_temp.actor_of('invitation.accepted'), pg_temp.u(8), 'accept_invitation : acteur = l''invité qui accepte');
select is(
  pg_temp.fa('invitation.accepted') -> 'a' ->> 'accepted_by', pg_temp.u(8)::text,
  'accept_invitation : accepted_by = l''invité'
);
-- accept_invitation : ré-activation d'un membre retiré avec un autre rôle
select pg_temp.as_user(1);
select public.create_invitation(pg_temp.o(1), 'again@aud.test', 'analyst', repeat('4d', 32));
reset role;
select pg_temp.step();
select pg_temp.as_user(14);
select public.accept_invitation(repeat('4d', 32));
reset role;
select is(pg_temp.fc(), 3, 'accept_invitation (membre retiré) : trois lignes');
select is(
  (select array_agg(action order by action) from pg_temp.fresh()),
  array['invitation.accepted', 'member.reactivated', 'member.role_changed'],
  'accept_invitation (membre retiré) : accepted, reactivated, role_changed'
);
select is(
  pg_temp.fa('member.role_changed'),
  pg_temp.ex('member', pg_temp.mid(pg_temp.o(1), pg_temp.u(14)), pg_temp.o(1), 'user',
    jsonb_build_object('user_id', pg_temp.u(14), 'role', 'sales_agent', 'status', 'removed'),
    jsonb_build_object('user_id', pg_temp.u(14), 'role', 'analyst', 'status', 'active')),
  'accept_invitation (membre retiré) : role_changed exact'
);
-- une acceptation refusée n'écrit rien
select pg_temp.step();
select pg_temp.as_user(7);
select throws_ok($$select public.accept_invitation(repeat('9f', 32))$$, 'P0001', 'invitation_invalid', 'acceptation invalide refusée');
reset role;
select is(pg_temp.fc(), 0, 'acceptation refusée : aucune ligne d''audit');

-- Lecture de ces lignes par le journal, selon le rôle
select pg_temp.as_user(1);
select is(
  (select count(*)::int from public.audit_logs where action = 'invitation.created' and entity_id = current_setting('t.inv2')::uuid),
  1, 'owner Alpha lit invitation.created du flux'
);
select pg_temp.as_user(3);
select is(
  (select count(*)::int from public.audit_logs where action = 'invitation.created'),
  0, 'marketing_manager ne lit pas invitation.created'
);
select pg_temp.as_user(6);
select is(
  (select count(*)::int from public.audit_logs where organization_id = pg_temp.o(1)),
  0, 'owner Beta ne lit aucune ligne d''audit d''Alpha'
);
reset role;

-- transfer_ownership : deux changements de rôle attribués à l'ancien owner
select pg_temp.step();
select pg_temp.as_user(1);
select public.transfer_ownership(pg_temp.o(1), pg_temp.u(2));
reset role;
select is(pg_temp.fc(), 2, 'transfer_ownership : deux lignes');
select is(
  (select jsonb_agg(jsonb_build_object('u', after ->> 'user_id', 'b', before ->> 'role', 'a', after ->> 'role', 'act', actor_id, 'k', actor_kind, 'ent', entity_type)
                    order by after ->> 'user_id') from pg_temp.fresh() where action = 'member.role_changed'),
  (select jsonb_agg(x order by x ->> 'u') from (values
     (jsonb_build_object('u', pg_temp.u(1)::text, 'b', 'company_owner', 'a', 'company_admin', 'act', pg_temp.u(1), 'k', 'user', 'ent', 'member')),
     (jsonb_build_object('u', pg_temp.u(2)::text, 'b', 'company_admin', 'a', 'company_owner', 'act', pg_temp.u(1), 'k', 'user', 'ent', 'member'))
   ) v (x)),
  'transfer_ownership : promotion de la cible et rétrogradation de l''appelant, acteur = ancien owner'
);

-- ---------------------------------------------------------------------------
-- 14. Isolation inter-entreprises et actions système
-- ---------------------------------------------------------------------------
select pg_temp.step();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.organizations set name = 'Aud Beta 2' where id = pg_temp.o(2);
select is(pg_temp.fc(), 1, 'modification de Beta : une ligne');
select is(
  (select jsonb_build_object('o', organization_id, 'k', actor_kind, 'act', actor_id) from pg_temp.fresh()),
  jsonb_build_object('o', pg_temp.o(2), 'k', 'system', 'act', null),
  'la ligne est classée sous Beta (jamais Alpha), acteur système (service_role sans sub)'
);
select is(
  (select count(*)::int from pg_temp.fresh() where organization_id = pg_temp.o(1)),
  0, 'aucune ligne n''apparaît chez une autre entreprise'
);

-- suppression d'un compte acteur : jamais bloquée, l'historique n'est pas réécrit
select is(
  (select count(*)::int from public.audit_logs where actor_id = pg_temp.u(9)), 1,
  'précondition : l''utilisateur u9 est acteur d''une ligne d''audit'
);
select lives_ok($$delete from auth.users where id = '70000000-0000-4000-8000-000000000009'$$, 'supprimer le compte d''un acteur n''est pas bloqué');
select is(
  (select count(*)::int from public.audit_logs where actor_id = '70000000-0000-4000-8000-000000000009'), 1,
  'l''historique conserve actor_id après la suppression du compte'
);

-- ---------------------------------------------------------------------------
-- 15. Atomicité
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(1), 'role', 'authenticated')::text, true);
select pg_temp.step();
savepoint sp_atomic;
update public.organizations set name = 'Aud Rolled Back' where id = pg_temp.o(2);
select is(pg_temp.fc(), 1, 'dans la transaction : la mutation produit sa ligne d''audit');
rollback to savepoint sp_atomic;
select is(pg_temp.fc(), 0, 'mutation annulée : aucune ligne d''audit ne subsiste');
select is((select name from public.organizations where id = pg_temp.o(2)), 'Aud Beta 2', 'mutation annulée : donnée inchangée');

-- Échec forcé de l'écriture d'audit => la mutation échoue (fail closed)
alter table public.audit_logs add constraint tmp_force_fail check (false) not valid;
select throws_ok(
  $$update public.organizations set name = 'Should Not Stick' where id = '80000000-0000-4000-8000-000000000002'$$,
  '23514', null, 'audit en échec : la modification d''organisation échoue'
);
select is((select name from public.organizations where id = pg_temp.o(2)), 'Aud Beta 2', 'audit en échec : le nom n''a pas changé');
select throws_ok(
  $$delete from public.organization_members where organization_id = '80000000-0000-4000-8000-000000000001' and user_id = '70000000-0000-4000-8000-000000000004'$$,
  '23514', null, 'audit en échec : la suppression de membre échoue'
);
select ok(
  exists (select 1 from public.organization_members where organization_id = pg_temp.o(1) and user_id = pg_temp.u(4)),
  'audit en échec : le membre existe toujours'
);
select throws_ok(
  $$update public.organization_members set role = 'analyst' where organization_id = '80000000-0000-4000-8000-000000000001' and user_id = '70000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'audit en échec : le changement de rôle échoue'
);
select is(
  (select role::text from public.organization_members where organization_id = pg_temp.o(1) and user_id = pg_temp.u(3)),
  'marketing_manager', 'audit en échec : le rôle n''a pas changé'
);
select throws_ok(
  $$insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at)
    values ('80000000-0000-4000-8000-000000000001', 'fail@example.com', 'analyst', repeat('ee', 32), now() + interval '1 day')$$,
  '23514', null, 'audit en échec : la création d''invitation échoue'
);
select is(
  (select count(*)::int from public.invitations where token_hash = repeat('ee', 32)),
  0, 'audit en échec : aucune invitation créée'
);
select pg_temp.as_user(1);
select throws_ok(
  $$select public.create_invitation('80000000-0000-4000-8000-000000000001', 'fail2@example.com', 'analyst', repeat('ef', 32))$$,
  '23514', null, 'audit en échec : create_invitation (fonction) échoue'
);
reset role;
alter table public.audit_logs drop constraint tmp_force_fail;
select lives_ok(
  $$update public.organizations set name = 'Aud Beta 3' where id = '80000000-0000-4000-8000-000000000002'$$,
  'contrôle positif : la même modification réussit une fois la contrainte retirée'
);

-- ---------------------------------------------------------------------------
-- 15b. Sous session_replication_role = replica, l'audit des mutations est QUAND MÊME écrit (ENABLE ALWAYS)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select pg_temp.step();
set local session_replication_role = replica;
insert into public.organizations (id, name, slug) values (pg_temp.o(5), 'Aud Replica', 'aud-replica-test');
-- Abonnement de test : limite d'utilisateurs très haute (ces tests ne portent pas sur les quotas, voir 090).
insert into public.subscriptions (organization_id, plan_id, limits_override)
  select o.id, (select id from public.plans where code = 'growth'), '{"users": 100000}'::jsonb from public.organizations o
   where not exists (select 1 from public.subscriptions s where s.organization_id = o.id);
insert into public.organization_members (organization_id, user_id, role, status)
values (pg_temp.o(5), pg_temp.u(9), 'sales_agent', 'active');
insert into public.invitations (id, organization_id, email_normalized, role, token_hash, expires_at, invited_by)
values ('90000000-0000-4000-8000-0000000000a1', pg_temp.o(5), 'zed@replica.test', 'analyst',
        repeat('ef', 32), '2030-01-01T00:00:00Z', pg_temp.u(9));
update public.organizations set name = 'Aud Replica 2' where id = pg_temp.o(5);
reset session_replication_role;
select is(
  (select array_agg(action order by action) from pg_temp.fresh() where organization_id = pg_temp.o(5)),
  array['invitation.created', 'member.joined', 'organization.created', 'organization.updated'],
  'session_replication_role = replica : organisation, membre, invitation et mise à jour produisent leur ligne d''audit'
);
select is(
  (select after ->> 'email_masked' from pg_temp.fresh() where action = 'invitation.created' and organization_id = pg_temp.o(5)),
  'z***@replica.test', 'replica : l''e-mail de l''invitation reste masqué'
);
select is(
  (select count(*)::int from pg_temp.fresh() where organization_id = pg_temp.o(5) and actor_kind = 'system'),
  4, 'replica : lignes d''audit attribuées au système (aucun JWT)'
);
delete from public.organization_members where organization_id = pg_temp.o(5);
select is(
  (select count(*)::int from pg_temp.fresh() where organization_id = pg_temp.o(5) and action = 'member.deleted'),
  1, 'suppression de membre : ligne member.deleted écrite'
);

-- ---------------------------------------------------------------------------
-- 16. Aucun secret dans le journal
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.audit_logs
    where coalesce(before::text, '') || coalesce(after::text, '') ~* '"[a-z_-]*(token|hash|secret|password|passwd|api[ ._-]?key|private[ ._-]?key|signature|otp|authorization|cookie|credential|jwt)[a-z_-]*":'),
  0, 'aucune clé sensible (token, hash, secret, mot de passe…) dans before/after'
);
select is(
  (select count(*)::int from public.audit_logs
    where coalesce(before::text, '') || coalesce(after::text, '') ~* '(abababab|cdcdcdcd|1a1a1a1a|2b2b2b2b|3c3c3c3c|4d4d4d4d|eeeeeeee|invitee@|jane\.doe|again@|revme@|bob@|fail@)'),
  0, 'aucun hash de jeton ni e-mail complet dans le journal'
);
select is(
  (select count(*)::int from public.audit_logs where action like 'invitation.created' and after ->> 'email_masked' !~ '^[a-z]\*\*\*@'),
  0, 'tous les e-mails d''invitation sont masqués'
);
select is(
  (select count(*)::int from public.audit_logs where ip is not null),
  0, 'ip reste NULL (aucun proxy de confiance)'
);

select * from finish();
rollback;
