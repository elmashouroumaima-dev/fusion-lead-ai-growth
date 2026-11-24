-- Retour arrière de 20261224100000_s09_import_files_purge.sql : supprime les quatre fonctions de purge, l'index et la colonne `file_purged_at`.
-- Les lots annulés par `import_expire_stale` restent annulés (aucune donnée de contact n'est concernée).
drop function if exists public.import_orphan_files(interval, integer);
drop function if exists public.import_file_purged(uuid, uuid);
drop function if exists public.import_files_due(integer);
drop function if exists public.import_expire_stale(interval);
drop function if exists private.import_orphan_files(interval, integer);
drop function if exists private.import_file_purged(uuid, uuid);
drop function if exists private.import_files_due(integer);
drop function if exists private.import_expire_stale(interval);
drop index if exists public.import_batches_purge_idx;
alter table public.import_batches drop column if exists file_purged_at;
