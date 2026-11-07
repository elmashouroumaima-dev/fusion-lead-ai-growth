# API — Paramétrage (palette de couleurs globale)

Page : `/{locale}/settings/appearance` (owner et admin d'organisation ; les autres utilisateurs sont redirigés vers le tableau de bord). La palette s'applique à toute la plateforme, page de connexion comprise : **un owner/admin la modifie pour tous les clients** (risque assumé, ADR 016).

## Server Actions (`apps/web/lib/settings/actions.ts`)
| Action | Champs | Droit | Effet |
|---|---|---|---|
| `savePaletteAction` | `palette` (JSON), `uiLocale` | owner / admin actif (vérifié par la base) | enregistre `appearance.palette` (upsert) |
| `resetPaletteAction` | `uiLocale` | idem | supprime la ligne : retour aux couleurs par défaut |

Réponse : `{ status: "idle" | "error" | "success", code? }` avec `code` ∈ `invalid_input`, `forbidden`, `rate_limited`, `duplicate_request`, `idempotency_in_progress`, `idempotency_conflict`, `service_unavailable`, `generic`. Débit : `mutation`. Aucune organisation : `organization_id` est refusé. Idempotence sans objet (upsert naturellement idempotent).

## Fonctions SQL
- `set_platform_config(p_key text, p_value jsonb)` — `authenticated` ; `42501 forbidden` si l'appelant n'est pas owner/admin actif d'une organisation ; `22023 validation_failed` si clé hors liste blanche ou forme invalide.
- `reset_platform_config(p_key text)` — idem.
- `can_manage_platform_config()` — `authenticated` ; `true` si `auth.uid()` est owner/admin actif d'une organisation.
- `get_platform_config(p_key text)` — **`service_role` seulement** (lecture serveur) ; `null` si absente ou clé hors liste blanche.
- Aucun accès direct à la table `platform_config`.

## Forme de la palette
```json
{ "light": { "primary": "#006a4e", "primary_foreground": "#ffffff", "...": "..." }, "dark": { "...": "..." } }
```
Jetons : `primary`, `primary_foreground`, `secondary`, `secondary_foreground`, `background`, `foreground`, `accent`, `accent_foreground`, `destructive`, `destructive_foreground`. Valeurs `#rrggbb` en minuscules. Côté application, palette complète (clair + sombre) et contraste AA obligatoires.
