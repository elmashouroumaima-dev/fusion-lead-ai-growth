-- J11 — Couche service : idempotency_keys, rate_limit_buckets, fonctions idempotency_* et rate_limit_take
-- (ADR 006, ADR 007 G-D9, ADR 005 §5–§8, menace B8).
-- Les appels s'exécutent sous le rôle `authenticated` (ou anon / service_role) avec un JWT de test (seul `sub`
-- compte) ; les vérifications d'état s'exécutent sous le propriétaire (sans RLS). Tout est annulé en fin de test.
-- Dans une transaction, now() est constant : on simule le temps qui passe en reculant created_at,
-- expires_at et refilled_at depuis le propriétaire.
begin;
create extension if not exists pgtap with schema extensions;
select plan(260);

-- Aide de test : attempt_id COURANT d'une clé (lu sous le propriétaire, SECURITY DEFINER), ou un uuid
-- aléatoire si la ligne n'existe pas. Permet d'appeler complete / abandon avec le bon essai sous n'importe
-- quel rôle sans lire la table.
create function pg_temp.att(p_org uuid, p_key text) returns uuid
language sql security definer set search_path = ''
as $f$ select coalesce((select k.attempt_id from public.idempotency_keys k where k.organization_id = p_org and k.key = p_key), gen_random_uuid()) $f$;
grant execute on function pg_temp.att(uuid, text) to public;

-- ---------------------------------------------------------------------------
-- Données de test
-- U1 owner Alpha · U2 sales Alpha · U3 owner Beta · U4 sans adhésion · U5 suspendu Alpha
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('50000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@svc.test', now()),
  ('50000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@svc.test', now()),
  ('50000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u3@svc.test', now()),
  ('50000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u4@svc.test', now()),
  ('50000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u5@svc.test', now());

insert into public.organizations (id, name, slug) values
  ('60000000-0000-4000-8000-000000000001', 'Svc Alpha', 'svc-alpha-test'),
  ('60000000-0000-4000-8000-000000000002', 'Svc Beta', 'svc-beta-test');

insert into public.organization_members (organization_id, user_id, role, status) values
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'sales_agent', 'active'),
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'sales_agent', 'suspended'),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003', 'company_owner', 'active');

-- ---------------------------------------------------------------------------
-- 1. idempotency_keys : structure
-- ---------------------------------------------------------------------------
select has_table('public', 'idempotency_keys', 'public.idempotency_keys existe');
select col_not_null('public', 'idempotency_keys', 'organization_id', 'idempotency_keys.organization_id NOT NULL');
select col_type_is('public', 'idempotency_keys', 'organization_id', 'uuid', 'organization_id est uuid');
select col_not_null('public', 'idempotency_keys', 'key', 'key NOT NULL');
select col_not_null('public', 'idempotency_keys', 'actor_id', 'actor_id NOT NULL');
select col_not_null('public', 'idempotency_keys', 'request_hash', 'request_hash NOT NULL');
select col_not_null('public', 'idempotency_keys', 'state', 'state NOT NULL');
select col_not_null('public', 'idempotency_keys', 'expires_at', 'expires_at NOT NULL');
select col_is_null('public', 'idempotency_keys', 'status_code', 'status_code nullable (null tant que in_progress)');
select col_is_null('public', 'idempotency_keys', 'response', 'response nullable (null tant que in_progress)');
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.idempotency_keys'::regclass
            and conname = 'idempotency_keys_org_key_key' and contype = 'u'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'public.idempotency_keys'::regclass and attname = 'organization_id'),
                               (select attnum from pg_attribute where attrelid = 'public.idempotency_keys'::regclass and attname = 'key')]::int2[]),
  'unique (organization_id, key)'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.idempotency_keys'::regclass
            and conname = 'idempotency_keys_org_id_key' and contype = 'u'),
  'unique (organization_id, id) pour les FK composites'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.idempotency_keys'::regclass
            and contype = 'f' and confdeltype = 'r'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'public.idempotency_keys'::regclass and attname = 'organization_id')]::int2[]),
  'FK organization_id -> organizations ON DELETE RESTRICT'
);
select ok(
  exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
           where i.indrelid = 'public.idempotency_keys'::regclass and a.attname = 'organization_id' and not i.indisunique),
  'index non unique commençant par organization_id'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'idempotency_keys'
            and indexname = 'idempotency_keys_expires_at_idx' and indexdef like '%(expires_at)%'),
  'index sur expires_at'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.idempotency_keys'::regclass and tgname = 'set_updated_at' and not tgisinternal),
  'trigger set_updated_at'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.idempotency_keys'::regclass and tgname = 'prevent_organization_id_change' and not tgisinternal),
  'trigger anti-changement d''organization_id'
);
select ok((select relrowsecurity from pg_class where oid = 'public.idempotency_keys'::regclass), 'RLS activée sur idempotency_keys');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'idempotency_keys'),
  0, 'idempotency_keys : AUCUNE politique'
);
select ok(
  not has_table_privilege('anon', 'public.idempotency_keys', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('anon', 'public.idempotency_keys', 'select,insert,update,references'),
  'idempotency_keys : anon n''a aucun privilège'
);
select ok(
  not has_table_privilege('authenticated', 'public.idempotency_keys', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('authenticated', 'public.idempotency_keys', 'select,insert,update,references'),
  'idempotency_keys : authenticated n''a aucun privilège'
);
select ok(
  not has_table_privilege('service_role', 'public.idempotency_keys', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('service_role', 'public.idempotency_keys', 'select,insert,update,references'),
  'idempotency_keys : service_role n''a aucun privilège (accès par les fonctions seulement)'
);

-- Contraintes CHECK (insertions directes depuis le propriétaire)
select lives_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-valid-key', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', now() + interval '1 day')$$,
  'ligne valide acceptée'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'short', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', now())$$,
  '23514', null, 'clé de 5 caractères refusée (8..128)'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', repeat('k', 129), '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', now())$$,
  '23514', null, 'clé de 129 caractères refusée'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'bad key with space', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', now())$$,
  '23514', null, 'clé avec espace refusée'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-bad-hash-1', '50000000-0000-4000-8000-000000000001', repeat('A', 64), 'in_progress', now())$$,
  '23514', null, 'hash en majuscules refusé'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-bad-hash-2', '50000000-0000-4000-8000-000000000001', repeat('a', 63), 'in_progress', now())$$,
  '23514', null, 'hash de 63 caractères refusé'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-bad-state', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'done', now())$$,
  '23514', null, 'état inconnu refusé'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-bad-status-99', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 99, '{}', now())$$,
  '23514', null, 'status_code 99 refusé'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-bad-status-600', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 600, '{}', now())$$,
  '23514', null, 'status_code 600 refusé'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-inprog-status', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', 200, now())$$,
  '23514', null, 'in_progress avec status_code refusé (cohérence)'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-completed-empty', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', now())$$,
  '23514', null, 'completed sans status_code ni réponse refusé (cohérence)'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-too-big', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 200, jsonb_build_object('x', repeat('a', 70000)), now())$$,
  '23514', null, 'réponse de plus de 16 Kio refusée'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'chk-valid-key', '50000000-0000-4000-8000-000000000002', repeat('b', 64), 'in_progress', now())$$,
  '23505', null, 'même (organisation, clé) refusée (unicité)'
);
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values (null, 'chk-null-org-key', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', now())$$,
  '23502', null, 'organization_id NULL refusé'
);
select throws_ok(
  $$update public.idempotency_keys set organization_id = '60000000-0000-4000-8000-000000000002' where key = 'chk-valid-key'$$,
  '23514', null, 'organization_id immuable'
);
select throws_ok(
  $$delete from public.organizations where id = '60000000-0000-4000-8000-000000000001'$$,
  '23503', null, 'une organisation ayant des clés ne peut pas être supprimée (RESTRICT)'
);
delete from public.idempotency_keys where key = 'chk-valid-key';

-- ---------------------------------------------------------------------------
-- 2. rate_limit_buckets : structure
-- ---------------------------------------------------------------------------
select has_table('public', 'rate_limit_buckets', 'public.rate_limit_buckets existe');
select col_is_null('public', 'rate_limit_buckets', 'organization_id', 'rate_limit_buckets.organization_id NULLABLE (seaux globaux par fournisseur)');
select col_is_null('public', 'rate_limit_buckets', 'provider', 'provider nullable');
select col_not_null('public', 'rate_limit_buckets', 'bucket_key', 'bucket_key NOT NULL');
select col_not_null('public', 'rate_limit_buckets', 'tokens', 'tokens NOT NULL');
select col_not_null('public', 'rate_limit_buckets', 'refilled_at', 'refilled_at NOT NULL');
select col_type_is('public', 'rate_limit_buckets', 'tokens', 'double precision', 'tokens est double precision');
select ok((select relrowsecurity from pg_class where oid = 'public.rate_limit_buckets'::regclass), 'RLS activée sur rate_limit_buckets');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'rate_limit_buckets'),
  0, 'rate_limit_buckets : AUCUNE politique'
);
select ok(
  not has_table_privilege('anon', 'public.rate_limit_buckets', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('anon', 'public.rate_limit_buckets', 'select,insert,update,references'),
  'rate_limit_buckets : anon n''a aucun privilège'
);
select ok(
  not has_table_privilege('authenticated', 'public.rate_limit_buckets', 'select,insert,update,delete,truncate,references,trigger')
    and not has_any_column_privilege('authenticated', 'public.rate_limit_buckets', 'select,insert,update,references'),
  'rate_limit_buckets : authenticated n''a aucun privilège'
);
select ok(
  has_table_privilege('service_role', 'public.rate_limit_buckets', 'select')
    and has_table_privilege('service_role', 'public.rate_limit_buckets', 'insert')
    and has_table_privilege('service_role', 'public.rate_limit_buckets', 'update')
    and has_table_privilege('service_role', 'public.rate_limit_buckets', 'delete'),
  'rate_limit_buckets : service_role a select, insert, update, delete'
);
select ok(
  not has_table_privilege('service_role', 'public.rate_limit_buckets', 'truncate')
    and not has_table_privilege('service_role', 'public.rate_limit_buckets', 'references')
    and not has_table_privilege('service_role', 'public.rate_limit_buckets', 'trigger'),
  'rate_limit_buckets : service_role n''a rien d''autre (ni truncate, references, trigger)'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'rate_limit_buckets'
            and indexdef like '%UNIQUE%' and indexdef like '%COALESCE(organization_id%' and indexdef like '%COALESCE(provider%'
            and indexdef like '%bucket_key%'),
  'index unique sur (coalesce(organization_id), coalesce(provider), bucket_key)'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.rate_limit_buckets'::regclass and tgname = 'set_updated_at' and not tgisinternal)
    and exists (select 1 from pg_trigger where tgrelid = 'public.rate_limit_buckets'::regclass and tgname = 'prevent_organization_id_change' and not tgisinternal),
  'triggers set_updated_at et prevent_organization_id_change'
);
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.rate_limit_buckets'::regclass
            and contype = 'f' and confdeltype = 'r'
            and conkey = array[(select attnum from pg_attribute where attrelid = 'public.rate_limit_buckets'::regclass and attname = 'organization_id')]::int2[]),
  'FK organization_id -> organizations ON DELETE RESTRICT'
);

select lives_ok(
  $$insert into public.rate_limit_buckets (organization_id, provider, bucket_key, tokens, refilled_at)
    values (null, 'salla', 'global:shared', 5, now())$$,
  'seau global par fournisseur (organization_id NULL) accepté'
);
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, provider, bucket_key, tokens, refilled_at)
    values (null, 'salla', 'global:shared', 5, now())$$,
  '23505', null, 'doublon de seau global refusé (coalesce dans l''index unique)'
);
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, provider, bucket_key, tokens, refilled_at)
    values (null, null, 'nowhere', 5, now())$$,
  '23514', null, 'ni organisation ni fournisseur refusé (CHECK)'
);
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, bucket_key, tokens, refilled_at)
    values ('60000000-0000-4000-8000-000000000001', 'has space', 5, now())$$,
  '23514', null, 'bucket_key avec espace refusée'
);
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, bucket_key, tokens, refilled_at)
    values ('60000000-0000-4000-8000-000000000001', 'user@example.com', 5, now())$$,
  '23514', null, 'bucket_key de type e-mail (@) refusée : clé opaque uniquement'
);
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, bucket_key, tokens, refilled_at)
    values ('60000000-0000-4000-8000-000000000001', repeat('k', 201), 5, now())$$,
  '23514', null, 'bucket_key de 201 caractères refusée'
);
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, bucket_key, tokens, refilled_at)
    values ('60000000-0000-4000-8000-000000000001', 'neg', -1, now())$$,
  '23514', null, 'tokens négatif refusé'
);
select throws_ok(
  $$update public.rate_limit_buckets set organization_id = '60000000-0000-4000-8000-000000000001' where bucket_key = 'global:shared'$$,
  '23514', null, 'organization_id immuable (même depuis NULL)'
);
delete from public.rate_limit_buckets where bucket_key = 'global:shared';

-- ---------------------------------------------------------------------------
-- 3. Fonctions : nature et privilèges
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('idempotency_begin', 'idempotency_complete', 'idempotency_abandon'))
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('idempotency_begin', 'idempotency_complete', 'idempotency_abandon')) = 3,
  'private.idempotency_* : 3 fonctions SECURITY DEFINER'
);
select ok(
  (select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private', 'public') and p.proname in ('idempotency_begin', 'idempotency_complete', 'idempotency_abandon', 'rate_limit_take')),
  'search_path vide fixé sur les fonctions du J11'
);
select ok(
  (select bool_and(not p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('idempotency_begin', 'idempotency_complete', 'idempotency_abandon', 'rate_limit_take'))
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('idempotency_begin', 'idempotency_complete', 'idempotency_abandon', 'rate_limit_take')) = 4,
  'public.idempotency_* et public.rate_limit_take : SECURITY INVOKER'
);
select is(
  (select count(*)::int from (values ('anon'), ('public'), ('service_role')) as r (role)
     cross join (values
       ('public.idempotency_begin(uuid,text,text)'),
       ('public.idempotency_complete(uuid,text,uuid,integer,jsonb)'),
       ('public.idempotency_abandon(uuid,text,uuid)'),
       ('private.idempotency_begin(uuid,text,text)'),
       ('private.idempotency_complete(uuid,text,uuid,integer,jsonb)'),
       ('private.idempotency_abandon(uuid,text,uuid)')) as f (sig)
     where has_function_privilege(r.role, f.sig::regprocedure, 'execute')),
  0, 'anon, PUBLIC et service_role ne peuvent exécuter aucune fonction idempotency_*'
);
select is(
  (select count(*)::int from (values
       ('public.idempotency_begin(uuid,text,text)'),
       ('public.idempotency_complete(uuid,text,uuid,integer,jsonb)'),
       ('public.idempotency_abandon(uuid,text,uuid)'),
       ('private.idempotency_begin(uuid,text,text)'),
       ('private.idempotency_complete(uuid,text,uuid,integer,jsonb)'),
       ('private.idempotency_abandon(uuid,text,uuid)')) as f (sig)
     where has_function_privilege('authenticated', f.sig::regprocedure, 'execute')),
  6, 'authenticated peut exécuter les 6 fonctions idempotency_*'
);
select ok(
  has_function_privilege('service_role', 'public.rate_limit_take(uuid,text,text,integer,double precision,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.rate_limit_take(uuid,text,text,integer,double precision,integer)', 'execute')
    and not has_function_privilege('anon', 'public.rate_limit_take(uuid,text,text,integer,double precision,integer)', 'execute')
    and not has_function_privilege('public', 'public.rate_limit_take(uuid,text,text,integer,double precision,integer)', 'execute'),
  'rate_limit_take : exécutable par service_role SEUL'
);

-- Rôles sans droit : refus à l'appel
set local role anon;
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'anon-key-0001', repeat('a', 64))$$,
  '42501', null, 'idempotency_begin : anon refusé'
);
select throws_ok(
  $$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'anon:x', 10, 1)$$,
  '42501', null, 'rate_limit_take : anon refusé'
);
reset role;
set local role service_role;
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'svc-key-00001', repeat('a', 64))$$,
  '42501', null, 'idempotency_begin : service_role refusé'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'svc-key-00001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'svc-key-00001'), 200, '{}')$$,
  '42501', null, 'idempotency_complete : service_role refusé'
);
select throws_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'svc-key-00001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'svc-key-00001'))$$,
  '42501', null, 'idempotency_abandon : service_role refusé'
);
select throws_ok(
  $$select count(*) from public.idempotency_keys$$,
  '42501', null, 'idempotency_keys : lecture directe refusée à service_role'
);
reset role;
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'auth:x', 10, 1)$$,
  '42501', null, 'rate_limit_take : authenticated refusé'
);
select throws_ok($$select count(*) from public.idempotency_keys$$, '42501', null, 'idempotency_keys : SELECT direct refusé à authenticated');
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'direct-insert-1', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'in_progress', now())$$,
  '42501', null, 'idempotency_keys : INSERT direct refusé à authenticated'
);
select throws_ok($$update public.idempotency_keys set state = 'completed'$$, '42501', null, 'idempotency_keys : UPDATE direct refusé à authenticated');
select throws_ok($$delete from public.idempotency_keys$$, '42501', null, 'idempotency_keys : DELETE direct refusé à authenticated');
select throws_ok($$select count(*) from public.rate_limit_buckets$$, '42501', null, 'rate_limit_buckets : SELECT direct refusé à authenticated');
select throws_ok(
  $$insert into public.rate_limit_buckets (organization_id, bucket_key, tokens, refilled_at)
    values ('60000000-0000-4000-8000-000000000001', 'direct-insert', 10, now())$$,
  '42501', null, 'rate_limit_buckets : INSERT direct refusé à authenticated'
);
select throws_ok($$delete from public.rate_limit_buckets$$, '42501', null, 'rate_limit_buckets : DELETE direct refusé à authenticated');
reset role;

-- ---------------------------------------------------------------------------
-- 4. idempotency_begin : authentification, autorisation, validation
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'unauth-key-01', repeat('a', 64))$$,
  '28000', 'unauthenticated', 'begin : JWT sans sub => unauthenticated'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'unauth-key-01', pg_temp.att('60000000-0000-4000-8000-000000000001', 'unauth-key-01'), 200, '{}')$$,
  '28000', 'unauthenticated', 'complete : JWT sans sub => unauthenticated'
);
select throws_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'unauth-key-01', pg_temp.att('60000000-0000-4000-8000-000000000001', 'unauth-key-01'))$$,
  '28000', 'unauthenticated', 'abandon : JWT sans sub => unauthenticated'
);

-- Non-membre (U4), membre suspendu (U5), organisation NULL
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'nomember-key1', repeat('a', 64))$$,
  '42501', 'forbidden', 'begin : utilisateur sans adhésion refusé'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'nomember-key1', pg_temp.att('60000000-0000-4000-8000-000000000001', 'nomember-key1'), 200, '{}')$$,
  '42501', 'forbidden', 'complete : utilisateur sans adhésion refusé'
);
select throws_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'nomember-key1', pg_temp.att('60000000-0000-4000-8000-000000000001', 'nomember-key1'))$$,
  '42501', 'forbidden', 'abandon : utilisateur sans adhésion refusé'
);
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'bad', 'not-a-hash')$$,
  '42501', 'forbidden', 'begin : l''autorisation passe AVANT la validation (rien ne fuit)'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'suspended-key1', repeat('a', 64))$$,
  '42501', 'forbidden', 'begin : membre suspendu refusé'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.idempotency_begin(null, 'null-org-key01', repeat('a', 64))$$,
  '42501', 'forbidden', 'begin : organisation NULL => forbidden'
);

-- Validation (U1, membre actif d'Alpha)
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'short', repeat('a', 64))$$,
  '22023', 'validation_failed', 'begin : clé trop courte');
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', repeat('k', 129), repeat('a', 64))$$,
  '22023', 'validation_failed', 'begin : clé trop longue');
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'bad key !!!', repeat('a', 64))$$,
  '22023', 'validation_failed', 'begin : clé avec caractères interdits');
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', null, repeat('a', 64))$$,
  '22023', 'validation_failed', 'begin : clé NULL');
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'valid-key-0001', repeat('A', 64))$$,
  '22023', 'validation_failed', 'begin : hash en majuscules');
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'valid-key-0001', repeat('a', 63))$$,
  '22023', 'validation_failed', 'begin : hash trop court');
select throws_ok($$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'valid-key-0001', null)$$,
  '22023', 'validation_failed', 'begin : hash NULL');
select throws_ok($$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'bad', pg_temp.att('60000000-0000-4000-8000-000000000001', 'bad'), 200, '{}')$$,
  '22023', 'validation_failed', 'complete : clé invalide');
select throws_ok($$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'bad', pg_temp.att('60000000-0000-4000-8000-000000000001', 'bad'))$$,
  '22023', 'validation_failed', 'abandon : clé invalide');
reset role;
select is((select count(*)::int from public.idempotency_keys), 0, 'aucune ligne créée par les appels refusés ou invalides');

-- ---------------------------------------------------------------------------
-- 5. idempotency_begin : états new / in_progress / conflict
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(
  (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('a', 64)))->>'state',
  'new', 'begin : première fois => new'
);
reset role;
select ok(
  exists (select 1 from public.idempotency_keys
           where organization_id = '60000000-0000-4000-8000-000000000001' and key = 'flow-key-0001'
             and actor_id = '50000000-0000-4000-8000-000000000001' and request_hash = repeat('a', 64)
             and state = 'in_progress' and status_code is null and response is null
             and expires_at = now() + interval '24 hours'),
  'la ligne créée est in_progress, rattachée à l''acteur, sans réponse, expire dans 24 h'
);
set local role authenticated;
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('a', 64)),
  '{"state":"in_progress"}'::jsonb, 'begin : même acteur, même hash, encore en cours => in_progress'
);
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('b', 64)),
  '{"state":"conflict"}'::jsonb, 'begin : même clé, hash différent => conflict'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('a', 64)),
  '{"state":"conflict"}'::jsonb, 'begin : même clé, même hash, AUTRE acteur => conflict'
);

-- complete : seul l'acteur d'origine
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 201, '{"ok":true}')$$,
  'P0001', 'invalid_state', 'complete : un autre membre ne peut pas conclure la clé d''autrui'
);
select lives_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'))$$,
  'abandon par un autre membre : sans effet, sans erreur'
);
reset role;
select is(
  (select state from public.idempotency_keys where key = 'flow-key-0001'),
  'in_progress', 'la ligne d''autrui est intacte après abandon par un autre acteur'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;

-- complete : validations
select throws_ok($$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 99, '{}')$$,
  '22023', 'validation_failed', 'complete : status_code 99');
select throws_ok($$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 600, '{}')$$,
  '22023', 'validation_failed', 'complete : status_code 600');
select throws_ok($$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), null, '{}')$$,
  '22023', 'validation_failed', 'complete : status_code NULL');
select throws_ok($$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 200, null)$$,
  '22023', 'validation_failed', 'complete : réponse NULL');
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 200, jsonb_build_object('x', repeat('a', 70000)))$$,
  '22023', 'validation_failed', 'complete : réponse de plus de 16 Kio'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'never-begun-01', pg_temp.att('60000000-0000-4000-8000-000000000001', 'never-begun-01'), 200, '{}')$$,
  'P0001', 'invalid_state', 'complete : clé jamais ouverte => invalid_state'
);
select lives_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 201, '{"id":"abc","replayed":false}')$$,
  'complete : l''acteur conclut sa clé'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 200, '{}')$$,
  'P0001', 'invalid_state', 'complete : une clé déjà conclue ne peut plus l''être (invalid_state)'
);
reset role;
select ok(
  exists (select 1 from public.idempotency_keys where key = 'flow-key-0001' and state = 'completed'
            and status_code = 201 and response = '{"id":"abc","replayed":false}'),
  'la réponse est stockée telle quelle, la ligne est completed'
);

-- replay
set local role authenticated;
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('a', 64)),
  '{"state":"replay","status_code":201,"response":{"id":"abc","replayed":false}}'::jsonb,
  'begin : clé conclue, même acteur, même hash => replay avec la réponse stockée'
);
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('b', 64)),
  '{"state":"conflict"}'::jsonb, 'begin : clé conclue, hash différent => conflict (jamais de rejeu)'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('a', 64)),
  '{"state":"conflict"}'::jsonb, 'begin : clé conclue, autre acteur, même hash => conflict (la réponse ne fuit pas)'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- abandon d'une ligne conclue : sans effet
select lives_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'))$$,
  'abandon d''une clé conclue : sans erreur'
);
reset role;
select is((select state from public.idempotency_keys where key = 'flow-key-0001'), 'completed', 'abandon ne supprime jamais une clé conclue');

-- ---------------------------------------------------------------------------
-- 6. Expiration et lignes bloquées
-- ---------------------------------------------------------------------------
update public.idempotency_keys set expires_at = now() - interval '1 second' where key = 'flow-key-0001';
set local role authenticated;
select is(
  (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('c', 64)))->>'state',
  'new', 'begin : clé conclue mais expirée (hash différent) => new'
);
reset role;
select ok(
  exists (select 1 from public.idempotency_keys where key = 'flow-key-0001' and state = 'in_progress'
            and request_hash = repeat('c', 64) and status_code is null and response is null
            and actor_id = '50000000-0000-4000-8000-000000000001' and expires_at = now() + interval '24 hours'),
  'la ligne expirée est remplacée : nouveau hash, in_progress, réponse effacée, nouvelle échéance'
);
select is((select count(*)::int from public.idempotency_keys where key = 'flow-key-0001'), 1, 'toujours une seule ligne pour (organisation, clé)');

-- in_progress de 4 minutes : encore valable
update public.idempotency_keys set created_at = now() - interval '4 minutes' where key = 'flow-key-0001';
set local role authenticated;
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('c', 64)),
  '{"state":"in_progress"}'::jsonb, 'begin : in_progress de 4 minutes => toujours in_progress'
);
reset role;
-- in_progress de 6 minutes : abandonné, remplaçable même par un autre acteur et un autre hash
update public.idempotency_keys set created_at = now() - interval '6 minutes' where key = 'flow-key-0001';
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is(
  (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'flow-key-0001', repeat('d', 64)))->>'state',
  'new', 'begin : in_progress de 6 minutes (abandonné) => new, même pour un autre acteur/hash'
);
reset role;
select ok(
  exists (select 1 from public.idempotency_keys where key = 'flow-key-0001'
            and actor_id = '50000000-0000-4000-8000-000000000002' and request_hash = repeat('d', 64) and state = 'in_progress'),
  'la ligne bloquée appartient désormais au nouvel acteur'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'flow-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'flow-key-0001'), 200, '{}')$$,
  'P0001', 'invalid_state', 'complete : l''ancien acteur ne peut plus conclure une ligne reprise par un autre'
);

-- ---------------------------------------------------------------------------
-- 7. abandon : l'acteur supprime sa ligne in_progress, un nouvel essai repart de zéro
-- ---------------------------------------------------------------------------
select is((public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'abandon-key-01', repeat('a', 64)))->>'state', 'new', 'abandon : begin => new');
select lives_ok($$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'abandon-key-01', pg_temp.att('60000000-0000-4000-8000-000000000001', 'abandon-key-01'))$$, 'abandon par l''acteur');
reset role;
select is((select count(*)::int from public.idempotency_keys where key = 'abandon-key-01'), 0, 'la ligne in_progress de l''acteur est supprimée');
set local role authenticated;
select is((public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'abandon-key-01', repeat('a', 64)))->>'state', 'new', 'après abandon, un nouvel essai obtient new');
select lives_ok($$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'unknown-key-001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'unknown-key-001'))$$, 'abandon d''une clé inconnue : sans erreur');

-- ---------------------------------------------------------------------------
-- 8. Isolation entre organisations
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'cross-org-key1', repeat('a', 64))$$,
  '42501', 'forbidden', 'begin : le propriétaire de Beta ne peut pas ouvrir une clé chez Alpha'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'abandon-key-01', pg_temp.att('60000000-0000-4000-8000-000000000001', 'abandon-key-01'), 200, '{}')$$,
  '42501', 'forbidden', 'complete : le propriétaire de Beta ne peut pas conclure une clé d''Alpha'
);
select throws_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'abandon-key-01', pg_temp.att('60000000-0000-4000-8000-000000000001', 'abandon-key-01'))$$,
  '42501', 'forbidden', 'abandon : le propriétaire de Beta ne peut pas supprimer une clé d''Alpha'
);
-- Même chaîne de clé dans deux organisations : indépendantes
select is((public.idempotency_begin('60000000-0000-4000-8000-000000000002', 'abandon-key-01', repeat('a', 64)))->>'state', 'new',
  'la même clé chez Beta est indépendante de celle d''Alpha (new)');
select lives_ok($$select public.idempotency_complete('60000000-0000-4000-8000-000000000002', 'abandon-key-01', pg_temp.att('60000000-0000-4000-8000-000000000002', 'abandon-key-01'), 200, '{"org":"beta"}')$$, 'Beta conclut sa clé');
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000002', 'abandon-key-01', repeat('a', 64))$$,
  '42501', 'forbidden', 'begin : le propriétaire d''Alpha ne peut pas lire/rejouer la clé de Beta'
);
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'abandon-key-01', repeat('a', 64)), '{"state":"in_progress"}'::jsonb,
  'la clé d''Alpha n''a pas été affectée par celle de Beta');
reset role;
select is((select count(*)::int from public.idempotency_keys where key = 'abandon-key-01'), 2, 'deux lignes distinctes, une par organisation');
select is(
  (select response from public.idempotency_keys where key = 'abandon-key-01' and organization_id = '60000000-0000-4000-8000-000000000002'),
  '{"org":"beta"}'::jsonb, 'la réponse de Beta est restée chez Beta'
);

-- ---------------------------------------------------------------------------
-- 9. rate_limit_take : validation (appels depuis service_role)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 0, 1)$$, '22023', 'validation_failed', 'capacité 0 refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10001, 1)$$, '22023', 'validation_failed', 'capacité 10001 refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', null, 1)$$, '22023', 'validation_failed', 'capacité NULL refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, -0.1)$$, '22023', 'validation_failed', 'recharge négative refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, 1000.5)$$, '22023', 'validation_failed', 'recharge > 1000 refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, 'NaN'::double precision)$$, '22023', 'validation_failed', 'recharge NaN refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, null)$$, '22023', 'validation_failed', 'recharge NULL refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, 1, 0)$$, '22023', 'validation_failed', 'coût 0 refusé');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, 1, 11)$$, '22023', 'validation_failed', 'coût > capacité refusé');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'v:1', 10, 1, null)$$, '22023', 'validation_failed', 'coût NULL refusé');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, '', 10, 1)$$, '22023', 'validation_failed', 'clé vide refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, null, 10, 1)$$, '22023', 'validation_failed', 'clé NULL refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, repeat('k', 201), 10, 1)$$, '22023', 'validation_failed', 'clé de 201 caractères refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'a b', 10, 1)$$, '22023', 'validation_failed', 'clé avec espace refusée');
select throws_ok($$select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'me@example.com', 10, 1)$$, '22023', 'validation_failed', 'clé de type e-mail refusée (opaque uniquement)');
select throws_ok($$select public.rate_limit_take(null, null, 'v:1', 10, 1)$$, '22023', 'validation_failed', 'ni organisation ni fournisseur refusé');
select throws_ok($$select public.rate_limit_take(null, 'bad provider!', 'v:1', 10, 1)$$, '22023', 'validation_failed', 'fournisseur invalide refusé');
reset role;
select is((select count(*)::int from public.rate_limit_buckets), 0, 'aucun seau créé par les appels invalides');

-- ---------------------------------------------------------------------------
-- 10. rate_limit_take : épuisement, recharge exacte, coût, plafond, retry_after
-- ---------------------------------------------------------------------------
set local role service_role;
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 3, 0),
  '{"allowed":true,"remaining":2,"retry_after_seconds":0}'::jsonb, 'premier jeton : seau plein de 3, reste 2'
);
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 3, 0),
  '{"allowed":true,"remaining":1,"retry_after_seconds":0}'::jsonb, 'deuxième jeton : reste 1'
);
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 3, 0),
  '{"allowed":true,"remaining":0,"retry_after_seconds":0}'::jsonb, 'troisième jeton : reste 0'
);
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 3, 0),
  '{"allowed":false,"remaining":0,"retry_after_seconds":86400}'::jsonb, 'seau épuisé, recharge nulle => refusé, retry_after plafonné à 86400'
);
reset role;
select is(
  (select tokens from public.rate_limit_buckets where bucket_key = 'ex:1'),
  0::double precision, 'un refus ne consomme rien et ne rend pas le seau négatif'
);

-- Recharge exacte : seau vidé, refilled_at reculé de 4 s, recharge 0,5/s => 2 jetons
update public.rate_limit_buckets set tokens = 0, refilled_at = now() - interval '4 seconds' where bucket_key = 'ex:1';
set local role service_role;
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 3, 0.5),
  '{"allowed":true,"remaining":1,"retry_after_seconds":0}'::jsonb, 'recharge exacte : 4 s x 0,5/s = 2 jetons, on en prend 1, reste 1'
);
reset role;
-- Tokens fractionnaires : 3,25 + 10 s x 0,1 = 4,25 ; on prend 1 => 3,25
update public.rate_limit_buckets set tokens = 3.25, refilled_at = now() - interval '10 seconds' where bucket_key = 'ex:1';
set local role service_role;
select ok(
  abs((public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0.1) ->> 'remaining')::double precision - 3.25) < 1e-9,
  'recharge fractionnaire exacte (3,25 + 1,0 - 1 = 3,25)'
);
reset role;
select ok(
  abs((select tokens from public.rate_limit_buckets where bucket_key = 'ex:1') - 3.25) < 1e-9
    and (select refilled_at from public.rate_limit_buckets where bucket_key = 'ex:1') = now(),
  'le seau stocke les jetons restants et refilled_at = maintenant'
);

-- Plafond à la capacité
update public.rate_limit_buckets set tokens = 0, refilled_at = now() - interval '1000 seconds' where bucket_key = 'ex:1';
set local role service_role;
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0.5),
  '{"allowed":true,"remaining":9,"retry_after_seconds":0}'::jsonb, 'la recharge est plafonnée à la capacité (10) : reste 9 après un jeton'
);
reset role;

-- Coût > 1
update public.rate_limit_buckets set tokens = 10, refilled_at = now() where bucket_key = 'ex:1';
set local role service_role;
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0, 4),
  '{"allowed":true,"remaining":6,"retry_after_seconds":0}'::jsonb, 'coût 4 : reste 6'
);
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0, 7),
  '{"allowed":false,"remaining":6,"retry_after_seconds":86400}'::jsonb, 'coût 7 > 6 disponibles : refusé, rien consommé'
);
select is(
  public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0, 6),
  '{"allowed":true,"remaining":0,"retry_after_seconds":0}'::jsonb, 'coût 6 : exactement le solde, autorisé'
);
reset role;

-- retry_after : ceil du temps nécessaire, au moins 1
update public.rate_limit_buckets set tokens = 0, refilled_at = now() where bucket_key = 'ex:1';
set local role service_role;
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0.5) ->> 'retry_after_seconds')::int,
  2, 'retry_after = ceil(1 / 0,5) = 2'
);
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 1.0 / 6) ->> 'retry_after_seconds')::int,
  6, 'retry_after = 6 pour une recharge de 1/6 par seconde (seau « sensible »)'
);
reset role;
update public.rate_limit_buckets set tokens = 0.5, refilled_at = now() where bucket_key = 'ex:1';
set local role service_role;
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 0.5, 5) ->> 'retry_after_seconds')::int,
  9, 'retry_after = ceil((5 - 0,5) / 0,5) = 9 pour un coût de 5'
);
reset role;
update public.rate_limit_buckets set tokens = 0.9, refilled_at = now() where bucket_key = 'ex:1';
set local role service_role;
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'ex:1', 10, 1000) ->> 'retry_after_seconds')::int,
  1, 'retry_after vaut au moins 1 quand refusé (temps nécessaire < 1 s)'
);
reset role;

-- ---------------------------------------------------------------------------
-- 11. rate_limit_take : isolation des seaux
-- ---------------------------------------------------------------------------
set local role service_role;
select public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'iso:a', 1, 0);
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'iso:a', 1, 0) ->> 'allowed')::boolean,
  false, 'isolation : le seau iso:a de l''organisation Alpha est épuisé');
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', null, 'iso:b', 1, 0) ->> 'allowed')::boolean,
  true, 'isolation : une autre clé de la même organisation est indépendante');
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000002', null, 'iso:a', 1, 0) ->> 'allowed')::boolean,
  true, 'isolation : la même clé dans une autre organisation est indépendante');
select is(
  (public.rate_limit_take(null, 'salla', 'iso:a', 1, 0) ->> 'allowed')::boolean,
  true, 'isolation : la même clé en seau global par fournisseur est indépendante');
select is(
  (public.rate_limit_take(null, 'salla', 'iso:a', 1, 0) ->> 'allowed')::boolean,
  false, 'seau global par fournisseur : épuisé après un jeton');
select is(
  (public.rate_limit_take(null, 'whatsapp', 'iso:a', 1, 0) ->> 'allowed')::boolean,
  true, 'isolation : un autre fournisseur est indépendant');
select is(
  (public.rate_limit_take('60000000-0000-4000-8000-000000000001', 'salla', 'iso:a', 1, 0) ->> 'allowed')::boolean,
  true, 'isolation : (organisation, fournisseur) est distinct de (organisation, sans fournisseur)');
reset role;
select is(
  (select count(*)::int from public.rate_limit_buckets where bucket_key = 'iso:a'),
  5, 'cinq seaux distincts pour la même clé opaque');
select ok(
  (select bool_and(bucket_key !~ '@' ) from public.rate_limit_buckets),
  'aucun seau ne contient de clé de type e-mail');

-- ---------------------------------------------------------------------------
-- 12. Fonctions et tables : documentation et suppression
-- ---------------------------------------------------------------------------
select ok(
  obj_description('public.rate_limit_buckets'::regclass, 'pg_class') ~* 'opaque'
    and col_description('public.rate_limit_buckets'::regclass, (select attnum from pg_attribute where attrelid = 'public.rate_limit_buckets'::regclass and attname = 'bucket_key')) ~* 'opaque',
  'la table et bucket_key documentent la règle « clé opaque, aucune donnée personnelle »'
);

-- ---------------------------------------------------------------------------
-- 13. attempt_id : seul l'essai COURANT peut conclure ou abandonner (une reprise renouvelle l'essai)
-- ---------------------------------------------------------------------------
create temp table att_saved (name text primary key, id uuid);
grant all on table att_saved to public;

select col_not_null('public', 'idempotency_keys', 'attempt_id', 'attempt_id NOT NULL');
select col_type_is('public', 'idempotency_keys', 'attempt_id', 'uuid', 'attempt_id est uuid');

select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
insert into att_saved select 'A', (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'att-key-00001', repeat('a', 64)) ->> 'attempt_id')::uuid;
reset role;
select ok((select id from att_saved where name = 'A') is not null, 'begin => new renvoie un attempt_id');
select is((select id from att_saved where name = 'A'), pg_temp.att('60000000-0000-4000-8000-000000000001', 'att-key-00001'),
  'l''attempt_id renvoyé est celui stocké sur la ligne');

-- Reprise après 5 minutes par le MÊME acteur : nouvel essai
update public.idempotency_keys set created_at = now() - interval '6 minutes' where key = 'att-key-00001';
set local role authenticated;
insert into att_saved select 'B', (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'att-key-00001', repeat('a', 64)) ->> 'attempt_id')::uuid;
reset role;
select isnt((select id from att_saved where name = 'B'), (select id from att_saved where name = 'A'),
  'la reprise d''une ligne bloquée renouvelle l''attempt_id');
select is((select id from att_saved where name = 'B'), pg_temp.att('60000000-0000-4000-8000-000000000001', 'att-key-00001'),
  'la ligne porte l''attempt_id du nouvel essai');

set local role authenticated;
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'att-key-00001', (select id from att_saved where name = 'A'), 200, '{"late":true}')$$,
  'P0001', 'invalid_state', 'complete : l''essai tardif (même acteur) ne peut pas conclure la ligne du nouvel essai'
);
select lives_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'att-key-00001', (select id from att_saved where name = 'A'))$$,
  'abandon par l''essai tardif : sans erreur'
);
reset role;
select ok(
  exists (select 1 from public.idempotency_keys where key = 'att-key-00001' and state = 'in_progress'
            and attempt_id = (select id from att_saved where name = 'B')),
  'abandon tardif : sans effet, la ligne du nouvel essai est intacte'
);
set local role authenticated;
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'att-key-00001', gen_random_uuid(), 200, '{}')$$,
  'P0001', 'invalid_state', 'complete : un attempt_id inconnu est refusé (invalid_state)'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'att-key-00001', null, 200, '{}')$$,
  '22023', 'validation_failed', 'complete : attempt_id NULL => validation_failed'
);
select throws_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'att-key-00001', null)$$,
  '22023', 'validation_failed', 'abandon : attempt_id NULL => validation_failed'
);
select lives_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'att-key-00001', gen_random_uuid())$$,
  'abandon : un attempt_id inconnu est sans effet, sans erreur'
);
select lives_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'att-key-00001', (select id from att_saved where name = 'B'), 200, '{"done":true}')$$,
  'complete : le nouvel essai conclut sa ligne'
);
select is(
  public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'att-key-00001', repeat('a', 64)),
  '{"state":"replay","status_code":200,"response":{"done":true}}'::jsonb,
  'replay de sa propre ligne conclue : fonctionne toujours (sans attempt_id)'
);
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'att-key-00001', (select id from att_saved where name = 'A'), 500, '{"late":true}')$$,
  'P0001', 'invalid_state', 'complete : l''essai tardif ne peut pas écraser une ligne conclue'
);
select lives_ok(
  $$select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'att-key-00001', (select id from att_saved where name = 'B'))$$,
  'abandon d''une ligne conclue avec le bon essai : sans erreur'
);
reset role;
select ok(
  exists (select 1 from public.idempotency_keys where key = 'att-key-00001' and state = 'completed' and status_code = 200),
  'la ligne conclue est intacte (jamais supprimée par abandon)'
);

-- Reprise d'une ligne EXPIRÉE : nouvel attempt_id aussi
update public.idempotency_keys set expires_at = now() - interval '1 second' where key = 'att-key-00001';
set local role authenticated;
insert into att_saved select 'C', (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'att-key-00001', repeat('b', 64)) ->> 'attempt_id')::uuid;
reset role;
select isnt((select id from att_saved where name = 'C'), (select id from att_saved where name = 'B'),
  'la reprise d''une ligne expirée renouvelle aussi l''attempt_id');

-- Abandon avec le bon essai supprime ; avec un autre essai, ne supprime pas
set local role authenticated;
insert into att_saved select 'D', (public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'att-key-00002', repeat('a', 64)) ->> 'attempt_id')::uuid;
select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'att-key-00002', gen_random_uuid());
reset role;
select is((select count(*)::int from public.idempotency_keys where key = 'att-key-00002'), 1, 'abandon avec un autre essai : la ligne reste');
set local role authenticated;
select public.idempotency_abandon('60000000-0000-4000-8000-000000000001', 'att-key-00002', (select id from att_saved where name = 'D'));
reset role;
select is((select count(*)::int from public.idempotency_keys where key = 'att-key-00002'), 0, 'abandon avec le bon essai : la ligne est supprimée');

-- ---------------------------------------------------------------------------
-- 14. Plafond de la réponse stockée : 16384 octets (16384 accepté, 16385 refusé)
-- ---------------------------------------------------------------------------
select is(octet_length(jsonb_build_object('x', repeat('a', 16384 - 9))::text), 16384, 'mesure : la réponse de test fait exactement 16384 octets');
select is(octet_length(jsonb_build_object('x', repeat('a', 16385 - 9))::text), 16385, 'mesure : la réponse de test fait exactement 16385 octets');
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'cap-key-0001', repeat('a', 64)) ->> 'state', 'new', 'cap : begin cap-key-0001');
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'cap-key-0002', repeat('a', 64)) ->> 'state', 'new', 'cap : begin cap-key-0002');
select throws_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'cap-key-0002', pg_temp.att('60000000-0000-4000-8000-000000000001', 'cap-key-0002'), 200, jsonb_build_object('x', repeat('a', 16385 - 9)))$$,
  '22023', 'validation_failed', 'complete : réponse de 16385 octets refusée'
);
select lives_ok(
  $$select public.idempotency_complete('60000000-0000-4000-8000-000000000001', 'cap-key-0001', pg_temp.att('60000000-0000-4000-8000-000000000001', 'cap-key-0001'), 200, jsonb_build_object('x', repeat('a', 16384 - 9)))$$,
  'complete : réponse de 16384 octets acceptée'
);
reset role;
select throws_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'cap-direct-big', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 200, jsonb_build_object('x', repeat('a', 16385 - 9)), now())$$,
  '23514', null, 'CHECK : réponse de 16385 octets refusée'
);
select lives_ok(
  $$insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
    values ('60000000-0000-4000-8000-000000000001', 'cap-direct-ok1', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 200, jsonb_build_object('x', repeat('a', 16384 - 9)), now())$$,
  'CHECK : réponse de 16384 octets acceptée'
);

-- ---------------------------------------------------------------------------
-- 15. Quota : au plus 200 lignes non expirées par (entreprise, acteur)
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('50000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u6@svc.test', now());
insert into public.organization_members (organization_id, user_id, role, status) values
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000006', 'sales_agent', 'active'),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000006', 'sales_agent', 'active');
-- 199 lignes vivantes + 5 expirées (qui ne comptent pas) pour U6 chez Alpha
insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
select '60000000-0000-4000-8000-000000000001', 'quota-live-' || lpad(i::text, 5, '0'), '50000000-0000-4000-8000-000000000006',
       repeat('a', 64), 'in_progress', now() + interval '12 hours'
  from generate_series(1, 199) as i;
insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
select '60000000-0000-4000-8000-000000000001', 'quota-dead-' || lpad(i::text, 5, '0'), '50000000-0000-4000-8000-000000000006',
       repeat('a', 64), 'completed', 200, '{}', now() - interval '1 second'
  from generate_series(1, 5) as i;
select is(
  (select count(*)::int from public.idempotency_keys
    where organization_id = '60000000-0000-4000-8000-000000000001' and actor_id = '50000000-0000-4000-8000-000000000006' and expires_at > now()),
  199, 'mise en place : 199 lignes vivantes pour U6 chez Alpha (les expirées ne comptent pas)'
);
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
set local role authenticated;
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-new-00200', repeat('a', 64)) ->> 'state', 'new',
  'quota : la 200e ligne vivante est acceptée');
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-new-00201', repeat('a', 64))$$,
  'P0001', 'quota_exceeded', 'quota : la 201e ligne vivante est refusée (quota_exceeded)'
);
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-new-00200', repeat('a', 64)),
  '{"state":"in_progress"}'::jsonb, 'quota atteint : une clé existante reste lisible (in_progress), aucune nouvelle ligne n''est nécessaire');
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000002', 'quota-other-org', repeat('a', 64)) ->> 'state', 'new',
  'quota : le même acteur dans une AUTRE entreprise n''est pas affecté');
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-other-act', repeat('a', 64)) ->> 'state', 'new',
  'quota : un AUTRE acteur de la même entreprise n''est pas affecté');
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000006","role":"authenticated"}', true);
reset role;
select is(
  (select count(*)::int from public.idempotency_keys where key = 'quota-new-00201'), 0, 'aucune ligne créée par le refus de quota'
);
-- Reprise d'une ligne bloquée de l'acteur au quota : la ligne reprise n'est pas comptée deux fois
update public.idempotency_keys set created_at = now() - interval '6 minutes' where key = 'quota-live-00001';
set local role authenticated;
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-live-00001', repeat('a', 64)) ->> 'state', 'new',
  'quota atteint : reprendre sa propre ligne bloquée reste possible');
reset role;
-- Une ligne qui expire libère de la place
update public.idempotency_keys set expires_at = now() - interval '1 second' where key = 'quota-live-00002';
set local role authenticated;
select is(public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-after-exp', repeat('a', 64)) ->> 'state', 'new',
  'quota : une ligne expirée libère une place');
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-full-again', repeat('a', 64))$$,
  'P0001', 'quota_exceeded', 'quota : de nouveau plein à 200'
);
reset role;
-- Reprise d'une ligne expirée d'autrui par un acteur au quota : refusée (ce serait une nouvelle ligne vivante)
insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
values ('60000000-0000-4000-8000-000000000001', 'quota-foreign-exp', '50000000-0000-4000-8000-000000000002', repeat('a', 64), 'completed', 200, '{}', now() - interval '1 second');
set local role authenticated;
select throws_ok(
  $$select public.idempotency_begin('60000000-0000-4000-8000-000000000001', 'quota-foreign-exp', repeat('a', 64))$$,
  'P0001', 'quota_exceeded', 'quota : reprendre la ligne expirée d''autrui est refusé quand on est au quota'
);
reset role;
select is(
  (select count(*)::int from public.idempotency_keys where organization_id = '60000000-0000-4000-8000-000000000001'
     and actor_id = '50000000-0000-4000-8000-000000000006' and expires_at > now()),
  200, 'après tout cela : exactement 200 lignes vivantes pour U6 chez Alpha'
);

-- ---------------------------------------------------------------------------
-- 16. Purges : privilèges (service_role SEUL), nature des fonctions
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('idempotency_purge', 'rate_limit_purge'))
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('idempotency_purge', 'rate_limit_purge')) = 2
  and (select bool_and(not p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('idempotency_purge', 'rate_limit_purge'))
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('idempotency_purge', 'rate_limit_purge')) = 2,
  'purges : private.* SECURITY DEFINER, public.* SECURITY INVOKER'
);
select ok(
  (select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private', 'public') and p.proname in ('idempotency_purge', 'rate_limit_purge')),
  'purges : search_path vide'
);
select is(
  (select count(*)::int from (values ('anon'), ('public'), ('authenticated')) as r (role)
     cross join (values
       ('public.idempotency_purge(integer)'), ('public.rate_limit_purge(integer)'),
       ('private.idempotency_purge(integer)'), ('private.rate_limit_purge(integer)')) as f (sig)
     where has_function_privilege(r.role, f.sig::regprocedure, 'execute')),
  0, 'purges : anon, PUBLIC et authenticated ne peuvent exécuter aucune des 4 fonctions'
);
select is(
  (select count(*)::int from (values
       ('public.idempotency_purge(integer)'), ('public.rate_limit_purge(integer)'),
       ('private.idempotency_purge(integer)'), ('private.rate_limit_purge(integer)')) as f (sig)
     where has_function_privilege('service_role', f.sig::regprocedure, 'execute')),
  4, 'purges : service_role peut exécuter les 4 fonctions'
);
set local role anon;
select throws_ok($$select public.idempotency_purge()$$, '42501', null, 'idempotency_purge : anon refusé');
select throws_ok($$select public.rate_limit_purge()$$, '42501', null, 'rate_limit_purge : anon refusé');
reset role;
select set_config('request.jwt.claims', '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.idempotency_purge()$$, '42501', null, 'idempotency_purge : authenticated refusé');
select throws_ok($$select public.rate_limit_purge()$$, '42501', null, 'rate_limit_purge : authenticated refusé');
select throws_ok($$select private.idempotency_purge(10)$$, '42501', null, 'private.idempotency_purge : authenticated refusé');
select throws_ok($$select private.rate_limit_purge(10)$$, '42501', null, 'private.rate_limit_purge : authenticated refusé');
reset role;

-- ---------------------------------------------------------------------------
-- 17. idempotency_purge : comportement
-- ---------------------------------------------------------------------------
delete from public.idempotency_keys;
insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at, created_at) values
  ('60000000-0000-4000-8000-000000000001', 'purge-exp-2h-01', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 200, '{}', now() - interval '2 hours', now() - interval '26 hours'),
  ('60000000-0000-4000-8000-000000000001', 'purge-exp-59m-01', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 200, '{}', now() - interval '59 minutes', now() - interval '25 hours'),
  ('60000000-0000-4000-8000-000000000001', 'purge-live-0001', '50000000-0000-4000-8000-000000000001', repeat('a', 64), 'completed', 200, '{}', now() + interval '1 hour', now()),
  ('60000000-0000-4000-8000-000000000002', 'purge-stale-2h-1', '50000000-0000-4000-8000-000000000003', repeat('a', 64), 'in_progress', null, null, now() + interval '22 hours', now() - interval '2 hours'),
  ('60000000-0000-4000-8000-000000000002', 'purge-ip-30m-001', '50000000-0000-4000-8000-000000000003', repeat('a', 64), 'in_progress', null, null, now() + interval '23 hours', now() - interval '30 minutes'),
  ('60000000-0000-4000-8000-000000000002', 'purge-ip-fresh-01', '50000000-0000-4000-8000-000000000003', repeat('a', 64), 'in_progress', null, null, now() + interval '24 hours', now());
set local role service_role;
select is(public.idempotency_purge(), 2, 'idempotency_purge : supprime la ligne expirée depuis 2 h et l''in_progress vieux de 2 h');
reset role;
select is(
  (select array_agg(key order by key) from public.idempotency_keys),
  array['purge-exp-59m-01', 'purge-ip-30m-001', 'purge-ip-fresh-01', 'purge-live-0001']::text[],
  'idempotency_purge : les lignes vivantes, récemment expirées (< 1 h) et in_progress récentes sont conservées'
);
set local role service_role;
select is(public.idempotency_purge(), 0, 'idempotency_purge : second appel sans rien à supprimer => 0');
reset role;

-- Lots : au plus p_batch lignes par appel
insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at)
select '60000000-0000-4000-8000-000000000001', 'purge-batch-' || lpad(i::text, 4, '0'), '50000000-0000-4000-8000-000000000001',
       repeat('a', 64), 'completed', 200, '{}', now() - interval '3 hours'
  from generate_series(1, 5) as i;
set local role service_role;
select is(public.idempotency_purge(2), 2, 'idempotency_purge(2) : au plus 2 lignes (lot 1)');
select is(public.idempotency_purge(2), 2, 'idempotency_purge(2) : lot 2');
select is(public.idempotency_purge(2), 1, 'idempotency_purge(2) : dernier lot de 1');
select throws_ok($$select public.idempotency_purge(0)$$, '22023', 'validation_failed', 'idempotency_purge(0) refusé');
select throws_ok($$select public.idempotency_purge(10001)$$, '22023', 'validation_failed', 'idempotency_purge(10001) refusé');
select throws_ok($$select public.idempotency_purge(null)$$, '22023', 'validation_failed', 'idempotency_purge(NULL) refusé');
select lives_ok($$select public.idempotency_purge(1)$$, 'idempotency_purge(1) accepté');
select lives_ok($$select public.idempotency_purge(10000)$$, 'idempotency_purge(10000) accepté');
reset role;
select is((select count(*)::int from public.idempotency_keys), 4, 'après les lots : seules les 4 lignes à conserver restent');

-- ---------------------------------------------------------------------------
-- 18. rate_limit_purge : comportement
-- ---------------------------------------------------------------------------
delete from public.rate_limit_buckets;
insert into public.rate_limit_buckets (organization_id, provider, bucket_key, tokens, refilled_at) values
  ('60000000-0000-4000-8000-000000000001', null, 'rlp:idle-8d', 1, now() - interval '8 days'),
  ('60000000-0000-4000-8000-000000000001', null, 'rlp:idle-6d', 1, now() - interval '6 days'),
  ('60000000-0000-4000-8000-000000000002', null, 'rlp:fresh', 1, now()),
  (null, 'salla', 'rlp:global-idle-30d', 1, now() - interval '30 days'),
  (null, 'salla', 'rlp:global-idle-2d', 1, now() - interval '2 days');
set local role service_role;
select is(public.rate_limit_purge(), 2, 'rate_limit_purge : supprime les seaux inactifs depuis plus de 7 jours (organisation et global)');
reset role;
select is(
  (select array_agg(bucket_key order by bucket_key) from public.rate_limit_buckets),
  array['rlp:fresh', 'rlp:global-idle-2d', 'rlp:idle-6d']::text[],
  'rate_limit_purge : les seaux récents sont conservés'
);
set local role service_role;
select is(public.rate_limit_purge(1), 2, 'rate_limit_purge(1) : supprime ceux inactifs depuis plus d''1 jour (2 j et 6 j)');
select is(public.rate_limit_purge(1), 0, 'rate_limit_purge(1) : rien à supprimer ensuite');
reset role;
-- Un seau utilisé est « rafraîchi » par rate_limit_take et n'est plus purgé
update public.rate_limit_buckets set refilled_at = now() - interval '400 days' where bucket_key = 'rlp:fresh';
set local role service_role;
select public.rate_limit_take('60000000-0000-4000-8000-000000000002', null, 'rlp:fresh', 5, 1);
select is(public.rate_limit_purge(365), 0, 'rate_limit_purge : un seau utilisé récemment n''est pas purgé');
reset role;
update public.rate_limit_buckets set refilled_at = now() - interval '366 days' where bucket_key = 'rlp:fresh';
insert into public.rate_limit_buckets (organization_id, provider, bucket_key, tokens, refilled_at) values
  (null, 'salla', 'rlp:global-364d', 1, now() - interval '364 days');
set local role service_role;
select is(public.rate_limit_purge(365), 1, 'rate_limit_purge(365) : 366 jours purgé, 364 jours conservé');
select throws_ok($$select public.rate_limit_purge(0)$$, '22023', 'validation_failed', 'rate_limit_purge(0) refusé');
select throws_ok($$select public.rate_limit_purge(366)$$, '22023', 'validation_failed', 'rate_limit_purge(366) refusé');
select throws_ok($$select public.rate_limit_purge(null)$$, '22023', 'validation_failed', 'rate_limit_purge(NULL) refusé');
reset role;

select * from finish();
rollback;
