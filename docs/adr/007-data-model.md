# ADR 007 — Modèle de données réconcilié

- **Statut :** Proposed — décisions E1–E12 / G-D / G-R reprises des propositions par défaut du Jour 0 (validées globalement par « PLAN VALIDÉ », à relire ligne à ligne)
- **Date :** 2026-11-10
- **Section de spec :** §7, §7.1, §7.2, §9, §10, §11 ; analyses : `docs/analysis/gaps-and-questions.md`
- **ERD :** `docs/architecture/erd.md`

## 1. Règles communes (T)
Toute table **tenant** porte (« colonnes T ») : `id uuid pk default gen_random_uuid()`, `organization_id uuid not null → organizations(id)`, `created_at`, `updated_at` (trigger), `unique (organization_id, id)` (cible des FK composites), index `(organization_id)`. Toute FK entre tables tenant est **composite** `(organization_id, x_id)`. Trigger anti-transfert (ADR 005 §3). RLS activée, politiques par opération, jamais `user_metadata`. Rôles : OWN/ADM/MKT/SAL/ANA (ADR 014). `own` = `assignee_id = auth.uid()`.

Les entrées marquées **[ajout ADR]** sont des tables ou colonnes absentes de la spec §7, introduites pour résoudre l'écart indiqué entre crochets.

## 2. Décisions sur les écarts
| Écart | Décision |
|---|---|
| E1 | `pipelines` + `pipeline_stages` par organisation ; `leads.stage_id` et `deals.stage_id` en FK composite. La colonne spec `pipeline_stage`/`stage` devient `stage_id`. |
| E2 | Pas de table `tasks` : `activities.type = 'task'` avec `due_at`/`completed_at`. |
| E3 | `landing_page_id` = texte libre stocké dans `leads.utm` (clé `landing_page_id`) ; pas de table. |
| E4 | Table `knowledge_items`. |
| E5 | Table `message_templates`. |
| E6 / G-D12 | Table `usage_counters (organization_id, period_start, metric, value)`. `ai_runs` et `ai_cost_micros` sont des métriques. |
| E7 | Table `support_sessions` + `private.platform_admins`. |
| E8 | Tables `assignment_rules` et `crm_field_mappings`. |
| E9 | Un seul nom `segment_snapshot_id`; table `segment_snapshots` immuable. `campaigns.audience_snapshot_id` de la spec devient `campaigns.segment_snapshot_id`. |
| E10 / G-D1 | `organizations.plan_id` **supprimé** ; `subscriptions` est la source unique ; catalogue `plans` (limites en jsonb). |
| E11 | `organization_id` ajouté partout. |
| E12 | FK composites partout (ADR 005). |
| G-D2 | Les « `*_ref` » de la spec deviennent des colonnes `jsonb` **sans secret** (`payload`, `input`, `output`) ; les contenus volumineux (média, pièce jointe) vont en Storage avec leur chemin. Les jobs ne portent que des identifiants de lignes. |
| G-D3 | `external_source` / `external_id` ajoutés sur `contacts`, `leads`, `deals` ; `unique (organization_id, external_source, external_id) where external_id is not null`. |
| G-D4 | `consent_events` = source de vérité ; `contacts.consent_status` est dérivé (maintenu par trigger/service) pour le filtrage rapide. |
| G-D5 | Table `suppressions` (rebonds, plaintes, désinscriptions) en plus de `consent_events`/`do_not_contact`. |
| G-D6 | Table `domain_events` (mesures et déclencheurs) ; `meeting_booked` = `activities.type='meeting'`. |
| G-D7 | Pas de table pour les liens UTM au MVP (génération à la volée). |
| G-D8 | `organizations.settings jsonb` (marque, politique de consentement par défaut, heures ouvrées, `approval_policy`, `send_paused`) ; `slug` = sous-domaine. |
| G-D9 | Table `rate_limit_buckets` (token bucket en base). |
| G-D10 | `audit_logs` append-only (REVOKE UPDATE/DELETE + trigger de refus). |
| G-D11 | Bucket privé `assets`, chemin `{organization_id}/{project_id}/…`. Types/taille : images (png, jpeg, webp) ≤ 5 Mo, PDF ≤ 10 Mo, CSV ≤ 10 Mo ; magic bytes vérifiés (J57). |
| G-R4 | `private.platform_admins (user_id)`. |
| G-R6 | `unique (provider, external_account_id)` **global** sur `integrations`. |
| G-R7 | Création d'entreprise par fonction transactionnelle `security definer`. |
| G-R8 | Table `invitations`. |
| Notifications | Alertes in-app (§5.8, assignation échouée, quotas) : table `notifications` **[ajout ADR]**. |

## 3. Enums
`app_role` (company_owner, company_admin, marketing_manager, sales_agent, analyst) · `member_status` (invited, active, suspended, removed) · `org_status` (active, suspended, closed) · `subscription_status` (trial, active, past_due, suspended, cancelled) · `project_type` (website_sales, salla_app, salla_theme, custom) · `project_status` (active, archived) · `channel_type` (email, whatsapp, web_form, crm, salla) · `consent_status` (granted, revoked, unknown) · `stage_kind` (open, won, lost, unassigned) · `activity_type` (note, call, email, task, meeting, stage_change, assignment) · `conversation_state` (open, pending, closed, to_triage) · `message_direction` (inbound, outbound) · `message_status` (queued, accepted, sent, delivered, read, failed, bounced, cancelled) · `campaign_status` (draft, pending_approval, approved, scheduled, running, completed, paused, rejected, failed) · `approval_status` (draft, pending, approved, rejected) · `job_status` (queued, running, succeeded, failed, dead_letter, cancelled) · `webhook_status` (received, processing, processed, ignored, failed) · `agent_type` (research, campaign, lead_qualification, reply, analyst) · `agent_run_status` (running, succeeded, failed, blocked, timeout) · `integration_status` (pending, active, error, disabled, disconnected).

## 4. Tables

### 4.1 Noyau tenant et administration
**organizations** (pas de colonne `organization_id`; racine) — `id`, `name`, `slug unique`, `status org_status`, `timezone` (IANA), `locale` (`ar|en`), `settings jsonb`, timestamps. RLS : select membre actif ; update OWN/ADM ; insert/delete uniquement via fonctions (création) / Platform Admin.

**organization_members** — T, `user_id → auth.users`, `role app_role`, `status`, `invited_by`. `unique (organization_id, user_id)` ; index `(user_id, organization_id)`. RLS : select propre ligne ou OWN/ADM ; insert/update/delete OWN/ADM avec règles ADR 014 (jamais attribuer/retirer OWN pour ADM) ; dernier OWN non supprimable (trigger).

**invitations** [G-R8, ajout ADR] — T, `email_normalized`, `role`, `token_hash unique`, `expires_at`, `accepted_at`, `invited_by`. RLS : OWN/ADM ; acceptation par fonction serveur.

**plans** [G-D1, ajout ADR] — pas tenant (catalogue) : `id`, `code unique`, `name`, `limits jsonb` (users, projects, contacts, messages_per_month, ai_runs, integrations), `active`. RLS : lecture authentifiée ; écriture Platform Admin.

**subscriptions** — T (1 active/org), `plan_id → plans`, `status subscription_status`, `period_start`, `period_end`, `limits_override jsonb`, `decided_by`, `decision_reason`. RLS : select OWN/ADM ; écriture Platform Admin uniquement (audit).

**usage_counters** [E6] — T, `metric`, `period_start`, `value bigint`; `unique (organization_id, metric, period_start)`. Incrément atomique par fonction. RLS : select OWN/ADM ; écriture service.

**private.platform_admins** [G-R4, ajout ADR] — `user_id pk`, `created_at`. Aucun GRANT à `authenticated`.

**support_sessions** [E7] — T (organisation consultée), `admin_id`, `reason`, `approved_by` (OWN/ADM de l'entreprise), `starts_at`, `expires_at`, `ended_at`. RLS : select OWN/ADM de l'entreprise + l'admin concerné ; l'accès Platform Admin aux tables tenant n'est ouvert que si une session `now() between starts_at and expires_at` existe.

**audit_logs** — T, `actor_id`, `actor_kind` (user|system|support), `action`, `entity_type`, `entity_id`, `before jsonb`, `after jsonb` (secrets masqués), `ip`, `request_id`, `created_at`. Append-only. RLS : select OWN/ADM ; insert par fonction.

**idempotency_keys** — T, `key`, `request_hash`, `response jsonb`, `status_code`, `expires_at`; `unique (organization_id, key)`.

**notifications** [ajout ADR] — T, `recipient_id` (nullable = tous les ADM), `kind`, `payload jsonb`, `read_at`. RLS : le destinataire ; OWN/ADM pour les alertes d'organisation.

**rate_limit_buckets** [G-D9, ajout ADR] — T nullable (global par fournisseur) : `provider`, `bucket_key`, `tokens`, `refilled_at`. Écriture service uniquement.

### 4.2 Projets et CRM
**projects** — T, `type project_type`, `name`, `status`, `owner_id`, `settings jsonb` (schéma zod par type). RLS : select tous les rôles (§2) ; insert/update/delete OWN/ADM ; quota vérifié par la couche service.

**products** — T, `project_id`, `kind`, `offer`, `price_hint`, `landing_url`, `assets jsonb` (chemins Storage). FK composite projet. RLS : comme projects.

**pipelines** [E1, ajout ADR] — T, `name`, `is_default`. **pipeline_stages** [E1] — T, `pipeline_id`, `name`, `position`, `kind stage_kind`; une étape `unassigned` système par pipeline. RLS : select membres ; écriture OWN/ADM.

**contacts** — T, `name`, `email_normalized`, `email_raw`, `phone_e164`, `language`, `country`, `consent_status` (dérivé), `do_not_contact bool`, `external_source`, `external_id`, `attributes jsonb`. Index **uniques partiels** `(organization_id, email_normalized) where email_normalized is not null` et `(organization_id, phone_e164) where phone_e164 is not null` : ils garantissent en base qu'aucune course entre deux soumissions identiques ne crée deux contacts (§13-3). Ils ne font pas de l'e-mail l'identifiant unique (spec §7) : un contact peut n'avoir qu'un téléphone, et si l'e-mail correspond à un contact et le téléphone à un autre, la règle de domaine `findDuplicate` ne fusionne pas seule et place le cas dans une file de revue. Unique aussi `(organization_id, external_source, external_id) where external_id is not null`. RLS : select OWN/ADM/MKT, SAL (`own` via leads assignés), ANA ✘ ; écriture OWN/ADM/MKT, SAL pour ses leads.

**consent_events** — T, `contact_id`, `channel channel_type`, `purpose`, `source`, `proof jsonb` (texte et version du consentement, IP, URL), `captured_at`, `revoked_at`. Append-only logique (révocation = nouvel événement ou `revoked_at`). RLS : select comme contacts ; insert service/OWN/ADM/MKT.

**suppressions** [G-D5, ajout ADR] — T, `channel`, `value_normalized`, `reason` (bounce|complaint|unsubscribe|manual), `source_message_id`; `unique (organization_id, channel, value_normalized)`. Écriture service ; select OWN/ADM/MKT.

**leads** — T, `contact_id`, `project_id`, `source`, `stage_id`, `score`, `score_reason jsonb`, `assignee_id`, `campaign_id` (nullable), `utm jsonb`, `external_source`, `external_id`, `landing_page_id` dans `utm`. FK composites contact/projet/étape/campagne. RLS : select OWN/ADM/MKT, SAL `own`, ANA ✘ ; insert OWN/ADM/MKT/SAL (assigné à soi) ; update OWN/ADM, SAL `own`.

**deals** — T, `lead_id`, `stage_id`, `value numeric(14,2)`, `currency`, `expected_close_at`, `won_at`, `lost_at`, `external_*`. Contrainte : `won_at` et `lost_at` exclusifs ; cohérents avec `stage.kind`. RLS : comme leads.

**activities** — T, `lead_id`, `contact_id`, `type activity_type`, `owner_id`, `due_at`, `completed_at`, `metadata jsonb`. RLS : comme leads ; automatique à chaque changement d'étape/assignation.

**assignment_rules** [E8, ajout ADR] — T, `project_id` nullable, `strategy` (round_robin|fixed), `eligible_member_ids uuid[]`, `cursor`, `active`. RLS : OWN/ADM.

**crm_field_mappings** [E8, ajout ADR] — T, `integration_id`, `entity`, `internal_field`, `external_field`, `source_of_truth` (internal|external), `direction`. RLS : OWN/ADM.

**form_keys** [ajout ADR, J21] — T, `project_id`, `key_hash`, `allowed_origins text[]`, `active`. RLS : OWN/ADM ; la clé claire n'est affichée qu'à la création.

### 4.3 Intégrations, canaux, messagerie
**private.secrets** — voir ADR 004 (hors Data API).

**integrations** — T, `provider`, `status integration_status`, `external_account_id`, `scopes text[]`, `secret_ref → private.secrets`, `last_sync_at`, `last_error`. `unique (provider, external_account_id)` global. RLS : select OWN/ADM (sans colonne secret) ; écriture via fonctions serveur.

**channels** — T, `type channel_type`, `integration_id`, `sender_identity`, `status`, `project_scope uuid[]`, `send_paused bool`. RLS : select OWN/ADM ; écriture OWN/ADM.

**message_templates** [E5, ajout ADR] — T, `channel_id`, `provider`, `name`, `version`, `language`, `category`, `status` (pending|approved|rejected|paused), `components jsonb`; unique `(organization_id, channel_id, name, language, version)`.

**conversations** — T, `contact_id`, `channel_id`, `assignee_id`, `state conversation_state`, `last_message_at`, `handled_by` (human|ai_suggest), `lock_owner`, `lock_expires_at`. RLS : select OWN/ADM, SAL `own` ; update idem.

**messages** — T, `conversation_id` (FK composite → cohérence d'organisation), `direction`, `provider_message_id`, `body`, `status`, `sent_at`, `received_at`, `error_code`, `campaign_id`, `segment_snapshot_id`, `template_id`, `template_version`, `template_language`, `idempotency_key`, `approved_by`, `approved_at`. `unique (organization_id, channel_id, provider_message_id)`. `unique (organization_id, idempotency_key)`. Corps jamais journalisé. RLS : comme conversations.

**webhook_events** — T (résolu depuis le compte fournisseur), `provider`, `external_event_id`, `received_at`, `processed_at`, `status webhook_status`, `payload jsonb` (sans en-têtes d'authentification), `signature_valid`. `unique (provider, external_event_id)`. Service uniquement ; select OWN/ADM (métadonnées).

**jobs** — voir ADR 003. RLS : select OWN/ADM (page Exploitation) ; écriture service.

### 4.4 Campagnes
**audience_segments** — T, `project_id`, `name`, `definition jsonb` (DSL zod), `estimated_size`. RLS : OWN/ADM/MKT.

**segment_snapshots** [E9, ajout ADR] — T, `segment_id`, `contact_ids uuid[]`, `count`, `hash`, `created_at`; **immuable** (trigger). RLS : select OWN/ADM/MKT.

**campaigns** — T, `project_id`, `objective`, `channel`, `status campaign_status`, `segment_id`, `segment_snapshot_id`, `scheduled_at`, `timezone`, `budget`, `currency`, `version`, `submitted_by`, `approved_by`, `approved_at`, `counters` calculés depuis `messages`. RLS : select OWN/ADM/MKT/ANA ; écriture OWN/ADM/MKT ; transitions via machine d'états.

**campaign_assets** — T, `campaign_id`, `kind`, `content jsonb`, `version`, `approval_status`, `approved_by`, `approved_at`, `created_by`, `source` (human|ai). Les versions sont des lignes distinctes.

**campaign_spend** [ajout ADR, J46] — T, `campaign_id`, `period_start/end`, `channel`, `amount numeric`, `currency`, `source` (manual_import).

### 4.5 IA, mesures
**agent_runs** — T, `agent_type`, `project_id`, `prompt_version`, `model`, `input jsonb` (références et métadonnées, pas de PII brute), `output jsonb`, `context_sources jsonb`, `token_usage jsonb`, `cost_micros`, `status`, `reviewer_id`, `review_decision`, `started_at`, `finished_at`. RLS : select OWN/ADM + l'utilisateur demandeur ; écriture service.

**knowledge_items** [E4, ajout ADR] — T, `project_id` nullable, `title`, `content`, `source`, `status`. RLS : OWN/ADM/MKT écriture ; lecture agents via service.

**domain_events** [G-D6, ajout ADR] — T, `type` (lead_created, qualified, meeting_booked, deal_won, deal_lost, message_sent, message_delivered, message_replied, app_installed), `entity_id`, `occurred_at`, `natural_key unique par organisation` (anti double comptage), `payload jsonb`.

**metric_daily** — T, `project_id`, `date`, `metrics jsonb`, `source_kind` (direct|imported|computed), `computed_at`; `unique (organization_id, project_id, date)`. RLS : select OWN/ADM/MKT/ANA.

### 4.6 Différé / sous feature flag
`salla_stores` (store_id ↔ organisation/projet) : créée seulement si l'option OAuth du J55 est retenue.

## 5. Contrôles automatiques
- « Schema lint » : chaque table `public` a `organization_id not null`, index, RLS, politiques par opération.
- Tests RLS par table : utilisateur × entreprise × CRUD + changement d'`organization_id`.
- Triggers : `updated_at`, anti-transfert, immuabilité (`audit_logs`, `segment_snapshots`), cohérence d'état (deals won/lost).

## 6. Conséquences
Le modèle ajoute ~14 tables à la spec §7 (toutes marquées « ajout ADR »). Chaque ajout a son origine (E/G/section). Toute table non listée ici nécessite un nouvel ADR.

## Mise en œuvre J6 (2026-11-06)
Tables créées : `plans` (catalogue global ; ligne `trial` sans limites, valeurs au J14 car la spec n'en donne pas), `organizations`, `organization_members`, `subscriptions` (une ligne par entreprise), `usage_counters` ; enums `app_role` (5 valeurs), `member_status`, `org_status`, `subscription_status`. Écarts avec l'ADR : `plans` créé au J6 (au lieu du J14) pour porter la FK de `subscriptions.plan_id` ; `private.platform_admins` reste prévu au J14. Le « schema lint » (J7) devra autoriser explicitement les tables sans `organization_id` : `organizations` (racine) et `plans` (catalogue global).

## Mise en œuvre J11 (2026-11-06)
- `idempotency_keys` : ajouts `actor_id`, `state` (`in_progress` | `completed`), `attempt_id` ; aucune politique RLS et aucun GRANT : accès uniquement par fonctions `security definer`. Unicité `(organization_id, key)`.
- `rate_limit_buckets` : `organization_id` reste nullable (ADR 007 G-D9) avec `check (organization_id is not null or provider is not null)` ; exemption justifiée dans le schema lint (règle L1). Écriture réservée à `service_role`. Deux seaux par appel : (organisation, utilisateur) et global par utilisateur (organisation NULL, fournisseur `user_scope`).
- Purge : `idempotency_purge` et `rate_limit_purge` (service_role) ; planification avec le worker (J13).
