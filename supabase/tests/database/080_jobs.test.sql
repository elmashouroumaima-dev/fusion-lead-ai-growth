-- J13 — Jobs : structure, droits, enqueue, claim exclusif, bail (lease) et heartbeat, retry avec backoff,
-- dead_letter, rejeu et annulation audités, RLS. Les appels du worker s'exécutent sous service_role ; les
-- vérifications d'état sous le propriétaire. Dans une transaction now() est constant : le temps qui passe est
-- simulé en reculant next_run_at / lease_until. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(75);

-- Données : orgs A et B ; U1 owner A · U2 sales A · U3 owner B
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('76000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@jb.test', now()),
  ('76000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@jb.test', now()),
  ('76000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u3@jb.test', now());
insert into public.organizations (id, name, slug) values
  ('77000000-0000-4000-8000-00000000000a', 'JB Alpha', 'jb-alpha-test'),
  ('77000000-0000-4000-8000-00000000000b', 'JB Beta', 'jb-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('77000000-0000-4000-8000-00000000000a', '76000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('77000000-0000-4000-8000-00000000000a', '76000000-0000-4000-8000-000000000002', 'sales_agent', 'active'),
  ('77000000-0000-4000-8000-00000000000b', '76000000-0000-4000-8000-000000000003', 'company_owner', 'active');
delete from public.jobs;

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Structure et droits
select has_table('public', 'jobs', 'public.jobs existe');
select col_not_null('public', 'jobs', 'organization_id', 'organization_id NOT NULL');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.jobs'::regclass), 'RLS activée');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'jobs'), 1, 'une seule politique (select)');
select ok(not has_table_privilege('anon', 'public.jobs', 'select,insert,update,delete'), 'anon : aucun droit');
select ok(has_table_privilege('authenticated', 'public.jobs', 'select'), 'authenticated : select (sous RLS)');
select ok(not has_table_privilege('authenticated', 'public.jobs', 'insert,update,delete'), 'authenticated : aucune écriture');
select ok(not has_table_privilege('service_role', 'public.jobs', 'select,insert,update,delete'), 'service_role : aucun droit direct (fonctions seulement)');
select ok(
  exists (select 1 from pg_constraint where conrelid = 'public.jobs'::regclass and conname = 'jobs_org_idempotency_key' and contype = 'u'),
  'unique (organization_id, idempotency_key)'
);

-- 2. Seul service_role exécute les fonctions
select pg_temp.as_user('76000000-0000-4000-8000-000000000001');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'key-authenticated-1')$$, '42501', null, 'authenticated : enqueue refusé');
select throws_ok($$select * from public.claim_jobs('w1', 1, 60)$$, '42501', null, 'authenticated : claim refusé');
reset role;
set local role anon;
select throws_ok($$select * from public.claim_jobs('w1', 1, 60)$$, '42501', null, 'anon : claim refusé');
reset role;

-- 3. enqueue (le worker s'authentifie avec la clé service_role : aucun `sub`, donc acteur « système » dans l'audit)
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
set local role service_role;
select lives_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{"contact_id": "c1"}'::jsonb, 'key-alpha-0001')$$, 'enqueue valide');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'key-alpha-0001')$$, '23505', 'duplicate_job', 'idempotency_key dupliquée refusée (même organisation)');
select lives_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000b', 'noop', '{}'::jsonb, 'key-alpha-0001')$$, 'même clé dans une autre organisation : autorisée');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'Bad Kind', '{}'::jsonb, 'key-alpha-0002')$$, '22023', 'validation_failed', 'kind invalide refusé');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'short')$$, '22023', 'validation_failed', 'clé trop courte refusée');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{"token": "abc"}'::jsonb, 'key-alpha-0003')$$, '22023', 'validation_failed', 'payload avec clé sensible refusé');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', jsonb_build_object('body', repeat('x', 300)), 'key-alpha-0004')$$, '22023', 'validation_failed', 'payload avec longue chaîne (corps de message) refusé');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '[]'::jsonb, 'key-alpha-0005')$$, '22023', 'validation_failed', 'payload non objet refusé');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'key-alpha-0006', null, 0)$$, '22023', 'validation_failed', 'max_attempts 0 refusé');
select throws_ok($$select public.enqueue_job('77000000-0000-4000-8000-0000000000ff', 'noop', '{}'::jsonb, 'key-alpha-0007')$$, '22023', 'validation_failed', 'organisation inconnue refusée');
select lives_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'key-alpha-future', now() + interval '1 hour')$$, 'job planifié dans le futur');
reset role;
select is((select count(*)::int from public.jobs), 3, '3 jobs créés : refus sans effet de bord');

-- 4. claim exclusif
set local role service_role;
select is((select count(*)::int from public.claim_jobs('worker-a', 1, 60)), 1, 'worker A prend 1 job');
select is((select count(*)::int from public.claim_jobs('worker-b', 5, 60)), 1, 'worker B prend le job restant (jamais celui de A) ; le job futur est ignoré');
select is((select count(*)::int from public.claim_jobs('worker-c', 5, 60)), 0, 'plus rien à prendre');
select throws_ok($$select * from public.claim_jobs('bad worker', 1, 60)$$, '22023', 'validation_failed', 'nom de worker invalide refusé');
select throws_ok($$select * from public.claim_jobs('worker-a', 0, 60)$$, '22023', 'validation_failed', 'limite 0 refusée');
select throws_ok($$select * from public.claim_jobs('worker-a', 1, 1)$$, '22023', 'validation_failed', 'bail trop court refusé');
reset role;
select is((select count(*)::int from public.jobs where status = 'running'), 2, '2 jobs en cours');
select is((select count(distinct locked_by)::int from public.jobs where status = 'running'), 2, 'chaque job a un seul détenteur');
select ok((select bool_and(attempts = 1 and lease_until > now()) from public.jobs where status = 'running'), 'attempts = 1 et bail posé');

-- 5. heartbeat et complete : réservés au détenteur du bail
create temp table my_job on commit drop as select id, organization_id from public.jobs where locked_by = 'worker-a';
grant select on my_job to public;
set local role service_role;
select is(public.heartbeat_job((select id from my_job), 'worker-a', 120), true, 'heartbeat par le détenteur');
select is(public.heartbeat_job((select id from my_job), 'worker-b', 120), false, 'heartbeat par un autre worker : refusé');
select is(public.complete_job((select id from my_job), 'worker-b'), false, 'complete par un autre worker : refusé');
select is(public.fail_job((select id from my_job), 'worker-b', 'x'), null, 'fail par un autre worker : refusé');
select is(public.complete_job((select id from my_job), 'worker-a'), true, 'complete par le détenteur');
select is(public.complete_job((select id from my_job), 'worker-a'), false, 'complete deux fois : refusé');
reset role;
select is((select status::text from public.jobs where id = (select id from my_job)), 'succeeded', 'job réussi');

-- 6. retry avec backoff
select is((select count(*)::int from public.jobs where locked_by = 'worker-b' and status = 'running'), 1, 'job de B toujours en cours');
create temp table b_job on commit drop as select id, organization_id from public.jobs where locked_by = 'worker-b';
grant select on b_job to public;
set local role service_role;
select is(public.fail_job((select id from b_job), 'worker-b', E'timeout\nconnexion ' || repeat('x', 400)), 'queued', 'échec : nouvel essai planifié');
reset role;
select is((select status::text from public.jobs where id = (select id from b_job)), 'queued', 'job remis en file');
select ok((select next_run_at > now() + interval '4 seconds' and next_run_at <= now() + interval '11 seconds' from public.jobs where id = (select id from b_job)), 'backoff : 10 s x jitter (0,5 à 1) après le 1er échec');
select ok((select locked_by is null and lease_until is null from public.jobs where id = (select id from b_job)), 'bail libéré');
select ok((select char_length(last_error) <= 200 and last_error ~ '^[A-Za-z0-9_.:-]+$' from public.jobs where id = (select id from b_job)), 'last_error tronqué, alphabet sûr uniquement');
select is(private.job_clean_error(E'a\u202eb\u200bc d\n'), 'a_b_c_d_', 'bidi, zéro-largeur, espace et saut de ligne remplacés');
set local role service_role;
select is((select count(*)::int from public.claim_jobs('worker-a', 5, 60)), 0, 'avant next_run_at : pas repris');
reset role;
update public.jobs set next_run_at = now() - interval '1 second' where id = (select id from b_job);
set local role service_role;
select is((select attempts from public.claim_jobs('worker-a', 5, 60) limit 1), 2, 'repris après le délai : attempts = 2');
reset role;

-- 7. dead_letter : essais épuisés, erreur non reprenable
set local role service_role;
select lives_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'key-dead-0001', null, 1)$$, 'job à 1 essai');
select lives_ok($$select public.enqueue_job('77000000-0000-4000-8000-00000000000a', 'noop', '{}'::jsonb, 'key-dead-0002', null, 5)$$, 'job à 5 essais');
select is((select count(*)::int from public.claim_jobs('worker-d', 50, 60)), 2, 'les deux jobs sont pris');
reset role;
create temp table dead1 on commit drop as select id from public.jobs where idempotency_key = 'key-dead-0001';
create temp table dead2 on commit drop as select id from public.jobs where idempotency_key = 'key-dead-0002';
grant select on dead1, dead2 to public;
set local role service_role;
select is(public.fail_job((select id from dead1), 'worker-d', 'boom'), 'dead_letter', 'essais épuisés : dead_letter');
select is(public.fail_job((select id from dead2), 'worker-d', 'invalid_payload', false), 'dead_letter', 'erreur non reprenable : dead_letter immédiat');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'job.dead_lettered' and entity_id in (select id from dead1 union select id from dead2)), 2, 'audit job.dead_lettered');
select ok((select bool_and(actor_kind = 'system' and not (after ? 'payload')) from public.audit_logs where action = 'job.dead_lettered' and entity_id in (select id from dead1)), 'audit : acteur système, sans payload');

-- 8. bail expiré : reprise ou dead_letter
update public.jobs set lease_until = now() - interval '1 minute' where status = 'running' and locked_by = 'worker-a';
create temp table stale as select id, attempts, max_attempts from public.jobs where status = 'running' and locked_by = 'worker-a';
grant select on stale to public;
set local role service_role;
select is((select count(*)::int from public.claim_jobs('worker-e', 5, 60)), 0, 'claim reprend les baux expirés (remis en file avec backoff, pas encore dus)');
reset role;
select is((select status::text from public.jobs where id = (select id from stale limit 1)), 'queued', 'bail expiré, essais restants : remis en file');
select is((select last_error from public.jobs where id = (select id from stale limit 1)), 'lease_expired', 'cause : lease_expired');
update public.jobs set status = 'running', attempts = max_attempts, locked_by = 'worker-z', lease_until = now() - interval '1 minute'
 where id = (select id from stale limit 1);
set local role service_role;
select is((select count(*)::int from public.claim_jobs('worker-e', 5, 60)), 0, 'claim déclenche la reprise');
reset role;
select is((select status::text from public.jobs where id = (select id from stale limit 1)), 'dead_letter', 'bail expiré, essais épuisés : dead_letter');

-- 9. rejeu et annulation audités
set local role service_role;
select is(public.replay_dead_letter('77000000-0000-4000-8000-00000000000b', (select id from dead1)), false, 'rejeu avec une autre organisation : refusé');
select is(public.replay_dead_letter('77000000-0000-4000-8000-00000000000a', (select id from dead1)), true, 'rejeu du dead_letter');
select is(public.replay_dead_letter('77000000-0000-4000-8000-00000000000a', (select id from dead1)), false, 'rejeu d''un job déjà remis en file : refusé');
reset role;
select ok((select status = 'queued' and attempts = 0 and last_error is null from public.jobs where id = (select id from dead1)), 'rejeu : file, attempts = 0');
select is((select count(*)::int from public.audit_logs where action = 'job.replayed' and entity_id = (select id from dead1)), 1, 'audit job.replayed');
set local role service_role;
select is(public.cancel_job('77000000-0000-4000-8000-00000000000a', (select id from dead1)), true, 'annulation d''un job en attente');
select is(public.cancel_job('77000000-0000-4000-8000-00000000000a', (select id from my_job)), false, 'annulation d''un job terminé : refusée');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'job.cancelled' and entity_id = (select id from dead1)), 1, 'audit job.cancelled');

-- 10. RLS : lecture owner/admin de l'organisation seulement
select pg_temp.as_user('76000000-0000-4000-8000-000000000001');
select ok((select count(*) from public.jobs) > 0, 'owner A : voit les jobs de A');
select is((select count(*)::int from public.jobs where organization_id = '77000000-0000-4000-8000-00000000000b'), 0, 'owner A : ne voit pas ceux de B');
reset role;
select pg_temp.as_user('76000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.jobs), 0, 'sales A : ne voit aucun job');
reset role;
select pg_temp.as_user('76000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.jobs where organization_id = '77000000-0000-4000-8000-00000000000a'), 0, 'owner B : ne voit pas ceux de A');
select throws_ok($$update public.jobs set status = 'succeeded'$$, '42501', null, 'owner : UPDATE direct refusé');
select throws_ok($$delete from public.jobs$$, '42501', null, 'owner : DELETE direct refusé');
reset role;

select * from finish();
rollback;
