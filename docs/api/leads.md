# Pipelines, leads et deals (J19)

Migration `20261121100000_leads_pipelines_deals.sql` (retour arrière : `supabase/rollbacks/20261121100000_leads_pipelines_deals.sql`). Spec §7 et §9.1, ADR 007 (E1, G-D3), ADR 014. Pas d'écran au J19 (l'interface CRM vient au J24) : base, domaine et service sont livrés.

## Modèle
- **`pipelines`** (par entreprise, un seul par défaut) et **`pipeline_stages`** (`name`, `position`, `kind` : `open`, `won`, `lost`, `unassigned`). Chaque pipeline a **une étape système `unassigned`** (file des leads sans responsable, spec §9.1), non supprimable, de genre immuable.
- **Étapes par défaut** créées automatiquement pour chaque entreprise (nouvelles et existantes) dans sa langue : *Non assigné, Nouveau, Qualifié, Proposition* (ouvertes), *Gagné, Perdu* (fr) ; *Unassigned, New, Qualified, Proposal, Won, Lost* (en) ; équivalents arabes. Les nouveaux pipelines reçoivent les mêmes étapes. Plafonds : 20 pipelines par entreprise, 30 étapes par pipeline.
- **`leads`** : `contact_id`, `project_id`, `source` (code court), `stage_id`, `score` (0 à 100), `score_reason`, `assignee_id`, `campaign_id` (colonne **sans clé étrangère** jusqu'au J42), `utm` (clés connues : `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `landing_page_id`), `external_source` / `external_id` (unique par entreprise). Clés étrangères **composites** vers le contact, le projet, l'étape et l'adhésion du responsable : tout reste dans la même entreprise. Contact et projet sont immuables.
- **`deals`** : `lead_id`, `stage_id`, `value numeric(14,2)` ≥ 0, `currency` (ISO 4217, 3 lettres majuscules), `expected_close_at`, `won_at` / `lost_at` (exclusifs et **cohérents avec le genre de l'étape**, contrainte + déclencheur), `external_*`. Un deal ne se place jamais dans l'étape système et reste dans le pipeline de son lead.

## Règles
- Un lead dans l'étape `unassigned` n'a **pas** de responsable (déclencheur). Créé sans responsable : étape `unassigned` ; avec responsable : première étape ouverte. Assigner un lead le sort de l'étape `unassigned` ; retirer le responsable d'un lead ouvert le renvoie à `unassigned`.
- Un **responsable** est un membre **actif** owner, admin ou commercial (`sales_agent`) de l'entreprise.
- Un membre suspendu, retiré (statut **ou suppression de la ligne**) ou **rétrogradé** vers un rôle sans portefeuille (marketing, analyste) **libère ses leads** (retour à `unassigned` s'ils étaient ouverts). Assigner verrouille la ligne du membre (une suspension simultanée attend).
- Un lead ou un deal d'un **projet archivé** est en lecture seule. Un lead **reste dans son pipeline** (changer d'étape = une étape du même pipeline).
- **Abonnement actif** exigé pour créer pipelines, leads et deals (`subscription_inactive`). Plafonds techniques hors plan : 50 leads par contact, 50 deals par lead.
- **Valeurs** : `value` jamais NaN (la base refuse aussi l'infini), `expected_close_at` entre 2000 et 2100.
- Déplacer un deal vers une étape `won` / `lost` pose la date correspondante ; le rouvrir l'efface.
- Supprimer une étape est refusé si elle est utilisée par un lead ou un deal, si elle est système, ou si c'est la dernière étape ouverte du pipeline.

## Droits (ADR 014)
| Action | owner | admin | marketing | commercial | analyste |
|---|---|---|---|---|---|
| Lire les pipelines et étapes | oui | oui | oui | oui | oui |
| Lire les leads et deals | tous | tous | tous | **les siens** (`assignee_id = auth.uid()`) | non |
| Créer un lead | oui | oui | oui, **sans choisir le responsable** | non (J21–22) | non |
| Modifier un lead, changer d'étape, créer / modifier / déplacer un deal | oui | oui | non | **sur ses leads** | non |
| Assigner un lead (ou choisir le responsable à la création) | oui | oui | non | non | non |
| Créer / renommer un pipeline, gérer les étapes, pipeline par défaut | oui | oui | non | non | non |

Aucune écriture directe sur les tables, même pour `service_role` : tout passe par les fonctions. Un lead d'un autre commercial est « introuvable » pour un commercial (comme avec la RLS).

**Contacts (promesse du J18)** : le commercial lit les contacts et consentements de **ses** leads et peut révoquer un consentement ou poser « ne plus contacter » sur eux (jamais le retirer, jamais enregistrer un consentement).

## Fonctions SQL (surface PostgREST, `SECURITY DEFINER`, `search_path` vide, aucun droit pour `anon` ni `service_role`)
`create_pipeline(p_org, p_name)` · `rename_pipeline(p_org, p_id, p_name)` · `set_default_pipeline(p_org, p_id)` · `create_stage(p_org, p_pipeline, p_name, p_kind, p_position)` · `update_stage(p_org, p_id, p_name, p_position)` · `delete_stage(p_org, p_id)` · `create_lead(p_org, p_contact, p_project, p_source, p_assignee, p_score, p_score_reason, p_utm, p_external_source, p_external_id)` · `update_lead(p_org, p_id, p_source, p_score, p_score_reason, p_utm)` · `assign_lead(p_org, p_id, p_assignee)` · `move_lead_stage(p_org, p_id, p_stage)` · `create_deal(p_org, p_lead, p_stage, p_value, p_currency, p_expected_close_at)` · `update_deal(p_org, p_id, p_value, p_currency, p_expected_close_at)` · `move_deal_stage(p_org, p_id, p_stage)`.

Codes d'erreur : `28000` non authentifié · `42501` interdit · `22023` / `23514` valeur invalide · `PT404` introuvable · `23505` doublon (nom, identifiant externe) · `P0001` : `project_archived`, `assignee_invalid`, `pipeline_incomplete`, `stage_in_use`, `system_stage`, `last_open_stage`, `too_many_pipelines`, `too_many_stages`.

## Service web (`apps/web/lib/leads`)
`createLead`, `updateLead`, `assignLead`, `moveLeadStage`, `createDeal`, `updateDeal`, `moveDealStage`, `createPipeline`, `renamePipeline`, `setDefaultPipeline`, `createStage`, `updateStage`, `deleteStage` (résultat `{ ok, value | code }`, entreprise du **contexte vérifié**) ; lectures `listPipelines`, `listStages`, `listLeads` (filtres étape / responsable / projet, pagination), `getLead`, `listDeals`, `getDeal` avec les droits de l'utilisateur. Codes : `assignee_invalid` → `validation_failed` ; `project_archived`, `stage_in_use`, `system_stage`, `last_open_stage`, `pipeline_incomplete`, plafonds, doublons → `conflict`.

## Audit
`pipeline.created / renamed / default_changed`, `stage.created / updated / deleted`, `lead.created / assigned / stage_changed / updated` (noms des champs), `deal.created / stage_changed / won / lost / updated` (noms des champs). **Jamais** la valeur d'un deal, le score, les raisons, les UTM ni l'identité d'un contact. La création système des étapes par défaut n'est pas journalisée (aucun acteur).

## Limites connues
- **Idempotence** : le service n'a pas de clé d'idempotence ; elle sera exigée au niveau des routes et Server Actions (mutations rejouables), avec l'unicité (contact, projet) du J21. Si la relecture après écriture échoue, le service renvoie `internal_error` alors que l'écriture a eu lieu : les appelants doivent relire avant de rejouer.
- **Audit des créations système** : les déclencheurs d'audit imbriqués (création de l'entreprise) ne journalisent pas ; il n'existe plus de réglage de session pour supprimer l'audit.
- Pas d'unicité (contact, projet) : décidée au J21 avec la capture publique (la course se joue là).
- Un commercial ne peut pas créer de lead (il ne voit pas les contacts non assignés) : prévu avec la capture et l'assignation (J21–22).
- Le journal automatique des changements d'étape dans la chronologie (`activities`) est le J20 ; au J19 l'historique est l'audit.
- `campaign_id` : la clé étrangère vers `campaigns` est ajoutée au J42.
