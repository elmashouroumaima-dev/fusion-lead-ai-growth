-- Retour arrière de 20261116100000_plans_quotas.sql
-- ATTENTION : supprime la liste des administrateurs de la plateforme et les plans starter / growth (les
-- abonnements qui y pointent doivent d'abord être ramenés au plan trial). Les compteurs d'usage sont conservés.
-- create_invitation retrouve sa définition du J10 (relancer le corps de la migration 20261110100000 si nécessaire :
-- ci-dessous, seule la vérification de limite est retirée).

update public.subscriptions set plan_id = (select id from public.plans where code = 'trial')
 where plan_id in (select id from public.plans where code in ('starter', 'growth'));

drop trigger if exists enforce_member_quota on public.organization_members;
drop function if exists private.enforce_member_quota();
grant insert, update, delete on public.plans, public.subscriptions to service_role;

drop trigger if exists audit_subscriptions on public.subscriptions;
drop function if exists private.audit_subscriptions();

alter table public.subscriptions drop constraint if exists subscriptions_limits_override_valid;
alter table public.plans drop constraint if exists plans_limits_valid;
delete from public.plans where code in ('starter', 'growth');
update public.plans set limits = '{}'::jsonb where code = 'trial';

drop function if exists public.admin_set_subscription(uuid, text, public.subscription_status, jsonb, text, timestamptz);
drop function if exists public.admin_list_organizations(integer, integer);
drop function if exists public.consume_quota(uuid, text, integer);
drop function if exists public.get_org_usage(uuid);
drop function if exists public.is_platform_admin();
drop function if exists private.admin_set_subscription(uuid, text, public.subscription_status, jsonb, text, timestamptz);
drop function if exists private.admin_list_organizations(integer, integer);
drop function if exists private.consume_quota(uuid, text, integer);
drop function if exists private.get_org_usage(uuid);
drop function if exists private.usage_rows(uuid);
drop function if exists private.assert_within_limit(uuid, text, integer);
drop function if exists private.quota_period_start();
drop function if exists private.effective_limit(uuid, text);
drop function if exists private.current_stock_usage(uuid, text);
drop function if exists private.is_valid_plan_limits(jsonb);
drop function if exists private.is_platform_admin();
drop table if exists private.platform_admins;
