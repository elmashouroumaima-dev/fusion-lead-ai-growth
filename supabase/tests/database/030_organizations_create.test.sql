-- J9 — Création transactionnelle d'une organisation : private.create_organization (security definer)
-- et wrapper public.create_organization (security invoker). Sources : ADR 005 §11 (G-R7), ADR 006, ADR 014.
-- Chaque cas qui appelle la fonction s'exécute sous le rôle `authenticated` avec un JWT de test dont
-- seul `sub` compte ; les vérifications de lignes s'exécutent sous le propriétaire (sans RLS).
-- Tout est annulé en fin de test (rollback) : aucune donnée ne subsiste.
begin;
create extension if not exists pgtap with schema extensions;
select plan(163);

-- Utilisateurs de test (auth.users minimal) : u1..u4 existent, u9 n'existe pas.
insert into auth.users (id, instance_id, aud, role, email) values
  ('90000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j9-u1@seed.test'),
  ('90000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j9-u2@seed.test'),
  ('90000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j9-u3@seed.test'),
  ('90000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j9-u4@seed.test');

-- ---------------------------------------------------------------------------
-- 1. Structure : fonctions, sécurité, privilèges
-- ---------------------------------------------------------------------------
select has_function('private', 'create_organization', array['text', 'text', 'text', 'text'], 'private.create_organization existe');
select has_function('public', 'create_organization', array['text', 'text', 'text', 'text'], 'public.create_organization existe');

select ok(
  (select prosecdef from pg_proc where oid = 'private.create_organization(text,text,text,text)'::regprocedure),
  'private.create_organization est SECURITY DEFINER'
);
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc where oid = 'private.create_organization(text,text,text,text)'::regprocedure),
  'private.create_organization fixe search_path vide'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.create_organization(text,text,text,text)'::regprocedure),
  'public.create_organization est SECURITY INVOKER'
);
select is(
  (select proargnames from pg_proc where oid = 'private.create_organization(text,text,text,text)'::regprocedure),
  array['p_name', 'p_locale', 'p_timezone', 'p_creation_key'],
  'private.create_organization : aucun paramètre identité (l''utilisateur vient de auth.uid())'
);
select is(
  (select proargnames from pg_proc where oid = 'public.create_organization(text,text,text,text)'::regprocedure),
  array['p_name', 'p_locale', 'p_timezone', 'p_creation_key'],
  'public.create_organization : aucun paramètre identité'
);
select is(
  (select count(*)::int from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public' and pr.prosecdef),
  0,
  'aucune fonction security definer dans le schéma public (L10)'
);

select ok(not has_function_privilege('anon', 'public.create_organization(text,text,text,text)', 'execute'), 'anon ne peut pas exécuter le wrapper public');
select ok(not has_function_privilege('public', 'public.create_organization(text,text,text,text)', 'execute'), 'PUBLIC ne peut pas exécuter le wrapper public');
select ok(has_function_privilege('authenticated', 'public.create_organization(text,text,text,text)', 'execute'), 'authenticated peut exécuter le wrapper public');
select ok(not has_function_privilege('service_role', 'public.create_organization(text,text,text,text)', 'execute'), 'service_role n''a pas besoin du wrapper public');
select ok(not has_function_privilege('anon', 'private.create_organization(text,text,text,text)', 'execute'), 'anon ne peut pas exécuter la fonction privée');
select ok(not has_function_privilege('public', 'private.create_organization(text,text,text,text)', 'execute'), 'PUBLIC ne peut pas exécuter la fonction privée');
select ok(has_function_privilege('authenticated', 'private.create_organization(text,text,text,text)', 'execute'), 'authenticated peut exécuter la fonction privée (via le wrapper)');

-- Colonnes : created_by / creation_key ne sont écrivables par aucun client (GRANT par colonne de J7 inchangés).
select ok(not has_column_privilege('authenticated', 'public.organizations', 'created_by', 'update'), 'created_by : pas de UPDATE pour authenticated');
select ok(not has_column_privilege('authenticated', 'public.organizations', 'creation_key', 'update'), 'creation_key : pas de UPDATE pour authenticated');
select ok(not has_column_privilege('authenticated', 'public.organizations', 'created_by', 'insert'), 'created_by : pas de INSERT pour authenticated');
select ok(not has_column_privilege('authenticated', 'public.organizations', 'creation_key', 'insert'), 'creation_key : pas de INSERT pour authenticated');
select ok(not has_column_privilege('anon', 'public.organizations', 'created_by', 'select'), 'created_by : anon ne lit pas');
select ok(has_column_privilege('authenticated', 'public.organizations', 'name', 'update'), 'name reste modifiable (GRANT J7 inchangé)');
select ok(not has_column_privilege('authenticated', 'public.organizations', 'slug', 'update'), 'slug reste non modifiable');
select ok(not has_table_privilege('authenticated', 'public.organizations', 'insert'), 'aucun INSERT direct sur organizations');
select ok(not has_table_privilege('authenticated', 'public.organization_members', 'insert'), 'aucun INSERT direct sur organization_members');
select ok(not has_table_privilege('authenticated', 'public.subscriptions', 'insert'), 'aucun INSERT direct sur subscriptions');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('organizations', 'organization_members', 'subscriptions')
      and cmd in ('INSERT', 'ALL')),
  0,
  'aucune politique INSERT sur organizations / organization_members / subscriptions'
);
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'organizations'
            and indexname = 'organizations_created_by_creation_key_key'
            and indexdef like '%UNIQUE%' and indexdef like '%creation_key IS NOT NULL%'),
  'index unique partiel (created_by, creation_key) où creation_key is not null'
);

-- ---------------------------------------------------------------------------
-- 2. Appel non authentifié
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.create_organization('Sans identité', 'ar', 'UTC', 'nokey-0001')$$,
  '28000', 'unauthenticated', 'JWT sans sub : unauthenticated (28000)'
);
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select public.create_organization('Sans identité', 'ar', 'UTC', 'nokey-0001')$$,
  '28000', 'unauthenticated', 'aucune revendication JWT : unauthenticated (28000)'
);
reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok(
  $$select public.create_organization('Anon Co', 'ar', 'UTC', 'anonkey-01')$$,
  '42501', null, 'anon : permission refusée sur le wrapper public'
);
select throws_ok(
  $$select private.create_organization('Anon Co', 'ar', 'UTC', 'anonkey-01')$$,
  '42501', null, 'anon : permission refusée sur la fonction privée (schéma non accessible)'
);
reset role;

select is((select count(*)::int from public.organizations where name = 'Sans identité' or name = 'Anon Co'), 0, 'appels non authentifiés : aucune organisation créée');

-- ---------------------------------------------------------------------------
-- 3. Création nominale (u1) : organisation + owner actif + abonnement d'essai
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('t.org1',
  public.create_organization('  Acme Café  ', 'en', 'Africa/Casablanca', 'j9-key-0001')::text, true);
reset role;

select ok(current_setting('t.org1')::uuid is not null, 'la création renvoie un identifiant');
select is((select name from public.organizations where id = current_setting('t.org1')::uuid), 'Acme Café', 'nom rogné (trim)');
select is((select locale from public.organizations where id = current_setting('t.org1')::uuid), 'en', 'locale enregistrée');
select is((select timezone from public.organizations where id = current_setting('t.org1')::uuid), 'Africa/Casablanca', 'fuseau enregistré');
select is((select status::text from public.organizations where id = current_setting('t.org1')::uuid), 'active', 'organisation active');
select is((select created_by from public.organizations where id = current_setting('t.org1')::uuid), '90000000-0000-4000-8000-000000000001'::uuid, 'created_by = auth.uid()');
select is((select creation_key from public.organizations where id = current_setting('t.org1')::uuid), 'j9-key-0001', 'creation_key enregistrée');
select matches((select slug from public.organizations where id = current_setting('t.org1')::uuid), '^acme-cafe-[0-9a-f]{6}$', 'slug ASCII normalisé (accents retirés) + suffixe aléatoire');
select matches((select slug from public.organizations where id = current_setting('t.org1')::uuid), '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$', 'slug conforme à organizations_slug_format');

select is((select count(*)::int from public.organization_members where organization_id = current_setting('t.org1')::uuid), 1, 'une seule adhésion créée');
select is((select role::text from public.organization_members where organization_id = current_setting('t.org1')::uuid), 'company_owner', 'adhésion : rôle company_owner');
select is((select status::text from public.organization_members where organization_id = current_setting('t.org1')::uuid), 'active', 'adhésion : statut active');
select is((select user_id from public.organization_members where organization_id = current_setting('t.org1')::uuid), '90000000-0000-4000-8000-000000000001'::uuid, 'adhésion : user_id = auth.uid()');
select is((select count(*)::int from public.subscriptions where organization_id = current_setting('t.org1')::uuid), 1, 'un seul abonnement créé');
select is((select p.code from public.subscriptions s join public.plans p on p.id = s.plan_id where s.organization_id = current_setting('t.org1')::uuid), 'trial', 'abonnement : plan trial');
select is((select status::text from public.subscriptions where organization_id = current_setting('t.org1')::uuid), 'trial', 'abonnement : statut trial');
select ok((select period_start is not null and period_start <= now() from public.subscriptions where organization_id = current_setting('t.org1')::uuid), 'abonnement : period_start = now()');
select ok((select period_end is null from public.subscriptions where organization_id = current_setting('t.org1')::uuid), 'abonnement : period_end NULL (aucune durée d''essai inventée)');

-- Le propriétaire voit son organisation via la RLS (lecture normale)
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.organizations where id = current_setting('t.org1')::uuid), 1, 'le créateur voit son organisation (RLS)');
select is((select count(*)::int from public.subscriptions where organization_id = current_setting('t.org1')::uuid), 1, 'le créateur (owner) voit son abonnement (RLS)');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Idempotence : même (utilisateur, clé) => même organisation, rien de nouveau
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(
  public.create_organization('  Acme Café  ', 'en', 'Africa/Casablanca', 'j9-key-0001'),
  current_setting('t.org1')::uuid,
  'rejeu identique : même identifiant'
);
select is(
  public.create_organization('Acme Café', 'en', 'Africa/Casablanca', 'j9-key-0001'),
  current_setting('t.org1')::uuid,
  'rejeu avec nom équivalent après trim : même identifiant'
);
reset role;
select is((select count(*)::int from public.organizations where created_by = '90000000-0000-4000-8000-000000000001'), 1, 'rejeu : toujours 1 organisation');
select is((select count(*)::int from public.organization_members where user_id = '90000000-0000-4000-8000-000000000001'), 1, 'rejeu : toujours 1 adhésion');
select is((select count(*)::int from public.subscriptions where organization_id = current_setting('t.org1')::uuid), 1, 'rejeu : toujours 1 abonnement');

-- Conflit : même clé, charge utile différente
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.create_organization('Autre nom', 'en', 'Africa/Casablanca', 'j9-key-0001')$$,
  'P0001', 'idempotency_conflict', 'même clé, nom différent : idempotency_conflict'
);
select throws_ok(
  $$select public.create_organization('Acme Café', 'ar', 'Africa/Casablanca', 'j9-key-0001')$$,
  'P0001', 'idempotency_conflict', 'même clé, locale différente : idempotency_conflict'
);
select throws_ok(
  $$select public.create_organization('Acme Café', 'en', 'Europe/Paris', 'j9-key-0001')$$,
  'P0001', 'idempotency_conflict', 'même clé, fuseau différent : idempotency_conflict'
);
reset role;
select is((select count(*)::int from public.organizations where created_by = '90000000-0000-4000-8000-000000000001'), 1, 'conflits : aucune organisation supplémentaire');

-- Un autre utilisateur ne peut pas réutiliser la clé pour lire / obtenir l'organisation d'autrui
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select set_config('t.org2', public.create_organization('Acme Café', 'en', 'Africa/Casablanca', 'j9-key-0001')::text, true);
reset role;
select isnt(current_setting('t.org2')::uuid, current_setting('t.org1')::uuid, 'u2 avec la même clé que u1 : obtient SA propre organisation');
select is((select created_by from public.organizations where id = current_setting('t.org2')::uuid), '90000000-0000-4000-8000-000000000002'::uuid, 'organisation de u2 : created_by = u2');
select is((select count(*)::int from public.organization_members where organization_id = current_setting('t.org1')::uuid and user_id = '90000000-0000-4000-8000-000000000002'), 0, 'u2 n''est pas membre de l''organisation de u1');
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.organizations where id = current_setting('t.org1')::uuid), 0, 'u2 ne voit pas l''organisation de u1 (RLS)');
reset role;

-- Sans clé : pas d'idempotence, deux créations distinctes
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select set_config('t.nokey_a', public.create_organization('Sans clé', 'ar', 'UTC', null)::text, true);
select set_config('t.nokey_b', public.create_organization('Sans clé', 'ar', 'UTC', null)::text, true);
reset role;
select isnt(current_setting('t.nokey_a')::uuid, current_setting('t.nokey_b')::uuid, 'creation_key null : deux organisations distinctes');
select is((select count(distinct slug)::int from public.organizations where created_by = '90000000-0000-4000-8000-000000000003'), 2, 'deux organisations de même nom : deux slugs distincts');

-- ---------------------------------------------------------------------------
-- 5. Validation (SQLSTATE 22023 / validation_failed) ; aucune ligne créée
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.create_organization('   ', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom blanc refusé');
select throws_ok($$select public.create_organization(E' \t\n ', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom blanc (tabulation / retour ligne) refusé');
select throws_ok($$select public.create_organization(null, 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom null refusé');
select throws_ok($$select public.create_organization(repeat('a', 121), 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom de 121 caractères refusé');
select throws_ok($$select public.create_organization('Val Co', 'es', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'locale hors (ar, en, fr) refusée');
select throws_ok($$select public.create_organization('Val Co', 'FR', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'locale FR (majuscules) refusée');
select throws_ok($$select public.create_organization('Val Co', 'fr ', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'locale « fr » avec espace final refusée');
select throws_ok($$select public.create_organization('Val Co', '', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'locale vide refusée');
select throws_ok($$select public.create_organization('Val Co', null, 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'locale null refusée');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'Mars/Phobos', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau inconnu refusé');
select throws_ok($$select public.create_organization('Val Co', 'ar', null, 'val-key-001')$$, '22023', 'validation_failed', 'fuseau null refusé');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'UTC', 'short07')$$, '22023', 'validation_failed', 'clé de 7 caractères refusée');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'UTC', repeat('k', 129))$$, '22023', 'validation_failed', 'clé de 129 caractères refusée');
select throws_ok($$select public.create_organization('Acme' || chr(1) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+0001 refusé');
select throws_ok($$select public.create_organization('Acme' || chr(31) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+001F refusé');
select throws_ok($$select public.create_organization('Acme' || chr(127) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+007F refusé');
select throws_ok($$select public.create_organization('Acme' || chr(133) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+0085 (C1) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(159) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+009F (C1) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8203) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+200B (zero-width space) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8204) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+200C refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8205) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+200D refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8206) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+200E (LRM) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8207) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+200F (RLM) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8232) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+2028 refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8233) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+2029 refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8234) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+202A (LRE) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8238) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+202E (RLO) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8288) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+2060 (word joiner) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8294) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+2066 (LRI) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(8297) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+2069 (PDI) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(1564) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+061C (ALM) refusé');
select throws_ok($$select public.create_organization('Acme' || chr(65279) || 'Co', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom avec U+FEFF (BOM) refusé');
select throws_ok($$select public.create_organization(chr(8238) || 'Acme', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom : bidi en tête refusé (après trim ASCII)');
select throws_ok($$select public.create_organization('شركة' || chr(8) || 'النور', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom : caractère de contrôle en milieu de nom arabe refusé');
select throws_ok($$select public.create_organization('!!!', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom sans lettre ni chiffre (ponctuation) refusé');
select throws_ok($$select public.create_organization('- - -', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom sans lettre ni chiffre (tirets et espaces) refusé');
select throws_ok($$select public.create_organization(chr(128512), 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom sans lettre ni chiffre (emoji seul) refusé');
select throws_ok($$select public.create_organization('«»،؟', 'ar', 'UTC', 'val-key-001')$$, '22023', 'validation_failed', 'nom sans lettre ni chiffre (ponctuation arabe) refusé');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'EST', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : abréviation EST');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'est', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : abréviation est');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'Asia/Nowhere', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : région/ville inconnue');
select throws_ok($$select public.create_organization('Val Co', 'ar', '', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : fuseau vide');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'Europe/', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : ville manquante');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'utc ', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : utc suivi d'' espace');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'utc', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : utc en minuscules');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'asia/riyadh', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : casse incorrecte');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'UTC ', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : UTC suivi d'' espace');
select throws_ok($$select public.create_organization('Val Co', 'ar', 'Europe//Paris', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : double barre');
select throws_ok($$select public.create_organization('Val Co', 'ar', '/Europe/Paris', 'val-key-001')$$, '22023', 'validation_failed', 'fuseau refusé : barre initiale');
reset role;
select is((select count(*)::int from public.organizations where created_by = '90000000-0000-4000-8000-000000000004'), 0, 'validations refusées : aucune organisation créée');
select is((select count(*)::int from public.organization_members where user_id = '90000000-0000-4000-8000-000000000004'), 0, 'validations refusées : aucune adhésion créée');

-- Bornes acceptées
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.create_organization(repeat('a', 120), 'ar', 'UTC', repeat('k', 128))$$, 'nom de 120 caractères et clé de 128 caractères acceptés');
select lives_ok($$select public.create_organization('Bornes', 'ar', 'UTC', 'keylen-08')$$, 'clé de 9 caractères acceptée');
select lives_ok($$select public.create_organization('Bornes 8', 'ar', 'UTC', '12345678')$$, 'clé de 8 caractères acceptée');
select lives_ok($$select public.create_organization('Défaut')$$, 'wrapper : valeurs par défaut (fr, UTC, sans clé)');
select lives_ok($$select public.create_organization('Val Fr', 'fr', 'UTC', 'ok-fr-0001')$$, 'locale fr acceptée');
select lives_ok($$select public.create_organization('Éclair Ñandú', 'en', 'UTC', 'ok-name-01')$$, 'nom latin accentué accepté');
select lives_ok($$select public.create_organization('Привет', 'en', 'UTC', 'ok-name-02')$$, 'nom cyrillique accepté');
select lives_ok($$select public.create_organization('شركة النور', 'ar', 'UTC', 'ok-name-03')$$, 'nom arabe accepté');
select lives_ok($$select public.create_organization('١٢٣', 'ar', 'UTC', 'ok-name-04')$$, 'nom en chiffres arabo-indiens accepté');
select lives_ok($$select public.create_organization('42', 'en', 'UTC', 'ok-name-05')$$, 'nom uniquement numérique accepté');
select lives_ok($$select public.create_organization('Acme (Maroc) - SARL', 'en', 'UTC', 'ok-name-06')$$, 'ponctuation ordinaire acceptée si une lettre est présente');
select lives_ok($$select public.create_organization('Acme', 'en', 'Asia/Kolkata', 'ok-tz-0001')$$, 'fuseau Asia/Kolkata accepté');
select lives_ok($$select public.create_organization('Acme', 'en', 'Europe/Kyiv', 'ok-tz-0002')$$, 'fuseau Europe/Kyiv accepté');
select lives_ok($$select public.create_organization('Acme', 'en', 'America/Argentina/Buenos_Aires', 'ok-tz-0003')$$, 'fuseau America/Argentina/Buenos_Aires accepté');
select lives_ok($$select public.create_organization('Acme', 'en', 'Etc/GMT+5', 'ok-tz-0004')$$, 'fuseau Etc/GMT+5 accepté');
select lives_ok($$select public.create_organization('Acme', 'en', 'UTC', 'ok-tz-0005')$$, 'fuseau UTC accepté');
reset role;
select is((select locale || '/' || timezone from public.organizations where name = 'Défaut'), 'fr/UTC', 'valeurs par défaut : fr / UTC');
select is((select locale from public.organizations where name = 'Val Fr'), 'fr', 'locale fr enregistrée par la fonction');
select is(
  (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.organizations'::regclass and a.attname = 'locale'),
  '''fr''::text', 'organizations.locale : défaut fr'
);
select is(
  (select pg_get_expr(pr.proargdefaults, 0) from pg_proc pr where pr.oid = 'public.create_organization(text,text,text,text)'::regprocedure),
  '''fr''::text, ''UTC''::text, NULL::text', 'wrapper : défauts fr / UTC / null'
);
select is(
  (select count(*)::int from public.organizations where slug in ('alpha', 'beta') and locale = (case slug when 'alpha' then 'en' else 'ar' end)),
  2, 'entreprises du seed inchangées (alpha = en, beta = ar)'
);
select ok((select length(slug) <= 63 from public.organizations where name = repeat('a', 120)), 'nom de 120 caractères : slug dans la limite de 63');

-- ---------------------------------------------------------------------------
-- 6. Règles de slug
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select public.create_organization('شركة النور', 'ar', 'Asia/Riyadh', 'slug-key-01');
select public.create_organization('Привет', 'en', 'UTC', 'slug-key-02');
select public.create_organization('Ünïcode & Co -- Ltd.', 'en', 'UTC', 'slug-key-03');
select public.create_organization('  --Trait-- ', 'en', 'UTC', 'slug-key-04');
select public.create_organization('Société 123', 'en', 'UTC', 'slug-key-05');
select public.create_organization('Crème Brûlée Ñandú Ça', 'en', 'UTC', 'slug-key-06');
reset role;
select matches((select slug from public.organizations where creation_key = 'slug-key-01' and created_by = '90000000-0000-4000-8000-000000000003'), '^org-[0-9a-f]{6}$', 'nom arabe : slug préfixé « org »');
select matches((select slug from public.organizations where creation_key = 'slug-key-02' and created_by = '90000000-0000-4000-8000-000000000003'), '^org-[0-9a-f]{6}$', 'nom cyrillique (aucune lettre/chiffre ASCII) : slug préfixé « org »');
select matches((select slug from public.organizations where creation_key = 'slug-key-03' and created_by = '90000000-0000-4000-8000-000000000003'), '^unicode-co-ltd-[0-9a-f]{6}$', 'accents retirés, séparateurs regroupés');
select matches((select slug from public.organizations where creation_key = 'slug-key-04' and created_by = '90000000-0000-4000-8000-000000000003'), '^trait-[0-9a-f]{6}$', 'tirets de bord retirés');
select matches((select slug from public.organizations where creation_key = 'slug-key-05' and created_by = '90000000-0000-4000-8000-000000000003'), '^societe-123-[0-9a-f]{6}$', 'chiffres conservés');
select matches((select slug from public.organizations where creation_key = 'slug-key-06' and created_by = '90000000-0000-4000-8000-000000000003'), '^creme-brulee-nandu-ca-[0-9a-f]{6}$', 'noms latins accentués : tous les diacritiques retirés (regex par échappements)');

-- ---------------------------------------------------------------------------
-- 7. Atomicité : un échec en cours de fonction ne laisse AUCUNE ligne
-- ---------------------------------------------------------------------------
-- 7a. Échec à la dernière étape (plan d'essai absent) : organisation et adhésion déjà insérées
--     doivent être annulées.
update public.plans set code = 'trial_off' where code = 'trial';
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.create_organization('Atomique Co', 'ar', 'UTC', 'atomic-key-1')$$,
  'XX000', 'trial_plan_missing', 'plan d''essai absent : échec en fin de transaction'
);
reset role;
update public.plans set code = 'trial' where code = 'trial_off';
select is((select count(*)::int from public.organizations where name = 'Atomique Co'), 0, 'atomicité : aucune organisation restante');
select is((select count(*)::int from public.organization_members where user_id = '90000000-0000-4000-8000-000000000004' and organization_id not in (select id from public.organizations)), 0, 'atomicité : aucune adhésion orpheline');
select is((select count(*)::int from public.organizations where creation_key = 'atomic-key-1'), 0, 'atomicité : la clé d''idempotence n''est pas consommée');

-- 7b. Utilisateur inexistant dans auth.users (clé étrangère) : rien n'est créé.
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-0000000000ee","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.create_organization('Fantôme Co', 'ar', 'UTC', 'ghost-key-01')$$,
  '23503', null, 'utilisateur absent de auth.users : violation de clé étrangère'
);
reset role;
select is((select count(*)::int from public.organizations where name = 'Fantôme Co'), 0, 'utilisateur fantôme : aucune organisation');
select is((select count(*)::int from public.organization_members where user_id = '90000000-0000-4000-8000-0000000000ee'), 0, 'utilisateur fantôme : aucune adhésion');

-- Après les échecs, une création normale fonctionne (le plan est rétabli)
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.create_organization('Atomique Co', 'ar', 'UTC', 'atomic-key-1')$$, 'après rétablissement du plan, la création réussit');
reset role;

-- ---------------------------------------------------------------------------
-- 8. Écritures directes refusées ; triggers J6/J7 toujours actifs
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$update public.organizations set created_by = null where name = 'Acme Café'$$, '42501', null, 'UPDATE created_by refusé (GRANT par colonne)');
select throws_ok($$update public.organizations set creation_key = 'hijacked-key' where name = 'Acme Café'$$, '42501', null, 'UPDATE creation_key refusé (GRANT par colonne)');
select throws_ok($$insert into public.organizations (name, slug) values ('Direct', 'direct-org')$$, '42501', null, 'INSERT direct sur organizations refusé');
select throws_ok(
  format($f$insert into public.organization_members (organization_id, user_id, role) values (%L, %L, 'company_owner')$f$,
    current_setting('t.org2'), '90000000-0000-4000-8000-000000000001'),
  '42501', null, 'INSERT direct sur organization_members refusé'
);
select lives_ok($$update public.organizations set name = 'Acme Café SARL' where name = 'Acme Café' and created_by = '90000000-0000-4000-8000-000000000001'$$, 'le owner peut toujours renommer (name)');
reset role;

-- protect_last_owner : l'owner créé est l'unique owner actif => ni suppression ni rétrogradation
select throws_ok(
  format($f$delete from public.organization_members where organization_id = %L$f$, current_setting('t.org1')),
  '23514', null, 'protect_last_owner : le créateur (unique owner) ne peut pas être supprimé'
);
select throws_ok(
  format($f$update public.organization_members set role = 'analyst' where organization_id = %L$f$, current_setting('t.org1')),
  '23514', null, 'protect_last_owner : le créateur ne peut pas être rétrogradé'
);
-- anti-transfert : une souscription ne change pas d'organisation
select throws_ok(
  format($f$update public.subscriptions set organization_id = %L where organization_id = %L$f$, current_setting('t.org2'), current_setting('t.org1')),
  '23514', null, 'anti-transfert : organization_id d''un abonnement est immuable'
);
select throws_ok(
  format($f$update public.organization_members set organization_id = %L where organization_id = %L$f$, current_setting('t.org2'), current_setting('t.org1')),
  '23514', null, 'anti-transfert : organization_id d''une adhésion est immuable'
);

select * from finish();
rollback;
