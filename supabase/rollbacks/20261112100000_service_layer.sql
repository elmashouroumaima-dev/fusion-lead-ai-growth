-- Retour arrière de 20261112100000_service_layer.sql
-- À exécuter AVANT les retours arrière des migrations précédentes.
-- Procédure : psql -f <ce fichier> sur la base concernée, puis supprimer la ligne correspondante
-- de supabase_migrations.schema_migrations si la migration doit pouvoir être rejouée.
-- ATTENTION : perd toutes les clés d'idempotence et tous les seaux à jetons (état éphémère, sans
-- conséquence métier : les prochains appels repartent d'un seau plein).

drop function if exists public.rate_limit_purge(integer);
drop function if exists public.idempotency_purge(integer);
drop function if exists private.rate_limit_purge(integer);
drop function if exists private.idempotency_purge(integer);

drop function if exists public.rate_limit_take(uuid, text, text, integer, double precision, integer);

drop function if exists public.idempotency_abandon(uuid, text, uuid);
drop function if exists public.idempotency_complete(uuid, text, uuid, integer, jsonb);
drop function if exists public.idempotency_begin(uuid, text, text);

drop function if exists private.idempotency_abandon(uuid, text, uuid);
drop function if exists private.idempotency_complete(uuid, text, uuid, integer, jsonb);
drop function if exists private.idempotency_begin(uuid, text, text);

drop table if exists public.rate_limit_buckets;
drop table if exists public.idempotency_keys;
