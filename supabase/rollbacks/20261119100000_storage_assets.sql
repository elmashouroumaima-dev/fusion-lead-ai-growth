-- Retour arrière de 20261119100000_storage_assets.sql
-- ATTENTION : supprime les politiques et le bucket `assets`. Storage interdit la suppression directe de lignes tant que
-- `storage.allow_delete_query` n'est pas activé ; les FICHIERS PHYSIQUES d'un bucket supprimé de cette façon restent orphelins :
-- vider d'abord le bucket par l'API Storage (ou la console) si des fichiers existent.

drop function if exists public.remove_product_asset(uuid, uuid, text);
drop function if exists public.append_product_asset(uuid, uuid, text);
drop function if exists private.remove_product_asset(uuid, uuid, text);
drop function if exists private.append_product_asset(uuid, uuid, text);
-- private.update_product retrouve sa définition du J16 en relançant le corps de la fonction dans 20261118100000_projects_products.sql
-- (create or replace) si les fichiers doivent de nouveau se modifier par cette fonction.

drop policy if exists assets_delete on storage.objects;
drop policy if exists assets_insert on storage.objects;
drop policy if exists assets_select on storage.objects;

drop function if exists private.can_write_asset(text);
drop function if exists private.can_read_asset(text);
drop function if exists private.asset_path_ok(text);

set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'assets';
delete from storage.buckets where id = 'assets';
