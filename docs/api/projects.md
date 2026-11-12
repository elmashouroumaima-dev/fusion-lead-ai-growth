# API — Projets et produits (J16)

Modèle : spec §4 (types de projet), §7 (tables `projects`, `products`), §8 (`POST /api/projects`), ADR 005 (FK composites), ADR 007, ADR 014 (rôles). Migration `20261118100000_projects_products.sql` (retour arrière : `supabase/rollbacks/`).

## Route
### `POST /api/projects`
Crée un projet de l'entreprise **active** (contexte relu en base à chaque requête).

| | |
|---|---|
| Rôles | **owner** et **admin** (`can(role, "create", "projects")`) ; la fonction SQL revérifie le rôle |
| En-tête obligatoire | `Idempotency-Key` (8 à 128 caractères `[A-Za-z0-9_-]`) : rejeu identique → même réponse avec `Idempotent-Replay: true` ; même clé et autre corps → 422 |
| Corps | `type`, `name`, `settings` (selon le type, défaut `{}`), `owner_id` (facultatif, membre **actif** de l'entreprise), `organization_id` (facultatif, doit être celui du contexte sinon 403) |
| Succès | `201 { "project": { id, organization_id, type, name, status, owner_id, settings, created_at, updated_at } }` |
| Limites | corps ≤ 16 Ko ; limitation de débit « mutation » |

Erreurs normalisées `{ code, message, request_id }` :

| Statut | `code` | Cause |
|---|---|---|
| 400 | `validation_failed` | type inconnu, champ inconnu, réglages invalides pour le type, nom invalide, `owner_id` non membre actif, clé d'idempotence absente |
| 401 | `unauthenticated` | pas de session valide (corps valide) |
| 403 | `forbidden` | rôle insuffisant (marketing, commercial, analyste), `organization_id` d'une autre entreprise |
| 409 | `conflict` | projet archivé (lecture seule) |
| 422 | `idempotency_conflict` | même clé, autre corps |
| 429 | `quota_exceeded` | limite de projets du plan atteinte, ou abonnement suspendu / annulé |

## Types de projet et réglages (`settings`)
Quatre types (spec §4) ; le type est **immuable**. Réglages stricts : une clé inconnue est refusée (par zod ET par la base) ; les textes sont rognés et vérifiés (pas de caractère de contrôle, ni caractère invisible ou de direction : U+061C, U+2060 à U+206F, U+00AD, sélecteurs de variation, BOM, balises…, ni espace en bordure). Les URL sont en **https** vers un **nom de domaine** : jamais d'adresse IP, de `localhost`, d'hôte interne (`.local`, `.internal`…), d'identifiants intégrés ni de caractère invisible ; port de 1 à 65535.

| Type | Réglages (tous facultatifs) |
|---|---|
| `website_sales` | `offers[]` (20), `business_models[]` (10), `target_market`, `qualification_questions[]` (20), `landing_pages[]` (20 × `{ name, url }`) |
| `salla_app` | `app_name`, `problem_solved`, `merchant_segments[]` (20), `store_url`, `activation_flow`, `test_pricing`, `faqs[]` (30 × `{ question, answer }`) |
| `salla_theme` | `preview_url`, `sectors[]` (20), `features[]` (30), `ad_scenarios[]` (20) ; les captures d'écran (Storage) viennent au J17 |
| `custom` | `notes` (2 000 caractères), `fields` (20 clés `^[a-z][a-z0-9_]{0,39}$`, valeurs ≤ 500) |

La base contrôle l'objet JSON, sa taille (≤ 32 Ko), sa profondeur (4 niveaux), les clés de premier niveau autorisées pour le type et les liens (`store_url`, `preview_url`, `landing_pages[].url`) : un appel direct de la fonction par l'API de données ne contourne donc plus zod pour cela. Les longueurs et listes fines sont contrôlées par zod (`packages/domain/src/projects`).

## Services (`apps/web/lib/projects/service.ts`)
Résultat `{ ok: true, value } | { ok: false, code }`. L'entreprise vient du **contexte vérifié**, jamais de l'entrée.

| Fonction | Effet | Remarques |
|---|---|---|
| `createProject` | `create_project` | quota « projects » contrôlé sous verrou |
| `updateProject` | `update_project` | lit le type, valide les réglages, nom, propriétaire (`owner_id` explicite : `null` retire le propriétaire) ; projet archivé → `conflict` |
| `setProjectStatus` | `set_project_status` | archive ou **réactive** (la réactivation consomme le quota) |
| `createProduct` / `updateProduct` | `create_product` / `update_product` | projet archivé → `conflict` ; projet d'une autre entreprise → `not_found` |
| `listProjects`, `getProject`, `listProducts`, `getProduct` | lectures RLS | filtre `organization_id` explicite |

Les Server Actions et l'interface arrivent au J17.

## Fonctions SQL (`authenticated` ; identité = `auth.uid()`, jamais `user_metadata`)
`create_project(p_org, p_type, p_name, p_settings, p_owner)` · `update_project(p_org, p_id, p_name, p_settings, p_owner)` (**`p_owner` obligatoire** : plus d'effacement silencieux) · `set_project_status(p_org, p_id, p_status)` · `create_product(p_org, p_project, p_kind, p_offer, p_price_hint, p_landing_url, p_assets)` · `update_product(p_org, p_id, …)`. `SECURITY DEFINER`, `search_path` vide, aucun droit pour `anon` ni `service_role`.

Erreurs : `unauthenticated` 28000 · `forbidden` 42501 · `validation_failed` 22023 · `not_found` **PT404** (HTTP 404 côté API de données ; projet ou produit inexistant **dans l'entreprise indiquée**, réponse identique pour un identifiant inconnu et pour celui d'une autre entreprise) · `project_archived` P0001 · `owner_invalid` P0001 · `quota_exceeded` P0001 · `subscription_inactive` P0001.

## Droits et RLS
- Lecture : tous les rôles actifs de l'entreprise (une politique `select` par table). `anon` : rien.
- **Aucun droit INSERT / UPDATE / DELETE direct**, y compris pour `service_role` : tout passe par les fonctions ci-dessus (le quota ne peut pas être contourné, la réactivation non plus).
- **Pas de suppression** : l'archivage remplace DELETE (matrice ADR 014 ; écart assumé avec la ligne « delete » de l'ADR 007).
- FK composites : `products (organization_id, project_id) → projects (organization_id, id)` ; `projects (organization_id, owner_id) → organization_members (organization_id, user_id)` (`ON DELETE SET NULL (owner_id)`).
- Plafond technique : **100 produits par projet** (provisoire, hors plan ; `quota_exceeded`, `detail = products`), contrôlé sous le verrou du projet.
- Un membre **suspendu ou retiré** perd ses projets (`owner_id` → NULL, audit `project.updated`).
- `products.assets` : chemins `{organization_id}/{project_id}/…` obligatoirement (50 au plus, sans `..` ni `//`) ; `landing_url` : https seulement.

## Quota
Métrique `projects` = projets **actifs** (un projet archivé ne compte pas). Plans provisoires : essai 1, démarrage 3, croissance 10. Contrôle par `private.assert_within_limit` (verrou consultatif de l'entreprise) dans la même transaction que l'insertion ; testé sous 12 créations simultanées pour 5 places (exactement 5 réussissent).

## Audit
`project.created`, `project.updated` (liste des **noms** de champs modifiés), `project.archived`, `project.reactivated`, `product.created`, `product.updated`. Le contenu des réglages, des offres, des URL et des assets n'est jamais journalisé.

## Seed local
Deux projets par entreprise (Alpha : site vitrine, application Salla ; Beta : boutique, thème Salla) et un produit sur le premier : le scénario T1 (isolation) les couvre automatiquement.

## Écran Projets (J17)
Pages (menu latéral « Projets », visible pour tous les rôles de l'entreprise active) :

| Page | Contenu | Rôles |
|---|---|---|
| `/{locale}/projects` | liste (nom, type, statut, date), filtre Actifs / Archivés | lecture : tous ; bouton « Nouveau projet » : owner et admin |
| `/{locale}/projects/new` | choix du type puis réglages du type | owner et admin (les autres sont renvoyés vers la liste) |
| `/{locale}/projects/{id}` | réglages (modifiables si projet actif), produits (ajout et modification en fenêtre), archivage / réactivation | lecture : tous ; écriture : owner et admin |

Un projet d'une autre entreprise, un identifiant inconnu ou illisible donnent la même page « introuvable » (404).

### Server Actions (`apps/web/lib/projects/actions.ts`)
Pipeline commun `withAction` (zod, contexte tenant relu en base, comparaison de l'`organization_id` posté, `can()` ADR 014, limitation de débit « mutation », idempotence) puis services J16.

| Action | Champs | Droit | Idempotence |
|---|---|---|---|
| `createProjectAction` | `type`, `name`, `settings` (JSON), `organization_id`, `uiLocale` | `create` projets | obligatoire (`idempotency_key`, champ caché généré au rendu) |
| `updateProjectAction` | `project_id`, `name`, `settings`, `organization_id` | `update` | facultative |
| `setProjectStatusAction` | `project_id`, `status`, `organization_id` | `archive` | facultative |
| `createProductAction` | `project_id`, `kind`, `offer`, `price_hint`, `landing_url`, `assets`, `organization_id` | `create` | obligatoire |
| `updateProductAction` | `product_id`, mêmes champs | `update` | facultative |

Réponse : `{ status, code?, fieldErrors?, success? }`, jamais de texte : `code` ∈ `invalid_input`, `forbidden`, `quota_exceeded`, `conflict` (projet archivé), `not_found`, `rate_limited`, `duplicate_request`, `idempotency_in_progress`, `idempotency_conflict`, `service_unavailable`, `generic` ; l'interface les traduit (fr / ar / en).

Sécurité des entrées (revue J17) : un champ JSON de plus de 6 niveaux d'imbrication ou portant une clé `__proto__` est **refusé** (`invalid_input`) avant tout décodage récursif ; corps des Server Actions plafonné à 512 Ko (`serverActions.bodySizeLimit`, avant le pipeline : l'erreur de Next n'est alors pas normalisée) ; liens : `isSafeHttpsUrl` n'empêche **pas** un nom de domaine de résoudre vers une adresse interne (DNS rebinding, `*.nip.io`) : tout futur chargement serveur d'un lien (`landing_url`, `store_url`, `preview_url`) devra résoudre le nom, refuser les adresses privées et les redirections.

Règles : le créateur est propriétaire du projet (aucun sélecteur tant que la liste des membres n'affiche pas d'identité lisible) ; à la modification le propriétaire est conservé ; les réglages voyagent en JSON dans un champ caché, **toujours revalidés** par zod puis par la base (un JSON illisible est refusé, jamais remplacé par un objet vide) ; les listes se saisissent « une ligne par élément » ; les fichiers (`assets`) ne passent **plus** par les formulaires de création et de modification : toute liste venue du client est ignorée, `update_product` n'écrit plus cette colonne.

## Fichiers des produits (J17, partie 2 — Storage)
Migration `20261119100000_storage_assets.sql` (retour arrière : `supabase/rollbacks/`). ADR 005 §12, ADR 007 G-D11.

**Bucket** `assets` : privé, 10 Mo au plus, types `image/png`, `image/jpeg`, `image/webp`, `application/pdf` (le CSV viendra avec l'import des leads, J23). Aucune URL publique.

**Chemin obligatoire** `{organization_id}/{project_id}/{asset_id}/{fichier}` : UUID en minuscules, nom `[A-Za-z0-9._-]` (120 caractères au plus). Le projet doit exister **dans cette entreprise**.

| Opération | Qui | Condition |
|---|---|---|
| Lire, lister, signer | membres actifs de l'entreprise du chemin (tous les rôles) | projet existant dans l'entreprise (actif ou archivé) |
| Envoyer, supprimer | owner et admin | projet **actif** |
| Mettre à jour (écraser, renommer) | personne | aucune politique |
| `anon` | personne | — |

**Interface** : fenêtre « Modifier » d'un produit → bloc « Fichiers du produit » (liste avec aperçu des images, téléchargement des PDF, envoi, retrait). Lecture des fichiers pour tous les rôles dans la liste des produits.

**Server Actions** (pipeline `withAction`, rôle `update` projets, limitation de débit « mutation ») :

| Action | Champs | Effet |
|---|---|---|
| `uploadProductAssetAction` | `product_id`, `organization_id`, `file` | contrôle, envoi avec les droits de l'utilisateur, association ATOMIQUE au produit (`append_product_asset`) |
| `removeProductAssetAction` | `product_id`, `path`, `organization_id` | retire le chemin du produit (`remove_product_asset`, base d'abord), puis supprime l'objet **seulement si aucun autre produit ne le référence** ; seul un chemin **déjà associé au produit** est accepté |

Contrôles de l'envoi (`apps/web/lib/projects/assets.ts`) : type **réel par les octets** (PNG, JPEG, WebP, `%PDF-` ; SVG, HTML, GIF, exécutables, archives refusés — le type annoncé et l'extension du nom sont ignorés) ; **5 Mo au plus** pour tous les types au J17 (la spec autorise 10 Mo pour un PDF : à relever avec un envoi par route dédiée, la limite des corps de Server Actions est de 6 Mo) ; 50 fichiers par produit ; nom d'objet **généré par le serveur** (`uuid` + nom nettoyé : minuscules ASCII, accents retirés, extension du type réel, « fichier » si le nom n'a aucun caractère exploitable) ; produit relu par RLS (autre entreprise → `not_found`), projet archivé → `conflict` ; si l'association échoue, l'objet envoyé est supprimé.

Codes d'erreur ajoutés : `file_missing`, `file_empty`, `file_too_large`, `file_type`, `too_many_files` (plus ceux du pipeline).

**Lecture** : liens signés de **60 secondes** générés à chaque affichage (images : affichage ; PDF : téléchargement forcé) ; jamais d'URL publique ; un lien signé est un secret porteur (il ouvre le fichier sans session pendant sa durée de vie).

**Fonctions atomiques** (revue J17) : `append_product_asset(p_org, p_product, p_path)` et `remove_product_asset(p_org, p_product, p_path)` (`SECURITY DEFINER`, owner / admin, projet actif) travaillent sous verrou de la ligne du produit : plus de perte de mise à jour sous envois simultanés. L'ajout exige que l'objet existe, appartienne au dossier du projet et ne soit pas déjà rattaché à un AUTRE produit ; 50 fichiers au plus (`too_many_files`) ; chemin déjà présent : sans effet. Le retrait renvoie le nombre de produits qui référencent encore l'objet.

**Risques acceptés (revue J17)** : lien signé de 60 s = secret porteur (durée courte, jamais journalisé) ; jeton d'envoi signé de Storage (valable 2 h) : l'objet reste sous le dossier de l'entreprise, au pire un orphelin purgé ; pas de plafond d'octets par entreprise (surveillance du volume, purge du worker) ; PDF servis en téléchargement forcé (`download`), images servies avec leur type réel contrôlé par les octets.

**Limites connues** : un owner ou admin peut envoyer directement à l'API Storage (sans passer par l'application) ; seules la taille (10 Mo) et la liste de types du bucket s'appliquent alors (le contrôle des octets n'a pas lieu) ; des objets peuvent rester non rattachés à un produit (purge à prévoir, tâche du worker).

