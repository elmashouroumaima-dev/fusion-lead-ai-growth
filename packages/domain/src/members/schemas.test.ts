import { describe, expect, it } from "vitest";
import {
  changeRoleSchema,
  inviteMemberSchema,
  invitationTokenHashSchema,
  invitationTokenSchema,
  normalizeEmail,
  removeMemberSchema,
  revokeInvitationSchema,
  transferOwnershipSchema,
} from "./schemas";

const ID = "11111111-1111-4111-8111-111111111111";

describe("normalizeEmail", () => {
  it("rogne et met en minuscules", () => {
    expect(normalizeEmail("  Ali.Ben@Example.COM \t")).toBe("ali.ben@example.com");
  });
});

describe("inviteMemberSchema", () => {
  const parse = (input: unknown) => inviteMemberSchema.safeParse(input);

  it("normalise l'e-mail et accepte un rôle valide", () => {
    const r = parse({ email: "  Ali@Example.COM ", role: "sales_agent" });
    expect(r.success && r.data).toEqual({ email: "ali@example.com", role: "sales_agent" });
  });

  it.each(["", "a", "a@b", "@example.com", "a@@example.com", "a b@example.com", "a@exa mple.com", "a@example..com", "a@-example.com", "عمر@example.com", "a@مثال.com", "a@example.com\n"])(
    "refuse %j",
    (email) => {
      // « a@example.com\n » est rogné en une adresse valide : seul le cas interne doit échouer.
      const expected = email === "a@example.com\n";
      expect(parse({ email, role: "analyst" }).success).toBe(expected);
    },
  );

  it("refuse une adresse de plus de 254 caractères, accepte 254", () => {
    const domain = "@example.com";
    expect(parse({ email: `${"a".repeat(254 - domain.length)}${domain}`, role: "analyst" }).success).toBe(true);
    expect(parse({ email: `${"a".repeat(255 - domain.length)}${domain}`, role: "analyst" }).success).toBe(false);
    expect(parse({ email: "a".repeat(5000) + domain, role: "analyst" }).success).toBe(false);
  });

  it.each(["platform_admin", "owner", "", "COMPANY_OWNER", undefined, null])("refuse le rôle %j", (role) => {
    expect(parse({ email: "a@example.com", role }).success).toBe(false);
  });

  it("accepte les cinq rôles d'organisation", () => {
    for (const role of ["company_owner", "company_admin", "marketing_manager", "sales_agent", "analyst"]) {
      expect(parse({ email: "a@example.com", role }).success).toBe(true);
    }
  });

  it.each(["status", "invited_by", "token_hash", "x"])("strict : refuse le champ inconnu %s", (field) => {
    expect(parse({ email: "a@example.com", role: "analyst", [field]: "v" }).success).toBe(false);
  });

  it("organization_id : uuid facultatif, tout autre type refusé", () => {
    expect(parse({ email: "a@example.com", role: "analyst", organization_id: ID }).success).toBe(true);
    expect(parse({ email: "a@example.com", role: "analyst", organization_id: "x" }).success).toBe(false);
    expect(parse({ email: "a@example.com", role: "analyst", organization_id: null }).success).toBe(false);
  });
});

describe("autres schémas de membres (stricts)", () => {
  it("changeRoleSchema", () => {
    expect(changeRoleSchema.safeParse({ member_id: ID, role: "analyst" }).success).toBe(true);
    expect(changeRoleSchema.safeParse({ member_id: "x", role: "analyst" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ member_id: ID, role: "root" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ member_id: ID, role: "analyst", status: "active" }).success).toBe(false);
  });
  it.each([
    ["removeMemberSchema", removeMemberSchema, "member_id"],
    ["transferOwnershipSchema", transferOwnershipSchema, "member_id"],
    ["revokeInvitationSchema", revokeInvitationSchema, "invitation_id"],
  ] as const)("%s : uuid obligatoire, champs inconnus refusés", (_n, schema, key) => {
    expect(schema.safeParse({ [key]: ID }).success).toBe(true);
    expect(schema.safeParse({ [key]: ID, organization_id: ID }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ [key]: "nope" }).success).toBe(false);
    expect(schema.safeParse({ [key]: ID, role: "company_owner" }).success).toBe(false);
  });
});

describe("invitationTokenSchema / invitationTokenHashSchema", () => {
  it("jeton : exactement 43 caractères base64url", () => {
    expect(invitationTokenSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(invitationTokenSchema.safeParse(`${"a-_0".repeat(10)}abc`).success).toBe(true);
    for (const bad of ["", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, `${"A".repeat(42)}/`, `${"A".repeat(42)} `, `${"A".repeat(42)}\n`, 5, null]) {
      expect(invitationTokenSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("empreinte : 64 hexadécimaux minuscules", () => {
    expect(invitationTokenHashSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(invitationTokenHashSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(invitationTokenHashSchema.safeParse("a".repeat(63)).success).toBe(false);
    expect(invitationTokenHashSchema.safeParse("g".repeat(64)).success).toBe(false);
  });
});
