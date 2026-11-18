# Changelog

Format : Keep a Changelog. Une entrée par jour de travail.

## [Non publié]
### Page Membres : présentation responsive (retour de test)
- Correction : débordement horizontal de la page Membres sur mobile (+304 px) et tablette (+175 px) ; `min-w-0` sur la page et les cartes, plus de largeur minimale forcée sur les tableaux.
- Ajout : sous 1024 px, une carte par membre et par invitation (motif de la liste des projets) ; le tableau reste à partir de `lg`. Actions inchangées (rôle, transfert, retrait, annulation d'invitation), aucune modification d'API ni de clé i18n.
- Tests : `components/members/lists.responsive.test.tsx` (7). Vérifié au navigateur à 375 px et 768 px, en anglais et en arabe (RTL) : pas de défilement horizontal de la page.

### Correctifs rapides d'accessibilité, de fil d'Ariane et de textes (retour de test)
- Correction : instructions Deals en double (la description se limite à « Vos opportunités par étape. » ; l'indication de glisser-déposer reste) ; `0 / 50000` devient `0 / 50 000` (nombres de la carte d'utilisation du plan formatés selon la langue) ; « Langue » devient « Langue par défaut de l'entreprise » (c'est la langue de l'entreprise, pas celle de l'interface) ; le tableau de bord salue la personne connectée (début de son adresse de connexion, en attendant un vrai champ « Nom » : ADR à venir) et non plus l'entreprise.
- Correction : `leads/page.tsx` : le lien « File non assignée » utilisait `aria-pressed` (réservé aux boutons) ; il utilise `aria-current`.
- Correction : le fil d'Ariane était vide sur Intégrations, Exploitation, Assignation, Alertes et Import CSV : `pageKeyOf` (extrait dans `components/layout/page-key.ts`) connaît maintenant ces routes. Un test vérifie que chaque entrée de la barre latérale a une page.
### Écran de canaux (hors plan, validé « ok default »)
- Ajout : migration `20261213100000_channels_activation.sql` (+ retour arrière) : un canal est `active` si et seulement si son intégration est validée par le fournisseur (création et `integration_set_validation`) ; pgTAP `320_channels_activation` (23 tests, refus d'abord).
- Ajout : `createPostmarkValidator` (`GET /server`, adresse fixe, codes courts) ; la vérification de connexion gère l'e-mail.
- Ajout : routes `POST /api/channels` et `POST /api/channels/update` ; page Intégrations : « Connecter un e-mail (Postmark) », ajout d'un canal, pause / reprise, « Vérifier la connexion » pour l'e-mail ; textes ar / en / fr.
- Tests : unitaires (adaptateur 6, service 11), acceptation HTTP `channels-flow` (7), pgTAP 320 (23).
- Réserve : `GET /server` de Postmark est une hypothèse à confirmer au test réel (C3, E1). Corrige l'écart n° 2 de C3.
### J41 — Checkpoint C3 (brouillon, audit sans comptes réels)
- Ajout : `docs/checkpoints/C3.md` : audit de conformité de la Phase 3 (invariants du CLAUDE.md par recherche, utilisation de `service_role`, preuves par critère §13, balayage de la base et des journaux, registre de 15 écarts) et **verdict proposé : NO-GO à G3 tant que le test sur comptes réels n'est pas fait** ; section 5 à remplir.
- Ajout : `docs/testing/Guide-test-manuel-C3-comptes-reels.pdf` (7 pages) et scripts `docs/testing/fixtures/c3-setup.sql` (canaux, contact de test, conversations), `c3-approve.sql` (envoi approuvé par le propriétaire), `c3-leak-scan.sql` (balayage en lecture seule) ; essayés avec des données factices (aucun fournisseur réel).
- Modification : `pnpm test:call` accepte `--json-file` (corps JSON lu dans un fichier : un jeton ne passe pas par la ligne de commande).
- Constats : aucun écran ni route pour créer un canal (SQL seulement) ; pas de réponse WhatsApp depuis la boîte de réception ; une migration modifiée après sa création (commentaire seulement). Balayage de la base après la suite complète : 1 984 lignes d'audit, 0 adresse, 0 numéro, 0 jeton, 0 contenu ; journaux de l'application et du worker : 0.
### Guide de test : import CSV et fichier d'exemple (hors plan)
- Ajout : `docs/testing/fixtures/import-demo.csv` (14 lignes : 7 nouveaux contacts, 2 déjà connus, 1 doublon, 4 refus : e-mail invalide, ni e-mail ni téléphone, numéro invalide, pays invalide ; deux numéros sans indicatif qui exigent le pays par défaut « MA »). Résultat attendu à l'aperçu : 14 / 10 valides / 7 nouveaux / 2 connus / 1 doublon / 4 refusés ; après traitement : 7 créés, 3 rapprochés, 4 refusés.
- Modification : `Guide-test-simple-phase3-exploitation-configuration.pdf` (17 pages) : partie F « Import d'un fichier CSV » (étapes 15 à 20 avec captures : envoi, correspondance des colonnes, aperçu, confirmation, suivi et rapport, contacts créés sans consentement) ; la partie des scénarios automatiques devient la partie G ; fiche de résultat étendue.
### Icône de l'onglet (hors plan)
- Ajout : `app/icon.png` (512 px), `app/apple-icon.png` (180 px) et `app/favicon.ico` : le « F » du logo officiel en noir de marque sur le vert `--brand` (#00d4a4), lisible sur onglet clair comme sombre. Avant : globe générique du navigateur. Next ajoute les trois liens `<link rel="icon">` dans l'en-tête ; le proxy d'authentification n'intercepte pas ces chemins (extension).
- Test : `app-icons.test.ts` (forme des fichiers).
### Durcissement J38 — la finalité « reply » est réservée à la réponse
- Faille corrigée : `message_approve` (owner et admin) acceptait n'importe quelle finalité, `reply` comprise ; un message promotionnel approuvé « reply » était alors couvert par le consentement conversationnel de 30 jours (un message entrant du contact) sans consentement marketing. Migration `20261212100000_reply_purpose_reserved.sql` (et retour arrière) : `message_approve` refuse `reply` (`purpose_reserved`) ; `conversation_reply` (le composeur) la pose toujours.
- Tests : pgTAP `310_reply_purpose` (14) ; écrit avant la migration : les 4 tests de la faille échouaient, les 10 autres (le commercial n'approuve jamais, entrant d'un autre fil ne couvre pas, « ne plus contacter » et suppression restent bloquants) passaient déjà.
- Conséquence révélée : le scénario T4 (J40) simulait une réponse WhatsApp humaine avec `message_approve(..., 'reply')`, c'est-à-dire par la faille elle-même ; le composeur ne gère que l'e-mail (`channel_unsupported` pour WhatsApp). T4 approuve maintenant avec la finalité « service » (consentement WhatsApp enregistré), fenêtre de 24 h inchangée.
- Documentation : amendement J38 de l'ADR 014, `docs/api/conversations.md`, `docs/api/send.md`.
### J39c — Écran d'import CSV
- Ajout : page `/imports` (menu « CSV import », owner et admin) : assistant en trois étapes (envoi, correspondance des colonnes avec aperçu, confirmation), suivi des lots, annulation et rapport CSV téléchargeable sans donnée de contact ; proposition de correspondance à partir des en-têtes ; ar / en / fr. Aucune migration, aucune nouvelle route.
- Tests : `lib/imports/guess-mapping` (4), acceptation HTTP `import-screen-flow` (10 : rôles, rien d'écrit avant la confirmation, lot traité par le vrai handler, rapport sans donnée de contact, annulation, isolation Alpha / Beta).
- Correction pendant le jour : les boutons « Annuler » n'envoyaient pas d'`Idempotency-Key` (la route l'exige : 400) ; trouvé par le test, corrigé et vérifié dans un navigateur.
- Documentation : `docs/api/imports.md` (section Écran).
### Correctif des scénarios canaux T3 / T4 (CI)
- Correction : dans la suite d'acceptation complète (CI), le worker de test réclamait aussi les jobs d'AUTRES scénarios restés en file (assignation, import, synchronisation) et les échouait (« expected 9 to be 2 ») ; il met maintenant de côté TOUT ce qui attend dans la file (y compris `process_webhook` / `send_message` d'autres fichiers et les jobs « en cours » au bail expiré, remis en file par la base) pendant le test (`parkForeignJobs`) et le rend intact ensuite. Un premier correctif ne mettait de côté que les autres types de jobs : la CI a encore échoué. Reproduit en local avec des jobs de tous types et des baux expirés, 15 tests verts (deux fois).
### Correctif : carte « Retirer un consentement » (écran contact)
- Correction : le sélecteur de canal (largeur fixe de 16 rem) débordait sur celui de la finalité dans la carte étroite ; les deux sélecteurs sont maintenant empilés et occupent toute la largeur de la carte (cellules à une colonne, sans débordement). Le sélecteur de canal du formulaire d'enregistrement suit la largeur de sa colonne.
### Guide de test exploitation et configuration, correctif des libellés de notification (hors plan)
- Ajout : `docs/testing/Guide-test-simple-phase3-exploitation-configuration.pdf` (11 pages, captures d'écran, fiche OK / KO : arrêt d'urgence, jobs en échec, clés de formulaire, règles d'assignation, notifications, droits, scénarios automatiques J40) et le jeu de données `docs/testing/fixtures/phase3b-ops-demo.sql`.
- Correction (J39b) : les libellés des notifications s'affichaient en clair (« Notifications.kind.send.failed ») car une clé de traduction contenait un point ; clés renommées (`leadUnassigned`, `sendFailed`) et test d'acceptation qui vérifie le libellé traduit.
- Rapport d'avancement : données remises à jour (J30b à J40 : 66,2 %, 45 jours sur 68, 8 008 tests) ; une revue de sécurité « pas encore faite » n'est plus présentée comme faite.
### J40 — Scénarios canaux (T3 et T4)
- Ajout : `tests/acceptance/src/t3-email-series.test.ts` (8 tests) et `t4-whatsapp-scenarios.test.ts` (7 tests), outillage `channels.testkit.ts`. Le VRAI worker (Runner piloté pas à pas, handlers `send_message` et `process_webhook`, base locale) contre un Postmark et un Meta SIMULÉS par un `fetch` injecté dans les adaptateurs réels (pas de nouvelle dépendance).
- T3 : série de 5 e-mails, désabonnement du 3e en cours de série par le vrai lien (annulé, jamais envoyé, refus au contrôle final pour un message ultérieur), 503 deux fois puis 200 sans doublon, lien de désabonnement sur chaque envoi.
- T4 : conversation démarrée par le client, par un modèle approuvé, webhook reçu deux fois (un seul message), statut `delivered` reçu deux fois, 429 deux fois puis 200 sans doublon, 503 = résultat inconnu jamais rejoué.
- Aucun défaut du produit trouvé ; aucune migration. Exigent la clé maître (comme les autres flux d'acceptation).
### J39b — Écrans de configuration
- Ajout : routes `POST /api/forms/keys` (+ `/active`, `/origins`), `POST /api/assignment/rules` (+ `/update`, `/delete`), `POST /api/notifications/read` ; pages `/assignment` et `/notifications` ; section « Form keys » dans la page d'un projet ; liens de menu avec compteur de notifications non lues ; ar / en / fr. Aucune migration.
- Modification : ressource `form_keys` (action `manage`, owner et admin) rattachée à la ligne 16 de l'ADR 014 (amendement J39b) ; le schéma des notifications accepte `send.failed` (J39) en plus de `lead.unassigned`.
- Sécurité : la clé de formulaire en clair n'existe que dans la réponse de création (`storeResponse: false`, jamais dans l'audit ni dans la page, rejeu = 409).
- Tests : domain +1, permissions (399), acceptation HTTP `config-screens-flow` (7).
- Documentation : `docs/api/config-screens.md`, ADR 014 (amendement).
### J39 — Exploitation des envois
- Ajout : migration `20261211100000_send_operations.sql` (et retour arrière) : `set_send_emergency_stop` (owner, admin, marketing manager ; audit `send.emergency_stop`), `operator_replay_dead_letter` (owner, admin ; acteur humain vérifié, comble la limite `p_actor` de l'ADR 003), alerte `send.failed` (déclencheur sur `jobs`, owner et admin, sans donnée de contact), débit horaire compté par (type de canal, entreprise) au lieu de par canal.
- Ajout : `POST /api/send/emergency-stop`, `POST /api/jobs/dead-letters/replay`, page `/operations` (arrêt d'urgence, liste et rejeu des dead letters), traductions ar / en / fr, lien de menu.
- Tests : RLS `send-operations` (11), domain `operations` (3), acceptation HTTP `send-operations-flow` (8).
- Documentation : `docs/runbooks/emergency-stop.md`, `docs/api/send-operations.md`, `docs/runbooks/jobs-worker.md`, `docs/api/send.md`.
### Guides de test simples (hors plan)
- Ajout : quatre guides PDF courts avec captures d'écran et fiche OK / KO (`docs/testing/Guide-test-simple-*.pdf`) : comptes et rôles, CRM, conversations et envoi, boîte de réception et réponses (J37 à J38).
- Ajout : jeu de données `docs/testing/fixtures/phase4-inbox-demo.sql` (4 conversations pour la boîte de réception et les réponses).
- Correction : `pnpm test:call` retire le préfixe `C:/Program Files/Git` que Git Bash ajoute aux chemins `/api/...`.
### J36b — Retrait de consentement WhatsApp (hors plan)
- Ajout : migration `20261207100000` (et retour arrière) : un mot d'arrêt reçu d'un contact révoque ses consentements WhatsApp, supprime son numéro, annule ses envois WhatsApp en file ; numéro seul supprimé pour un expéditeur inconnu ; rattrapage des « STOP » déjà reçus.
- Modification : version de l'API Graph v25.0 (une constante pour toutes les requêtes sortantes).
- Tests : pgTAP 300 (53), acceptation HTTP `whatsapp-flow` (+1).
- Documentation : `docs/api/whatsapp-inbound.md` (retrait par mot d'arrêt), `docs/api/whatsapp-send.md`.
### Fusion J36 × J38 — `message_send_claim` (branche `day-36-whatsapp-send`)
- Modifié : migration `20261210120000_message_send_claim_merge.sql` (et retour arrière) : version unique de `private.message_send_claim` qui contient les changements WhatsApp de J36 (destinataire par canal, fenêtre de 24 h, modèle, compte) ET ceux de J38 (un commercial approuve sa réponse sur sa conversation ; consentement conversationnel de 30 jours pour la finalité `reply`). Sans elle, la migration J38 (postérieure) effaçait les changements de J36. Les migrations déjà appliquées ne sont pas modifiées.
### J36 — Envoi WhatsApp conforme
- Ajout : migration `20261206100000` (et retour arrière qui recrée les fonctions d'avant) : table `message_templates` (ADR 007 E5, versions, RLS), `messages.template_id` / `template_variables` / `template_text`, `message_attach_template`, `message_templates_sync` (service_role) ; `message_approve`, `message_send_claim`, `whatsapp_status_apply` et `messages_guard` étendus (numéro pour WhatsApp, fenêtre de 24 h, modèle, statut devançant l'envoi réessayé).
- Ajout : envoi WhatsApp par l'API Cloud (`packages/adapters/src/whatsapp/send.ts`, résultats accepté / refusé / réessayable / inconnu), liste et réduction des modèles de Meta (`templates.ts`), envoi par le worker avec le contrôle final (modèle obligatoire hors fenêtre), `POST /api/integrations/templates/sync`.
- Tests : pgTAP 290 (57), adaptateurs +24, worker +9, web +6, acceptation HTTP `whatsapp-send` (9).
- Documentation : `docs/api/whatsapp-send.md`.
### J35 — Réception WhatsApp
- Ajout : migration `20261205100000` (et retour arrière) : `whatsapp_inbound_apply` et `whatsapp_status_apply` (service_role seulement) ; la garde `messages_guard` accepte un `failed` de Meta suivi de `delivered` ou `read`.
- Ajout : normalisation des événements Meta à la lecture (`packages/adapters/src/whatsapp/events.ts` : messages, boutons, réponses interactives, statuts ; ni profils ni médias), processeur `whatsapp` du worker.
- Modification : le webhook WhatsApp conserve la forme normalisée (plus le corps brut) et déduplique chaque message par son `wamid`.
- Tests : pgTAP 280 (44), adaptateurs +13, worker +8, acceptation HTTP `whatsapp-flow` (7).
- Documentation : `docs/api/whatsapp-inbound.md`.
### J34 — Connexion WhatsApp
- Ajout : migration `20261204100000` (et retour arrière) : `integration_set_validation` (service_role seulement), codes de validation ajoutés à `integrations_error_valid`.
- Ajout : adaptateur de webhook WhatsApp (signature `X-Hub-Signature-256`, compte = numéro, déduplication par empreinte du corps), poignée de main GET avec `WHATSAPP_VERIFY_TOKEN`, client de validation de l'API Graph (adresse fixe, codes courts).
- Ajout : `POST /api/integrations/validate`, composants « Connecter un numéro WhatsApp » et « Vérifier la connexion » (fr, ar, en).
- Tests : pgTAP 270 (30), adaptateurs +13, web +17, domaine +2, acceptation HTTP `whatsapp-connect` (9).
- Documentation : `docs/api/whatsapp-connect.md`, `docs/runbooks/whatsapp-setup.md`, ADR 007 (notes J34).
### J33 — Désabonnement
- Ajout : migration `20261203100000` (et retour arrière) : `unsubscribe_apply` (service_role seulement) révoque les consentements e-mail du contact, supprime l'adresse (`suppressions`, raison `unsubscribe`), annule les messages en file non réclamés et leurs jobs, audite sans donnée personnelle ; idempotente.
- Ajout : lien signé (`packages/adapters/src/email/unsubscribe.ts`, HMAC-SHA256, clé dérivée du trousseau, rotation sans casser les anciens liens), en-têtes `List-Unsubscribe` / One-Click et pied de page dans chaque e-mail ; le worker refuse d'envoyer sans clé de signature ; l'adaptateur Postmark transmet les en-têtes (liste blanche).
- Ajout : `GET` et `POST /api/unsubscribe/[token]`, page publique `/{fr,ar,en}/unsubscribe/[token]` (confirmation, jamais de désabonnement à l'ouverture), limite par adresse, textes génériques.
- Tests : pgTAP 260 (42), adaptateurs +10, worker +3, web +22, acceptation HTTP.
- Documentation : `docs/api/unsubscribe.md`, ADR 008 (note J33).
### Correctif J37 — L10 : `search_conversations` hors de `public` (branche `day-38-replies`)
- Modifié : migration `20261210110000_inbox_search_private.sql` (et retour arrière) : le corps SECURITY DEFINER passe dans `private.search_conversations`, `public.search_conversations` devient une enveloppe SECURITY INVOKER (mêmes arguments, mêmes colonnes, mêmes droits de lecture réappliqués). Aucun changement de comportement ni de code web. La migration J37 déjà appliquée n'est pas modifiée.
- Tests : `030_organizations_create` (test 8) et `900_schema_lint` (test 10, L10) repassent au vert ; `260_inbox` (31) inchangé.
### J38 — Réponses et verrou humain / IA (branche `day-38-replies`)
- Ajout : `POST /api/conversations/:id/replies` (`Idempotency-Key` obligatoire, 1 à 10 000 caractères, `202 { message_id, status: "queued" }`) : la réponse est créée et approuvée par son auteur en une transaction (owner et admin partout, commercial sur SES conversations, marketing et analyste jamais), puis envoyée par le worker après le contrôle final ; composeur dans `/inbox/[id]` (e-mail) avec bail de 5 minutes, battement de cœur de 2 minutes, bandeaux « autre membre » et « IA » et « Reprendre la main » ; messages fr / ar / en.
- Ajout : migration `20261210100000_replies_lock.sql` (et retour arrière) : `conversation_reply`, bail (`conversation_lock_acquire` / `status` / `release`), `conversation_take_over`, `conversation_ai_claim` / `conversation_ai_release` (service_role), jamais l'IA et un humain en même temps.
- Modifié : `message_send_claim` (J31) : un commercial approuve sa propre réponse sur sa conversation ; consentement conversationnel de 30 jours pour la finalité `reply`. **Point sensible à valider** ; conflit à fusionner avec la migration WhatsApp (J36) qui remplace la même fonction.
- Tests : pgTAP `270_replies_lock` (46), Vitest `lib/conversations/reply.test.ts` (8), acceptation HTTP `replies-flow.test.ts` (11 : rôles, clé d'idempotence, envoi par le worker avec un fournisseur de test, `do_not_contact`, verrou IA / humain).
- Écart au plan : WhatsApp indisponible pour la réponse (J36 non fusionnée) ; une migration qui remplace une fonction de J31.
### J37 — Boîte de réception unifiée (branche `day-37-inbox`)
- Ajout : pages `/inbox` (e-mail et WhatsApp dans une même liste, filtres état / canal / responsable, recherche, aperçu de 140 caractères du dernier message) et `/inbox/[id]` (fil en lecture, assigner, changer l'état), lien « Boîte de réception » dans le menu pour owner, admin et commercial ; actualisation automatique toutes les 15 s ; messages fr / ar / en.
- Ajout : migration `20261209100000_inbox.sql` (et retour arrière) : `search_conversations` (SECURITY DEFINER qui réapplique les droits de lecture des conversations ; nom du contact, type du canal et aperçu tronqué) ; Server Actions `inbox.assign` et `inbox.state.set` (idempotence obligatoire, droits ADR 014) ; ADR 013 (polling, **Proposed**).
- Règles : le commercial ne lit que SES conversations (404 sinon) ; marketing et analyste renvoyés au tableau de bord ; le corps complet d'un message n'est affiché que dans le fil ; l'audit ne contient jamais le corps.
- Tests : pgTAP `260_inbox` (31), Vitest `lib/inbox/inbox.test.ts` (9), acceptation HTTP `inbox-pages.test.ts` (7), navigateur (assignation, état, message arrivé pendant que la page est ouverte) ; jeu de démonstration `docs/testing/fixtures/inbox-demo-data.sql`.
- Écart au plan : une migration (liste) ; le composeur et le verrou humain / IA sont J38. WhatsApp (J34 à J36b) n'est pas encore dans `main` : la liste est indépendante du canal et affiche WhatsApp dès que ces conversations existent (test avec un canal WhatsApp créé en base).
### J30d — Fiche lead, 2e partie : deal, étape, gagné / perdu, assignation (branche `day-30d-lead-actions`)
- Ajout : sur `/leads/[id]`, carte « Gérer ce lead » (étape du lead ; assignation pour owner et admin), création d'un deal (valeur, devise, clôture prévue, étape de départ), déplacement d'un deal par menu et boutons **Gagné** / **Perdu** ; messages fr / ar / en.
- Ajout : Server Actions `leads.stage.move`, `leads.assign`, `deals.create`, `deals.stage.move` (idempotence obligatoire, droits ADR 014 : owner, admin, commercial sur son lead ; assignation : owner et admin ; la base revérifie rôle, propriété, étape et projet).
- Règles : le marketing lit sans rien modifier ; le message « gagné » ou « perdu » vient de la date posée par la base ; l'audit ne contient jamais la valeur d'un deal.
- Parcours G2 rejoué par l'interface (navigateur) : lead non assigné -> assigné (Sales agent) -> deal créé (5 000 MAD) -> « Gagné », avec l'historique dans la chronologie (voir le journal).
- Tests : Vitest `lib/leads/action-schemas.test.ts` (30), acceptation HTTP `lead-page.test.ts` (8, dont formulaires par rôle).
- Aucune migration. Hors plan : pas de « Add lead » (création manuelle).
### J30c — Fiche lead : détail, chronologie, notes, appels et tâches (branche `day-30c-lead-page`)
- Ajout : page `/leads/[id]` (résumé, contact, prochaine action, deals, chronologie la plus récente d'abord avec les entrées automatiques d'étape et d'assignation), formulaire « Ajouter à la chronologie » (note, appel, tâche), marquer une tâche faite ou à refaire ; le nom du contact dans la liste des leads devient le lien ; messages fr / ar / en.
- Ajout : Server Actions `activities.create` et `activities.task.complete` (idempotence obligatoire, droits ADR 014 « Leads / deals : tâches » : owner, admin, commercial sur son lead ; la base revérifie la propriété du lead).
- Règles : le commercial ne voit que la fiche de ses leads (404 sinon) ; l'analyste est renvoyé au tableau de bord ; le marketing lit sans pouvoir écrire ; le contenu saisi n'est jamais dans l'audit.
- Tests : Vitest `lib/activities/action-schemas.test.ts` (25), acceptation HTTP `lead-page.test.ts` (6 : rôles, isolation, ordre de la chronologie, entrées automatiques, formulaire par rôle), navigateur (tâche ajoutée, marquée faite, prochaine action mise à jour).
- Hors plan J30c : pas de « Add lead » (création manuelle d'un lead) ; aucune migration.
### J30b — Écran contacts et consentement (branche `day-30b-contacts`)
- Ajout : pages `/contacts` (liste, recherche par nom, e-mail ou téléphone, pagination côté serveur) et `/contacts/[id]` (coordonnées, statut, historique du consentement avec la preuve, enregistrer ou retirer un consentement, poser ou lever « ne plus contacter »), lien « Contacts » dans le menu pour owner, admin et marketing ; messages fr / ar / en.
- Ajout : migration `20261208100000_contacts_search.sql` (et retour arrière) : `search_contacts` (SECURITY INVOKER, saisie échappée) ; Server Actions `contacts.consent.record`, `contacts.consent.revoke`, `contacts.do_not_contact.set` (idempotence obligatoire, droits ADR 014, base revérifiant le rôle).
- Règles : l'adresse IP et l'URL d'une preuve ne sont jamais affichées ; lever « ne plus contacter » : owner et admin seulement ; commercial et analyste renvoyés au tableau de bord.
- Tests : pgTAP `250_contacts_search` (19), Vitest `lib/contacts/action-schemas.test.ts` (33 avec les services), acceptation HTTP `contacts-pages.test.ts` (6 : rôles, recherche, pagination, preuve sans IP, autre entreprise en 404).
- Écart au plan : une migration (recherche) alors que le plan n'en prévoyait pas ; la création de contact ou de lead n'est pas dans J30b (voir J30c et J30d).
### Hors plan — tableau de bord repensé (branche `day-37a-dashboard-ux`)
- Modification : tableau de bord (`apps/web/app/[locale]/(app)/dashboard/page.tsx`) : en-tête d'accueil (salutation selon l'heure du fuseau de l'organisation, date longue, rôle), cartes d'indicateurs (projets, leads, deals ouverts, deals gagnés) lues sous RLS (`lib/dashboard/queries.ts` ; `null` = carte masquée, jamais de faux zéro), liste « pour commencer » avec progression, actions rapides filtrées par rôle, barres d'usage du plan vert / ambre / rouge, carte organisation regroupée.
- Modification : thème global indigo / violet (`app/globals.css`, clair et sombre, rayon 0,75 rem, logo) ; ADR 015 amendé. Contrastes AA vérifiés par les tests.
- Modification : page « Nouveau projet » : choix du type par cartes (boutons radio accessibles, icône et description), étapes numérotées, barre d'actions collante (Créer / Annuler), lien de retour avec flèche (inversée en RTL).
- Modification : look moderne des composants partagés (`components/ui` : boutons et champs arrondis `rounded-lg`, cartes `rounded-2xl`, badges en pilule, en-tête de table discret, élément actif de la barre latérale teinté) ; fond de page légèrement teinté avec cartes blanches ; page Projets en cartes avec filtre segmenté.
- Modification : gabarit des e-mails (`packages/adapters/src/email/layout.ts`, donc confirmation, réinitialisation et test SMTP, en fr / ar / en) : en-tête dégradé indigo, carte arrondie, bouton plus grand, lien de secours en clair sous le bouton, pied bleu nuit ; texte alternatif du logo stylé (visible si l'image est bloquée). Fichiers `supabase/templates/*.html` et objets de `config.toml` régénérés (`pnpm email:templates`).
- Modification : thème Mintlify (noir et vert, boutons en pilule, jeton `--brand`), police Inter à la place de Poppins (`apps/web/app/fonts`), logo vert, gabarits d'e-mail noir et vert avec pied rouge de la marque et marque « F » officielle en data URI (`packages/adapters/src/email/mark.ts`) et logotype texte « FUSION LEAP » (s'affichent même si l'adresse du site est locale ; Gmail et Outlook bloquent les data URI : le texte reste ; le message de test SMTP garde le logo joint) ; marque « F » officielle (`apps/web/public/brand/mark.png`, inversée en sombre) à la place de l'icône par défaut du menu et des pages publiques ; ADR 015 amendé ; `docs/design/mintlify-DESIGN.md` ajouté. Tests de polices et de contraste adaptés.
- Correction : sélecteur d'organisation de l'en-tête : choisir une organisation la change tout de suite (avant, le menu affichait la nouvelle valeur sans changer d'organisation tant qu'on n'avait pas cliqué sur « Changer », ce qui laissait croire à un mélange de données). Le bouton reste présent pour les lecteurs d'écran. Aucune fuite de données : l'organisation active était restée la précédente.
- Correction : export CSV des leads : ligne `sep=,` ajoutée en tête du fichier (`packages/domain/src/crm/csv-export.ts`), pour qu'Excel, en français ou en arabe, répartisse les colonnes au lieu de tout mettre dans la première cellule.
- Aucune migration, aucune donnée fictive ; messages fr / ar / en ; classes logiques (RTL). Tests : `lib/dashboard/queries.test.ts`.
### Hors plan — guide de tests et rapport d'avancement
- Ajout : guide de tests fonctionnels des phases 2 et 3 (`docs/testing/phase2-3-functional-tests.md` et PDF) : 107 cas (interface : projets, leads, deals, intégrations ; technique : capture, assignation, import, synchro CRM, secrets, webhooks e-mail, conversations, envoi sous contrôles), fiche de résultats, données de démonstration (`docs/testing/fixtures/`), outils `pnpm test:call` et `pnpm test:guide`.
- Ajout : page « journal du jour » du rapport (`journal` dans `scripts/progress-report/data.json` : phrase, activités, vignettes dans `docs/progress/report/journal/`, compteurs de lignes calculés par `git log --numstat` sur les commits du jour).
- Modification : rapport d'avancement refondu (8 pages avec le journal : synthèse, feuille de route, phases, livré récemment, qualité, décisions) avec historique (`history.json`) et comparaison avec le rapport précédent ; textes figés corrigés (« J0 à J27 », compteur de PR), modules mal libellés corrigés.
- Documentation : `docs/runbooks/test-guide.md`, `docs/runbooks/progress-report.md`.
### J32 — E-mail entrant et statuts
- Ajout : migration `20261202100000` (et retour arrière) : **second secret par intégration** (`webhook_secret_ref`, illisible par l'API, supprimé à la déconnexion), table `inbound_unmatched` (file des cas ambigus, lecture owner et admin, aucune écriture directe), fonctions service_role `email_status_apply` (delivered, rebond dur, plainte) et `email_inbound_apply` (canal par l'adresse destinataire, contact par l'adresse expéditrice).
- Ajout : adaptateur de webhook Postmark (Basic Auth : utilisateur = compte de l'intégration, mot de passe = secret de webhook), événements normalisés (`packages/adapters/src/email/events.ts`, fixtures = exemples officiels), processeur `email` du worker, `POST /api/integrations/webhook-secret`, `Metadata` (identifiant de notre message) à l'envoi.
- Règles : un rebond dur ajoute l'adresse à `suppressions` SANS toucher `do_not_contact` ; une plainte ajoute l'adresse ET pose `do_not_contact` ; un expéditeur inconnu ne crée JAMAIS de contact (file `inbound_unmatched`) ; `delivered` ne vient que d'un événement du fournisseur ; un envoi « résultat inconnu » (J31) est réconcilié par l'événement.
- Sécurité (revue adverse, 1 bloquant, 1 majeur, 5 moyens corrigés) : anti-usurpation (SPF aligné sur le domaine de « From » ou DKIM de l'auteur, en-têtes dupliqués = non fiable), file bornée (corps 2 000 caractères, 20 par expéditeur, 10 000 par entreprise, jamais perdue en silence), texte nettoyé avant stockage, identifiants d'événement conformes, canal par adresse exacte, HTTPS exigé, secret de webhook jamais égal au jeton d'envoi.
- Tests modifiés : `handle.test.ts` et `webhooks-flow` (l'e-mail a maintenant un adaptateur).
- Tests : adaptateur (+32), worker (+11), web (+5), domaine (schéma du secret), pgTAP (+114), API réelle (+9), acceptation (`email-flow`).
- Documentation : `docs/api/email-inbound.md`, `docs/runbooks/email-webhooks.md`, ADR 007 (amendement), ADR 008 (note), `docs/api/webhooks.md`, `docs/api/integrations.md`, `docs/integrations/email.md`.
### J31 — Envoi d'e-mail derrière la chaîne de contrôles
- Ajout : migration `20261201100000` (et retour arrière) : approbation humaine d'un message sortant (`approved_by`, `approved_at`, `approved_purpose`, `approved_recipient`), tentative d'envoi unique (`send_claimed_at`), garde-fous de base (pas d'envoi accepté sans approbation, statuts qui ne reculent pas), table `suppressions` (lecture seule), fonctions `message_approve` (owner et admin, met le job en file) et, pour le worker, `message_send_claim`, `message_mark_accepted`, `message_mark_failed`, `message_release_claim`.
- Ajout : `packages/domain/src/outbound` (`checkCanSend` / `assertCanSend`, 15 contrôles dans un ordre fixe, échec fermé), `packages/adapters/src/email` (interface `EmailProvider`, fournisseur Postmark), handler worker `send_message` (au plus un envoi par message, `accepted` n'est pas `delivered`).
- Sécurité (revue adverse, 0 bloquant, 2 majeurs, 5 moyens corrigés) : approbation revalidée à l'envoi (approbateur toujours owner ou admin, moins de 72 h, adresse inchangée, entreprise et abonnement actifs), `approved_by` sans clé étrangère (suppression de compte non bloquée), envoi en cours distingué du résultat inconnu, `accepted` tardif permis, compteur de débit sérialisé par canal, 502 et 504 classés « inconnu » (jamais renvoyés).
- Test existant modifié : `230_conversations_messages` (un message ne passe plus à `accepted` sans approbation).
- Tests : domaine (+33), adaptateur (+11), worker (+30), pgTAP (+94), API réelle (+10).
- Documentation : `docs/api/send.md`, ADR 008 (Accepted sous réserve de Q2).
### J30 — Conversations et messages
- Ajout : migration `20261130100000` (et retour arrière) : tables `conversations` (un fil par contact et canal, états `open`, `pending`, `closed`, `to_triage` cohérents avec le responsable par CHECK) et `messages` (clé composite entreprise + conversation + canal, unicité du message fournisseur et de la clé d'envoi, corps de 1 à 100 000 caractères, immuables : organisation, conversation, canal, sens, corps).
- Ajout : RLS (owner et admin tout, le commercial SES conversations et leurs messages, marketing et analyste rien) ; fonctions `assign_conversation` et `set_conversation_state` (par rôle) ; fonctions service_role `conversation_get_or_create` et `message_record` (idempotentes : rejeu identique = `duplicate`, rejeu contradictoire = `idempotency_conflict`) ; libération des conversations d'un membre qui perd son accès ; audit sans corps de message.
- Ajout : `packages/domain/src/conversations`, `apps/web/lib/conversations` (liste, détail, messages, assigner, état). Pas d'écran ni de route (inbox au J37).
- Sécurité (revue adverse) : entrées validées avant insertion (aucun corps dans les erreurs), conflit d'idempotence, verrous dans l'ordre membre puis conversation, plafond de 10 000 messages par conversation, horodatage limité à maintenant + 5 minutes, aucun message sur un canal déconnecté, index alignés sur le tri.
- Tests : domaine (6), service web (6), pgTAP (126), API réelle (12).
- Documentation : `docs/api/conversations.md`, addendum ADR 007.
### J29 — Pipeline webhook
- Ajout : migration `20261129100000` (et retour arrière) : table `webhook_events` (métadonnées seules lisibles par owner et admin, payload jamais exposé), fonctions service_role `webhook_resolve_integration`, `webhook_record` (événement + job `process_webhook` dans la même transaction, unicité par entreprise, plafond de file sur 7 jours), `webhook_record_rejection` (plafonnée), `webhook_start` et `webhook_finish`.
- Ajout : `packages/adapters/src/webhooks` : interface `WebhookAdapter`, helper `verifyHmacSha256Hex` (temps constant, corps brut) et pipeline pur `ingestWebhook` (taille, compte, tenant par le COMPTE, signature, fenêtre de 5 minutes, enregistrement idempotent).
- Ajout : route `POST /api/webhooks/[provider]` (sans session, limitation de débit par fournisseur et adresse, corps borné, ACK rapide ; 404 sans adaptateur) ; handler worker `process_webhook` et passerelle ; registre d'adaptateurs et de processeurs vides (e-mail J32, WhatsApp J34 et J35).
- Sécurité (revue adverse) : compte inconnu = même 401 qu'une signature invalide (aucun oracle d'existence), seau de débit par adresse agrégée (IPv6 /64) et refus 503 sans adresse source, secret absent refusé, horodatage strict, adaptateur qui lève = requête invalide, sans processeur = `failed` re-jouable, marge de taille du jsonb, plafond de file sur 7 jours.
- Tests : adapters (19), route (11), magasin (6), worker (12), pgTAP (78), API réelle (6), acceptation (16).
- Documentation : `docs/api/webhooks.md`, addendum ADR 007.
### J28 — Intégrations et secrets
- Ajout : migration `20261128100000` (et retour arrière) : `integrations` étendue (`scopes`, `secret_ref`, `has_secret`, fournisseurs `email` et `whatsapp`, statuts `pending`, `active`, `error`, `disconnected`, `disabled`, unicité globale des comptes e-mail et WhatsApp), table `channels` (ADR 007 E4), fonctions `create_provider_integration`, `set_integration_secret` (rotation et reconnexion), `disconnect_integration`, `create_channel`, `update_channel` (owner et admin) et `get_integration_secret` (service_role seulement).
- Sécurité : SELECT par colonnes (`secret_ref` illisible, `select *` refusé), `private.secrets` sans droit d'API, clé étrangère composite secret / entreprise, AAD par entreprise ; le jeton n'est jamais renvoyé, journalisé, audité ni stocké dans les clés d'idempotence (HMAC avec une clé serveur : rejouer une clé avec un autre jeton donne 422).
- Ajout : `packages/adapters/src/secrets/store.ts` (`put`, `get`, `rotate`, `delete`, secrets d'organisation), `packages/domain/src/integrations`, `apps/web/lib/integrations`, `lib/service/integration-secrets.ts` ; routes `GET/POST /api/integrations`, `POST /api/integrations/secret` et `/disconnect` ; écran `/integrations` (fr, ar, en) : statut, portée, canaux, « Remplacer le jeton » (écriture seule), « Reconnecter », « Déconnecter ».
- Ajout : `withRoute` option `hashOmit` (HMAC des champs secrets dans l'empreinte d'idempotence) ; le service CRM ne liste que les intégrations `csv` et `internal`.
- CI : le job `e2e` génère une clé maître aléatoire (masquée) pour que l'acceptation des intégrations déchiffre réellement.
- Revue adverse : identité d'un canal au format e-mail ou E.164, reconnexion d'un compte déconnecté, plafond du secret en octets, `get_integration_secret` limité aux statuts pending, active et error.
- Tests : adapters (10), domaine (7), service web et idempotence (22), pgTAP (119), API réelle (12), acceptation (9).
- Documentation : `docs/api/integrations.md`, `docs/runbooks/secret-rotation.md`, addendums ADR 004 et 007.
### CI — job de bout en bout et couverture (décision C2, option A)
- Ajout : job `e2e` dans `.github/workflows/ci.yml` : pile Supabase locale (même liste d'exclusions que `database`, Storage conservé), `pnpm db:reset`, variables de l'application tirées de `supabase status`, `pnpm build`, `next start` sur le port 3000 avec attente de `/fr/login`, `pnpm test:e2e`, journal de l'application en cas d'échec.
- Ajout : étape « Couverture » dans le job `verify` (`test:coverage` de `domain` et `permissions`, seuil 80 %).
- Aucun code applicatif ni migration. Ferme l'écart 3 du C2 et l'écart 4 du C1.
### Décisions du 2026-11-09 (ADR, CI, Playwright)
- Modification : ADR 001 à 006, 014, 015 passés en **Accepted** ; 007 accepté pour les Phases 1 et 2 ; 016 accepté sous condition (écriture restreinte aux administrateurs de la plateforme avant tout client réel, au plus tard J54) ; 008, 010 et 012 restent Proposed ; ADR 005 complété (modèle « lecture par politique, écriture par fonctions »).
- Modification : `libphonenumber-js` épinglé en `1.13.15`.
- Décision : job CI de bout en bout (option A) avant J29 ; Playwright décidé au J58. Détail : `docs/checkpoints/C2-decisions.md`.
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
