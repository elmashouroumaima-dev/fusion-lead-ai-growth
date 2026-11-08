# Changelog

Format : Keep a Changelog. Une entrée par jour de travail.

## [Non publié]
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
