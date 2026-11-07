# ADR 004 — Stockage des secrets (`secret_ref`)

- **Statut :** Proposed — **relecture de sécurité par la responsable technique requise**
- **Date :** 2026-11-10
- **Section de spec :** §6 (secrets), §7 (`integrations.secret_ref`), §11 (chiffrement, rotation, pas de jeton dans les logs), §2 (Company Admin ne voit pas les secrets bruts)

## Contexte
Les jetons OAuth, clés API et secrets webhook ne doivent jamais être stockés bruts en base, ni apparaître dans les logs ou `audit_logs` ; ils sont référencés par `secret_ref` (§7, §11). Il faut aussi une restauration testée (critère §13-10).

## Vérification de la documentation officielle (consultée le 2026-11-05)
Page « Vault » de Supabase : les secrets sont dans `vault.secrets` avec chiffrement authentifié (libsodium) ; **la clé racine n'est pas dans la base**, elle est gérée par projet par Supabase. Sauvegardes, PITR, restauration in-place et restauration vers un nouveau projet via la fonction de Supabase conservent/copient la clé ; en revanche, un **`pg_dump`/`pg_restore` manuel vers un nouveau projet obtient une nouvelle clé et ne peut pas déchiffrer** les secrets copiés (la clé racine doit être recopiée via l'API de gestion). La doc avertit aussi que quiconque accède à `vault.decrypted_secrets` lit les secrets en clair.
Source : https://supabase.com/docs/guides/database/vault

## Options
| Option | Pour | Contre |
|---|---|---|
| A. Supabase Vault | Pas de cryptographie maison ; clé hors base | Dépendance à la clé gérée par Supabase ; restauration manuelle fragile ; restreindre `vault.*` à `service_role` ; difficile à reproduire en CI/local identique |
| **B. Chiffrement applicatif AES-256-GCM** (enveloppe) | Restauration portable (le dump contient des secrets chiffrés, la clé est dans le gestionnaire de secrets du serveur) ; testable en local/CI ; rotation de clé maîtresse maîtrisée | Cryptographie à implémenter avec soin ; gestion de la clé à notre charge |

## Décision recommandée
**Option B**, avec :
- Table `secrets` (schéma `private`, non exposé) : `id`, `organization_id`, `ciphertext`, `nonce`, `key_version`, `created_at`, `rotated_at` ; `integrations.secret_ref` = `secrets.id`.
- AES-256-GCM via l'API crypto standard de Node, nonce unique 96 bits par chiffrement, **AAD = `organization_id || secret_id`** (empêche de rejouer un secret d'une entreprise dans une autre), clé maîtresse versionnée fournie par variable d'environnement serveur (jamais `NEXT_PUBLIC_*`), jamais dans la base ni dans le dépôt.
- Accès uniquement par un module serveur `packages/adapters/secrets` (`put`, `get`, `rotate`, `delete`) et la RPC `service_role` ; aucun GRANT à `anon`/`authenticated` sur `private.secrets`.
- **Aucune API ne renvoie un secret au navigateur** (UI en écriture seule : « remplacer », « déconnecter »). Pas de rôle, y compris Owner, ne lit un secret brut (ADR 014).
- Rotation : nouveau secret → bascule de `secret_ref` → suppression de l'ancien ; rotation de clé maîtresse par `key_version` (re-chiffrement en tâche worker).
- Redaction : les champs `token`, `secret`, `authorization`, `api_key`, `secret_ref` en valeur résolue sont masqués par le logger et par `audit()`.

Option A reste l'alternative documentée si vous préférez déléguer la cryptographie ; elle nécessiterait de documenter la procédure de copie de clé dans le runbook de restauration.

## Conséquences
Runbook `secret-rotation` et `restore` (J58–J59) ; test J28 : lecture via Data API impossible, rotation vérifiée ; test de non-rejeu inter-tenant par l'AAD.

## Mise en œuvre « Paramètres SMTP » (2026-11-07)
Première utilisation de l'option B (chiffrement applicatif), avant le J28 :
- `packages/adapters/src/secrets` : AES-256-GCM (nonce 96 bits unique, étiquette 128 bits), AAD `platform:<usage>:<id du secret>` (variante `org:<organization_id>:<id>` prête pour les secrets d'organisation), trousseau de clés versionné (`createKeyRing`), erreur unique sans détail. Clé maître : `SECRETS_MASTER_KEY` (base64, 32 octets) et `SECRETS_KEY_VERSION`, validées par le schéma d'environnement serveur, optionnelles (sans clé, aucun secret ne peut être enregistré).
- `private.secrets` (migration `20261117100000`) : `id` (généré par l'application, car il fait partie de l'AAD), `purpose`, `organization_id` (NULL = secret de la plateforme), `ciphertext`, `nonce`, `key_version`, `created_at`, `rotated_at` ; **aucun droit** pour anon / authenticated / service_role ; accès par fonctions `SECURITY DEFINER` uniquement. Écart à l'ADR : `organization_id` est nullable (secrets de la plateforme).
- Le mot de passe n'est jamais lisible par l'API : l'administrateur ne reçoit que `has_password` ; le chiffré n'est lu que par `service_role` (`get_smtp_delivery`) et déchiffré dans le serveur Next.js.
- Reste : module `get / rotate / delete` générique pour les intégrations (J28), re-chiffrement lors d'une rotation de clé maître (tâche worker), runbooks `secret-rotation` et `restore`. L'ADR reste « Proposed » : à relire par la responsable technique.

