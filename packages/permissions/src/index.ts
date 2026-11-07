/** Nom du package (smoke test de J4). */
export const PACKAGE_NAME = "@fusion-leap/permissions" as const;

export { assignableRoles, can, canManageMember, isRole } from "./can";
export { PERMISSION_MATRIX } from "./matrix";
export {
  ACTIONS,
  RESOURCES,
  ROLES,
  type Action,
  type Grant,
  type PermissionContext,
  type PermissionRule,
  type Resource,
  type Role,
} from "./types";
