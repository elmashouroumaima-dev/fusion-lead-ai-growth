# Compréhension de la spécification v1.0 — Fusion Leap AI Growth

Source : `docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md` (v1.0, 3 nov 2026, rédigée en arabe). Les références `§n` renvoient à cette spec. Quand une case n'est pas couverte par la spec, elle est marquée **[À TRANCHER]** (voir `gaps-and-questions.md`) et aucune règle n'est inventée.

---

## A. Le produit en 10 lignes

1. Fusion Leap AI Growth est une plateforme SaaS multi-entreprises (multi-tenant), utilisée d'abord en interne par Fusion Leap puis vendue par abonnement à d'autres entreprises (§1).
2. Chaque entreprise dispose d'un espace isolé : membres, projets, canaux, données clients, campagnes, agents IA (§1, §3).
3. Un projet est de type site web, application Salla, thème Salla ou personnalisé (§1, §4) ; il porte offres, audiences et assets.
4. Parcours standard : source → lead → déduplication → qualification → assignation → brouillon IA → relecture humaine → envoi/publication → réponse → suivi → deal → rapport (§3).
5. E-mail et WhatsApp (Cloud API officielle) sont les deux canaux de conversation ; tout envoi marketing exige consentement et respect des politiques fournisseur (§1, §9.2, §9.3).
6. Le CRM interne léger est la source de vérité tant que l'API du CRM Fusion Leap n'est pas documentée (§5.3, §9.1, §14).
7. L'IA ne produit que des brouillons, résumés, qualifications et suggestions ; tout envoi externe est approuvé par un utilisateur habilité (§5.7, §9.5).
8. Les chiffres du tableau de bord indiquent leur source (direct/importé/calculé) et affichent « non disponible » quand le coût est inconnu (§10).
9. Exclus du MVP : n8n, publication automatique d'apps/thèmes Salla, achat d'annonces, envois WhatsApp de masse sans consentement/template, agent autonome, facturation automatique (§1).
10. Pourquoi multi-tenant : un seul code et une seule base servent plusieurs entreprises ; l'isolation (RLS + couche service + worker) est donc le critère n°1, avant toute fonctionnalité (§5 ordre de priorité, §7.2, §11, §13.1).

---

## B. Rôles (§2) — matrice rôle × action

Légende : ✔ explicitement dit · ✘ explicitement exclu · ◐ conditionnel (condition indiquée) · ? **[À TRANCHER]** (la spec ne dit rien).

La spec décrit les rôles en prose (§2) et par les critères §13.2 ; elle ne fournit pas de matrice complète. Toute case « ? » devient un ADR (voir G-R1 dans `gaps-and-questions.md`).

| Rôle | Lire | Créer | Modifier | Envoyer | Approuver | Gérer intégrations | Gérer membres |
|---|---|---|---|---|---|---|---|
| **Platform Admin** | ◐ données d'un client uniquement via session de support journalisée, limitée dans le temps, après autorisation (§2) | ? | ? | ? | ? | ? | ? (gère entreprises, plans, support : §2 ; activation manuelle des plans §10) |
| **Company Owner** | ✔ tous les projets (§2) | ✔ tous les projets (§2) | ✔ (« contrôle de tous les projets », §2) | ? | ? | ✔ (§2) | ✔ inviter ; seul à pouvoir gérer les adhésions (§13.2) |
| **Company Admin** | ✔ projets/membres/campagnes/canaux (§2) | ✔ idem (§2) | ✔ idem (§2) | ? | ? | ◐ gère les canaux ; ✘ pas les secrets bruts (§2) | ✔ gère les membres (§2) ; ✘ pas de transfert de propriété (§2) |
| **Marketing Manager** | ? | ✔ campagnes (§2) | ✔ relecture (§2) | ◐ « uniquement après approbation selon la politique » (§13.2) | ◐ publie dans le budget et les droits approuvés (§2) | ? | ? |
| **Sales Agent** | ◐ clients et conversations qui lui sont assignés (§2) | ? | ✔ statut du deal (§2) ; répondre (§2) | ◐ répondre (§2) ; envoi soumis à approbation en MVP (§5.7) | ? | ✘ (§2, §13.2) | ? |
| **Analyst** | ◐ rapports et données autorisées (§2) | ✘ | ✘ | ✘ (§13.2) | ✘ | ✘ | ✘ |

Règles transverses : un utilisateur peut appartenir à plusieurs entreprises avec des rôles différents ; `active_organization_id` est fixé à chaque requête et l'adhésion est vérifiée côté serveur et base (§2) ; un projet appartient à une seule entreprise ; le transfert d'enregistrement vers une autre entreprise par simple UPDATE est interdit, seule une action admin auditée est possible (§2).

---

## C. Modèle de données (§7)

Règles générales (§7) : PK `uuid` ; `organization_id uuid not null` + index sur toute table tenant ; `created_at`/`updated_at` « là où nécessaire » ; recommandé `unique (organization_id, external_source, external_id)` pour les données importées ; l'e-mail n'est pas l'identifiant unique.

Colonne **org_id** : « listé » = présent dans la spec ; « implicite » = absent du tableau §7 mais obligatoire par la règle « toute table tenant » (voir E11).

| Table | Champs listés par la spec | org_id | Relations / contraintes / notes |
|---|---|---|---|
| `organizations` | id, name, slug, status, timezone, locale, plan_id | est elle‑même le tenant | `plan_id` fait doublon avec `subscriptions.plan` (E10). Statuts non énumérés. |
| `organization_members` | organization_id, user_id, role, status, invited_by | listé | « clé composite unique » (organization_id, user_id). Source du rôle (§7.2). `status = 'active'` utilisé dans l'exemple RLS. |
| `subscriptions` | organization_id, plan, status, period_start/end, limites d'usage | listé | Statuts : trial, active, past_due, suspended, cancelled (§10). Facturation manuelle d'abord. |
| `projects` | organization_id, type, name, status, owner_id, settings jsonb | listé | Types : website_sales, salla_app, salla_theme, custom (§4). |
| `products` | project_id, kind, offer, price_hint, landing_url, assets | implicite | FK vers projects ; doit rester dans la même organisation (E12). |
| `contacts` | nom, e-mail normalisé, téléphone E.164, langue, pays, consent_status, do_not_contact | implicite | Déduplication **dans la même entreprise** (§9.1) ; deux entreprises peuvent avoir le même e-mail séparément (§13.3). |
| `leads` | contact_id, project_id, source, stage, score, assignee_id, campaign_id, utm jsonb | implicite | « Chaque lead appartient à un projet de la même entreprise » ; contrainte/service refuse un project_id d'une autre entreprise (§7). |
| `deals` | lead_id, pipeline_stage, value, currency, expected_close_at, won_at/lost_at | implicite (E11) | Étapes configurables (§5.3) sans table de pipeline (E1). |
| `activities` | lead_id/contact_id, type, owner_id, due_at, completed_at, metadata | implicite (E11) | Sert aussi aux tâches (E2). |
| `integrations` | provider, status, external_account_id, scopes, secret_ref, last_sync_at | implicite | Jamais de jeton brut ; `secret_ref` seulement. |
| `channels` | type, integration_id, sender_identity, status, project_scope | implicite | Types : e-mail, WhatsApp, formulaires web, CRM, Salla (§3). |
| `conversations` | contact_id, channel_id, assignee_id, state, last_message_at | implicite | Empêche réponse IA + réponse humaine simultanées (§9.3). |
| `messages` | conversation_id, direction, provider_message_id, body, status, sent_at, received_at, error_code | implicite (E11) | Hérite l'entreprise de la conversation avec `organization_id` dupliqué, cohérence vérifiée en base (§7). |
| `campaigns` | project_id, objective, channel, status, audience_snapshot_id, scheduled_at, budget, currency | implicite | Statuts : draft → pending_approval → approved → scheduled → running → completed ; + paused, rejected, failed (§10). |
| `campaign_assets` | campaign_id, kind, content, version, approval_status, approved_by/at | implicite | Toute modif après approbation → pending_approval (§10). |
| `audience_segments` | définition et conditions, estimation de taille | implicite | Snapshot figé avant envoi (§7, §10) ; table de snapshot non listée (E9). |
| `consent_events` | contact_id, channel, purpose, source, proof, captured_at, revoked_at | implicite | Une révocation met à jour `do_not_contact` immédiatement et stoppe les jobs en attente (§9.3). |
| `agent_runs` | agent_type, input_ref, output_ref, model, token_usage, status, reviewer_id | implicite | Doit aussi tracer prompt_version, coût approximatif, sources du contexte, décision du relecteur (§9.5). |
| `jobs` | kind, payload_ref, status, attempts, next_run_at, lease_until, idempotency_key | implicite | Lease, retry avec backoff, `dead_letter` (§6). |
| `webhook_events` | provider, external_event_id, received_at, processed_at, status, payload_ref | implicite | Déduplication ; tenant déduit de l'identité du compte fournisseur (§8, §11). |
| `audit_logs` | acteur, entreprise, action, entité, avant/après (secrets masqués), IP, timestamp | listé (« الشركة ») | Non modifiable via l'interface (§11). Pas de textes IA ni payloads sensibles. |
| `metric_daily` | organization_id, project_id, date, indicateurs calculés + source | listé | Source/type par chiffre (§10). |

**Tables / entités citées mais non définies dans §7** (détail dans `gaps-and-questions.md`) : pipeline et étapes, tâches, landing pages, base de connaissance, templates WhatsApp, compteurs d'usage, sessions de support, règles d'assignation, mapping de champs CRM, snapshots d'audience/segment, catalogue de plans, événements métier (`events`, §6 « jobs / events / audit »).

**Contraintes d'intégrité exigées** : isolation par `organization_id` ; unicité des adhésions ; unicité `(organization_id, external_source, external_id)` ; `external_message_id` unique par fournisseur et entreprise (§9.3) ; cohérence `messages.organization_id` = celui de la conversation ; lead et projet de la même organisation ; idempotency_key sur jobs et messages de campagne ; pas de double comptage de conversions par webhooks répétés (§10).

---

## D. Parcours

### D1. Capture de lead (§9.1)
1. Le formulaire envoie e-mail/téléphone, projet, UTM, texte de consentement et sa version.
2. L'API valide la source, normalise téléphone et e-mail, cherche un contact **dans la même entreprise**.
3. Création/mise à jour de `contact`, `lead`, `consent_event` dans **une seule transaction**, puis événement d'assignation.
4. Règle d'assignation → commercial ; en cas d'échec, le lead va en file « non assigné » et le manager est alerté.
5. L'adaptateur CRM pousse/tire via un mapping de champs enregistré et un `external_id` ; résolution de conflit par `source_of_truth` de champ et date de dernière modification.
6. Résultat de sync et cause d'échec visibles ; retry et re-liaison manuelle.
Contrainte : pas de sync bidirectionnelle sans règles de conflit documentées ; CRM interne = source de vérité si l'API Fusion Leap CRM n'est pas stable ; CSV import/export.

### D2. E-mail (§9.2)
Fournisseur unique pour le MVP (SMTP/API pro, ou Gmail OAuth selon la réponse Q2). Gmail : plus petit scope (`gmail.send` pour l'envoi ; la réception exige un autre scope et une revue Google). Jetons chiffrés via `secret_ref`, rafraîchis côté serveur. Marketing : consentement adapté à la finalité, lien de désinscription, identité d'expéditeur claire, contrôle `do_not_contact` et rebonds, limites de débit par entreprise. Entrant : rattaché à contact/conversation par identifiants fournisseur et headers, avec plan pour les cas ambigus. « Delivered » seulement sur événement fournisseur, pas sur l'acceptation de l'API.

### D3. WhatsApp (§9.3)
Cloud API officielle, un compte/numéro ou une autorisation par entreprise ; jamais WhatsApp Web. Vérification de propriété du compte, état du numéro, permissions de l'app, webhook et signature ; `external_message_id` unique. Message initié hors fenêtre de conversation → template approuvé (template_id/version/langue enregistrés, échec tracé). Révocation de consentement / demande d'arrêt → `consent_events` + `do_not_contact` immédiats, jobs en attente stoppés ; contrôle final juste avant l'appel fournisseur. Inbox unifiée avec statuts livré/lu, transfert à un humain, pas de double réponse IA/humain.

### D4. Salla (§4.2–4.3, §9.4)
Séparation stricte entre **marketing interne des apps/thèmes Fusion Leap** (sans permission boutique) et **données d'une boutique marchande réelle** (app + OAuth + scopes). Enregistrer `store_id` et la relation boutique ↔ entreprise/projet ; renouvellement des jetons ; jetons en coffre de secrets uniquement. Événements `app.installed`/`app.uninstalled` + événements boutique nécessaires, webhook vérifié ; à la désinstallation, arrêt de sync et conservation/suppression selon la politique. Indicateurs d'installation/achat/revenu seulement si les scopes le permettent. Publication d'app/thème : hors MVP.

### D5. Agents IA (§9.5)
Cinq agents : Research (brouillon interne), Campaign (brouillon en attente d'approbation), Lead Qualification (suggestion, ne rejette jamais un client automatiquement), Reply (envoi humain uniquement), Analyst (ne modifie aucun budget). Contexte isolé par entreprise et projet, sans secrets ni données inutiles. Traçabilité : `prompt_version`, modèle, coût approximatif, sources de contexte, décision du relecteur, résultat. Messages clients et pages externes = entrées non fiables, sans pouvoir d'appel d'outils. Budget d'usage et limite de temps par entreprise. Pas de données clients réelles envoyées à un modèle externe avant documentation des CGU/rétention/consentement. MCP optionnel : outils nommés avec schéma (`get_lead_context`, `draft_reply`, `create_followup_task`), lecture seule d'abord, mutations via service de permissions + approbation + audit, jamais de `service_role` ni de secrets fournisseur.

### D6. Cycle de vie d'une campagne (§10, §8)
`draft → pending_approval → approved → scheduled → running → completed` (+ `paused`, `rejected`, `failed`). Endpoints : create (draft) → `submit` (pending_approval) → `approve` (gel du snapshot d'audience + audit) → `schedule` (fuseau IANA, canal connecté, jobs créés après contrôle des consentements). Toute modification du contenu ou du segment après approbation ramène en `pending_approval`. Snapshot d'audience et hachage d'envoi à la planification ; arrêt immédiat si l'approbation est retirée ou l'intégration désactivée. Chaque message : `campaign_id`, `segment_snapshot_id`, `idempotency_key`. Mesures : UTM unifiés ; événements `lead_created`, `qualified`, `meeting_booked`, `deal_won/lost`, `message_sent/delivered/replied`, `app_installed` ; coût par lead = dépense / nb de leads sur une période et un canal connus, sinon « non disponible ».

---

## E. Invariants de sécurité et de conformité (vérifiables)

Numérotation alignée sur `docs/plan/provided-plan.txt` §1.1, avec compléments tirés des §6, §7.2, §8, §11.

1. Aucun n8n dans le produit ni l'architecture ; tâches de fond dans les services applicatifs + worker séparé (§1).
2. MCP n'est ni une file de jobs ni un moteur de permissions ; passerelle d'outils optionnelle, lecture seule d'abord (§1, §6).
3. `organization_id uuid not null` + index sur toute table tenant ; PK UUID (§7).
4. RLS sur toute table exposée à la Data API ; politiques séparées lecture/écriture/suppression ; USING + WITH CHECK ; contrôle du rôle ; `TO authenticated` seul ne suffit pas (§7.2, §11).
5. Jamais `user_metadata` pour décider d'une autorisation ; la source du rôle est `organization_members` (§7.2).
6. Double contrôle d'autorisation : couche service + base de données ; le serveur ne fait jamais confiance à un `organization_id` envoyé seul (§8, §11).
7. `service_role` uniquement serveur/worker, jamais navigateur ni `NEXT_PUBLIC_*` ; logique tenant explicite même quand RLS est contournée (§6, §11).
8. Aucun envoi externe sans approbation d'un utilisateur habilité au MVP ; l'IA ne fait que des brouillons (§5.7, §9.5).
9. Webhooks : signature/secret vérifiés, horodatage si dispo, limite de taille, déduplication, ACK rapide, traitement différé ; tenant déduit de l'identité du compte fournisseur, jamais d'un champ libre (§8, §11).
10. Contrôle final avant chaque appel fournisseur : consentement, `do_not_contact`, template, limites de débit (§9.2, §9.3).
11. WhatsApp uniquement via Cloud API officielle (§9.3).
12. Secrets chiffrés via `secret_ref` ; pas de jeton brut en base, logs ou `audit_logs` ; rotation et séparation des environnements (§7, §11).
13. Toute modification post-approbation d'une campagne la renvoie en `pending_approval` ; arrêt immédiat si approbation retirée (§10).
14. Chaque chiffre affiche source, dernière mise à jour et type ; « non disponible » si coût inconnu (§10).
15. Les tests RLS ne sont jamais reportés en fin de projet (§12).
16. Données isolées aussi dans Storage (policies, fichiers, URL signées), exports, recherche (§7.2, §11, §13.1).
17. `audit_logs` non modifiable par l'interface ; couvre adhésions, intégrations, approbations, envois, exports, support admin, suppressions (§11).
18. Les messages entrants et pages externes sont des entrées non fiables pour l'IA ; un prompt injecté ne déclenche aucun outil ni fuite inter-tenant (§9.5, §13.8).
19. Pas de données clients réelles envoyées à un modèle externe avant documentation CGU/rétention/consentement (§9.5).
20. Rate limiting des API, validation des entrées, CSRF si applicable, en-têtes de sécurité, contrôle des fichiers uploadés (§11).
21. Arrêt d'urgence d'envoi par entreprise et par canal ; sauvegarde/restauration testées ; monitoring (§11, §13.10).
22. Migrations réversibles, une par étape de phase (§12).
23. Un enregistrement ne change pas d'entreprise par UPDATE direct (§2).
24. Accès Platform Admin aux données client uniquement via session de support journalisée et limitée dans le temps (§2).

---

## F. Critères d'acceptation (§13) et scénarios réalistes

### Les 10 critères
1. **Isolation** : A ne voit, modifie ni exporte rien de B (enregistrement, fichier, message, rapport), même en changeant l'ID dans la requête ; tests UI + API + RLS + worker.
2. **Rôles** : Analyst n'envoie pas ; Sales Agent ne modifie pas les intégrations ; Marketing Manager n'envoie qu'après approbation selon la politique ; Owner gère les adhésions.
3. **Capture** : deux soumissions identiques dans une même entreprise ne créent pas deux contacts ; deux entreprises avec le même e-mail restent séparées ; source, UTM, consentement conservés.
4. **CRM** : lead → deal gagné visible avec historique d'activités ; échec de sync visible et relançable sans doublon.
5. **E-mail** : un message de test approuvé part de l'identité de l'entreprise, apparaît dans la conversation, ID fournisseur et résultat stockés ; la désinscription bloque l'envoi suivant.
6. **WhatsApp** : connexion de test officielle reçoit le webhook et rattache la réponse ; template et statut d'approbation contrôlés avant message initié ; un doublon n'apparaît pas deux fois.
7. **Campagnes** : modifier une version approuvée la renvoie en relecture ; pause stoppe les jobs non envoyés ; compteurs planifié/envoyé/échoué exacts.
8. **IA** : un brouillon ne s'envoie pas seul ; raison et sources de la qualification visibles ; un prompt dans un message entrant ne peut ni appeler un outil de modification ni révéler des données d'une autre entreprise.
9. **SaaS** : une nouvelle entreprise crée un projet, invite un membre, connecte un canal sans intervention en base ; limites de plan appliquées ; usages non mélangés.
10. **Exploitation** : retry et `dead_letter` observables ; sauvegarde et restauration testées ; runbook et arrêt d'urgence d'envoi.

### Les 5 scénarios d'acceptation réalistes
1. Deux entreprises, un utilisateur commun avec deux rôles, deux projets par entreprise.
2. Import de 100 leads avec doublons et formats de téléphone variés, puis vérification de l'assignation et des rapports.
3. Mini-campagne e-mail vers une liste test consentante, puis désinscription en cours d'exécution.
4. Conversation WhatsApp initiée par le client et une autre initiée par template approuvé, avec webhook dupliqué et panne fournisseur temporaire.
5. Changement d'entreprise pendant une session ouverte, puis tentative d'accès à un lien profond de l'entreprise précédente.

---

## G. Points d'attention de lecture croisée spec ↔ plan fourni

- Le plan fourni reprend fidèlement l'ordre de priorité du §5 et les six phases/gates du §12.
- Le plan retient 15 invariants ; ce document en liste 24 (les 15 du plan + 9 tirés de §2, §6, §11, §13). Pas de contradiction, ajout seulement.
- La spec ne donne aucune durée (§12 : « estimée après la phase 0 »). Les 63 jours / 378 h du plan sont une **hypothèse du plan**, à confirmer à la gate G0.
- La spec est en arabe et prévoit une interface arabe/anglaise (§6 : « واجهة عربية/إنجليزية ») ; le plan n'a pas de journée i18n/RTL dédiée (voir gap G-X2).
