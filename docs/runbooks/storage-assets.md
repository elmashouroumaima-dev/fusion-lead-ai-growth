# Fichiers des produits (Storage, bucket `assets`)

## Principe
Le bucket **privé** `assets` est créé par la migration `20261119100000_storage_assets.sql` (local, staging, production : même migration, aucune création manuelle). Chemin imposé `{organization_id}/{project_id}/{asset_id}/{fichier}` ; lecture par les membres de l'entreprise, écriture et suppression par owner et admin sur un projet actif ; liens de lecture **signés de 60 secondes** générés par le serveur. Détails : `docs/api/projects.md`.

## Vérifier en local
- Console Supabase (`http://127.0.0.1:54323`) → **Storage** → `assets` : les dossiers sont les identifiants d'entreprise puis de projet.
- Base : `select name, created_at from storage.objects where bucket_id = 'assets' order by created_at desc;`
- Fichiers d'un produit : `select assets from public.products where id = '<id>';` (les chemins doivent exister dans `storage.objects`).

## Objets non rattachés (orphelins)
Un envoi peut réussir sans que le chemin soit enregistré (panne entre les deux étapes : l'application tente de supprimer l'objet, sans garantie), ou un owner / admin peut envoyer directement à l'API Storage. Lister les objets sans produit :
```sql
select o.name, o.created_at
  from storage.objects o
 where o.bucket_id = 'assets'
   and not exists (select 1 from public.products p where p.assets ? o.name)
 order by o.created_at;
```
Suppression : par l'API Storage ou la console (jamais par `DELETE` SQL direct : Storage le refuse, et les fichiers physiques resteraient). Une purge automatique est à prévoir avec le worker (tâche « objets non rattachés de plus de 24 h »).

## Concurrence et association des fichiers
Les chemins de `products.assets` ne se modifient que par `append_product_asset` / `remove_product_asset` (verrou de la ligne du produit). Un objet n'est supprimé du Storage que si plus aucun produit ne le référence. Contrôle d'intégrité :
```sql
select p.id, a.path from public.products p, jsonb_array_elements_text(p.assets) as a(path)
 where not exists (select 1 from storage.objects o where o.bucket_id = 'assets' and o.name = a.path);
```
(doit être vide ; sinon, retirer le chemin par `remove_product_asset`.)

## Limites et réglages
- 10 Mo par fichier et types `image/png`, `image/jpeg`, `image/webp`, `application/pdf` : imposés par le bucket. L'application limite à **5 Mo** et vérifie les **octets** (le type annoncé et l'extension sont ignorés).
- Corps des Server Actions : 6 Mo (`serverActions.bodySizeLimit` dans `apps/web/next.config.ts`).
- Pas de plafond d'octets par entreprise au J17 : surveiller le volume (`select split_part(name,'/',1) org, count(*), sum((metadata->>'size')::bigint) from storage.objects where bucket_id='assets' group by 1;`) ; plafond lié au plan et purge à prévoir avec le worker.
- Hébergement (ADR 010) : retirer l'en-tête `X-Forwarded-Host` fourni par le client au niveau du reverse proxy ; surveiller le volume Storage et la région (Q5).

## Retour arrière
`supabase/rollbacks/20261119100000_storage_assets.sql` supprime les politiques, les fonctions et le bucket (il active `storage.allow_delete_query` pour la session). **Vider d'abord le bucket par l'API Storage** si des fichiers existent : sinon les fichiers physiques restent orphelins.
