# Purge des tables de la couche service

Tables : `idempotency_keys` et `rate_limit_buckets`. Aucune purge automatique avant le worker (J13).

## Purge manuelle (rôle `service_role` uniquement)
```sql
-- Répéter tant que le résultat est égal à la taille du lot (1000 par défaut)
select public.idempotency_purge();
-- Seaux inactifs depuis plus de 7 jours
select public.rate_limit_purge();
```
`idempotency_purge` supprime les lignes expirées depuis plus d'une heure et les lignes `in_progress` de plus d'une heure ; elle ne touche jamais une ligne vivante.

## Surveillance
Suivre la taille de `idempotency_keys` (le quota limite à 200 lignes vivantes par organisation et acteur, mais le nombre d'organisations par acteur n'est pas plafonné avant J57). La clé étrangère `on delete restrict` impose de purger ces lignes avant tout effacement d'organisation.
