# Changelog

Format : Keep a Changelog. Une entrée par jour de travail.

## [Non publié]
### Décision C2 — écrans CRM avant G3
- Modification : `docs/plan/development-plan.md` (addendum C2) : 5 jours d'écrans insérés (J30b contacts et consentement, J30c et J30d fiche lead, J39b configuration, J39c import) ; le plan passe de 63 à 68 jours ouvrés (408 h) ; G3 lun 18 jan 2027, fin du pilote mar 16 fév 2027 ; dates et cibles de tous les jours et des fiches `docs/backlog/` recalculées sur 68 jours ; fiches J30b, J30c, J30d, J39b, J39c ajoutées ; matrice de traçabilité §13-4 complétée.
- Modification : `docs/checkpoints/C2.md` et `C2-decisions.md` (décision A enregistrée ; la boîte de réception est J37, pas J38) ; rapport d'avancement : 2 modules « écrans CRM » (5 jours).
### J27 — Checkpoint C2 / Gate G2
- Ajout : scénario **G2** (`tests/acceptance/src/g2-lead-to-deal.test.ts`, 9 tests) : formulaire public -> lead -> vrai handler `lead.assign` -> deal créé et déplacé par `/api/deals/move` jusqu'à « gagné » -> historique d'activités lu par chaque rôle (jamais par l'analyste ni l'autre entreprise) -> audit sans valeur ni adresse -> rejeu sans effet ; même parcours chez Beta sans fuite.
- Ajout : `docs/checkpoints/C2.md` (audit de conformité Phase 2 par un relecteur indépendant : 0 bloquant, 3 majeurs, 9 mineurs ; recommandation GO avec réserves, décision à la responsable technique).
- Modification : helper `assign-worker.ts` partagé par `t2-sales` et G2. Aucune migration, aucun code applicatif modifié. Tests : acceptation 134 -> 143.
### J26 — Tests ventes
- Ajout : scénario **T2** automatisé (`tests/acceptance/src/t2-sales.test.ts`) : `leads-100.csv` par HTTP puis par le vrai handler `import_csv` (65 contacts créés, 17 rattachés, 18 lignes refusées, 67 leads), un job `lead.assign` par lead traité par le VRAI handler du worker (rotation round-robin dans l'ordre de la règle, répartition 22 / 22 / 23, rejeu sans seconde assignation), chiffres affichés sur `/leads` par rôle, rapport CSV sans donnée de contact, rejeu du fichier sans aucun doublon, puis le même fichier chez l'autre entreprise (jeux de contacts séparés, aucune adresse partagée, assignation limitée à ses membres) et un test de contexte forgé (propriétaire de Beta désignant Alpha).
- Ajout : matrice des rôles du CRM (`crm-roles-matrix.test.ts`) : 13 routes d'API (export, deals, intégrations, mapping, synchro, import complet) et 3 pages x 5 rôles + anonyme ; rôle non autorisé = 403 exact, rôle autorisé = statut exact de la route, anonyme = 401 ; capture publique : une session ne donne aucun droit.
- Ajout : seuil de couverture de 80 % (`test:coverage`) pour `packages/domain` et `packages/permissions` ; devDependency `@vitest/coverage-v8` 5.1.0 dans `packages/domain`.
- Modification : passerelle et exécution du job d'import des tests d'acceptation extraites dans `import-worker.ts` (partagées par `import-flow` et `t2-sales`).
- Aucune migration, aucun code applicatif modifié. Tests : acceptation 106 -> 134.
### J25 — Adaptateur CRM
- Ajout : interface `CrmAdapter` (`connect`, `validate`, `send`, `receive`, `refresh`, `disconnect`) et adaptateurs `internal` (source de vérité) et `csv` (lecture et écriture selon le mapping, dates ISO strictes, anti-formule) dans `packages/adapters/src/crm`.
- Ajout : tables `integrations` (minimale) et `crm_field_mappings` (champ interne, champ externe, `source_of_truth`, `direction`, liste blanche de champs), fonctions `create_integration`, `save_crm_mappings`, `request_crm_sync`, `retry_crm_sync`, `crm_sync_status` (owner et admin) et `crm_sync_*` (service_role) ; migration `20261127100000` et retour arrière ; statut `synced` des lots de fichier.
- Ajout : moteur de synchro pur (`packages/domain/src/crm-sync`) : conflit seulement si les deux côtés ont changé, `source_of_truth` par champ, perdant consigné dans l'audit sans valeur ; job worker `crm_sync` (contacts : créer, rattacher, mettre à jour ; idempotent par identifiant externe ; identité jamais écrasée ; « ne plus contacter » intact ; aucun consentement).
- Ajout : routes `/api/crm/integrations`, `/api/crm/mappings`, `/api/crm/sync`, `/api/crm/sync/retry` et écran `/crm` (statut, mapping, « Réessayer ») en français, arabe (RTL) et anglais.
- Sécurité (revue adverse) : curseur de fin (pas de faux conflit), lot de fichier consommé, colonne d'identifiant absente = échec, cellule vide non destructrice, identifiant externe propre à l'intégration, abonnement vérifié.
- Tests : domaine (22), adaptateurs (11), worker (21), service web (9), messages (4), pgTAP (107), API réelle (5), acceptation (7).
- Documentation : `docs/api/crm-sync.md`, `docs/integrations/crm.md`, addendum ADR 007.

### J24 — UI CRM
- Ajout : page `/leads` (filtres projet, étape, source, responsable, « non assignés » ; recherche nom, e-mail, téléphone ; tri ; pagination serveur) et page `/deals` (tableau par étape, glisser-déposer et menu « Déplacer vers… ») en français, arabe (RTL) et anglais ; liens « Leads » et « Deals » dans la barre latérale (rôles qui lisent les leads).
- Ajout : `GET /api/leads/export` (owner et admin, mêmes filtres que la liste, 10 000 lignes au plus, **audité** avant l'envoi, protégé contre l'injection de formule, jamais tronqué en silence) et `POST /api/deals/move` (Idempotency-Key obligatoire).
- Ajout : migration `20261126100000` (extension `pg_trgm`, index de recherche, `search_leads` SECURITY INVOKER, `log_export`) et retour arrière ; `packages/domain/src/crm` ; `apps/web/lib/crm` ; `withRoute` : contexte `request` et réponse texte.
- Sécurité (revue adverse) : GET d'export inter-sites refusé, export tronqué refusé, paramètre de filtre invalide refusé, formule précédée d'espaces neutralisée, total conservé hors page, `Referrer-Policy: no-referrer` sur `/leads`.
- Tests : domaine (15), service web (7), messages et CSS logique (14), pgTAP (63), API réelle (6), acceptation HTTP (16).
- Documentation : `docs/api/crm.md`, addendum ADR 007.

### J23 — Import CSV de leads
- Ajout : tables `import_batches` et `import_rows`, bucket privé `imports` (10 Mo, owner et admin), fonctions `create_import_batch`, `import_dedup_check`, `confirm_import`, `cancel_import` (owner et admin) et `import_start`, `import_row`, `import_record_error`, `import_finish`, `import_fail` (service_role) ; migration `20261125100000` et retour arrière.
- Ajout : routes `POST /api/imports` (fichier brut), `/preview`, `/confirm`, `/cancel`, `GET /api/imports` et `/report` (CSV sans donnée de contact) ; assistant en 3 étapes, **rien n'est écrit avant la confirmation**.
- Ajout : handler worker `import_csv` (même dédup que la capture publique, lead « non assigné » + job `lead.assign` étalé, contact « ne plus contacter » ignoré, aucun consentement créé, rejeu sans doublon) ; `packages/domain/src/imports` (parseur CSV en continu sans dépendance, mapping, normalisation) ; `apps/web/lib/imports` ; fixture `tests/fixtures/leads-100.csv`.
- Ajout : `withRoute` accepte un corps brut (`readBody`, `request` dans le contexte) et une réponse texte.
- Sécurité (revue adverse) : rapport lu par blocs de 1000, projet archivé refusé, corps de 10 Mo lu après l'authentification, lot « running » dont le job est mort annulable, fichier retiré à l'annulation, plafond de lots sur 90 jours, jobs d'assignation étalés.
- Tests : domaine (21), service web (17), worker (12), pgTAP (117), API réelle (10), acceptation (12 : 100 lignes, 65 créés, 17 rattachés, 18 refusés).
- Documentation : `docs/api/imports.md`, addendum ADR 007.

### J22 — Assignation automatique
- Ajout : `assignment_rules` (round-robin ou membre fixe, règle par projet ou par défaut, 1 à 50 membres, curseur) et `notifications` (alerte in-app par destinataire, dédupliquée) ; fonctions `create_assignment_rule`, `update_assignment_rule`, `delete_assignment_rule`, `mark_notification_read` ; migration `20261124100000` et retour arrière.
- Ajout : `auto_assign_lead` et `flag_lead_unassigned` (service_role) : lead verrouillé, membre éligible encore actif choisi à partir du curseur, rejeu sans double assignation ; sans règle ou sans membre, le lead reste « non assigné » et les owner / admin sont alertés.
- Ajout : handler worker `lead.assign` (remplace le handler provisoire du J21) : entreprise de la ligne du job, alerte à la dernière tentative ; `packages/domain/src/assignment`, `apps/web/lib/assignment` (règles, file « non assignés », notifications). Pas d'écran (J24).
- Sécurité (revue adverse) : évincement des notifications lues au plafond, plafond de règles sérialisé, réactivation refusée si abonnement suspendu, tableau 2D ou NULL refusé, curseur conservé.
- Tests : domaine (6), service web (12), worker (5), pgTAP (86), API réelle (8), acceptation (3).
- Documentation : `docs/api/assignment.md`, addendum ADR 007.

### J21 — Capture publique de leads
- Ajout : `form_keys` (clé générée par la base, empreinte SHA-256 seule conservée, origines https exactes, 5 clés actives par projet, lecture owner / admin sans l'empreinte), fonctions `create_form_key`, `set_form_key_active`, `set_form_key_origins` ; migration `20261123100000` et retour arrière.
- Ajout : `capture_lead` (service_role) : clé -> entreprise et projet, origine, contact dédoublonné, lead ouvert réutilisé, consentement (texte, version, page, IP), job `lead.assign`, en une transaction ; `form_origin_allowed` et `form_key_origin_ok` (sans écriture).
- Ajout : route publique `POST /api/leads` (+ préflight CORS) : clé en en-tête `X-Form-Key`, origine de la clé, limitation de débit par adresse et par clé, corps de 16 Kio, JSON strict, champ piège, réponse identique pour un nouveau contact et un doublon, journaux sans donnée personnelle.
- Ajout : `packages/domain/src/capture`, `apps/web/lib/forms` (gestion des clés), `apps/web/lib/service/capture-lead.ts`, `deriveServerSecret` (secret dérivé), `TRUSTED_PROXY_HOPS`, handler `lead.assign` provisoire dans le worker (traitement au J22).
- Sécurité (revue adverse) : pas de re-consentement par la voie publique après une révocation, contact « ne plus contacter » ignoré, finalités limitées à marketing / newsletter ; adresse du visiteur lue à droite de `x-forwarded-for` (port retiré, IPv6 en /64) ; seau par clé ouvert seulement pour une clé existante ; préflight limité par adresse.
- Tests : domaine (14), service web (30), route (18), pgTAP (137), API réelle (14), acceptation HTTP (11, dont « deux soumissions identiques = un contact »).
- Documentation : `docs/api/capture.md`, addendum ADR 007 et ADR 010.

### J20 — Activités et chronologie
- Ajout : table `activities` (enum `activity_type`), contenu par type validé par la base, FK composites, RLS comme les leads (owner / admin / marketing : tout ; commercial : ses leads ; analyste : aucun accès), écriture uniquement par fonctions ; migration `20261122100000` et retour arrière.
- Ajout : fonctions `create_activity` (note, appel, e-mail en compte rendu, rendez-vous, tâche), `update_task`, `complete_task` ; historique immuable (aucune suppression, seules les tâches évoluent).
- Ajout : journal automatique par déclencheurs : `stage_change` et `assignment` des leads (libérations automatiques comprises) et `stage_change` des deals.
- Ajout : `packages/domain/src/activities` (schémas, `nextAction`, `dueTasks`) et `apps/web/lib/activities` (service, chronologie, tâches dues, prochaine action). Pas d'écran (J24).
- Sécurité (revue adverse) : plafonds séparés (500 activités manuelles, 1000 entrées automatiques par lead) ; contenu validé avant insertion ; tâche confiée à un commercial seulement sur un lead dont il est responsable ; échéance obligatoire à la modification d'une tâche.
- Tests : domaine (12), service web (17), pgTAP (107), API réelle (14).
- Documentation : `docs/api/activities.md`, addendum ADR 007.

### J19 — Pipelines, leads et deals
- Ajout : tables `pipelines`, `pipeline_stages`, `leads`, `deals` (enum `stage_kind`), étapes par défaut dans la langue de l'entreprise (nouvelles et existantes), FK composites, RLS (owner / admin / marketing : tous les leads ; commercial : les siens ; analyste : aucun accès), écriture uniquement par fonctions ; migration `20261121100000` et retour arrière.
- Ajout : fonctions `create_pipeline`, `rename_pipeline`, `set_default_pipeline`, `create_stage`, `update_stage`, `delete_stage`, `create_lead`, `update_lead`, `assign_lead`, `move_lead_stage`, `create_deal`, `update_deal`, `move_deal_stage` ; un lead « non assigné » n'a pas de responsable ; dates gagné / perdu cohérentes avec l'étape ; libération des leads d'un membre suspendu, retiré ou rétrogradé.
- Ajout : `packages/domain/src/leads` (schémas, règles d'étapes) et `apps/web/lib/leads` (service, lectures, erreurs). Pas d'écran (J24).
- Modifié : le commercial lit les contacts et consentements de ses leads et peut révoquer / poser « ne plus contacter » sur eux (promesse du J18).
- Sécurité (revue adverse) : le marketing ne choisit pas le responsable à la création ; NaN et dates infinies refusés ; un lead ne change pas de pipeline ; libération à la suppression de la ligne du membre et à la rétrogradation ; abonnement actif exigé ; plafonds de 50 leads par contact et de 50 deals par lead ; audit sans réglage de session.
- Tests : domaine (16), service web (22), pgTAP (182), API réelle (13, dont 12 déplacements simultanés d'un deal).
- Documentation : `docs/api/leads.md`, addendum ADR 007.

### J18 — Contacts et consentement
- Ajout : tables `contacts` et `consent_events` (enums `channel_type`, `consent_status`), index uniques partiels (e-mail, téléphone, identifiant externe), RLS en lecture (owner, admin, marketing), historique de consentement append-only ; migration `20261120100000` et retour arrière.
- Ajout : fonctions `create_contact`, `update_contact`, `record_consent`, `revoke_consent`, `set_do_not_contact` (écriture uniquement par fonctions, quota « contacts » du plan, audit sans donnée personnelle).
- Ajout : `packages/domain/src/contacts` (normalisation e-mail et E.164 par `libphonenumber-js`, règle de déduplication, schémas zod) et `apps/web/lib/contacts` (service, lectures, erreurs). Nouvelle dépendance : `libphonenumber-js`.
- Modifié : `current_stock_usage` compte les contacts (quota « contacts »).
- Sécurité (revue adverse) : l'identité d'un contact « ne plus contacter » ne change plus que par owner / admin ; consentements révoqués quand l'adresse change ; canal cohérent avec l'identifiant ; 50 consentements au plus par contact ; e-mail saisi en ASCII ; attributs sans caractères de contrôle ni de direction.
- Tests : domaine (49), service web (23), pgTAP (111), API réelle (16, dont 12 créations simultanées pour 1 place).
- Documentation : `docs/api/contacts.md`, addendum ADR 007.

### J17 partie 2 — Storage : fichiers des produits
- Ajout : bucket privé `assets` et politiques Storage par entreprise (lecture : membres ; écriture et suppression : owner et admin sur un projet actif ; aucune mise à jour ; rien pour `anon`), chemin `{entreprise}/{projet}/{fichier}/{nom}` imposé ; migration `20261119100000` et retour arrière.
- Ajout : envoi de fichiers (PNG, JPEG, WebP, PDF, 5 Mo) depuis la fenêtre d'un produit : type RÉEL par les octets, nom d'objet généré par le serveur, envoi avec les droits de l'utilisateur, retrait ; aperçu des images et téléchargement des PDF par liens signés de 60 s ; `packages/domain/src/projects/assets.ts` ; messages fr / ar / en.
- Modifié : limite des corps de Server Actions de 512 Ko à 6 Mo (`next.config.ts`).
- Corrigé (revue sécurité) : ajout et retrait de fichiers ATOMIQUES (`append_product_asset`, `remove_product_asset`, verrou du produit) ; `update_product` n'écrit plus `assets` et toute liste venue du client est ignorée ; un objet partagé par un autre produit n'est jamais supprimé ; rattachement d'un fichier déjà utilisé par un autre produit refusé.
- Tests : pgTAP (45), API Storage réelle (17), unitaires (domaine et service).

### J17 — Écran Projets (partie 1 : sans Storage)
- Ajout : menu « Projets », pages liste (filtre Actifs / Archivés), création (formulaire dynamique selon le type : site web, application Salla, thème Salla, autre) et détail (réglages, produits en fenêtre, archivage et réactivation avec confirmation) ; lecture pour tous les rôles, écriture owner et admin.
- Ajout : Server Actions `createProjectAction`, `updateProjectAction`, `setProjectStatusAction`, `createProductAction`, `updateProductAction` (pipeline commun, idempotence, rôles) ; composant `Textarea` ; messages fr / ar / en ; `settings-form` (saisie « une ligne par élément », nettoyage avant envoi).
- Modifié : `updateProject` conserve le propriétaire quand il n'est pas précisé.
- Sécurité (revue adverse) : clé `__proto__` et JSON de plus de 6 niveaux refusés dans les champs de formulaire ; corps des Server Actions plafonné à 512 Ko ; les scénarios d'acceptation nettoient les clés d'idempotence et seaux de débit pour ne pas faire échouer `pnpm test:db`.
- Tests : composants et schémas d'action (web), 11 scénarios HTTP d'acceptation (rôles, isolation Alpha / Beta, 404 identique).
- À venir (partie 2) : Storage et envoi de fichiers.

### J16 — Projets et produits
- Ajout : tables `projects` (4 types : site web, application Salla, thème Salla, autre) et `products`, FK composites, RLS en lecture seule, écriture par fonctions `create_project`, `update_project`, `set_project_status`, `create_product`, `update_product` (owner et admin) ; quota « projects » (projets actifs) sous verrou, réactivation comprise ; audit `project.*` et `product.*` ; migration `20261118100000` et retour arrière.
- Ajout : `packages/domain/src/projects` (réglages stricts par type, textes sûrs, URL https, chemins d'assets), `apps/web/lib/projects` (services, lectures, erreurs) et `POST /api/projects` (Idempotency-Key obligatoire) ; nouveau code d'erreur `conflict` (409, projet archivé).
- Ajout : seed (2 projets par entreprise et un produit) couvert automatiquement par le scénario T1 ; tests pgTAP (105), RLS via l'API (21, dont 12 créations simultanées pour 5 places) et acceptation HTTP (10).
- Sécurité (revue adverse) : caractères invisibles et de direction refusés, liens https vers un nom de domaine seulement, réglages contrôlés par la base (clés par type, profondeur), plafond de 100 produits par projet, propriétaire explicite à la modification, `not_found` en 404, propriétaire suspendu ou retiré remis à NULL.
- Ajout : `docs/api/projects.md`, addendum ADR 007.

### Menu Paramétrage : libellés
- Modifié : dans le menu latéral, « Palette de couleurs » devient « Thème » et « Logotype » devient « Profil » (en : Theme, Profile ; ar : المظهر، الملف التعريفي), avec l'icône profil ; les pages et leurs adresses ne changent pas.

### Logo officiel sur les pages publiques
- Modifié : connexion, inscription, mot de passe oublié, invitation et accueil affichent le logo officiel « FUSION LEAP » (blanc, `public/brand/logo-white.png`, composant `OfficialLogo`). Il est **fixe** : il ne change pas avec le logo personnalisé du Paramétrage, réservé à l'application connectée.

### Gabarits d'e-mail : logo et « Tous droits réservés »
- Ajout : gabarit HTML des e-mails de la plateforme (`packages/adapters/src/email`) : grand en-tête avec logo, titre, bouton, signature en gras, barre de pied « © Fusion Leap AI Growth. Tous droits réservés. » ; compatible Gmail, Outlook et Mailtrap (tableaux, styles en ligne). **Une seule langue par message** (fr, ar en RTL ou en).
- Modifié : les e-mails Supabase Auth (confirmation, réinitialisation) et leurs objets sont générés depuis cette source (`pnpm email:templates`, test de concordance) et suivent `user_metadata.locale` (enregistrée à l'inscription et à la connexion, français par défaut) ; le message de test SMTP devient un e-mail HTML de la marque dans la langue de l'interface de l'administrateur (logo joint en `cid:`, version texte, date et année).
- Ajout : logo officiel « FUSION LEAP » (blanc, fond transparent) `apps/web/public/brand/email-logo.png` en tête des e-mails.

### Notifications : en haut, vertes (succès) et rouges (erreur)
- Modifié : les notifications s'affichent en haut au centre, avec bouton de fermeture, coins arrondis et ombre ; succès en vert (nouveau jeton `--success`), erreur en rouge (`--destructive`), contraste AA du texte blanc en clair et en sombre ; les erreurs restent 6 s.
- Ajout : toute erreur d'action (abonnement, invitation, membres, logo, palette, SMTP) est aussi une notification rouge ; le message reste écrit dans la page. Le test d'accessibilité « un seul canal pour les erreurs » est remplacé par « notification rouge ET message dans la page ».

### Pied de page sur toutes les pages
- Ajout : composant `AppFooter` (© année, nom de l'application, droits réservés ; fr / ar / en, sans lien) affiché par la coquille de l'application (pages normales et réduites) et par le cadre public (accueil, connexion, inscription, mot de passe oublié, invitation).

### J15 — Checkpoint C1 / gate G1 : isolation de deux entreprises
- Ajout : paquet `tests/acceptance` (`pnpm test:e2e`, 35 tests sur la pile locale réelle) : T1 (RLS / API sur toutes les tables tenant découvertes dans le catalogue, écritures vers l'autre entreprise, file de jobs, pages de l'application par HTTP) et T5 (changement d'entreprise, indice falsifié, rôle rétrogradé / adhésion retirée / entreprise suspendue en cours de session).
- Ajout : `docs/checkpoints/C1.md` (audit de conformité de la Phase 1, écarts, recommandation de GO avec réserves).
- Modifié : `pnpm test:e2e` n'est plus un espace réservé ; le paquet est ajouté à l'espace de travail pnpm.

### Paramètres SMTP de la plateforme (ADR 004 mise en œuvre, ADR 008 note)
- Ajout : carte « Paramètres SMTP » du Paramétrage (administrateurs de la plateforme) : serveur, port, sécurité, utilisateur, mot de passe en écriture seule, expéditeur, préréglage Mailtrap, test d'envoi à l'adresse de l'administrateur, suppression.
- Ajout : chiffrement applicatif AES-256-GCM (`packages/adapters/src/secrets`, clé maître `SECRETS_MASTER_KEY`), table `private.secrets` sans droit d'API, fonctions `set/reset/get_smtp_settings` et `get_smtp_delivery` (service_role) ; migration `20261117100000` et retour arrière.
- Ajout : garde-fous SSRF du test d'envoi (hôtes internes, résolution DNS contrôlée) ; dépendance `nodemailer`.
- Ajout : runbook `docs/runbooks/smtp-settings.md`.
- Modifié : « Paramétrage » devient une liste déroulante du menu latéral avec une page par section (Palette de couleurs, Logotype, Serveur SMTP) ; `/settings` redirige vers la première.

### J14 — Plans, quotas et administrateurs de la plateforme
- Ajout : `private.platform_admins` (SQL seulement), plans `trial` / `starter` / `growth` (limites provisoires, forme contrôlée), contrôle atomique des quotas (`assert_within_limit`, `consume_quota`, `get_org_usage`), limite `users` appliquée aux invitations (`quota_exceeded`, 429), administration des abonnements (`admin_list_organizations`, `admin_set_subscription`, audit `subscription.changed`) ; migration `20261116100000` et retour arrière.
- Ajout : `packages/domain/src/plans` (métriques, `assertWithinLimit`, schémas), carte « Utilisation du plan » (alerte à 80 %) sur le tableau de bord, écran `/admin/organizations` et lien « Administration » (administrateurs de la plateforme), messages fr/ar/en.
- Ajout : runbook `docs/runbooks/plans-quotas.md`.

### J13 — Jobs et worker
- Ajout : table `jobs` (RLS owner/admin, aucune écriture directe), enum `job_status`, fonctions `enqueue_job`, `claim_jobs` (`SKIP LOCKED`, bail), `heartbeat_job`, `complete_job`, `fail_job` (backoff exponentiel + jitter, `dead_letter`), `cancel_job`, `replay_dead_letter`, reprise des baux expirés ; migration `20261115100000` et retour arrière ; audit `job.dead_lettered` / `job.replayed` / `job.cancelled`.
- Ajout : worker (`apps/worker`) : `Runner` (concurrence, heartbeat, arrêt propre SIGTERM), registre de handlers typés, handler `noop`, journal JSON sans charge utile ; dépendances `@supabase/supabase-js` et `zod`.
- Ajout : runbook `docs/runbooks/jobs-worker.md` ; ADR 003 (mise en œuvre).

### Paramétrage — palette de couleurs globale de la plateforme (ADR 016, proposé)
- Ajout : table `platform_config` (palette globale, données non tenant), migration `20261114100000` et retour arrière ; écriture par `set_platform_config` / `reset_platform_config` réservée aux owner / admin d'organisation, lecture serveur par `get_platform_config` (service_role).
- Ajout : page `/settings/appearance` (owner / admin) : palettes prêtes à l'emploi, sélecteur de couleurs clair/sombre, aperçu, contrôle de contraste WCAG AA, réinitialisation.
- Ajout : logo paramétrable (clé `appearance.logo`, migration `20261114110000`) : PNG / JPEG / WebP ≤ 128 Ko validés par signature (SVG refusé), route `GET /api/brand/logo`, composant `Brand` alimenté par le layout de locale, carte « Logo » du Paramétrage.
- Ajout : `packages/domain/src/theme` (zod, contraste, CSS) ; palette appliquée par le layout de locale à toutes les pages, connexion comprise.


### J12 — Audit et logs
- Ajout : table `audit_logs` append-only (écrite par déclencheurs sur organisations, membres et invitations ; `UPDATE` / `DELETE` / `TRUNCATE` refusés pour tous les rôles), fonctions `audit_redact` et `mask_email`, runbook `audit-logs`.
- Ajout : logger JSON maison (caviardage par clés et par valeurs, contexte de requête, `x-request-id` transmis à Supabase).
- Modifié : les journaux de la couche service passent par le logger ; `console.*` retirés du code applicatif métier.
### Interface (Tailwind v4 + shadcn/ui)
- Ajout : design system inspiré du tableau de bord ONMD (jetons clair/sombre, Poppins et Cairo en WOFF2, composants shadcn/ui, `next-themes`, `sonner`).
- Modifié : coquille d'application (barre latérale repliable, en-tête, sélecteur d'organisation, langue, thème, profil) et habillage de toutes les pages (connexion, inscription, réinitialisation, onboarding, sélecteur, tableau de bord, membres, invitation).
- Sécurité : en-têtes `X-Frame-Options`, `frame-ancestors 'none'`, `nosniff` sur toutes les routes.
- Supprimé : CSS maison et modules CSS devenus inutiles.
### J11 — Couche service
- Ajout : `withRoute` / `withAction` (pipeline fixe, erreurs `{ code, message, request_id }`), `Idempotency-Key` (tables, fonctions, rejeu 24 h, quota), limitation de débit par seaux de jetons (429 / 503), module `service_role` confiné.
- Ajout : migration `20261112100000_service_layer.sql`, fonctions de purge, runbook `purge-service-tables`.
- Modifié : `/api/orgs` et les actions membres/organisations passent par la couche service ; `lib/api/` supprimé.
- Sécurité : règles ESLint renforcées (`noInlineConfig` pour `apps/web`, imports non littéraux interdits).
### Français et locale par défaut
- Ajout : locale `fr` (par défaut), messages `fr.json`, sélecteur de langue à trois choix, e-mails d'authentification en trois langues.
- Ajout : migration `20261111100000_locale_fr.sql` (`organizations.locale` accepte `fr`, défaut `fr` ; retour arrière avec perte documenté).
- Modifié : `LOCALES` / `DEFAULT_LOCALE` centralisés dans `packages/domain`.
### J10 — Membres, invitations et RBAC
- Ajout : `packages/permissions` (matrice ADR 014 complète, `can`, `canManageMember`, `assignableRoles`).
- Ajout : table `invitations` et fonctions `create_invitation`, `revoke_invitation`, `accept_invitation`, `transfer_ownership` (jeton haché, expiration 7 jours, erreur générique unique).
- Ajout : page Membres et page d'acceptation d'invitation (AR/EN, `Referrer-Policy: no-referrer`).
- Sécurité : re-vérification de l'inviteur à l'acceptation, ordre de verrous stable pour le transfert de propriété, e-mails ASCII uniquement.
### J9 — Organisations et contexte actif
- Ajout : `public.create_organization()` (enveloppe invoker) et `private.create_organization()` (security definer) : organisation + propriétaire + abonnement trial en une transaction, idempotente.
- Ajout : `POST /api/orgs`, `getTenantContext()`, cookie `fl_active_org`, pages onboarding et sélecteur d'organisation (AR/EN).
- Modifié : `organizations` gagne `created_by` et `creation_key`.
- Sécurité : validation commune SQL/zod des noms (caractères invisibles/bidi refusés) et des fuseaux horaires.
### J8 — Auth SSR bilingue (AR/EN)
- Ajout : clients Supabase SSR, `proxy.ts` (next-intl + session + routes protégées, échec fermé), actions d'authentification, route `/auth/confirm`, pages login/signup/forgot/reset/dashboard en arabe (RTL) et anglais.
- Ajout : schémas zod d'authentification (`@fusion-leap/domain`), variable `SITE_URL`, templates d'e-mail, skills projet.
- Sécurité : correction d'un contournement du proxy par locale encodée (`/%61r/...`).
- Modifié : `supabase/config.toml` (redirections, mot de passe ≥ 10, confirmation d'e-mail locale).
### J7 — RLS du noyau et harnais de tests
### J6 — Schéma du noyau tenant
### J5 — Environnements et garde-fou de fuite
### J4 — Monorepo et CI
