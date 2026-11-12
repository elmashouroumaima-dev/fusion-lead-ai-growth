# Journal d'audit (`audit_logs`)

## Principe
Les événements sont écrits **par la base**, dans la transaction de la modification, par des déclencheurs `security definer` (`organizations`, `organization_members`, `invitations`). Aucun rôle d'API n'a de droit d'écriture sur la table ; `private.audit_write` n'est appelable par personne en dehors de ces déclencheurs. Lecture : propriétaire et administrateur de l'organisation (RLS).

Actions : `organization.created`, `organization.updated`, `member.joined`, `member.role_changed`, `member.removed`, `member.reactivated`, `member.suspended`, `member.status_changed`, `member.deleted`, `invitation.created`, `invitation.revoked`, `invitation.accepted`.

## Garanties et limites
- **Immuable** : `UPDATE`, `DELETE` et `TRUNCATE` lèvent `audit_logs_immutable` pour tous les rôles, y compris `service_role` ; les déclencheurs sont `ENABLE ALWAYS` (pas contournables par `session_replication_role = replica`).
- **Limite** : le propriétaire de la table et un super-utilisateur peuvent désactiver ou supprimer les déclencheurs, et `DROP TABLE` n'est pas bloqué. À protéger par l'exploitation (accès base restreint).
- **Contenu** : avant/après limités aux colonnes utiles ; clés sensibles supprimées par `private.audit_redact` (`token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp`, même liste que le logger TypeScript, vérifiée par un test) ; chaînes tronquées à 200 caractères ; e-mails d'invitation masqués (`***@domaine`, première lettre conservée à partir de 3 caractères) ; jamais `token_hash`. `ip` reste NULL (pas de proxy de confiance, voir ADR 010).
- **`request_id`** : indice de corrélation, **pas une preuve** : appelée directement, l'API de données accepte l'en-tête `x-request-id` fourni par le client (format `^[A-Za-z0-9._-]{8,128}$`). L'application envoie son identifiant généré côté serveur ; les actions d'authentification (J8) et `/auth/confirm` passent hors couche service et laissent `request_id` NULL jusqu'à leur migration.
- **Orphelins de test** : les tests RLS suppriment des organisations en mode `replica` ; leurs lignes d'audit restent (effacées par `pnpm db:reset`).

## Procédures (en tant que propriétaire de la table, avec accord et traçabilité)
1. **Avant un retour arrière de la migration** : exporter la table (`\copy audit_logs to ...`), car le retour arrière **supprime tout le journal**.
2. **Effacement d'une organisation** (clé étrangère `on delete restrict`) : exporter ses lignes d'audit ; dans une transaction, désactiver les déclencheurs d'immutabilité (`alter table audit_logs disable trigger ...`), supprimer les lignes de l'organisation puis l'organisation, réactiver (`enable always trigger ...`), consigner l'opération (ticket, date, auteur). Les données pseudonymes restantes (identifiants d'acteur) relèvent de la politique de rétention.
3. **Croissance** : chaque changement d'organisation, de membre ou d'invitation écrit une ligne. Rétention et archivage (partition mensuelle ou purge contrôlée) à définir avant la production (J13/J57).
