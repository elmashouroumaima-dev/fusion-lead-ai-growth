import { PERMISSION_MATRIX } from "./matrix";
import { ROLES, type Action, type Grant, type PermissionContext, type Resource, type Role } from "./types";

/** Index `resource\0action` -> cellules. Map (pas un objet) : aucune clé « __proto__ » exploitable. */
const INDEX: ReadonlyMap<string, Readonly<Record<Role, Grant>>> = (() => {
  const map = new Map<string, Readonly<Record<Role, Grant>>>();
  for (const r of PERMISSION_MATRIX) {
    for (const resource of r.resources) {
      for (const action of r.actions) {
        const key = `${resource}\u0000${action}`;
        if (map.has(key)) throw new Error(`permission_matrix_duplicate:${key}`);
        map.set(key, r.grants);
      }
    }
  }
  return map;
})();

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value);
}

/**
 * Règles propres aux membres (ADR 014 ligne 4, spec §2 et §13-2). Le Company Admin ne peut jamais
 * agir sur un Company Owner ni attribuer ce rôle ; seul le Company Owner le fait. Les informations
 * manquantes ferment l'accès : une invitation exige `assignedRole`, un retrait exige `targetRole`,
 * un changement de rôle exige les deux.
 */
function memberGuard(role: Role, action: Action, ctx: PermissionContext): boolean {
  if (ctx.targetRole !== undefined && !isRole(ctx.targetRole)) return false;
  if (ctx.assignedRole !== undefined && !isRole(ctx.assignedRole)) return false;
  if (role === "company_owner") return true;

  const needsTarget = action === "change_role" || action === "remove";
  const needsAssigned = action === "invite" || action === "change_role";
  if (needsTarget && ctx.targetRole === undefined) return false;
  if (needsAssigned && ctx.assignedRole === undefined) return false;
  return ctx.targetRole !== "company_owner" && ctx.assignedRole !== "company_owner";
}

/**
 * Décision RBAC pure (ADR 014). Fail closed : rôle, action ou ressource inconnus -> false ;
 * cellule `own` sans `ctx.isOwnRecord === true` -> false ; cellule d'approbation sans
 * `ctx.isAuthor === false` -> false. La RLS reste l'autorité finale (défense en profondeur).
 */
export function can(role: Role, action: Action, resource: Resource, ctx: PermissionContext = {}): boolean {
  if (!isRole(role) || typeof action !== "string" || typeof resource !== "string") return false;
  const grants = INDEX.get(`${resource}\u0000${action}`);
  if (!grants) return false;

  let allowed: boolean;
  switch (grants[role]) {
    case "allow":
      allowed = true;
      break;
    case "own":
      allowed = ctx.isOwnRecord === true;
      break;
    case "not_author":
      allowed = ctx.isAuthor === false;
      break;
    case "if_approved":
      allowed = ctx.isApproved === true;
      break;
    default:
      allowed = false;
  }
  if (!allowed) return false;

  if (resource === "members" && (action === "invite" || action === "change_role" || action === "remove")) {
    return memberGuard(role, action, ctx);
  }
  return true;
}

/**
 * Peut-on agir sur un membre ? `newRole` absent = retrait. Seul le Company Owner touche un
 * Company Owner ou attribue ce rôle ; le Company Admin gère les autres rôles ; les autres : jamais.
 */
export function canManageMember(actorRole: Role, targetCurrentRole: Role, newRole?: Role): boolean {
  if (!isRole(actorRole) || !isRole(targetCurrentRole)) return false;
  if (newRole !== undefined && !isRole(newRole)) return false;
  return newRole === undefined
    ? can(actorRole, "remove", "members", { targetRole: targetCurrentRole })
    : can(actorRole, "change_role", "members", { targetRole: targetCurrentRole, assignedRole: newRole });
}

/** Rôles que l'acteur peut attribuer (invitation ou changement de rôle). */
export function assignableRoles(actorRole: Role): Role[] {
  if (!isRole(actorRole)) return [];
  return ROLES.filter((assigned) => can(actorRole, "invite", "members", { assignedRole: assigned }));
}
