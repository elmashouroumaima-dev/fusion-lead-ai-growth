import type { ActiveMembership } from "./memberships";
import { TenantError } from "./tenant-error";

/**
 * Choix de l'adhésion active (fonction pure, testée). `memberships` provient de la base ; `hint`
 * (cookie) n'est qu'un indice : sans adhésion active correspondante il ne donne AUCUN accès.
 *
 *  - indice présent  : doit correspondre à une adhésion active, sinon `forbidden`
 *  - sans indice     : 0 -> no_organization ; 1 -> celle-ci ; >1 -> organization_selection_required
 *  - organisation non `active` (suspendue, fermée) -> organization_inactive
 */
export function resolveActiveMembership(
  memberships: readonly ActiveMembership[],
  hint: string | undefined,
): ActiveMembership {
  let chosen: ActiveMembership | undefined;
  if (hint !== undefined) {
    chosen = memberships.find((m) => m.organizationId === hint);
    if (!chosen) throw new TenantError("forbidden");
  } else {
    if (memberships.length === 0) throw new TenantError("no_organization");
    if (memberships.length > 1) throw new TenantError("organization_selection_required");
    chosen = memberships[0];
  }
  if (!chosen) throw new TenantError("no_organization");
  if (chosen.organization.status !== "active") throw new TenantError("organization_inactive");
  return chosen;
}
