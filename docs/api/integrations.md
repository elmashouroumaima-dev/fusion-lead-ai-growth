# Intégrations, canaux et secrets (J28)

Migration `20261128100000_integrations_secrets.sql` (retour arrière : `supabase/rollbacks/20261128100000_integrations_secrets.sql`). Spec §2, §7 et §11, ADR 004 (secrets), 007 (E3 et E4), 014 (lignes 6 et 7). Écran : `/integrations` (owner et admin).

## Modèle
- **`integrations`** (J25, étendue) : `provider` (`csv`, `internal`, `email`, `whatsapp`), `status` (`pending`, `active`, `error`, `disconnected`, `disabled`), `external_account_id`, `scopes text[]`, `secret_ref`, `has_secret` (booléen généré), `last_sync_at`, `last_error`. Unicité par entreprise `(provider, compte)` et, pour `email` et `whatsapp`, **globale** `(provider, compte)` (ADR 005, décision 9).
- **`channels`** (ADR 007 E4) : `type` (`email`, `whatsapp`), `integration_id` (clé étrangère composite), `sender_identity` (e-mail ou numéro E.164), `status` (`pending`, `active`, `paused`, `disconnected`), `project_scope uuid[]`, `send_paused`. Unique par entreprise `(type, sender_identity)`.
- **`private.secrets`** (ADR 004) : secret chiffré (AES-256-GCM) avec `organization_id` ; **aucun droit d'API**. Une clé étrangère composite lie le secret à l'entreprise de son intégration.

## Aucun jeton lisible
- Le SELECT de `authenticated` sur `integrations` est accordé **par colonnes** : `secret_ref` n'est lisible par personne (ni owner, ni admin) ; `select *` est refusé (il l'inclurait). L'interface ne connaît que `has_secret`.
- Le jeton est chiffré par le **serveur applicatif** avant l'appel SQL (AAD `org:<organization_id>:<secret_id>` : un secret d'Alpha ne s'ouvre pas avec l'identité de Beta). Seul le chiffré est enregistré. Aucune réponse d'API, aucune page, aucune ligne d'audit, aucune empreinte d'idempotence ne contient le jeton, son chiffré ou son nonce.
- `get_integration_secret(p_org, p_integration)` : **service_role seulement** (worker, envois), entreprise = celle de la ligne du job ; renvoie le chiffré pour les statuts `pending`, `active`, `error`. Côté serveur web : `lib/service/integration-secrets.ts` (`readIntegrationSecret`), seul appelant.

## Fonctions SQL (SECURITY DEFINER, `search_path` vide, enveloppes `public.*` SECURITY INVOKER ; rôle owner ou admin revérifié)
| Fonction | Effet |
|---|---|
| `create_provider_integration(p_org, p_provider, p_account, p_scopes, p_secret_id, p_ciphertext, p_nonce, p_key_version)` | crée une intégration `email` ou `whatsapp` en `pending` avec son secret chiffré ; quota `integrations`, 20 par entreprise, compte déjà connecté (même chez une autre entreprise) : 23505 |
| `set_integration_secret(p_org, p_integration, p_secret_id, p_ciphertext, p_nonce, p_key_version)` | **rotation** : écrit le nouveau secret puis supprime l'ancien (même transaction). Sur une intégration `disconnected` : **reconnexion** (statut `pending`, canaux `pending` mais en pause) |
| `disconnect_integration(p_org, p_integration)` | supprime le secret, statut `disconnected`, canaux déconnectés et en pause ; rejouable |
| `create_channel(p_org, p_integration, p_type, p_sender, p_scope)` | type = fournisseur ; identité au format e-mail ou E.164 ; projets de l'entreprise seulement ; 50 canaux par entreprise |
| `update_channel(p_org, p_id, p_scope, p_paused)` | portée et pause ; valeurs nulles = inchangées |
| `get_integration_secret(p_org, p_integration)` | **service_role seulement** (voir plus haut) |

Codes : `42501` interdit · `22023` / `23514` valeur invalide · `PT404` introuvable · `23505` compte ou expéditeur déjà pris · `P0001` : `integration_not_replaceable` (fournisseur sans secret ou intégration déconnectée pour un canal), `too_many_integrations`, `too_many_channels`.

## Routes (`apps/web/app/api/integrations`)
Owner et admin ; entreprise du contexte vérifié ; `Idempotency-Key` obligatoire ; le champ `secret` est remplacé par son **HMAC** (clé serveur) dans l'empreinte d'idempotence : le jeton ne se retrouve pas dans `idempotency_keys`, et rejouer la même clé avec un autre jeton donne **422**.
- `GET /api/integrations` : intégrations (statut, portée, dernière synchro, `has_secret`) avec leurs canaux.
- `POST /api/integrations` `{ provider: "email" | "whatsapp", external_account_id, scopes?, secret }` : 201 `{ integration: { id } }`.
- `POST /api/integrations/secret` `{ integration_id, secret }` : 200 `{ replaced: true }` (rotation ou reconnexion).
- `POST /api/integrations/disconnect` `{ integration_id }` : 200 `{ disconnected: true }`.
Sans clé maître (`SECRETS_MASTER_KEY`) : **503**, rien n'est créé. Un secret fait 8 caractères au moins et **4096 octets UTF-8** au plus.

## Audit
`integration.created`, `integration.secret_set`, `integration.secret_rotated`, `integration.reconnected`, `integration.disconnected`, `channel.created`, `channel.updated` (noms de champs). **Jamais** le secret, le chiffré, le nonce, l'identité de l'expéditeur.

## Limites connues
- **Pas de validation par le fournisseur** (J31 e-mail, J34 WhatsApp) : une intégration reste `pending` et un canal ne doit passer `active` qu'après cette validation. La chaîne d'envoi (J31) devra exiger un canal `active` et non en pause, un consentement et `do_not_contact`.
- **Squat de compte** : un compte `email` ou `whatsapp` est réservé globalement dès la création, sans preuve de propriété, et le refus (409) révèle qu'il est pris ailleurs (ADR 005, décision 9). À arbitrer avec la validation par le fournisseur (libérer un compte `pending` non validé après un délai).
- **Appel direct de la Data API** : un owner ou admin peut écrire un chiffré de format valide mais illisible par ses propres fonctions ; il ne nuit qu'à son entreprise (l'AAD l'empêche d'atteindre une autre). Le worker traitera un secret illisible comme une erreur d'intégration (statut `error`).
- **Pas de rotation de la clé maître** (re-chiffrement par `key_version` dans un job du worker) : prévue avec les runbooks (J58 et J59). La rotation d'un SECRET (remplacement) est livrée et testée.
- `service_role` garde le SELECT sur `integrations` (donc peut lire `secret_ref`, un simple identifiant) mais aucun droit sur `private.secrets`.
