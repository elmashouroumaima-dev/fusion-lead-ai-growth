# Runbook — rotation et révocation des secrets d'intégration

Périmètre : jetons et clés d'API des intégrations `email` et `whatsapp` (J28, ADR 004). Le chiffrement de la clé maître (`SECRETS_MASTER_KEY`) et sa rotation par `key_version` sont décrits en fin de document ; la procédure complète (re-chiffrement par le worker) arrive avec les runbooks de J58 et J59.

## 1. Remplacer un jeton (rotation d'un secret)
Qui : owner ou admin de l'entreprise. Quand : jeton expiré, soupçon de fuite, départ d'un collaborateur.
1. Générer le nouveau jeton chez le fournisseur.
2. Écran **Intégrations** : saisir le nouveau jeton dans « Nouveau jeton », puis « Remplacer ». (API : `POST /api/integrations/secret` avec `Idempotency-Key`.)
3. L'ancien secret est supprimé dans la même transaction : il n'existe plus en base.
4. **Révoquer l'ancien jeton chez le fournisseur** : le supprimer de la base ne suffit pas.
5. Vérifier l'audit : `integration.secret_rotated` (identifiants seulement).
En cas de jeton **compromis**, révoquer d'abord chez le fournisseur, puis remplacer. Utiliser une clé d'idempotence neuve : rejouer la même clé avec un autre jeton est refusé (422).

## 2. Déconnecter une intégration
1. Écran **Intégrations** : « Déconnecter », puis confirmer.
2. Le secret est supprimé, le statut devient `disconnected`, les canaux sont déconnectés et en pause (plus aucun envoi).
3. Révoquer le jeton chez le fournisseur.
Pour reconnecter : saisir un nouveau jeton (« Reconnecter ») ; l'intégration revient en `pending` et ses canaux en `pending` **mais en pause** ; le propriétaire les relance après validation.

## 3. Jeton illisible ou clé maître absente
- **Sans `SECRETS_MASTER_KEY`** sur le serveur : l'écran affiche « chiffrement non configuré » et les routes répondent 503 ; rien n'est stocké en clair.
- **Secret illisible** (mauvaise clé maître, version de clé inconnue) : le déchiffrement échoue sans détail. Remettre la bonne clé ou **remplacer le jeton**.
- **Perte de la clé maître** : tous les secrets deviennent illisibles. Conserver la clé dans le gestionnaire de secrets de l'hébergeur (ADR 010) ; ne jamais la mettre dans le dépôt, un `.env` partagé ou un journal.

## 4. Clé maître : rotation par version (à compléter à J58 et J59)
Le trousseau (`createKeyRing`) accepte plusieurs versions : un secret chiffré avec l'ancienne version reste lisible tant que son entrée existe. Procédure cible : ajouter la nouvelle clé (version N+1) au trousseau, passer `SECRETS_KEY_VERSION` à N+1, re-chiffrer les secrets existants par un job du worker (lecture avec l'ancienne version, écriture avec la nouvelle), puis retirer l'ancienne clé. **Le job de re-chiffrement n'existe pas encore.**

## 5. Vérifications
- Aucun secret dans un journal : le journal applicatif masque `token`, `secret`, `authorization`, `api_key` ; l'audit ne contient que des identifiants et des noms de champs.
- Aucune lecture via la Data API : `secret_ref` n'est pas lisible, `private.secrets` n'a aucun droit (tests pgTAP `210`, tests RLS `integrations-secrets`, acceptation `integrations-flow`).
