-- J14 — Plans, quotas, administrateurs de la plateforme : limites, contrôle atomique, usage, invitations,
-- administration des abonnements, audit, droits. Les contrôles internes sont appelés sous le propriétaire ;
-- les appels d'API sous les rôles concernés. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(75);

-- U1 owner A · U2 admin A · U3 sales A · U4 owner B · U5 administrateur de la plateforme · U6 sans adhésion
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('78000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@pq.test', now()),
  ('78000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@pq.test', now()),
  ('78000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u3@pq.test', now()),
  ('78000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u4@pq.test', now()),
  ('78000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u5@pq.test', now()),
  ('78000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u6@pq.test', now());
insert into public.organizations (id, name, slug) values
  ('79000000-0000-4000-8000-00000000000a', 'PQ Alpha', 'pq-alpha-test'),
  ('79000000-0000-4000-8000-00000000000b', 'PQ Beta', 'pq-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('79000000-0000-4000-8000-00000000000a', '78000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('79000000-0000-4000-8000-00000000000a', '78000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('79000000-0000-4000-8000-00000000000a', '78000000-0000-4000-8000-000000000003', 'sales_agent', 'active'),
  ('79000000-0000-4000-8000-00000000000b', '78000000-0000-4000-8000-000000000004', 'company_owner', 'active');
insert into public.subscriptions (organization_id, plan_id, status)
  select o, (select id from public.plans where code = 'trial'), 'trial'
    from (values ('79000000-0000-4000-8000-00000000000a'::uuid), ('79000000-0000-4000-8000-00000000000b'::uuid)) v (o);
insert into private.platform_admins (user_id) values ('78000000-0000-4000-8000-000000000005');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Structure, droits, valeurs des plans
select has_table('private', 'platform_admins', 'private.platform_admins existe');
select ok(not has_table_privilege('authenticated', 'private.platform_admins', 'select,insert,update,delete'), 'authenticated : aucun droit sur platform_admins');
select ok(not has_table_privilege('service_role', 'private.platform_admins', 'select,insert,update,delete'), 'service_role : aucun droit sur platform_admins');
select is((select limits from public.plans where code = 'trial'), '{"users": 3, "projects": 1, "contacts": 500, "messages_per_month": 200, "ai_runs": 50, "integrations": 2}'::jsonb, 'plan trial : limites provisoires');
select is((select limits from public.plans where code = 'starter'), '{"users": 5, "projects": 3, "contacts": 5000, "messages_per_month": 2000, "ai_runs": 200, "integrations": 3}'::jsonb, 'plan starter : limites provisoires');
select is((select limits from public.plans where code = 'growth'), '{"users": 15, "projects": 10, "contacts": 50000, "messages_per_month": 20000, "ai_runs": 2000, "integrations": 6}'::jsonb, 'plan growth : limites provisoires');
select throws_ok($$update public.plans set limits = '{"inconnue": 1}' where code = 'trial'$$, '23514', null, 'clé de limite inconnue refusée');
select throws_ok($$update public.plans set limits = '{"users": -1}' where code = 'trial'$$, '23514', null, 'limite négative refusée');
select throws_ok($$update public.plans set limits = '{"users": 1.5}' where code = 'trial'$$, '23514', null, 'limite décimale refusée');
select throws_ok($$update public.plans set limits = '{"users": "5"}' where code = 'trial'$$, '23514', null, 'limite textuelle refusée');
select throws_ok($$update public.subscriptions set limits_override = '{"users": -3}'$$, '23514', null, 'surcharge invalide refusée');

-- 2. is_platform_admin
select pg_temp.as_user('78000000-0000-4000-8000-000000000005');
select is(public.is_platform_admin(), true, 'administrateur de la plateforme : true');
reset role;
select pg_temp.as_user('78000000-0000-4000-8000-000000000001');
select is(public.is_platform_admin(), false, 'owner d''organisation : false');
select throws_ok($$insert into private.platform_admins (user_id) values ('78000000-0000-4000-8000-000000000001')$$, '42501', null, 'aucune auto-promotion par l''API');
reset role;
set local role anon;
select throws_ok($$select public.is_platform_admin()$$, '42501', null, 'anon : refusé');
reset role;

-- 3. Quota de flux : atomique, plafonné, par organisation
select is((private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'messages_per_month', 150)) ->> 'used', '150', 'flux : 150 consommés');
select is((private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'messages_per_month', 40)) ->> 'near_limit', 'true', 'flux : alerte à 95 % (>= 80 %)');
select is((private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'messages_per_month', 10)) ->> 'remaining', '0', 'flux : exactement la limite (200), reste 0');
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'messages_per_month', 1)$$, 'P0001', 'quota_exceeded', 'flux : dépassement refusé');
select is((select value::int from public.usage_counters where organization_id = '79000000-0000-4000-8000-00000000000a' and metric = 'messages_per_month'), 200, 'compteur inchangé après le refus');
select is((select count(*)::int from public.usage_counters where organization_id = '79000000-0000-4000-8000-00000000000b'), 0, 'compteurs de l''autre organisation : intacts');
select is((private.assert_within_limit('79000000-0000-4000-8000-00000000000b', 'messages_per_month', 5)) ->> 'used', '5', 'organisation B : son propre compteur');
update public.subscriptions set limits_override = '{"messages_per_month": 10}' where organization_id = '79000000-0000-4000-8000-00000000000b';
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000b', 'messages_per_month', 6)$$, 'P0001', 'quota_exceeded', 'la surcharge l''emporte sur le plan');
select is((private.assert_within_limit('79000000-0000-4000-8000-00000000000b', 'messages_per_month', 5)) ->> 'used', '10', 'surcharge : 10 atteints');
update public.subscriptions set limits_override = '{"ai_runs": 0}' where organization_id = '79000000-0000-4000-8000-00000000000b';
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000b', 'ai_runs', 1)$$, 'P0001', 'quota_exceeded', 'limite 0 : tout est refusé');
update public.subscriptions set limits_override = '{}' where organization_id = '79000000-0000-4000-8000-00000000000b';

-- 4. Validation et abonnement inactif
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'inconnue', 1)$$, '22023', 'validation_failed', 'métrique inconnue refusée');
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'ai_runs', 0)$$, '22023', 'validation_failed', 'quantité 0 refusée');
update public.subscriptions set status = 'suspended' where organization_id = '79000000-0000-4000-8000-00000000000b';
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000b', 'ai_runs', 1)$$, 'P0001', 'subscription_inactive', 'abonnement suspendu : bloqué');
update public.subscriptions set status = 'trial' where organization_id = '79000000-0000-4000-8000-00000000000b';
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-0000000000ff', 'ai_runs', 1)$$, 'P0001', 'subscription_inactive', 'organisation sans abonnement : bloquée');

-- 5. Quota de stock : membres actifs + invitations en attente
select is((private.assert_within_limit('79000000-0000-4000-8000-00000000000b', 'users', 1)) ->> 'used', '1', 'stock users : 1 membre actif');
select throws_ok($$select private.assert_within_limit('79000000-0000-4000-8000-00000000000a', 'users', 1)$$, 'P0001', 'quota_exceeded', 'organisation A : 3 membres = limite trial (3) : refusé');
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by) values
  ('79000000-0000-4000-8000-00000000000b', 'p1@pq.test', 'sales_agent', repeat('a', 64), now() + interval '7 days', '78000000-0000-4000-8000-000000000004'),
  ('79000000-0000-4000-8000-00000000000b', 'p2@pq.test', 'sales_agent', repeat('b', 64), now() + interval '7 days', '78000000-0000-4000-8000-000000000004'),
  ('79000000-0000-4000-8000-00000000000b', 'old@pq.test', 'sales_agent', repeat('c', 64), now() - interval '1 day', '78000000-0000-4000-8000-000000000004');
select is((private.current_stock_usage('79000000-0000-4000-8000-00000000000b', 'users'))::int, 3, 'invitations en attente comptées, expirée ignorée');
select is((private.current_stock_usage('79000000-0000-4000-8000-00000000000b', 'projects'))::int, 0, 'projects : 0 tant que le module n''existe pas');

-- 6. create_invitation : la limite s'applique
select pg_temp.as_user('78000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_invitation('79000000-0000-4000-8000-00000000000b', 'p3@pq.test', 'sales_agent', repeat('d', 64))$$, 'P0001', 'quota_exceeded', 'limite atteinte : nouvelle invitation refusée');
select lives_ok($$select public.create_invitation('79000000-0000-4000-8000-00000000000b', 'p1@pq.test', 'sales_agent', repeat('e', 64))$$, 'ré-inviter la même adresse à la limite : autorisé (l''ancienne est révoquée avant le contrôle)');
reset role;
select is((select count(*)::int from public.invitations where organization_id = '79000000-0000-4000-8000-00000000000b' and email_normalized = 'p3@pq.test'), 0, 'invitation refusée : aucune ligne créée');
update public.subscriptions set limits_override = '{"users": 10}' where organization_id = '79000000-0000-4000-8000-00000000000b';
select pg_temp.as_user('78000000-0000-4000-8000-000000000004');
select lives_ok($$select public.create_invitation('79000000-0000-4000-8000-00000000000b', 'p3@pq.test', 'sales_agent', repeat('f', 64))$$, 'limite relevée par surcharge : invitation créée');
reset role;
update public.subscriptions set limits_override = '{}' where organization_id = '79000000-0000-4000-8000-00000000000b';

-- 7. consume_quota (serveur) et get_org_usage (owner/admin)
set local role service_role;
select is((public.consume_quota('79000000-0000-4000-8000-00000000000b', 'ai_runs', 3)) ->> 'used', '3', 'service_role : consume_quota');
reset role;
select pg_temp.as_user('78000000-0000-4000-8000-000000000001');
select throws_ok($$select public.consume_quota('79000000-0000-4000-8000-00000000000a', 'ai_runs', 1)$$, '42501', null, 'authenticated : consume_quota refusé');
select is((select count(*)::int from public.get_org_usage('79000000-0000-4000-8000-00000000000a')), 6, 'owner : usage de ses 6 métriques');
select is((select near_limit from public.get_org_usage('79000000-0000-4000-8000-00000000000a') where metric = 'users'), true, 'owner : users à 100 % => near_limit');
select throws_ok($$select * from public.get_org_usage('79000000-0000-4000-8000-00000000000b')$$, '42501', 'forbidden', 'owner A : usage de B refusé');
reset role;
select pg_temp.as_user('78000000-0000-4000-8000-000000000003');
select throws_ok($$select * from public.get_org_usage('79000000-0000-4000-8000-00000000000a')$$, '42501', 'forbidden', 'sales_agent : usage refusé');
reset role;
set local role anon;
select throws_ok($$select public.consume_quota('79000000-0000-4000-8000-00000000000a', 'ai_runs', 1)$$, '42501', null, 'anon : consume_quota refusé');
reset role;

-- 8. Administration de la plateforme
select pg_temp.as_user('78000000-0000-4000-8000-000000000005');
select ok((select count(*) from public.admin_list_organizations(200, 0) where organization_id in ('79000000-0000-4000-8000-00000000000a', '79000000-0000-4000-8000-00000000000b')) = 2, 'admin : liste les organisations');
select is((select plan_code from public.admin_list_organizations(200, 0) where organization_id = '79000000-0000-4000-8000-00000000000a'), 'trial', 'admin : plan visible');
select throws_ok($$select * from public.admin_list_organizations(0, 0)$$, '22023', 'validation_failed', 'limite 0 refusée');
select throws_ok($$select * from public.admin_list_organizations(201, 0)$$, '22023', 'validation_failed', 'limite 201 refusée');
select lives_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{"users": 8}', 'Passage en Starter après paiement', null)$$, 'admin : active un abonnement Starter');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'inexistant', 'active', '{}', 'raison valable', null)$$, '22023', 'validation_failed', 'plan inconnu refusé');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{"clef": 1}', 'raison valable', null)$$, '22023', 'validation_failed', 'surcharge invalide refusée');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{}', 'ok', null)$$, '22023', 'validation_failed', 'raison trop courte refusée');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-0000000000ff', 'starter', 'active', '{}', 'raison valable', null)$$, '22023', 'validation_failed', 'organisation sans abonnement refusée');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{}', 'raison valable', now() - interval '1 day')$$, '22023', 'validation_failed', 'fin de période dans le passé refusée');
reset role;
select is((select p.code || ':' || s.status::text || ':' || (s.limits_override ->> 'users') from public.subscriptions s join public.plans p on p.id = s.plan_id where s.organization_id = '79000000-0000-4000-8000-00000000000a'), 'starter:active:8', 'abonnement mis à jour, les refus n''ont rien changé');
select ok((select s.decided_by = '78000000-0000-4000-8000-000000000005' and s.period_start is not null and s.decision_reason = 'Passage en Starter après paiement' from public.subscriptions s where s.organization_id = '79000000-0000-4000-8000-00000000000a'), 'decided_by = auth.uid(), période ouverte, raison enregistrée');
select is((select count(*)::int from public.audit_logs where action = 'subscription.changed' and organization_id = '79000000-0000-4000-8000-00000000000a'), 1, 'audit subscription.changed (un seul : les refus n''en écrivent pas)');
select ok((select (before ->> 'plan') = 'trial' and (after ->> 'plan') = 'starter' and actor_id = '78000000-0000-4000-8000-000000000005' from public.audit_logs where action = 'subscription.changed' and organization_id = '79000000-0000-4000-8000-00000000000a'), 'audit : avant/après et acteur');

-- 9. Refus : owner, anon, écriture directe
select pg_temp.as_user('78000000-0000-4000-8000-000000000001');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'growth', 'active', '{}', 'raison valable', null)$$, '42501', 'forbidden', 'owner d''organisation : admin_set_subscription refusé');
select throws_ok($$select * from public.admin_list_organizations(10, 0)$$, '42501', 'forbidden', 'owner d''organisation : admin_list_organizations refusé');
select throws_ok($$update public.subscriptions set status = 'active'$$, '42501', null, 'owner : UPDATE direct de subscriptions refusé');
reset role;
select pg_temp.as_user('78000000-0000-4000-8000-000000000006');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'growth', 'active', '{}', 'raison valable', null)$$, '42501', 'forbidden', 'compte sans adhésion : refusé');
reset role;
set local role anon;
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'growth', 'active', '{}', 'raison valable', null)$$, '42501', null, 'anon : refusé');
reset role;

-- 10. Revue sécurité J14 : réactivation de membre, motif, audit sans changement de plan, droits de service_role
select ok(not has_table_privilege('service_role', 'public.subscriptions', 'insert,update,delete'), 'service_role : aucune écriture directe sur subscriptions');
select ok(not has_table_privilege('service_role', 'public.plans', 'insert,update,delete'), 'service_role : aucune écriture directe sur plans');

insert into public.organizations (id, name, slug) values ('79000000-0000-4000-8000-00000000000c', 'PQ Gamma', 'pq-gamma-test');
insert into public.subscriptions (organization_id, plan_id) values ('79000000-0000-4000-8000-00000000000c', (select id from public.plans where code = 'trial'));
insert into public.organization_members (organization_id, user_id, role, status) values
  ('79000000-0000-4000-8000-00000000000c', '78000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('79000000-0000-4000-8000-00000000000c', '78000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('79000000-0000-4000-8000-00000000000c', '78000000-0000-4000-8000-000000000003', 'sales_agent', 'removed'),
  ('79000000-0000-4000-8000-00000000000c', '78000000-0000-4000-8000-000000000006', 'sales_agent', 'removed');
select pg_temp.as_user('78000000-0000-4000-8000-000000000001');
select lives_ok($$update public.organization_members set status = 'active' where organization_id = '79000000-0000-4000-8000-00000000000c' and user_id = '78000000-0000-4000-8000-000000000003'$$, 'réactivation dans la limite (2 + 1 = 3) : autorisée');
select throws_ok($$update public.organization_members set status = 'active' where organization_id = '79000000-0000-4000-8000-00000000000c' and user_id = '78000000-0000-4000-8000-000000000006'$$, 'P0001', 'quota_exceeded', 'réactivation au-delà de la limite : refusée (plus de contournement par UPDATE direct)');
reset role;
select is((select status::text from public.organization_members where organization_id = '79000000-0000-4000-8000-00000000000c' and user_id = '78000000-0000-4000-8000-000000000006'), 'removed', 'le membre reste retiré après le refus');
insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
  values ('79000000-0000-4000-8000-00000000000c', 'u6@pq.test', 'sales_agent', repeat('9', 64), now() + interval '7 days', '78000000-0000-4000-8000-000000000001');
select pg_temp.as_user('78000000-0000-4000-8000-000000000001');
select lives_ok($$update public.organization_members set status = 'active' where organization_id = '79000000-0000-4000-8000-00000000000c' and user_id = '78000000-0000-4000-8000-000000000006'$$, 'avec invitation en attente pour la même adresse : la place est déjà réservée (chemin accept_invitation)');
reset role;

select pg_temp.as_user('78000000-0000-4000-8000-000000000005');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{}', 'texte ' || chr(8238) || ' inversé', null)$$, '22023', 'validation_failed', 'motif avec caractère bidi refusé');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{}', E'ligne1\nligne2', null)$$, '22023', 'validation_failed', 'motif avec saut de ligne / contrôle refusé');
select throws_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{}', repeat('a', 201), null)$$, '22023', 'validation_failed', 'motif de plus de 200 caractères refusé');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'subscription.changed' and organization_id = '79000000-0000-4000-8000-00000000000a'), 1, 'avant : une ligne d''audit pour l''organisation A');
select pg_temp.as_user('78000000-0000-4000-8000-000000000005');
select lives_ok($$select public.admin_set_subscription('79000000-0000-4000-8000-00000000000a', 'starter', 'active', '{"users": 8}', 'Même plan, nouveau motif', null)$$, 'mêmes valeurs, autre motif');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'subscription.changed' and organization_id = '79000000-0000-4000-8000-00000000000a'), 2, 'le changement de motif seul est audité');

select * from finish();
rollback;
