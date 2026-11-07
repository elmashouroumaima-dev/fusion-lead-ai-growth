-- « Schema lint » (plan D7, ADR 005 §14) : règles automatiques sur TOUTES les tables du schéma public.
-- Échoue dès qu'une table (présente ou future) viole l'isolation par entreprise :
--   organization_id not null + index, RLS activée, aucun accès anon, une politique pour chaque
--   opération accordée à authenticated, jamais user_metadata, fonctions security definer sûres.
-- Aucune exception silencieuse : les tables sans organization_id sont listées ci-dessous.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Tables légitimement SANS organization_id : `organizations` est la racine du tenant ;
-- `plans` est un catalogue global (ADR 007) ; `rate_limit_buckets` (J11, ADR 007 G-D9) a un
-- organization_id NULLABLE par conception (seaux globaux par fournisseur ; CHECK organization_id OU
-- provider non nul), n'est écrit que par service_role et n'a ni politique ni droit pour authenticated
-- (vérifié par 050_service_layer.test.sql). Toute autre exception doit être ajoutée ici AVEC une
-- justification en revue. `platform_config` (J12b, ADR 016) est une donnée GLOBALE : aucun droit pour anon /
-- authenticated / service_role, RLS sans politique, accès par fonctions (vérifié par 070_platform_config.test.sql).
create temporary table lint_exempt (table_name text primary key) on commit drop;
insert into lint_exempt values ('organizations'), ('plans'), ('rate_limit_buckets'), ('platform_config');

create temporary table lint_tables on commit drop as
select c.oid as relid, c.relname::text as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p');

-- L1 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(t.table_name order by t.table_name)
              from lint_tables t
             where t.table_name not in (select table_name from lint_exempt)
               and not exists (
                 select 1 from pg_attribute a
                  where a.attrelid = t.relid and a.attname = 'organization_id'
                    and a.attnotnull and a.atttypid = 'uuid'::regtype and not a.attisdropped)), '{}'::text[]),
  '{}'::text[],
  'L1 : toute table tenant a organization_id uuid NOT NULL'
);

-- L2 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(t.table_name order by t.table_name)
              from lint_tables t
             where t.table_name not in (select table_name from lint_exempt)
               and not exists (
                 select 1 from pg_index i
                  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                 where i.indrelid = t.relid and a.attname = 'organization_id')), '{}'::text[]),
  '{}'::text[],
  'L2 : organization_id est première colonne d''un index'
);

-- L3 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(t.table_name order by t.table_name)
              from lint_tables t join pg_class c on c.oid = t.relid
             where not c.relrowsecurity), '{}'::text[]),
  '{}'::text[],
  'L3 : RLS activée sur toute table du schéma public'
);

-- L4 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(t.table_name order by t.table_name)
              from lint_tables t
             where has_table_privilege('anon', t.relid, 'select,insert,update,delete,truncate,references,trigger')
                or has_any_column_privilege('anon', t.relid, 'select,insert,update,references')), '{}'::text[]),
  '{}'::text[],
  'L4 : le rôle anon n''a aucun privilège sur les tables du schéma public'
);

-- L5 -------------------------------------------------------------------------------------------
-- Chaque opération accordée à authenticated doit avoir au moins une politique (cmd ou ALL).
select is(
  coalesce((select array_agg(x.table_name || ':' || x.cmd order by x.table_name, x.cmd)
              from (
                select t.table_name, cmds.cmd
                  from lint_tables t
                 cross join (values ('select'), ('insert'), ('update'), ('delete')) as cmds (cmd)
                 where (case cmds.cmd
                          when 'select' then has_any_column_privilege('authenticated', t.relid, 'select')
                          when 'insert' then has_any_column_privilege('authenticated', t.relid, 'insert')
                          when 'update' then has_any_column_privilege('authenticated', t.relid, 'update')
                          when 'delete' then has_table_privilege('authenticated', t.relid, 'delete')
                        end)
                   and not exists (
                     select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = t.table_name
                        and p.cmd in (upper(cmds.cmd), 'ALL')
                        and 'authenticated' = any (p.roles))
              ) x), '{}'::text[]),
  '{}'::text[],
  'L5 : chaque privilège accordé à authenticated est couvert par une politique'
);

-- L6 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(p.tablename || '.' || p.policyname order by p.tablename, p.policyname)
              from pg_policies p
             where p.schemaname = 'public'
               and (p.roles && array['public', 'anon']::name[]
                    or not (p.roles @> array['authenticated']::name[]))), '{}'::text[]),
  '{}'::text[],
  'L6 : toute politique cible explicitement authenticated (jamais public ni anon)'
);

-- L7 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(p.tablename || '.' || p.policyname order by p.tablename, p.policyname)
              from pg_policies p
             where p.schemaname = 'public'
               and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~* '(user_metadata|raw_user_meta_data|app_metadata|raw_app_meta_data)'), '{}'::text[]),
  '{}'::text[],
  'L7 : aucune politique ne lit user_metadata / app_metadata (ADR 005 §5)'
);

-- L8 -------------------------------------------------------------------------------------------
-- Politique UPDATE sans WITH CHECK : une ligne pourrait être modifiée vers un état interdit.
select is(
  coalesce((select array_agg(p.tablename || '.' || p.policyname order by p.tablename, p.policyname)
              from pg_policies p
             where p.schemaname = 'public' and p.cmd in ('UPDATE', 'ALL') and p.with_check is null), '{}'::text[]),
  '{}'::text[],
  'L8 : toute politique UPDATE/ALL a un WITH CHECK'
);

-- L9 -------------------------------------------------------------------------------------------
select is(
  coalesce((select array_agg(n.nspname || '.' || pr.proname order by n.nspname, pr.proname)
              from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
             where n.nspname in ('public', 'private') and pr.prosecdef
               and not exists (select 1 from unnest(coalesce(pr.proconfig, '{}')) c where c like 'search_path=%')), '{}'::text[]),
  '{}'::text[],
  'L9 : toute fonction security definer fixe son search_path'
);

-- L10 ------------------------------------------------------------------------------------------
-- Une fonction security definer du schéma public serait appelable via /rpc : interdit sans ADR.
select is(
  coalesce((select array_agg(pr.proname::text order by pr.proname)
              from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
             where n.nspname = 'public' and pr.prosecdef), '{}'::text[]),
  '{}'::text[],
  'L10 : aucune fonction security definer exposée dans le schéma public'
);

-- L11 ------------------------------------------------------------------------------------------
-- Le schéma private ne doit pas être accessible à anon ni exposé comme API.
select ok(
  not has_schema_privilege('anon', 'private', 'usage')
    and not exists (
      select 1 from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
       where n.nspname = 'private'
         and (has_function_privilege('anon', pr.oid, 'execute') or has_function_privilege('public', pr.oid, 'execute'))),
  'L11 : aucune fonction du schéma private n''est exécutable par anon ou PUBLIC'
);

select * from finish();
rollback;
