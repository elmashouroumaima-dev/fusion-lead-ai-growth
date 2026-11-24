-- S-09 (revue de sécurité de la Phase 3, 2026-11-24) : les fichiers CSV importés (données personnelles de contacts) restaient dans le Storage après la fin de l'import, et les lots
-- « uploaded » abandonnés occupaient les 10 places d'import en cours de l'entreprise. La purge planifiée du Storage était déjà décidée (ADR 007, J23) ; elle n'existait pas.
--  * `import_batches.file_purged_at` : le fichier du lot a été retiré du Storage (ou n'existait plus).
--  * `private.import_expire_stale(intervalle)` : annule les lots restés `uploaded` plus longtemps que l'intervalle (24 h par défaut) : leur place est libérée et leur fichier devient
--    candidat à la purge. Les lots `queued` et `running` ne sont pas touchés (le worker et l'annulation existante s'en occupent).
--  * `private.import_files_due(limite)` : lots terminés (`done`, `failed`, `cancelled`) dont le fichier n'est pas encore purgé, depuis plus de 10 minutes (le temps de finir un rapport).
--  * `private.import_file_purged(entreprise, lot)` : marque le fichier du lot comme purgé (lot terminé seulement).
--  * `private.import_orphan_files(intervalle, limite)` : objets du bucket `imports` sans lot correspondant depuis plus de 24 h (échec de la création du lot après l'envoi).
-- Quatre fonctions réservées à `service_role` (le worker les appelle toutes les 15 minutes) ; la suppression du fichier se fait par l'API du Storage, jamais en SQL.
-- Retour arrière : supabase/rollbacks/20261224100000_s09_import_files_purge.sql

alter table public.import_batches add column file_purged_at timestamptz;
create index import_batches_purge_idx on public.import_batches (finished_at) where file_purged_at is null and status in ('done', 'failed', 'cancelled');

create function private.import_expire_stale(p_uploaded_after interval default interval '24 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_uploaded_after is null or p_uploaded_after < interval '1 hour' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.import_batches b set status = 'cancelled', finished_at = pg_catalog.now()
   where b.status = 'uploaded' and b.created_at < pg_catalog.now() - p_uploaded_after;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function private.import_files_due(p_limit integer default 200)
returns table (organization_id uuid, batch_id uuid, file_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.organization_id, b.id, b.file_path
    from public.import_batches b
   where b.status in ('done', 'failed', 'cancelled') and b.file_purged_at is null
     and coalesce(b.finished_at, b.updated_at) < pg_catalog.now() - interval '10 minutes'
   order by coalesce(b.finished_at, b.updated_at)
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

create function private.import_file_purged(p_org uuid, p_batch uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org is null or p_batch is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.import_batches b set file_purged_at = pg_catalog.now()
   where b.organization_id = p_org and b.id = p_batch and b.status in ('done', 'failed', 'cancelled') and b.file_purged_at is null;
end;
$$;

create function private.import_orphan_files(p_older interval default interval '24 hours', p_limit integer default 200)
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'imports' and o.created_at < pg_catalog.now() - greatest(coalesce(p_older, interval '24 hours'), interval '1 hour')
     and not exists (select 1 from public.import_batches b where b.file_path = o.name)
   order by o.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- droits : service_role seulement (private) ; enveloppes publiques SECURITY INVOKER pour l'API
revoke all on function private.import_expire_stale(interval) from public, anon, authenticated, service_role;
revoke all on function private.import_files_due(integer) from public, anon, authenticated, service_role;
revoke all on function private.import_file_purged(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.import_orphan_files(interval, integer) from public, anon, authenticated, service_role;
grant execute on function private.import_expire_stale(interval) to service_role;
grant execute on function private.import_files_due(integer) to service_role;
grant execute on function private.import_file_purged(uuid, uuid) to service_role;
grant execute on function private.import_orphan_files(interval, integer) to service_role;

create function public.import_expire_stale(p_uploaded_after interval default interval '24 hours')
returns integer language sql security invoker set search_path = ''
as $$ select private.import_expire_stale(p_uploaded_after); $$;
create function public.import_files_due(p_limit integer default 200)
returns table (organization_id uuid, batch_id uuid, file_path text) language sql stable security invoker set search_path = ''
as $$ select * from private.import_files_due(p_limit); $$;
create function public.import_file_purged(p_org uuid, p_batch uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.import_file_purged(p_org, p_batch); $$;
create function public.import_orphan_files(p_older interval default interval '24 hours', p_limit integer default 200)
returns table (name text) language sql stable security invoker set search_path = ''
as $$ select * from private.import_orphan_files(p_older, p_limit); $$;
revoke all on function public.import_expire_stale(interval) from public, anon, authenticated, service_role;
revoke all on function public.import_files_due(integer) from public, anon, authenticated, service_role;
revoke all on function public.import_file_purged(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.import_orphan_files(interval, integer) from public, anon, authenticated, service_role;
grant execute on function public.import_expire_stale(interval) to service_role;
grant execute on function public.import_files_due(integer) to service_role;
grant execute on function public.import_file_purged(uuid, uuid) to service_role;
grant execute on function public.import_orphan_files(interval, integer) to service_role;
