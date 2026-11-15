-- Jeu de données du guide « Exploitation et configuration » (J39, J39b) : à charger APRÈS `pnpm db:reset` et phase2-demo-data.sql.
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 < docs/testing/fixtures/phase3b-ops-demo.sql
-- Crée pour l'entreprise Alpha : deux jobs en échec (dead letters) dont un job d'envoi (alerte « envoi en échec » pour owner et admin), et une alerte
-- « lead non assigné » pointant vers un lead de démonstration. Données de test uniquement. Refuse un second chargement.
begin;

do $$
declare
  v_org constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  v_lead uuid;
  v_job uuid;
  v_member record;
begin
  if exists (select 1 from public.jobs where organization_id = v_org and idempotency_key like 'demo-p3b-%') then
    raise exception 'jeu de données déjà chargé : faire pnpm db:reset puis recharger phase2-demo-data.sql';
  end if;
  select id into v_lead from public.leads where organization_id = v_org order by created_at limit 1;
  if v_lead is null then
    raise exception 'aucun lead Alpha : charger d''abord docs/testing/fixtures/phase2-demo-data.sql';
  end if;

  -- 1) dead letter « noop » (sans alerte) et 2) dead letter d'envoi (alerte send.failed par le déclencheur)
  insert into public.jobs (organization_id, kind, payload, idempotency_key, status) values (v_org, 'noop', '{}', 'demo-p3b-noop-0001', 'queued');
  insert into public.jobs (organization_id, kind, payload, idempotency_key, status)
    values (v_org, 'send_message', jsonb_build_object('message_id', gen_random_uuid()), 'demo-p3b-send-0001', 'queued') returning id into v_job;
  update public.jobs set status = 'dead_letter', attempts = 5, finished_at = now() - interval '10 minutes', last_error = 'provider_unavailable'
    where organization_id = v_org and idempotency_key = 'demo-p3b-noop-0001';
  update public.jobs set status = 'dead_letter', attempts = 5, finished_at = now() - interval '5 minutes', last_error = 'provider_unavailable' where id = v_job;

  -- 3) alerte « lead non assigné » pour chaque owner / admin actif d'Alpha
  for v_member in select user_id from public.organization_members where organization_id = v_org and status = 'active' and role in ('company_owner', 'company_admin') loop
    insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key)
      values (v_org, v_member.user_id, 'lead.unassigned', jsonb_build_object('lead_id', v_lead, 'reason', 'no_rule'), 'demo-p3b-unassigned-' || v_member.user_id::text);
  end loop;
end
$$;

commit;
