# API et écrans de configuration (J39b)

Les fonctions SQL et les services web existaient depuis J21 (clés de formulaire) et J22 (assignation, notifications). J39b ajoute les **routes HTTP** et les **écrans**. Aucune migration. Toutes les routes : session + entreprise active vérifiée, `Idempotency-Key` obligatoire, erreurs `{ code, message, request_id }`. Un `organization_id` étranger dans le corps est refusé (403 pour les clés de formulaire, 400 pour les notifications dont le schéma est strict).

## Clés de formulaire — page d'un projet, section « Form keys »
Droit : `form_keys:manage` (owner, admin ; amendement ADR 014 ligne 16). Marketing, commercial, analyste : 403 (et la section n'apparaît pas).

| Route | Corps | Réponse |
|---|---|---|
| `POST /api/forms/keys` | `{ project_id, allowed_origins[1..10] }` | 201 `{ id, key, key_prefix }` |
| `POST /api/forms/keys/active` | `{ key_id, active }` | 200 `{ active }` (révoquer = `false`) |
| `POST /api/forms/keys/origins` | `{ key_id, allowed_origins[] }` | 200 `{ updated: true }` |

- **La clé en clair n'existe que dans la réponse 201 de la création.** L'interface l'affiche une fois (état local du composant), avec « Copier » et « Masquer » ; elle n'est ni dans l'URL, ni dans le stockage du navigateur, ni relue du serveur.
- `storeResponse: false` : l'idempotence ne conserve pas la réponse. Rejouer la même `Idempotency-Key` donne **409 `duplicate_request`** sans la clé (il faut en créer une autre).
- La base ne garde que l'empreinte SHA-256 ; la liste lit seulement `key_prefix`, les origines, l'état et la date. La clé n'apparaît pas dans `audit_logs` ni dans la page du projet (testé).
- Origines : https exactes, 1 à 10. 5 clés actives au plus par projet (409/400 selon la règle). Projet archivé : lecture seule.
- Pas de rotation en un clic : créer une nouvelle clé, la déployer, puis révoquer l'ancienne.

## Règles d'assignation — page `/assignment` (menu « Assignment »)
Droit : `assignment_rules:manage` (owner, admin). Les autres rôles sont renvoyés au tableau de bord.

| Route | Corps |
|---|---|
| `POST /api/assignment/rules` | `{ project_id?, strategy: "round_robin" \| "fixed", eligible_member_ids[1..50] }` → 201 `{ id }` |
| `POST /api/assignment/rules/update` | `{ rule_id, strategy, eligible_member_ids, active }` |
| `POST /api/assignment/rules/delete` | `{ rule_id }` |

- `project_id` absent = règle par défaut de l'entreprise ; une règle de projet l'emporte. `fixed` exige exactement un membre. La base revérifie que les membres sont actifs et owner / admin / commercial, et appartiennent à l'entreprise.
- Les membres sont désignés par un identifiant court et leur rôle (les e-mails ne sont pas lisibles sans `service_role`).

## Notifications — page `/notifications` (menu « Notifications », compteur de non lues)
Destinataires : owner et admin (les deux types d'alerte leur sont adressés). Chacun ne voit que **ses** notifications (RLS).
- `lead.unassigned` (J22) : motif (`no_rule`, `no_eligible`, `failed`) et lien vers le lead.
- `send.failed` (J39) : nature du job et lien vers Exploitation. Le schéma accepte les deux types (un schéma limité à `lead.unassigned` aurait fait échouer la lecture dès la première alerte d'envoi).
- `POST /api/notifications/read` `{ notification_id }` → 200 `{ read: true }`. Marquer la notification d'un autre : refusé.

## Limites connues
- Le compteur de non lues est lu au chargement de la page (pas de mise à jour en direct).
- Pas de « tout marquer comme lu », pas de pagination (100 plus récentes).
- Écart au plan par défaut : les notifications sont une page et un lien de menu avec compteur, pas un panneau déroulant dans l'en-tête.
- Les règles ne balaient pas les leads déjà non assignés (voir `docs/api/assignment.md`).
- Le marketing manager ne voit pas ces écrans (alertes adressées à owner et admin).
