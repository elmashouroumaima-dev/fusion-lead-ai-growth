# Adaptateur CRM et synchro de contacts (J25)

Migration `20261127100000_crm_sync.sql` (retour arrière : `supabase/rollbacks/20261127100000_crm_sync.sql`). Spec §6 (interface des adaptateurs), §9.1 étapes 5–6, `docs/integrations/crm.md`, ADR 007 (E8, G-D3). Écran `/crm` en français, arabe (RTL) et anglais.

## Principe
Le **CRM interne est la source de vérité** du MVP. Aucune information sur le CRM Fusion Leap n'étant dans le dépôt (fiche Q1 « À CONFIRMER »), **aucun squelette de son adaptateur n'est créé** et aucune synchro bidirectionnelle n'existe sans règle de conflit explicite. Ce qui est livré : l'interface commune, deux adaptateurs (`internal`, `csv`), un moteur de synchro pur, le mapping de champs et un job `crm_sync` qui synchronise des **contacts** depuis un fichier CSV.

## Interface `CrmAdapter` (`packages/adapters/src/crm`)
`connect`, `validate`, `send`, `receive`, `refresh`, `disconnect` (spec §6). Enregistrement neutre `{ entity, externalId, fields, updatedAt }`, aucun secret.
- **`internal`** : source de vérité ; n'envoie ni ne reçoit rien.
- **`csv`** : `receive` lit un CSV selon le mapping (`external_field` = en-tête de colonne), dates **ISO 8601 strictes**, signale les colonnes absentes de l'en-tête ; `send` produit un CSV (colonnes en sens `push` ou `both`, cellules protégées contre l'injection de formule).

## Mapping de champs (`crm_field_mappings`)
`entity` (`contact`), `internal_field`, `external_field`, `source_of_truth` (`internal` | `external`), `direction` (`pull` | `push` | `both`).
- Champs internes en **liste blanche** : mis à jour : `name`, `language`, `country` ; identité (création et rattachement seulement) : `email`, `phone` ; techniques (lecture seule) : `external_id` (**obligatoire**), `external_updated_at`.
- 2 à 20 entrées, un mapping par champ interne et par colonne externe. Owner et admin ; remplacement complet par `POST /api/crm/mappings`.

## Règle de conflit (moteur `packages/domain/src/crm-sync`)
- Un champ n'est en **conflit** que si **les deux côtés ont changé** depuis la dernière synchro **et** que les valeurs diffèrent : la `source_of_truth` du champ l'emporte et le **perdant est consigné dans l'audit** (`crm_sync.conflict` : nom du champ et gagnant, jamais la valeur).
- Un seul côté a changé : ce côté s'applique. Le fournisseur n'a rien de nouveau : rien n'est fait.
- Curseurs : début de la dernière synchro (côté fournisseur : aucune modification n'est manquée) et **fin** (côté interne : les écritures de la synchro elle-même ne sont pas des modifications humaines, donc pas de faux conflit à la suivante).
- Une cellule **vide** est « non fournie » : elle n'efface jamais une valeur interne. Une valeur invalide refuse la ligne.
- L'**identité** (e-mail, téléphone) n'écrase jamais un contact existant ; un contact « **ne plus contacter** » n'est jamais modifié ; **aucun consentement** n'est créé ni modifié.

## Synchro (job `crm_sync` `{ integration_id, batch_id }`)
1. `POST /api/crm/integrations` crée une intégration (`provider` : `csv` ou `internal`), puis `POST /api/crm/mappings` son mapping.
2. Le fichier CSV est envoyé par `POST /api/imports` (J23) **sans être confirmé comme import** ; `POST /api/crm/sync` `{ integration_id, batch_id }` enfile le job (202). Une seule synchro à la fois par intégration (409) ; mapping obligatoire.
3. Le worker (service_role, **entreprise de la ligne du job**) lit le fichier ligne par ligne : crée (identité obligatoire, quota « contacts »), **rattache** un contact existant (même e-mail ou téléphone, **sans identifiant externe**) ou met à jour. **Idempotent par identifiant externe** (`external_source` = `csv:<id de l'intégration>`, unique par entreprise : G-D3) ; un rejeu ne recrée rien.
4. Fin : `last_sync_at`, `last_sync_finished_at`, audit `crm_sync.completed` (compteurs : créés, mis à jour, rattachés, inchangés, ignorés, refusés, conflits) ; le lot de fichier est **consommé** (statut `synced` : ni importable ensuite, ni synchronisable, hors plafond des lots en cours).
5. Échecs définitifs (code enregistré sur l'intégration, audit `crm_sync.failed`) : `file_missing`, `file_malformed` (UTF-8, guillemets, aucune ligne lisible), `mapping_invalid` (mapping ou colonne d'identifiant absente du fichier). Panne technique : job réessayé ; à la dernière tentative l'échec est enregistré (`failed`).

## Statut visible et « Réessayer »
`GET /api/crm/integrations` : intégrations, mapping et statut `never | queued | running | ok | failed` (dernier job), dernière synchro réussie, dernière erreur (code). L'écran `/crm` (owner et admin) l'affiche avec le mapping en lecture ; en cas d'échec, **« Réessayer »** (`POST /api/crm/sync/retry`) rejoue le même job (même fichier : aucun doublon). Aucun secret ni contenu de fichier n'est affiché.

## Droits
Owner et admin seulement (lecture RLS, écriture par fonctions SQL qui revérifient le rôle et l'abonnement) ; marketing, commercial et analyste : 403 (page : redirection). Fonctions du worker : `service_role` seulement. `Idempotency-Key` obligatoire sur les écritures.

## Limites connues
- **Contacts seulement** (leads et deals : à venir) ; aucun transport réseau (API REST, webhooks) tant que le CRM Fusion Leap n'est pas documenté.
- **Un appel par ligne** (jusqu'à 3) : un fichier de 10 000 lignes occupe un emplacement du worker plusieurs minutes, sans équité entre entreprises ; un dépassement du délai du handler (15 min) relance tout le traitement (rejeu sans doublon, mais l'audit des conflits peut se répéter). À traiter avec un traitement par lots.
- **Champs d'identifiant libres** : un `marketing_manager` peut renseigner `external_source` / `external_id` d'un contact (J18) et préempter un identifiant ; à réserver à owner et admin.
- `external_updated_at` est fourni par l'utilisateur : une date future ou très ancienne n'a pas d'effet de sécurité mais oriente la détection de changement.
- Un téléphone du fichier qui appartient à un autre contact est ignoré lors d'un rattachement par e-mail.
- Pas de purge des fichiers de synchro du Storage (comme les imports).
