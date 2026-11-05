# Écarts, incohérences, questions et risques — Fusion Leap AI Growth

Légende : **Spec dit** = fait vérifiable dans `docs/spec/…Technical-Spec.md` ; **Proposition** = suggestion de l'agent, non validée. Rien dans la colonne Proposition n'est une exigence tant qu'un ADR « Accepted » ne la reprend (Jour 1).

Les écarts E1–E12 sont ceux annoncés dans le plan fourni (`docs/plan/provided-plan.txt` §1.3). Chacun a été **revérifié contre la spec** ; les nuances sont indiquées. Les écarts **G-xx** sont de nouveaux constats.

---

## 1. Entités ou règles utilisées mais non modélisées

| # | Constat (Spec dit) | Réf. | Proposition par défaut |
|---|---|---|---|
| **E1** | « Étapes configurables » (§5.3) ; `deals.pipeline_stage` et `leads.stage` sont des champs sans table de pipeline. | §5.3, §7 | Tables `pipelines` et `pipeline_stages` par organisation ; `stage` devient FK composite. |
| **E2** | « Tâches » au MVP (§5.3) sans table. *Nuance : `activities` porte déjà `due_at`, `completed_at`, `owner_id` (§7), donc c'est cohérent avec une tâche.* | §5.3, §7, §9.1 | `activities.type = 'task'` avec `due_at`/`completed_at` (pas de table `tasks`). |
| **E3** | `landing_page_id` envoyé par le formulaire (§4.1), aucune table de landing pages ; `products.landing_url` existe. | §4.1, §7 | Valeur texte libre dans `leads.utm`/metadata au MVP, pas de table. |
| **E4** | Reply Agent s'appuie sur une « base de connaissance de l'entreprise » ; non modélisée. | §9.5 | Table `knowledge_items` (organization_id, project_id nullable, titre, contenu, source, statut). |
| **E5** | Templates WhatsApp : `template_id/version/language` enregistrés, statut d'approbation contrôlé ; pas de table. | §9.3 | Table `message_templates` (provider, name, version, language, status, channel_id). |
| **E6** | Consommation « par entreprise et par cycle » ; limites sur utilisateurs, projets, contacts, messages/mois, runs IA, intégrations ; pas de table de compteurs. | §10 | Table `usage_counters (organization_id, period, metric, value)`. |
| **E7** | Session de support Platform Admin « enregistrée et limitée dans le temps après autorisation » ; non modélisée. | §2, §11 | Table `support_sessions` (admin, organization_id, autorisé par, début/fin, motif) + audit obligatoire. |
| **E8** | Règles d'assignation et « table de mapping de champs enregistrée » + `source_of_truth` par champ (§9.1) ; non modélisées. | §9.1 | Tables `assignment_rules` et `crm_field_mappings`. |
| **E9** | `campaigns.audience_snapshot_id` (§7) vs `segment_snapshot_id` sur les messages (§10) : deux noms, aucune table de snapshot. | §7, §10 | Un seul nom `segment_snapshot_id` ; table `segment_snapshots` immuable. |
| **E10** | `organizations.plan_id` (§7) **et** `subscriptions.plan` : double source de vérité. | §7 | `subscriptions` source unique ; `plan_id` retiré ou dérivé ; catalogue `plans` à définir (G-D1). |
| **E11** | Seules quelques tables listent `organization_id` dans le tableau §7. *Nuance : en réalité presque toutes l'omettent dans le tableau (products, contacts, leads, deals, activities, integrations, channels, conversations, messages, campaigns, campaign_assets, audience_segments, consent_events, agent_runs, jobs, webhook_events) ; la règle générale §7 et le texte sur `messages` les rendent obligatoires.* | §7 | Ajout systématique de `organization_id uuid not null` + index sur toute table tenant ; le plan ne cite que 3 tables, l'ADR 007 doit les couvrir toutes. |
| **E12** | « Lead et projet de la même organisation » exigé mais mécanisme non précisé ; idem `messages` ↔ `conversations`. | §7, §7.1 | Clés uniques `(organization_id, id)` + FK composites `(organization_id, project_id)` partout. |

### Nouveaux écarts

| # | Constat (Spec dit) | Réf. | Proposition par défaut |
|---|---|---|---|
| **G-D1** | « Plans » et « limites modifiables » (§10) mais pas de table de plans ni de quotas ; `subscriptions` embarque « limites d'usage ». | §7, §10 | Table `plans` (limites jsonb) + `subscriptions.plan_id` ; décision liée à E10. |
| **G-D2** | `payload_ref`, `input_ref`, `output_ref` : le « ref » n'est pas défini (colonne jsonb ? objet Storage ? table séparée ?). Impacte aussi l'interdiction des payloads sensibles dans les logs. | §7, §11 | Décision ADR : payload en jsonb chiffré/minimisé dans la table, ou objet Storage avec politique tenant. |
| **G-D3** | `contacts` n'a pas `external_source`/`external_id`, alors que l'unicité `(organization_id, external_source, external_id)` est recommandée pour les données importées. | §7 | Ajouter ces colonnes à `contacts` et `leads` (et aux autres entités synchronisées). |
| **G-D4** | `consent_status` (sur `contacts`) double `consent_events` (historique, par canal et finalité). Quelle source fait foi ? Consentement par canal ? | §7, §9.2 | `consent_events` = source de vérité ; `contacts.consent_status` dérivé (vue ou colonne maintenue par trigger). |
| **G-D5** | Aucune table pour les rebonds e-mail, plaintes, désinscriptions globales, ni suppression list, alors que §9.2 impose de les contrôler. | §9.2 | Table `suppressions` (organization_id, channel, valeur normalisée, raison) ou usage de `consent_events` + `do_not_contact`. |
| **G-D6** | Événements métier (`lead_created`, `qualified`, `meeting_booked`…) cités (§10), « jobs / events / audit » dans le schéma §6, mais aucune table `events`. `meeting_booked` n'a aucune entité (rendez-vous). | §6, §10 | Table `domain_events` ; `meeting_booked` = `activities.type='meeting'` (à confirmer). |
| **G-D7** | Liens de suivi UTM : « روابط UTM » dans les campagnes (§5.6) mais pas d'entité ; seule `leads.utm jsonb`. | §5.6, §10 | Génération d'URL à la volée à partir de `campaigns` ; pas de table au MVP. |
| **G-D8** | Paramètres d'entreprise cités en §4.4 (sous-domaine, identité de marque, politiques de consentement, heures de travail) mais `organizations` n'a ni `settings` ni sous-domaine ; `slug` seul existe. | §4.4, §7 | `organizations.settings jsonb` + `slug` = sous-domaine ; ADR sur routage par sous-domaine vs chemin. |
| **G-D9** | Limites de débit (par fournisseur et par entreprise, §6, §9.2) : où est stocké l'état (compteurs, fenêtres) ? | §6, §9.2 | Compteurs en base (table dédiée) ou Redis ; stack hors spec ⇒ ADR avant tout Redis. |
| **G-D10** | `audit_logs` « non modifiable via l'interface » : mécanisme non précisé (append-only par REVOKE UPDATE/DELETE, trigger, WORM). | §11 | REVOKE UPDATE/DELETE + trigger de refus ; INSERT par fonction `security definer`. |
| **G-D11** | Stockage de fichiers : buckets, structure de chemin par tenant, taille/type autorisés, durée des URL signées non définis. | §6, §11 | Chemin `{organization_id}/{project_id}/…` + policies Storage ; types/tailles à fixer par ADR. |
| **G-D12** | `ai_budget` : « budget d'usage et limite de temps par entreprise » (§9.5) ; stockage non défini (lié à E6). | §9.5 | Métrique dans `usage_counters` + limites dans `plans`. |

---

## 2. Règles de sécurité et de rôles ambiguës

| # | Constat | Réf. | Proposition |
|---|---|---|---|
| **G-R1** | Pas de matrice rôle × action complète ; 20+ cases de la matrice du document `spec-understanding.md` §B restent « ? » (ex. : qui approuve une campagne, qui peut lire les contacts non assignés, qui peut exporter). | §2, §13.2 | Matrice produite au Jour 1 (ADR 005/007), validée par la responsable technique. |
| **G-R2** | « Marketing Manager envoie seulement après approbation selon la politique » (§13.2) : qui approuve (lui-même ? Admin/Owner ?), qu'est-ce que « la politique » ? Séparation des tâches non précisée. | §2, §10, §13.2 | Politique d'approbation par organisation ; par défaut, l'approbateur ≠ l'auteur sauf Owner. À valider. |
| **G-R3** | Company Admin : « sans voir les secrets bruts des intégrations » ; Owner les voit-il ? Aucune interface n'est censée afficher un jeton (§11). | §2, §11 | Aucun rôle ne lit un secret brut ; les secrets sont write-only via UI. |
| **G-R4** | Platform Admin n'est pas un membre d'organisation : où est stocké ce rôle global (hors `user_metadata`, §7.2) ? Comment RLS le prend-il en compte ? | §2, §7.2 | Table `platform_admins` (hors schéma exposé) + accès uniquement via `support_sessions` (E7). |
| **G-R5** | `active_organization_id` « fixé à chaque requête » : mécanisme de transport (cookie, header, segment d'URL, claim JWT) non précisé. Un claim JWT serait périmé après changement d'entreprise. | §2 | Segment d'URL ou en-tête comparé à l'adhésion en base à chaque requête ; jamais lu depuis `user_metadata`. |
| **G-R6** | Les webhooks identifient le tenant via le compte fournisseur : `integrations.external_account_id` doit donc être **globalement unique par fournisseur**, alors que §7 recommande l'unicité par organisation. Conflit : deux entreprises connectant le même compte. | §7, §8, §11 | `unique (provider, external_account_id)` global ; comportement en cas de reconnexion à clarifier. |
| **G-R7** | Création d'une entreprise : `POST /api/orgs` donne l'adhésion Owner ; mais la RLS INSERT sur `organization_members` ne peut pas exiger une adhésion préexistante. | §8, §7.2 | Création via fonction `security definer` transactionnelle. |
| **G-R8** | Invitations : table non listée (token, e-mail invité, expiration). `organization_members.status` + `invited_by` suggèrent un statut `invited` mais l'e-mail invité n'est stocké nulle part. | §5.1, §7 | Table `invitations` (hash du token, expiration) — ajout ADR. |

---

## 3. Incohérences de nommage ou de source de vérité

| # | Incohérence | Réf. |
|---|---|---|
| N1 | `audience_snapshot_id` (campaigns) vs `segment_snapshot_id` (messages) → E9. | §7, §10 |
| N2 | `plan_id` (organizations) vs `plan` (subscriptions) → E10. | §7 |
| N3 | Noms de rôles : « Company Owner/Admin », « Platform Admin », « Sales Agent »… contre un enum `role` non défini ; le plan écrit « enum de rôles §2 ». Valeurs exactes à fixer (snake_case). | §2, §7 |
| N4 | Statuts de campagne en minuscules (`pending_approval`) mais aucun enum pour les autres entités (lead.stage, conversation.state, channel.status, integration.status, message.status, job.status). | §7, §10 |
| N5 | « Tâches » (§5.3) vs `activities` (§7) → E2. | §5.3, §7 |
| N6 | Le schéma §6 cite « jobs / events / audit », §7 liste `jobs` et `audit_logs` seulement → G-D6. | §6, §7 |
| N7 | §6 « table jobs **ou** file managée » : choix laissé ouvert, tranché par ADR 003. | §6 |
| N8 | §9.2 : « SMTP/API **ou** Gmail OAuth » : choix du fournisseur reporté après essai réel ⇒ ADR 008 dépend de Q2. | §9.2 |
| N9 | Spec (§12) ne donne aucune durée ; le plan fourni suppose 63 jours / 378 h. | §12 |

---

## 4. Questions Q1–Q5 (§14) et impact précis sur le plan

Hypothèse d'exécution de la spec jusqu'aux réponses : CRM interne source de vérité, un fournisseur e-mail, numéro WhatsApp de test officiel, Salla marketing sans lecture de boutique, plans SaaS activés à la main (§14).

| Q | Question | Impact si la réponse diffère de l'hypothèse | Jours concernés (plan fourni) | Réponse |
|---|---|---|---|---|
| **Q1** | Quel CRM existe chez Fusion Leap ? API, webhooks, doc, sandbox ? | Si API stable : écrire un adaptateur réel + mapping + règles de conflit (E8) ; sinon CRM interne + CSV. Pas de sync bidirectionnelle sans règles. | J2 (fiche CRM), phase 2 (adaptateur CRM) | **À fournir** |
| **Q2** | E-mail : Gmail/Workspace, fournisseur de campagnes, ou les deux ? Qui possède le domaine / SPF-DKIM-DMARC ? | Gmail ⇒ scopes OAuth + revue Google, réception d'e-mails (scope supplémentaire). Fournisseur d'envoi ⇒ webhooks de statut/rebonds. Domaine/DNS ⇒ délai de livrabilité. | ADR 008 (J2), phase 3 | **À fournir** |
| **Q3** | Compte WhatsApp Business Platform officiel et numéro de test ? Chaque entreprise connecte son compte, ou Fusion Leap fournit un numéro géré ? | Numéro géré ⇒ modèle multi-tenant d'un compte partagé, routage par numéro, facturation Meta ; chemin critique du plan (J34). | J2, J28–J41 | **À fournir** |
| **Q4** | Faut-il connecter une vraie boutique Salla au MVP ou seulement le marketing d'apps/thèmes ? Éligibilité partenaire/publication/encaissement ? | Boutique réelle ⇒ OAuth, scopes, `store_id`, webhooks `app.installed/uninstalled`, rétention (§9.4) et possible dépendance à l'agrément Salla. | J2, phase 5 | **À fournir** |
| **Q5** | Premier marché/pays, devise, politique de données et de facturation ? | Région d'hébergement Supabase, RGPD/PDPL (Arabie saoudite), TVA/devise, mentions légales de consentement, rétention. | ADR 005/006, phase 5 | **À fournir** |

---

## 5. Risques techniques (probabilité × impact, échelle 1–3)

| # | Risque | P | I | Score | Mitigation proposée |
|---|---|---|---|---|---|
| R1 | Fuite inter-tenant (RLS mal écrite, récursion `organization_members`, GRANT trop larges, `service_role` oublié) | 2 | 3 | **6** | Fonctions d'aide `security definer` dans schéma `private`, suite `test:rls` dès J7, revue GRANT/Data API, tests worker. |
| R2 | Accès WhatsApp / Meta non prêt (vérification d'entreprise, templates, numéro) | 3 | 3 | **9** | Demande dès J0, mode mock/MSW + numéro de test Meta, plan B documenté (ADR). |
| R3 | CRM Fusion Leap sans API stable | 2 | 2 | **4** | CRM interne + CSV (déjà l'hypothèse de la spec). |
| R4 | Revue Google (Gmail scopes) ou domaine/DNS (SPF/DKIM) en retard | 2 | 2 | **4** | Fournisseur d'envoi transactionnel d'abord ; Gmail ensuite. |
| R5 | Injection de prompt via messages entrants | 2 | 3 | **6** | Agents sans outils de mutation au MVP, contexte isolé, tests dédiés (critère §13.8). |
| R6 | Envoi non consenti ou double envoi (doublon webhook, retry, race pause/envoi) | 2 | 3 | **6** | Contrôle final avant appel fournisseur, `idempotency_key`, lease `SKIP LOCKED`, kill switch. |
| R7 | Webhooks forgés/rejoués ou rattachés au mauvais tenant | 2 | 3 | **6** | Signature, dédup, tenant par compte fournisseur (G-R6), tests T4. |
| R8 | Dérive de périmètre (hors MVP : publication Salla, facturation, achat média) | 2 | 2 | **4** | Audit de conformité à chaque gate (§15 du plan). |
| R9 | Calendrier : 6 h productives/jour supposées, 63 jours sans marge réelle | 3 | 2 | **6** | Buffers de fin de phase, suivi réel vs cible, procédure de blocage §13 du plan. |
| R10 | Coût et conformité du modèle IA (données clients envoyées à un tiers, CGU, rétention) | 2 | 3 | **6** | Données de test uniquement, contrat/CGU documentés avant toute donnée réelle, minimisation. |
| R11 | Interface arabe/anglaise (RTL, i18n) sous-estimée dans le plan | 2 | 2 | **4** | Décider i18n dès le scaffolding (J4) ; intégrer RTL aux critères d'écran. |
| R12 | Transitions de statuts incohérentes (campagne, conversation, job) sans enum ni machine d'états | 2 | 2 | **4** | Machines d'états dans `packages/domain`, tests de transitions (plan J49–J53). |
| R13 | Charge de la base : RLS + `exists()` sur `organization_members` à chaque ligne | 2 | 2 | **4** | Index `(user_id, organization_id)`, `(select auth.uid())` mis en cache (cf. exemple §7), mesure dès J15. |

---

## 6. Autres points à signaler

- **G-X1** — La spec et le plan se réfèrent à des figures 1 à 14 (diagrammes) ; le fichier Markdown de la spec n'en contient que deux schémas ASCII (§3, §6). Les figures ne sont pas accessibles ici ; si elles existent dans un PDF de la spec, le fournir.
- **G-X2** — Spec §6 : interface arabe/anglaise. Le plan ne prévoit aucune journée i18n/RTL ni de choix de bibliothèque (ADR nécessaire, hors stack imposée ⇒ accord requis).
- **G-X3** — Spec §11 : « arrêt d'envoi d'urgence par entreprise et par canal » : mécanisme (drapeau sur `channels`/`organizations`, vérifié par le contrôle final) à décrire dans l'ADR et le runbook.
- **G-X4** — Spec §9.1 : « transaction unique » contact + lead + consentement : le choix entre RPC Postgres transactionnelle et code applicatif est à fixer (ADR 005/006).
- **G-X5** — Spec §6 : « méthode SSR selon la documentation actuelle de Supabase au moment de l'implémentation » ⇒ vérifier la doc officielle (versions épinglées) au Jour 4/5 ; ne pas figer de version aujourd'hui.

## 7. Récapitulatif pour validation

Décisions à obtenir avant la gate G0 : réponses Q1–Q5 (ou confirmation que l'hypothèse §14 tient), arbitrage de E1–E12 et G-D1…G-D12, matrice des rôles (G-R1/G-R2), transport de l'organisation active (G-R5), unicité globale du compte fournisseur (G-R6), choix i18n (G-X2).
