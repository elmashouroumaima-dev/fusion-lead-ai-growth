-- Retour arrière de 20261125100000_imports.sql
-- ATTENTION : supprime TOUS les lots d'import et leurs rapports, et les politiques du bucket `imports`. Les contacts et leads déjà créés
-- par les imports sont conservés. Les fichiers et le bucket `imports` se suppriment par l'API Storage (pas par SQL).

drop function if exists public.import_fail(uuid, uuid, text);
drop function if exists public.import_finish(uuid, uuid, integer);
drop function if exists public.import_record_error(uuid, uuid, integer, text);
drop function if exists public.import_row(uuid, uuid, integer, text, text, text, text, text, text);
drop function if exists public.import_start(uuid, uuid);
drop function if exists public.cancel_import(uuid, uuid);
drop function if exists public.confirm_import(uuid, uuid, jsonb, text, integer);
drop function if exists public.import_dedup_check(uuid, text[], text[]);
drop function if exists public.create_import_batch(uuid, uuid, text, integer);

drop function if exists private.import_fail(uuid, uuid, text);
drop function if exists private.import_finish(uuid, uuid, integer);
drop function if exists private.import_record_error(uuid, uuid, integer, text);
drop function if exists private.import_row(uuid, uuid, integer, text, text, text, text, text, text);
drop function if exists private.import_start(uuid, uuid);
drop function if exists private.cancel_import(uuid, uuid);
drop function if exists private.confirm_import(uuid, uuid, jsonb, text, integer);
drop function if exists private.import_dedup_check(uuid, text[], text[]);
drop function if exists private.create_import_batch(uuid, uuid, text, integer);

drop table if exists public.import_rows;
drop table if exists public.import_batches;

drop function if exists private.audit_import_batches();
drop function if exists private.import_batches_immutable();
drop function if exists private.is_valid_import_mapping(jsonb);

drop policy if exists imports_delete on storage.objects;
drop policy if exists imports_insert on storage.objects;
drop policy if exists imports_select on storage.objects;
drop function if exists private.can_manage_import_path(text);
drop function if exists private.import_path_ok(text);

-- Le bucket `imports` n'est PAS supprimé ici (Storage refuse la suppression SQL directe) : vider puis supprimer le bucket par l'API Storage.
