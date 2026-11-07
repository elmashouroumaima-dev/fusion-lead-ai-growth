/**
 * Types du RBAC (ADR 014). Aucune dépendance, aucune IO : ces types sont partagés avec l'UI et les
 * Server Actions, mais la RLS (Postgres) reste l'autorité finale.
 */

/** Rôles d'organisation : valeurs de l'enum Postgres `app_role` (un test le vérifie dans les migrations). */
export const ROLES = [
  "company_owner",
  "company_admin",
  "marketing_manager",
  "sales_agent",
  "analyst",
] as const;
export type Role = (typeof ROLES)[number];

/** Ressources de la matrice ADR 014 (y compris celles dont les tables n'existent pas encore). */
export const RESOURCES = [
  "company",
  "organization",
  "billing",
  "members",
  "ownership",
  "integrations",
  "secrets",
  "sending",
  "projects",
  "contacts",
  "leads",
  "deals",
  "unassigned_leads",
  "assignment_rules",
  "pipelines",
  "crm_mappings",
  "conversations",
  "consent",
  "campaigns",
  "assets",
  "segments",
  "ai_agents",
  "ai_drafts",
  "reports",
  "audit_log",
  "exports",
  "campaign_results_exports",
  "alerts",
  "dead_letter",
  "records",
] as const;
export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = [
  "update_settings",
  "view",
  "list",
  "invite",
  "change_role",
  "remove",
  "transfer",
  "view_status",
  "connect",
  "replace_secret",
  "disconnect",
  "read_raw",
  "emergency_stop",
  "read",
  "create",
  "update",
  "archive",
  "change_stage",
  "manage_tasks",
  "assign",
  "manage",
  "reply",
  "revoke",
  "mark_do_not_contact",
  "submit",
  "approve",
  "schedule",
  "pause",
  "stop",
  "request_draft",
  "request_qualification",
  "use",
  "send_after_review",
  "export",
  "replay",
  "delete",
  "delete_permanently",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Nature d'une cellule de la matrice :
 *  - allow       : ✔
 *  - deny        : ✘
 *  - own         : seulement les enregistrements assignés (ctx.isOwnRecord === true)
 *  - not_author  : ✔ « ≠ auteur » (ctx.isAuthor === false)
 *  - if_approved : ✔ seulement si la campagne est `approved` (ctx.isApproved === true)
 */
export type Grant = "allow" | "deny" | "own" | "not_author" | "if_approved";

/** Contexte d'une décision. Toute information absente est traitée comme défavorable (fail closed). */
export type PermissionContext = {
  /** L'enregistrement est assigné à l'utilisateur (`assignee_id = auth.uid()`). */
  isOwnRecord?: boolean;
  /** L'utilisateur est l'auteur de la dernière version du contenu à approuver. */
  isAuthor?: boolean;
  /** Rôle ACTUEL du membre visé (changement de rôle, retrait). */
  targetRole?: Role;
  /** Rôle que l'on attribue (invitation, changement de rôle). */
  assignedRole?: Role;
  /** La campagne est à l'état `approved` (planifier / pause / arrêt pour le Marketing Manager). */
  isApproved?: boolean;
};

export type PermissionRule = {
  /** Numéro de ligne dans le tableau de l'ADR 014 (1 = première ligne de données). */
  adrRow: number;
  /** Libellé de la ressource tel qu'écrit en gras dans l'ADR (vérifié par un test). */
  adrLabel: string;
  /** Cellule marquée [P] (proposition à valider) dans l'ADR. */
  proposal: boolean;
  resources: readonly Resource[];
  actions: readonly Action[];
  grants: Readonly<Record<Role, Grant>>;
};
