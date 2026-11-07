import { describe, expect, it } from "vitest";
import type { ActiveMembership } from "./memberships";
import { resolveActiveMembership } from "./resolve";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function membership(id: string, status: "active" | "suspended" | "closed" = "active"): ActiveMembership {
  return {
    organizationId: id,
    role: "company_owner",
    organization: { id, name: id.slice(0, 2), slug: `org-${id.slice(0, 2)}`, locale: "ar", timezone: "UTC", status },
  };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe("resolveActiveMembership", () => {
  it("aucune adhésion -> no_organization", () => {
    expect(code(() => resolveActiveMembership([], undefined))).toBe("no_organization");
  });
  it("une seule adhésion, sans cookie -> celle-ci", () => {
    expect(resolveActiveMembership([membership(A)], undefined).organizationId).toBe(A);
  });
  it("plusieurs adhésions, sans cookie -> sélection requise", () => {
    expect(code(() => resolveActiveMembership([membership(A), membership(B)], undefined))).toBe(
      "organization_selection_required",
    );
  });
  it("cookie valide parmi plusieurs -> cette organisation", () => {
    expect(resolveActiveMembership([membership(A), membership(B)], B).organizationId).toBe(B);
  });
  it("cookie vers une organisation sans adhésion active -> forbidden (même avec une autre adhésion)", () => {
    expect(code(() => resolveActiveMembership([membership(A)], B))).toBe("forbidden");
    expect(code(() => resolveActiveMembership([], B))).toBe("forbidden");
  });
  it.each(["suspended", "closed"] as const)("organisation %s -> organization_inactive", (status) => {
    expect(code(() => resolveActiveMembership([membership(A, status)], undefined))).toBe("organization_inactive");
    expect(code(() => resolveActiveMembership([membership(A, status), membership(B)], A))).toBe("organization_inactive");
  });
});
