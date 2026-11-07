# API — organisations (J9)

## POST /api/orgs
Crée une organisation dont l'appelant devient `company_owner`, avec un abonnement `trial`.

- **Authentification** : session Supabase (cookie). Sinon `401 unauthenticated`.
- **En-tête obligatoire** : `Idempotency-Key` (8–128 car. `[A-Za-z0-9_-]`). Absent ou invalide → `400 validation_failed`.
- **Corps JSON** (champs inconnus refusés, 16 Ko max) : `name` (1–120), `locale` (`fr` | `ar` | `en`, défaut `fr` ; ne s'applique qu'aux nouvelles organisations), `timezone` (IANA, défaut `UTC`).
- **Refus** : un champ `organization_id` dans le corps → `403 forbidden` ; un client ne choisit jamais un identifiant.
- **Réponses** : `201` `{ organization: { id, name, slug, locale, timezone }, role: "company_owner" }` et cookie `fl_active_org` ; `200` si la même clé est rejouée avec le même contenu ; `422 idempotency_conflict` si la clé est rejouée avec un contenu différent ; `413 payload_too_large`.
- **Erreur normalisée** : `{ code, message, request_id }` (+ en-tête `x-request-id`). Aucun détail SQL ni trace.
