# Import CSV de leads (J23)

Migration `20261125100000_imports.sql` (retour arrière : `supabase/rollbacks/20261125100000_imports.sql`). Spec §9.1 (CSV avec aperçu et déduplication), §13 scénario 2, ADR 007 (addendum J23), ADR 014. Pas d'écran (J24) : l'API suffit à piloter l'assistant.

## Assistant en 3 étapes
1. **Envoi** `POST /api/imports?project_id=<uuid>` : corps = le fichier BRUT, `Content-Type: text/csv` (ou `text/plain`).
2. **Mapping + aperçu** `POST /api/imports/preview` : `{ batch_id, mapping, default_country? }`. **N'écrit rien.**
3. **Confirmation** `POST /api/imports/confirm` : même corps + en-tête `Idempotency-Key` obligatoire. Le lot est mis en file (job `import_csv`) ; le worker crée contacts et leads. Jamais dans la requête HTTP.

Suivi : `GET /api/imports` (liste), `GET /api/imports?id=<uuid>` (état et compteurs), `GET /api/imports/report?batch_id=<uuid>` (rapport CSV), `POST /api/imports/cancel` `{ batch_id }` (lot « envoyé » ou « en file »).

Rôles : **owner et admin** (la base et les politiques Storage le revérifient ; l'entreprise vient du contexte vérifié, un `organization_id` dans le corps est refusé).

## Le fichier
UTF-8 strict (BOM toléré), séparateur `,` `;` ou tabulation détecté, guillemets doublés et retours à la ligne dans une cellule acceptés, **10 Mo**, **10 000 lignes**, **50 colonnes**, 2000 caractères par cellule, un en-tête et au moins une ligne. Analyse en continu (`packages/domain/src/imports/csv.ts`, sans dépendance). Fichier refusé : 400 (413 au-delà de 10 Mo), rien n'est envoyé au Storage.

Le fichier est stocké dans le bucket **privé** `imports` sous `{entreprise}/{lot}.csv` (chemin GÉNÉRÉ par le serveur), avec les droits de l'utilisateur (politiques Storage : owner et admin de l'entreprise du chemin, ni mise à jour, ni lecture pour les autres rôles).

## Mapping
`{ name?, email?, phone?, language?, country? }` : rang de la colonne à partir de 0 (0 à 49). **E-mail ou téléphone obligatoire**, colonnes distinctes, champ inconnu refusé. `default_country` (ISO, majuscules) sert à lire un numéro national ; un numéro international (`+212…`, `00212…`) se lit seul.

Chaque ligne est normalisée avec **les mêmes règles que les contacts saisis** (J18) : e-mail ASCII en minuscules, téléphone E.164, langue sur 2 lettres, pays sur 2 lettres. Une valeur renseignée mais invalide **refuse la ligne** (jamais corrigée en silence). Motifs : `no_identifier`, `invalid_email`, `invalid_phone`, `invalid_name`, `invalid_language`, `invalid_country`.

## Aperçu (étape 2)
Réponse `{ preview }` : `rowCount`, `valid`, `newContacts`, `existingContacts`, `duplicatesInFile`, `errors`, `errorsByReason`, `errorRows` (100 premières : ligne + motif), `rows` (20 premières lignes : cellules, statut `new` | `existing` | `duplicate_in_file` | `error`). La comparaison aux contacts existants passe par `import_dedup_check` (lecture seule, 1000 valeurs par appel). Lot déjà confirmé ou annulé : 409.

## Traitement par le worker
Job `import_csv` `{ batch_id }` (aucune donnée de contact dans la charge utile). Le worker (service_role, **entreprise de la ligne du job**) :
1. `import_start` : passe le lot en `running` ou reprend ; un lot terminé, annulé, en échec ou inconnu est ignoré (rejeu sans effet) ;
2. lit le fichier dans le Storage, l'analyse, puis pour chaque ligne appelle `import_row` ;
3. `import_finish` : compteurs et statut `done`.

`import_row` : **même dédup que la capture publique** (contact par e-mail, sinon par téléphone ; sans fusion de données) ; sinon création sous quota « contacts » (quota plein : la ligne passe en erreur `quota_exceeded`, le lot continue) ; contact « **ne plus contacter** » : ligne ignorée (`skipped`, aucun lead) ; lead ouvert du même projet réutilisé, sinon lead « non assigné » source `csv_import` + job `lead.assign` (J22). **AUCUN consentement n'est créé** : un fichier ne prouve rien ; le statut reste « inconnu ». Résultat enregistré **une seule fois** par ligne (rejeu : même résultat, rien de recréé).

Échecs définitifs du lot (`status = failed`, `error_code`) : `file_missing`, `file_malformed`, `too_many_rows`, `subscription_inactive`. Panne technique : job réessayé ; à la dernière tentative le lot passe en `failed` (jamais bloqué en `running`).

## Rapport
`GET /api/imports/report` : CSV `row,outcome,reason,lead_created` (**numéro d'enregistrement** : l'en-tête est l'enregistrement 1, les lignes vides sont ignorées et une cellule sur plusieurs lignes compte pour un seul enregistrement ; `created` | `matched` | `skipped` | `error` ; motif en code). **Aucune donnée de contact** (ni e-mail, ni téléphone, ni nom). Un contact rencontré plus haut dans le même fichier donne `matched` + `duplicate_in_file`.

## Base
- `import_batches` : lot (projet, statut `uploaded` → `queued` → `running` → `done` | `failed` | `cancelled`, compteurs, code d'erreur). Lecture owner et admin, **sans** `file_path` ni `mapping`. 10 lots en cours et 500 au total par entreprise.
- `import_rows` : rapport par ligne ; lecture owner et admin, sans `contact_id`.
- Fonctions (owner et admin) : `create_import_batch`, `import_dedup_check`, `confirm_import`, `cancel_import` ; (service_role) : `import_start`, `import_row`, `import_record_error`, `import_finish`, `import_fail`. Aucune écriture directe, pas même `service_role`.
- Audit : `import.uploaded`, `import.queued`, `import.running`, `import.completed`, `import.failed`, `import.cancelled` (identifiants et compteurs) ; `contact.created` et `lead.created` avec l'acteur « système ».

## Fixture
`tests/fixtures/leads-100.csv` : 100 lignes (65 nouveaux, 15 doublons dans le fichier, 2 contacts déjà connus, 18 erreurs) ; chiffres vérifiés par le domaine, puis en base par l'acceptation (HTTP réel + handler du worker).

## Revue sécurité adverse (0 bloquant, 6 moyens, 6 faibles)
Corrigés : rapport lu par blocs de 1000 (l'API plafonne chaque réponse : plus de troncature silencieuse) ; **projet archivé** : confirmation refusée, `import_start` et `import_row` échouent le lot (`project_archived`) ; corps de 10 Mo lu **après** l'authentification, le contrôle de rôle et la limite de débit ; lot « running » dont le job est mort (`dead_letter`) **annulable** ; fichier retiré du Storage à l'annulation et si l'enregistrement du lot échoue (même sur exception) ; plafond de 500 lots sur **90 jours** (plus de plafond définitif) ; jobs `lead.assign` **étalés** (50 lignes par seconde) pour ne pas retarder les autres entreprises ; confirmation d'un lot non « envoyé » : 409 sans lire le fichier.
Documentés ci-dessous et dans l'ADR 007 : purge du Storage, écart avec l'ADR 014, fichier remplacé entre l'aperçu et la confirmation.

## Limites connues
- **Fichiers jamais purgés** : un fichier reste dans le Storage après `done` ou `failed`, et un lot « envoyé » jamais confirmé garde son fichier et occupe un des 10 emplacements. À planifier avec le worker (purge des objets et expiration des lots `uploaded`), comme `rate_limit_purge`. Un owner ou admin peut aussi écrire directement dans le Storage sous `{entreprise}/{uuid}.csv` sans lot : limité à 10 Mo par objet, à encadrer avec la purge.
- **Écart avec l'ADR 014** (ligne « Contacts / leads : créer (manuel, import CSV) » : marketing et commercial inclus) : l'import est réservé à owner et admin, comme l'écriture des clés de formulaire, des règles et des pipelines ; plus restrictif, donc sûr. À faire valider. Les routes utilisent `projects.create` comme proxy de contrôle (la base reste l'autorité) : une ressource `imports` dédiée dans la matrice est à décider.
- **Fichier remplacé** : un owner ou admin peut supprimer puis renvoyer un fichier au même chemin entre l'aperçu et la confirmation ; le worker lit alors le nouveau fichier (même rôle, aucune élévation). Un hash du fichier à l'envoi réglerait le cas.
- `create_import_batch` ne compare pas `p_size` à la taille réelle de l'objet (le worker revalide tout) ; le plafond de 10 lots en cours n'est pas sérialisé entre deux projets (dépassement léger possible).
- Un job rejoué pendant que le premier worker finit échoue sur la clé primaire de la ligne et consomme une tentative (non démontré en pratique : battement de bail toutes les 20 s).
- `import_rows.contact_id` en `on delete restrict` : une future suppression de contact (effacement) devra purger ou détacher le rapport.
- Pas d'écran (J24) ni de téléchargement du fichier d'origine.
- Fichier lu en mémoire (10 Mo au plus) par le worker et par l'aperçu ; analyse en continu mais pas de lecture du Storage en flux.
- L'aperçu ne détecte pas que deux lignes (e-mail d'un côté, téléphone de l'autre) désignent le même contact déjà connu ; le worker, lui, le signale (`duplicate_in_file`).
- Un lot **jamais confirmé** laisse son fichier dans le Storage : pas de purge au J23 (à planifier avec le worker, comme `rate_limit_purge`).
- Pas de consentement importé : un import ne permet aucun envoi marketing tant que le double opt-in n'est pas décidé.
