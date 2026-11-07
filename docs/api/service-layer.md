# Couche service (J11)

`apps/web/lib/service/` enveloppe toute mutation (route HTTP ou Server Action) dans un pipeline fixe :
`request_id` → limite de taille → lecture du corps → validation zod → authentification (session ou contexte tenant relu en base) → `can()` → limitation de débit → idempotence (début) → traitement → idempotence (fin) → réponse.
Chaque échec renvoie `{ code, message, request_id }` (messages génériques fixes, jamais de texte d'erreur brut) et l'en-tête `x-request-id`. Le `request_id` est toujours généré par le serveur ; un `x-request-id` fourni par le client n'est journalisé que comme `client_request_id`.

## Codes et statuts
| Code | Statut |
|---|---|
| `validation_failed` | 400 |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `idempotency_in_progress`, `duplicate_request` | 409 |
| `payload_too_large` | 413 |
| `idempotency_conflict` | 422 |
| `rate_limited` (+ `Retry-After`), `quota_exceeded` | 429 |
| `internal_error` | 500 |
| `service_unavailable` | 503 |

## Idempotence (`Idempotency-Key`)
- Route : en-tête `Idempotency-Key` ; Server Action : champ caché `idempotency_key` généré à chaque affichage du formulaire. Valeur : 8–128 caractères `[A-Za-z0-9_-]`.
- Table `idempotency_keys` (ADR 007), accessible **uniquement** par `idempotency_begin / complete / abandon` (fonctions `security definer`, identité = `auth.uid()`, membre actif requis). Même clé, même acteur, même corps (`sha256` de la méthode, du chemin et du corps canonique) : la réponse enregistrée est rejouée (en-tête `Idempotent-Replay: true`), sans second effet. Corps ou acteur différent : `422 idempotency_conflict`. Requête encore en cours : `409 idempotency_in_progress`.
- Durée : 24 h. Une ligne `in_progress` de plus de 5 minutes est reprise ; chaque tentative porte un `attempt_id` qui interdit à une tentative tardive de terminer ou supprimer celle qui l'a remplacée.
- Garde-fous : 200 lignes vivantes au maximum par (organisation, acteur) (`quota_exceeded`, quota souple sous forte concurrence puis verrouillé), réponse limitée à 16 Ko.
- `storeResponse: false` pour toute réponse qui contient un secret (invitation) : seul `{"replayed":true}` est conservé et un rejeu répond `409 duplicate_request` sans corps. Option explicite, sans valeur par défaut.
- Purge : `public.idempotency_purge(p_batch)` et `public.rate_limit_purge(p_idle_days)` (service_role uniquement). Planifiées avec le worker (J13) ; manuellement : `select public.idempotency_purge();` répété tant que le résultat atteint la taille du lot, puis `select public.rate_limit_purge();`.

## Limitation de débit
Seau de jetons en base (`rate_limit_buckets`, ADR 007 G-D9), écrit uniquement par `service_role` depuis le serveur (module `apps/web/lib/supabase/admin.ts`, confiné par ESLint). Deux seaux consommés par appel : (organisation, utilisateur) et un seau global par utilisateur.

| Portée | Capacité | Recharge |
|---|---|---|
| `mutation` | 30 | 0,5 jeton/s |
| `sensitive` (créer une organisation, inviter, transférer, changer un rôle, retirer, révoquer, accepter) | 10 | 1/6 jeton/s |

Dépassement : `429 rate_limited` avec `Retry-After`. Panne du limiteur : `503 service_unavailable`, aucune mutation exécutée (échec fermé). Pas de limite par IP avant J21.
