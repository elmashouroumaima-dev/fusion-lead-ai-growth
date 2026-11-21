# Runbook — Base Supabase hébergée : appliquer les migrations et enregistrer l'administrateur de la plateforme

À faire par la personne qui **possède le projet Supabase hébergé** (l'assistant de développement n'a pas d'accès à cette base). Symptôme à corriger : sur la base hébergée, les pages Contacts, Boîte de réception et Intégrations affichent des erreurs, parce qu'aucune migration n'y a été appliquée depuis J28.

## Règles (à lire d'abord)
- **Jamais `pnpm db:reset` ni `supabase db reset` sur la base hébergée** : cela efface toutes les données. Ces commandes sont réservées à la base locale (Docker).
- Toujours un **essai à blanc** (`--dry-run`) avant d'appliquer.
- Ne jamais modifier ni renommer une migration déjà appliquée (CLAUDE.md) : on ajoute une nouvelle migration.
- Le mot de passe de la base et les clés (`service_role`, `SECRETS_MASTER_KEY`) ne se collent ni dans une conversation, ni dans un fichier du dépôt, ni dans une capture d'écran.
- Avant d'appliquer : faire une **sauvegarde** (Supabase → Database → Backups, ou `supabase db dump --linked -f sauvegarde.sql`, fichier hors dépôt).

## 1. Lier le projet (une fois)
```bash
supabase login
supabase link --project-ref <référence du projet>
```
La référence du projet est dans l'adresse du tableau de bord (`https://supabase.com/dashboard/project/<référence>`). Le mot de passe de la base est demandé par la commande (ne pas le taper dans un fichier).

## 2. Voir ce qui manque
```bash
supabase migration list --linked
```
La colonne « Remote » doit être vide pour les migrations manquantes. Attendu au 20 novembre 2026 (à vérifier avec la liste réelle) : de `20261129100000_webhook_events` à `20261214100000_platform_config_admin_only` (18 migrations après `20261128100000_integrations_secrets`).

## 3. Essai à blanc puis application
```bash
supabase db push --linked --dry-run     # liste ce qui serait appliqué, ne change rien
supabase db push --linked               # applique dans l'ordre
```
Si la commande signale une migration « hors ordre » ou un écart d'historique : **s'arrêter** et demander à l'équipe de développement. Ne pas utiliser `--include-all` sans comprendre la raison.

## 4. Vérifier
Dans le SQL editor de Supabase (lecture seule) :
```sql
-- dernière migration appliquée : doit être 20261214100000
select max(version) from supabase_migrations.schema_migrations;
-- tables ajoutées depuis J28 (4 lignes attendues)
select table_name from information_schema.tables where table_schema = 'public'
  and table_name in ('webhook_events', 'conversations', 'messages', 'channels')
order by 1;
```
Puis ouvrir l'application hébergée : Contacts, Boîte de réception et Intégrations ne doivent plus afficher d'erreur.

## 5. L'application et le worker doivent être à jour aussi
- Déployer la version de la branche principale (même code que les migrations).
- Le **worker** doit tourner sur l'hébergé (sans lui, aucun envoi ni import) avec la même clé maître `SECRETS_MASTER_KEY` que l'application.
- `SITE_URL` (lien de désabonnement) et `WHATSAPP_VERIFY_TOKEN` (si WhatsApp) définis.

## 6. Enregistrer l'administrateur de la plateforme (ADR 016)
Sans ligne dans `private.platform_admins`, **personne** ne peut modifier la palette et le logo, ni administrer les entreprises. En local, `shared@seed.test` est administrateur (seed) ; sur l'hébergé il faut l'ajouter à la main.

1. Trouver l'identifiant de la personne (elle doit déjà s'être inscrite) dans le SQL editor :
```sql
select id, email from auth.users where email = '<adresse de la personne>';
```
2. L'enregistrer :
```sql
insert into private.platform_admins (user_id) values ('<identifiant trouvé>');
```
3. Retirer un administrateur si besoin : `delete from private.platform_admins where user_id = '<identifiant>';`

Aucune adresse ni aucun identifiant réel ne doit être écrit dans le dépôt (ce runbook garde des valeurs entre chevrons).

## 7. Retour arrière
Chaque migration a son fichier dans `supabase/rollbacks/` (même nom). Un retour arrière sur une base qui contient des données se décide avec l'équipe de développement, jamais seul : restaurer la sauvegarde est le chemin le plus sûr.

## Voir aussi
`docs/runbooks/plans-quotas.md` (administrateurs de la plateforme), `docs/runbooks/setup-new-machine.md`, `docs/runbooks/secret-rotation.md`.
