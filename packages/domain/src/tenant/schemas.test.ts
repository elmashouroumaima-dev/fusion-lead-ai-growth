import { describe, expect, it } from "vitest";
import {
  activeOrgCookieSchema,
  createOrganizationSchema,
  idempotencyKeySchema,
  membershipRowSchema,
  tenantRoleSchema,
} from "./schemas";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("createOrganizationSchema", () => {
  it("applique les défauts (locale fr, fuseau UTC) et rogne le nom", () => {
    expect(createOrganizationSchema.parse({ name: "  Acme  " })).toEqual({
      name: "Acme",
      locale: "fr",
      timezone: "UTC",
    });
  });

  it("accepte un fuseau IANA réel", () => {
    expect(createOrganizationSchema.parse({ name: "A", timezone: "Africa/Casablanca", locale: "en" })).toMatchObject({
      timezone: "Africa/Casablanca",
      locale: "en",
    });
  });

  it.each([
    [{ name: "" }],
    [{ name: "   " }],
    [{ name: "x".repeat(121) }],
    [{ name: "A", locale: "es" }],
    [{ name: "A", locale: "FR" }],
    [{ name: "A", locale: "fr " }],
    [{ name: "A", timezone: "Mars/Olympus" }],
    [{ name: "A", timezone: "" }],
    [{ name: 12 }],
    [{}],
  ])("refuse %j", (input) => {
    expect(createOrganizationSchema.safeParse(input).success).toBe(false);
  });

  it("accepte 120 caractères exactement", () => {
    expect(createOrganizationSchema.safeParse({ name: "x".repeat(120) }).success).toBe(true);
  });
});

describe("idempotencyKeySchema", () => {
  it.each(["abcdefgh", crypto.randomUUID(), "A_b-9".padEnd(128, "z")])("accepte %s", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
  });
  it.each(["short", "x".repeat(129), "has space 1234", "emoji-😀-1234", "a/b/c/d/e/f", ""])("refuse %j", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("activeOrgCookieSchema / tenantRoleSchema", () => {
  it("n'accepte que des uuid", () => {
    expect(activeOrgCookieSchema.safeParse(ORG).success).toBe(true);
    expect(activeOrgCookieSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(activeOrgCookieSchema.safeParse(`${ORG}; Path=/`).success).toBe(false);
  });
  it("refuse platform_admin et tout rôle inconnu", () => {
    expect(tenantRoleSchema.safeParse("company_owner").success).toBe(true);
    expect(tenantRoleSchema.safeParse("platform_admin").success).toBe(false);
  });
});

describe("membershipRowSchema", () => {
  const org = { id: ORG, name: "Acme", slug: "acme-1", locale: "ar", timezone: "UTC", status: "active" };
  it("accepte l'organisation imbriquée en objet ou en tableau d'un élément", () => {
    expect(membershipRowSchema.parse({ organization_id: ORG, role: "analyst", organizations: org }).organizations?.name).toBe("Acme");
    expect(membershipRowSchema.parse({ organization_id: ORG, role: "analyst", organizations: [org] }).organizations?.id).toBe(ORG);
  });
  it("donne null si l'organisation est masquée par la RLS", () => {
    expect(membershipRowSchema.parse({ organization_id: ORG, role: "analyst", organizations: null }).organizations).toBeNull();
    expect(membershipRowSchema.parse({ organization_id: ORG, role: "analyst", organizations: [] }).organizations).toBeNull();
  });
  it("refuse un rôle ou un statut inconnu", () => {
    expect(membershipRowSchema.safeParse({ organization_id: ORG, role: "root", organizations: org }).success).toBe(false);
    expect(membershipRowSchema.safeParse({ organization_id: ORG, role: "analyst", organizations: { ...org, status: "x" } }).success).toBe(false);
  });
});
