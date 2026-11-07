-- J6 — Contraintes et verrouillage du noyau tenant (spec §2, §7, §7.2, §10 ; ADR 005, 007).
-- Exécution : pnpm test:db (base locale réinitialisée avec le seed : 2 entreprises, 1 utilisateur commun).
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_table('public', 'plans', 'table plans');
select has_table('public', 'organizations', 'table organizations');
select has_table('public', 'organization_members', 'table organization_members');
select has_table('public', 'subscriptions', 'table subscriptions');
select has_table('public', 'usage_counters', 'table usage_counters');

-- Les 5 rôles d'organisation de la spec §2 ; platform_admin n'en fait pas partie (ADR 005 §10)
select is(
  (select array_agg(enumlabel::text order by enumsortorder)
     from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'app_role'),
  array['company_owner', 'company_admin', 'marketing_manager', 'sales_agent', 'analyst'],
  'app_role = 5 rôles, sans platform_admin'
);

select ok(
  (select jsonb_typeof(limits) = 'object' from public.plans where code = 'trial'),
  'le plan trial existe, limites = objet JSON (valeurs définies au J14)'
);

-- ---------------------------------------------------------------------------
-- RLS activée et aucun privilège direct pour anon / authenticated (ADR 005 §6)
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.plans'::regclass), 'RLS plans');
select ok((select relrowsecurity from pg_class where oid = 'public.organizations'::regclass), 'RLS organizations');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_members'::regclass), 'RLS organization_members');
select ok((select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass), 'RLS subscriptions');
select ok((select relrowsecurity from pg_class where oid = 'public.usage_counters'::regclass), 'RLS usage_counters');

select is(
  (select count(*)::int
     from (values ('plans'), ('organizations'), ('organization_members'),
                  ('subscriptions'), ('usage_counters')) as t (table_name)
    where has_table_privilege(
            'anon', format('public.%I', t.table_name),
            'select,insert,update,delete,truncate,references,trigger')
       or has_any_column_privilege('anon', format('public.%I', t.table_name), 'select,insert,update,references')),
  0,
  'anon n''a aucun privilège sur les tables du noyau'
);

-- authenticated : lecture seule, sauf mises à jour limitées à des colonnes et suppression d'adhésions (J7)
select is(
  (select count(*)::int
     from (values ('plans'), ('organizations'), ('organization_members'),
                  ('subscriptions'), ('usage_counters')) as t (table_name)
    where has_table_privilege(
            'authenticated', format('public.%I', t.table_name),
            'insert,update,truncate,references,trigger')
       or (t.table_name <> 'organization_members'
           and has_table_privilege('authenticated', format('public.%I', t.table_name), 'delete'))),
  0,
  'authenticated : aucun insert/update global/truncate, delete seulement sur organization_members'
);
select ok(
  has_column_privilege('authenticated', 'public.organizations', 'name', 'update')
    and not has_column_privilege('authenticated', 'public.organizations', 'slug', 'update')
    and not has_column_privilege('authenticated', 'public.organizations', 'status', 'update')
    and has_column_privilege('authenticated', 'public.organization_members', 'role', 'update')
    and not has_column_privilege('authenticated', 'public.organization_members', 'organization_id', 'update')
    and not has_column_privilege('authenticated', 'public.organization_members', 'user_id', 'update'),
  'GRANT par colonne : slug, status, organization_id et user_id non modifiables'
);

-- ---------------------------------------------------------------------------
-- Fonctions d'aide : security definer, search_path vide, droits (ADR 005 §4)
-- ---------------------------------------------------------------------------
select ok((select prosecdef from pg_proc where oid = 'private.is_member(uuid)'::regprocedure), 'is_member : security definer');
select ok((select prosecdef from pg_proc where oid = 'private.has_role(uuid, public.app_role[])'::regprocedure), 'has_role : security definer');
select is((select proconfig from pg_proc where oid = 'private.is_member(uuid)'::regprocedure), array['search_path=""'], 'is_member : search_path vide');
select is((select proconfig from pg_proc where oid = 'private.has_role(uuid, public.app_role[])'::regprocedure), array['search_path=""'], 'has_role : search_path vide');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon n''a pas accès au schéma private');
select ok(has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated peut évaluer les politiques (usage sur private)');
select ok(not has_function_privilege('anon', 'private.is_member(uuid)', 'execute'), 'anon ne peut pas exécuter is_member');
select ok(has_function_privilege('authenticated', 'private.is_member(uuid)', 'execute'), 'authenticated peut exécuter is_member');

-- ---------------------------------------------------------------------------
-- Contraintes (valeurs de seed : Alpha a0…a1, Beta b0…b1, shared 0…01)
-- ---------------------------------------------------------------------------
select is(
  (select role::text from public.organization_members
    where organization_id = 'a0000000-0000-4000-8000-0000000000a1' and user_id = '00000000-0000-4000-8000-000000000001'),
  'company_owner',
  'l''utilisateur commun est company_owner chez Alpha'
);
select is(
  (select role::text from public.organization_members
    where organization_id = 'b0000000-0000-4000-8000-0000000000b1' and user_id = '00000000-0000-4000-8000-000000000001'),
  'sales_agent',
  'et sales_agent chez Beta (deux rôles différents)'
);

select throws_ok(
  $$insert into public.organization_members (organization_id, user_id, role)
    values ('a0000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'analyst')$$,
  '23505', null, 'adhésion unique par (organization_id, user_id)'
);
select throws_ok(
  $$insert into public.organizations (name, slug) values ('Autre', 'alpha')$$,
  '23505', null, 'slug unique'
);
select throws_ok(
  $$insert into public.organizations (name, slug) values ('Mauvais', 'Bad Slug!')$$,
  '23514', null, 'format du slug (minuscules, chiffres, tirets)'
);
select throws_ok(
  $$insert into public.organizations (name, slug, locale) values ('Locale', 'locale-es', 'es')$$,
  '23514', null, 'locale limitée à ar/en/fr (es refusée)'
);
select lives_ok(
  $$insert into public.organizations (name, slug, locale) values ('Locale FR', 'locale-fr-ok', 'fr')$$,
  'locale fr acceptée'
);
select throws_ok(
  $$insert into public.organizations (name, slug, locale) values ('Locale', 'locale-maj', 'FR')$$,
  '23514', null, 'locale FR (majuscules) refusée'
);
select throws_ok(
  $$insert into public.organizations (name, slug, locale) values ('Locale', 'locale-esp', 'fr ')$$,
  '23514', null, 'locale « fr » avec espace final refusée'
);
select throws_ok(
  $$insert into public.organizations (name, slug, locale) values ('Locale', 'locale-nul', null)$$,
  '23502', null, 'locale null refusée'
);
select is(
  (select locale from public.organizations where slug = 'locale-fr-ok'),
  'fr', 'locale fr enregistrée'
);
select is(
  (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.organizations'::regclass and a.attname = 'locale'),
  '''fr''::text', 'organizations.locale : défaut fr'
);
select throws_ok(
  $$insert into public.organization_members (organization_id, user_id, role)
    values ('a0000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000007', 'platform_admin')$$,
  '22P02', null, 'platform_admin refusé comme rôle d''organisation'
);
select throws_ok(
  $$insert into public.subscriptions (organization_id, plan_id)
    values ('a0000000-0000-4000-8000-0000000000a1', (select id from public.plans where code = 'trial'))$$,
  '23505', null, 'une seule subscription par entreprise'
);
select throws_ok(
  $$update public.subscriptions set period_start = now(), period_end = now() - interval '1 day'
    where organization_id = 'a0000000-0000-4000-8000-0000000000a1'$$,
  '23514', null, 'période de subscription cohérente'
);

insert into public.usage_counters (organization_id, metric, period_start, value)
values ('a0000000-0000-4000-8000-0000000000a1', 'messages_sent', '2026-11-01', 3);
select throws_ok(
  $$insert into public.usage_counters (organization_id, metric, period_start, value)
    values ('a0000000-0000-4000-8000-0000000000a1', 'messages_sent', '2026-11-01', 1)$$,
  '23505', null, 'compteur unique par (organisation, métrique, période)'
);
select lives_ok(
  $$insert into public.usage_counters (organization_id, metric, period_start, value)
    values ('b0000000-0000-4000-8000-0000000000b1', 'messages_sent', '2026-11-01', 7)$$,
  'la même métrique et période existe séparément pour une autre entreprise'
);
select throws_ok(
  $$insert into public.usage_counters (organization_id, metric, period_start, value)
    values ('a0000000-0000-4000-8000-0000000000a1', 'ai_runs', '2026-11-01', -1)$$,
  '23514', null, 'valeur de compteur non négative'
);

-- ---------------------------------------------------------------------------
-- Triggers : anti-transfert d'organisation (spec §2) et updated_at
-- ---------------------------------------------------------------------------
select throws_ok(
  $$update public.organization_members set organization_id = 'b0000000-0000-4000-8000-0000000000b1'
    where organization_id = 'a0000000-0000-4000-8000-0000000000a1'
      and user_id = '00000000-0000-4000-8000-000000000005'$$,
  '23514', null, 'transfert d''une adhésion vers une autre entreprise refusé'
);
select throws_ok(
  $$update public.usage_counters set organization_id = 'b0000000-0000-4000-8000-0000000000b1'
    where organization_id = 'a0000000-0000-4000-8000-0000000000a1' and metric = 'messages_sent'$$,
  '23514', null, 'transfert d''un compteur vers une autre entreprise refusé'
);

update public.organizations set name = 'Alpha (renommée)' where slug = 'alpha';
select ok(
  (select updated_at > created_at from public.organizations where slug = 'alpha'),
  'updated_at est mis à jour par trigger'
);

select * from finish();
rollback;
