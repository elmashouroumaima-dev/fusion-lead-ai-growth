-- Retour arrière de 20261115100000_jobs.sql
-- ATTENTION : supprime tous les jobs (en attente, en cours, dead_letter) ; exporter avant si besoin
-- (\copy public.jobs to ...). Les lignes d'audit job.* restent (journal append-only).

drop function if exists public.replay_dead_letter(uuid, uuid);
drop function if exists public.cancel_job(uuid, uuid);
drop function if exists public.fail_job(uuid, text, text, boolean);
drop function if exists public.complete_job(uuid, text);
drop function if exists public.heartbeat_job(uuid, text, integer);
drop function if exists public.claim_jobs(text, integer, integer);
drop function if exists public.enqueue_job(uuid, text, jsonb, text, timestamptz, integer);

drop function if exists private.replay_dead_letter(uuid, uuid);
drop function if exists private.cancel_job(uuid, uuid);
drop function if exists private.fail_job(uuid, text, text, boolean);
drop function if exists private.complete_job(uuid, text);
drop function if exists private.heartbeat_job(uuid, text, integer);
drop function if exists private.claim_jobs(text, integer, integer);
drop function if exists private.requeue_expired_leases();
drop function if exists private.enqueue_job(uuid, text, jsonb, text, timestamptz, integer);
drop function if exists private.job_clean_error(text);

drop table if exists public.jobs;
drop type if exists public.job_status;
