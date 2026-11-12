-- Retour arrière de 20261121100000_leads_pipelines_deals.sql
-- ATTENTION : supprime TOUS les pipelines, leads et deals. Exporter avant si nécessaire.

drop function if exists public.move_deal_stage(uuid, uuid, uuid);
drop function if exists public.update_deal(uuid, uuid, numeric, text, timestamptz);
drop function if exists public.create_deal(uuid, uuid, uuid, numeric, text, timestamptz);
drop function if exists public.move_lead_stage(uuid, uuid, uuid);
drop function if exists public.assign_lead(uuid, uuid, uuid);
drop function if exists public.update_lead(uuid, uuid, text, integer, jsonb, jsonb);
drop function if exists public.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text);
drop function if exists public.delete_stage(uuid, uuid);
drop function if exists public.update_stage(uuid, uuid, text, integer);
drop function if exists public.create_stage(uuid, uuid, text, public.stage_kind, integer);
drop function if exists public.set_default_pipeline(uuid, uuid);
drop function if exists public.rename_pipeline(uuid, uuid, text);
drop function if exists public.create_pipeline(uuid, text);

-- Contacts : retour à la lecture owner / admin / marketing (J18).
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]));
drop policy if exists consent_events_select on public.consent_events;
create policy consent_events_select on public.consent_events
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin', 'marketing_manager']::public.app_role[]));
-- private.revoke_consent et private.set_do_not_contact retrouvent leur définition du J18 en relançant leur corps dans
-- 20261120100000_contacts_consent.sql (create or replace), avec private.assert_contact_manager(p_org) à la place de
-- private.assert_contact_revoker.

drop trigger if exists release_lead_assignments_delete on public.organization_members;
drop trigger if exists release_lead_assignments_role on public.organization_members;
drop trigger if exists release_lead_assignments on public.organization_members;
drop trigger if exists organizations_seed_pipeline on public.organizations;

drop function if exists private.lock_deal_for_write(uuid, uuid);
drop function if exists private.lock_lead_for_write(uuid, uuid);

drop table if exists public.deals;
drop table if exists public.leads;
drop table if exists public.pipeline_stages;
drop table if exists public.pipelines;

drop function if exists private.move_deal_stage(uuid, uuid, uuid);
drop function if exists private.update_deal(uuid, uuid, numeric, text, timestamptz);
drop function if exists private.create_deal(uuid, uuid, uuid, numeric, text, timestamptz);
drop function if exists private.move_lead_stage(uuid, uuid, uuid);
drop function if exists private.assign_lead(uuid, uuid, uuid);
drop function if exists private.update_lead(uuid, uuid, text, integer, jsonb, jsonb);
drop function if exists private.create_lead(uuid, uuid, uuid, text, uuid, integer, jsonb, jsonb, text, text);
drop function if exists private.delete_stage(uuid, uuid);
drop function if exists private.update_stage(uuid, uuid, text, integer);
drop function if exists private.create_stage(uuid, uuid, text, public.stage_kind, integer);
drop function if exists private.set_default_pipeline(uuid, uuid);
drop function if exists private.rename_pipeline(uuid, uuid, text);
drop function if exists private.create_pipeline(uuid, text);
drop function if exists private.assert_contact_revoker(uuid, uuid);
drop function if exists private.first_stage_of_kind(uuid, uuid, public.stage_kind);
drop function if exists private.assert_assignable(uuid, uuid);
drop function if exists private.audit_deals();
drop function if exists private.audit_leads();
drop function if exists private.audit_pipeline_stages();
drop function if exists private.audit_pipelines();
drop function if exists private.release_lead_assignments();
drop function if exists private.release_leads_of(uuid, uuid);
drop function if exists private.assert_subscription_active(uuid);
drop function if exists private.organizations_seed_pipeline();
drop function if exists private.seed_default_pipeline(uuid, text);
drop function if exists private.seed_pipeline_stages(uuid, uuid, text);
drop function if exists private.deals_guard();
drop function if exists private.leads_guard();
drop function if exists private.pipeline_stages_guard();
drop function if exists private.is_valid_score_reason(jsonb);
drop function if exists private.is_valid_lead_utm(jsonb);

drop type if exists public.stage_kind;
