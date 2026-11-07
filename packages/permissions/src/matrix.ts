import type { Action, Grant, PermissionRule, Resource, Role } from "./types";

/** Cellules dans l'ordre des colonnes de l'ADR 014 : OWN, ADM, MKT, SAL, ANA. */
function g(own: Grant, adm: Grant, mkt: Grant, sal: Grant, ana: Grant): Readonly<Record<Role, Grant>> {
  return Object.freeze({
    company_owner: own,
    company_admin: adm,
    marketing_manager: mkt,
    sales_agent: sal,
    analyst: ana,
  });
}

function rule(
  adrRow: number,
  adrLabel: string,
  proposal: boolean,
  resources: readonly Resource[],
  actions: readonly Action[],
  grants: Readonly<Record<Role, Grant>>,
): PermissionRule {
  return Object.freeze({ adrRow, adrLabel, proposal, resources, actions, grants });
}

const A = "allow";
const D = "deny";

/**
 * Matrice ADR 014, ligne par ligne, dans l'ordre du tableau (31 lignes). Les lignes marquées
 * `proposal: true` contiennent au moins une case [P] (propositions acceptées au J10).
 * Interprétations notées :
 *  - ligne 31 : OWN peut supprimer l'entreprise ET (surensemble d'ADM) des enregistrements ; ADM
 *    seulement des enregistrements ;
 *  - ligne 26 : la case Sales Agent est « ✘ (ses propres leads seulement) » : lecture littérale = ✘
 *    (ses leads restent lisibles via la ligne 12) ;
 *  - ligne 13 : Sales Agent crée « assigné à soi » ; l'assignation forcée est une règle de donnée,
 *    pas de permission (appliquée par la couche service / la RLS à venir).
 */
export const PERMISSION_MATRIX: readonly PermissionRule[] = Object.freeze([
  rule(1, "Entreprise", true, ["company"], ["update_settings"], g(A, A, D, D, D)),
  rule(2, "Plan / facturation", true, ["billing"], ["view"], g(A, A, D, D, D)),
  rule(3, "Membres", true, ["members"], ["list"], g(A, A, D, D, D)),
  rule(4, "Membres", false, ["members"], ["invite", "change_role", "remove"], g(A, A, D, D, D)),
  rule(5, "Propriété", false, ["ownership"], ["transfer"], g(A, D, D, D, D)),
  rule(6, "Intégrations / canaux", true, ["integrations"], ["view_status"], g(A, A, D, D, D)),
  rule(7, "Intégrations / canaux", false, ["integrations"], ["connect", "replace_secret", "disconnect"], g(A, A, D, D, D)),
  rule(8, "Secrets bruts", false, ["secrets"], ["read_raw"], g(D, D, D, D, D)),
  rule(9, "Arrêt d'urgence d'envoi", true, ["sending"], ["emergency_stop"], g(A, A, A, D, D)),
  rule(10, "Projets / produits", false, ["projects"], ["read"], g(A, A, A, A, A)),
  rule(11, "Projets / produits", true, ["projects"], ["create", "update", "archive"], g(A, A, D, D, D)),
  rule(12, "Contacts / leads / deals", true, ["contacts", "leads", "deals"], ["read"], g(A, A, A, "own", D)),
  // Interprétation (ADR 014 ligne 13) : « assigné à soi » pour le Sales Agent est accordé (allow) ici ; l'assignation
  // forcée à soi-même est une règle de donnée (couche service / RLS à venir), pas une permission. À valider par la responsable technique.
  rule(13, "Contacts / leads", true, ["contacts", "leads"], ["create"], g(A, A, A, A, D)),
  rule(14, "Leads / deals", false, ["leads", "deals"], ["update", "change_stage", "manage_tasks"], g(A, A, D, "own", D)),
  rule(15, "Leads non assignés", true, ["unassigned_leads"], ["read"], g(A, A, A, D, D)),
  rule(15, "Leads non assignés", true, ["unassigned_leads"], ["assign"], g(A, A, D, D, D)),
  rule(16, "Règles d'assignation, pipelines, mappings CRM", true, ["assignment_rules", "pipelines", "crm_mappings"], ["manage"], g(A, A, D, D, D)),
  rule(17, "Conversations", false, ["conversations"], ["read"], g(A, A, D, "own", D)),
  rule(18, "Conversations", false, ["conversations"], ["reply"], g(A, A, D, "own", D)),
  rule(19, "Consentement", true, ["consent"], ["revoke", "mark_do_not_contact"], g(A, A, A, "own", D)),
  rule(20, "Campagnes", true, ["campaigns"], ["read"], g(A, A, A, D, A)),
  rule(21, "Campagnes / assets / segments", false, ["campaigns", "assets", "segments"], ["create", "update", "submit"], g(A, A, A, D, D)),
  rule(22, "Campagnes", false, ["campaigns"], ["approve"], g("not_author", "not_author", "not_author", D, D)),
  rule(23, "Campagnes", false, ["campaigns"], ["schedule", "pause", "stop"], g(A, A, "if_approved", D, D)),
  rule(24, "Agents IA", true, ["ai_agents"], ["request_draft", "request_qualification"], g(A, A, A, "own", D)),
  rule(25, "Brouillon IA", false, ["ai_drafts"], ["use", "send_after_review"], g(A, A, D, "own", D)),
  // Interprétation (ADR 014 ligne 26) : la cellule Sales Agent est « ✘ (ses propres leads seulement) ».
  // Lecture littérale retenue = refus (deny) ; ses leads restent lisibles via la ligne 12. À valider par la responsable technique.
  rule(26, "Analyst Agent / rapports / tableau de bord", true, ["reports"], ["read"], g(A, A, A, D, A)),
  rule(27, "Journal d'audit", true, ["audit_log"], ["read"], g(A, A, D, D, D)),
  rule(28, "Exports de données", true, ["exports"], ["export"], g(A, A, D, D, D)),
  rule(28, "Exports de données", true, ["campaign_results_exports"], ["export"], g(A, A, A, D, D)),
  rule(29, "Alertes / centre d'exploitation, dead letter", true, ["alerts", "dead_letter"], ["view"], g(A, A, D, D, D)),
  rule(30, "Dead letter", true, ["dead_letter"], ["replay"], g(A, A, D, D, D)),
  // Interprétation (ADR 014 ligne 31) : OWN supprime l'entreprise ET des enregistrements (surensemble d'ADM) ;
  // ADM seulement des enregistrements, jamais l'entreprise. À valider par la responsable technique.
  rule(31, "Suppression définitive", true, ["organization"], ["delete"], g(A, D, D, D, D)),
  rule(31, "Suppression définitive", true, ["records"], ["delete_permanently"], g(A, A, D, D, D)),
]);
