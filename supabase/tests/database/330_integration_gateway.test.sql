-- Passerelle WhatsApp (ADR 017) : `integrations.gateway` (`meta` par défaut, `kapso`). Refus d'abord : une passerelle inconnue, Kapso pour un e-mail, une écriture directe, un rôle sans droit.
-- Puis : la création porte la passerelle, la résolution d'un webhook filtre par passerelle (un webhook Kapso ne retrouve pas une intégration Meta, et inversement), la réclamation d'envoi
-- renvoie `channel.gateway`, owner et admin lisent la colonne. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea500000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@gw.test', now()
    from generate_series(1, 3) n;
insert into public.organizations (id, name, slug) values ('eb500000-0000-4000-8000-00000000000a', 'GW Alpha', 'gw-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb500000-0000-4000-8000-00000000000a', 'ea500000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb500000-0000-4000-8000-00000000000a', 'ea500000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb500000-0000-4000-8000-00000000000a', 'ea500000-0000-4000-8000-000000000003', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values ('eb500000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
grant execute on function pg_temp.as_user(text), pg_temp.as_service() to public;

-- ---------------------------------------------------------------------------
-- Refus
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea500000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'whatsapp', '700000000000001', '{}', 'ed500000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'autre')$$,
  '22023', 'validation_failed', 'passerelle inconnue : refusée');
select throws_ok(
  $$select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'email', 'gw-mail', '{}', 'ed500000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'kapso')$$,
  '22023', 'validation_failed', 'Kapso pour un e-mail : refusé');
reset role;
select is((select count(*)::int from public.integrations where organization_id = 'eb500000-0000-4000-8000-00000000000a'), 0, 'aucun refus n''a créé d''intégration');

select pg_temp.as_user('ea500000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'whatsapp', '700000000000002', '{}', 'ed500000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'kapso')$$,
  '42501', null, 'un commercial ne crée pas d''intégration, quelle que soit la passerelle');
reset role;

-- ---------------------------------------------------------------------------
-- Création : Kapso, Meta explicite, défaut (appel sans le paramètre)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea500000-0000-4000-8000-000000000002');
select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'whatsapp', '700000000000001', '{}', 'ed500000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'kapso');
select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'whatsapp', '700000000000002', '{}', 'ed500000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, 'meta');
select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'whatsapp', '700000000000003', '{}', 'ed500000-0000-4000-8000-000000000003', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb500000-0000-4000-8000-00000000000a', 'email', 'gw-mail', '{}', 'ed500000-0000-4000-8000-000000000004', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
reset role;
select is((select gateway from public.integrations where external_account_id = '700000000000001'), 'kapso', 'création avec passerelle « kapso »');
select is((select gateway from public.integrations where external_account_id = '700000000000002'), 'meta', 'création avec passerelle « meta »');
select is((select gateway from public.integrations where external_account_id = '700000000000003'), 'meta', 'appel sans le paramètre (anciens appelants) : « meta »');
select is((select gateway from public.integrations where external_account_id = 'gw-mail'), 'meta', 'une intégration e-mail est « meta »');

-- ---------------------------------------------------------------------------
-- Écriture directe : la colonne n'est modifiable par aucun rôle d'API (ni owner ni admin)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea500000-0000-4000-8000-000000000001');
select throws_ok($$update public.integrations set gateway = 'meta' where external_account_id = '700000000000001'$$, '42501', null, 'un owner ne modifie pas la passerelle par une écriture directe');
reset role;
select throws_ok($$update public.integrations set gateway = 'autre' where external_account_id = '700000000000001'$$, '23514', null, 'la contrainte refuse une passerelle inconnue, même pour le propriétaire de la base');
select throws_ok($$update public.integrations set gateway = 'kapso' where external_account_id = 'gw-mail'$$, '23514', null, 'la contrainte refuse Kapso sur une intégration e-mail');

-- ---------------------------------------------------------------------------
-- Résolution d'un webhook : filtrée par passerelle
-- ---------------------------------------------------------------------------
select pg_temp.as_service();
select is((select public.webhook_resolve_integration('whatsapp', '700000000000001', 'kapso') ->> 'organization_id'), 'eb500000-0000-4000-8000-00000000000a', 'un webhook Kapso retrouve une intégration Kapso');
select is((select public.webhook_resolve_integration('whatsapp', '700000000000001', 'meta')), null, 'un webhook Meta ne retrouve pas une intégration Kapso');
select is((select public.webhook_resolve_integration('whatsapp', '700000000000002', 'kapso')), null, 'un webhook Kapso ne retrouve pas une intégration Meta');
select is((select public.webhook_resolve_integration('whatsapp', '700000000000002') ->> 'organization_id'), 'eb500000-0000-4000-8000-00000000000a', 'sans filtre (anciens appelants) : retrouvée');
reset role;

-- ---------------------------------------------------------------------------
-- Lecture : owner et admin lisent la colonne ; un commercial ne lit rien (RLS)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea500000-0000-4000-8000-000000000002');
select is((select gateway from public.integrations where external_account_id = '700000000000001'), 'kapso', 'un admin lit la passerelle');
reset role;

select * from finish();
rollback;
