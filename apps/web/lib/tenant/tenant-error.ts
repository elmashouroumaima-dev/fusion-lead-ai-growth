export type TenantErrorCode =
  | "unauthenticated"
  | "no_organization"
  | "organization_selection_required"
  | "forbidden"
  | "organization_inactive";

/** Erreur de résolution du contexte tenant. Le message ne contient aucune donnée : seul `code` compte. */
export class TenantError extends Error {
  readonly code: TenantErrorCode;

  constructor(code: TenantErrorCode) {
    super(code);
    this.name = "TenantError";
    this.code = code;
  }
}
