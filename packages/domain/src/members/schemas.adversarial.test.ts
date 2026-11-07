import { describe, expect, it } from "vitest";
import {
  changeRoleSchema,
  invitationTokenHashSchema,
  invitationTokenSchema,
  inviteMemberSchema,
  normalizeEmail,
  removeMemberSchema,
  revokeInvitationSchema,
  transferOwnershipSchema,
} from "./index";

/** Tests adversariaux complémentaires (J10, agent A4) : normalisation, doubles, limites, strictesse. */
const ID = "11111111-1111-4111-8111-111111111111";
const parseInvite = (email: unknown, ...rest: [role?: unknown]) => inviteMemberSchema.safeParse({ email, role: rest.length ? rest[0] : "analyst" });

describe("normalizeEmail", () => {
  it("est idempotente et gère la casse, les espaces et le plus-adressage", () => {
    const once = normalizeEmail("  Ali+Promo.Tag@Example.COM  ");
    expect(once).toBe("ali+promo.tag@example.com");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("ne supprime PAS le plus-adressage ni les points (deux adresses distinctes restent distinctes)", () => {
    expect(normalizeEmail("a.b+x@example.com")).not.toBe(normalizeEmail("ab@example.com"));
    expect(normalizeEmail("a+x@example.com")).not.toBe(normalizeEmail("a@example.com"));
  });

  it("rogne tous les blancs en bordure (tabulation, retour ligne) mais jamais à l'intérieur", () => {
    expect(normalizeEmail("\t\r\n a@example.com \n")).toBe("a@example.com");
    expect(normalizeEmail("a b@example.com")).toBe("a b@example.com");
  });
});

describe("inviteMemberSchema : e-mail", () => {
  it("conserve le plus-adressage dans la valeur envoyée à la base", () => {
    const r = parseInvite("Sales+Team@Example.com");
    expect(r.success && r.data.email).toBe("sales+team@example.com");
  });

  it("la casse et les espaces donnent la même valeur canonique", () => {
    const a = parseInvite("  USER@EXAMPLE.COM ");
    const b = parseInvite("user@example.com");
    expect(a.success && b.success && a.data.email === b.data.email).toBe(true);
  });

  it.each([
    ["fullwidth", "ａｌｉ@example.com"],
    ["fullwidth arobase", "ali＠example.com"],
    ["cyrillique 'а' (U+0430)", "аli@example.com"],
    ["cyrillique dans le domaine", "ali@exаmple.com"],
    ["grec omicron", "ali@exοample.com"],
    ["I majuscule pointé (U+0130)", "İli@example.com"],
    ["espace insécable interne", "a b@example.com"],
    ["zero width space interne", "a​b@example.com"],
    ["caractère de contrôle", "a\u0000b@example.com"],
    ["domaine IDN non punycode", "a@bücher.de"],
    ["deux arobases", "a@b@example.com"],
    ["sans domaine à point", "a@localhost"],
    ["point final", "a@example.com."],
    ["tiret en tête de label", "a@-x.example.com"],
    ["tiret en fin de label", "a@x-.example.com"],
  ])("refuse %s", (_label, email) => {
    expect(parseInvite(email).success).toBe(false);
  });

  it("accepte le punycode et les sous-domaines", () => {
    expect(parseInvite("a@xn--bcher-kva.de").success).toBe(true);
    expect(parseInvite("a@mail.eu.example.co.uk").success).toBe(true);
  });

  it("limite de longueur : 254 accepté, 255 refusé, 100000 refusé sans exception", () => {
    const domain = "@example.com";
    expect(parseInvite(`${"a".repeat(254 - domain.length)}${domain}`).success).toBe(true);
    expect(parseInvite(`${"a".repeat(255 - domain.length)}${domain}`).success).toBe(false);
    expect(() => parseInvite("a".repeat(100_000) + domain)).not.toThrow();
    expect(parseInvite("a".repeat(100_000) + domain).success).toBe(false);
  });

  it.each([undefined, null, 12, true, {}, [], ["a@example.com"]])("refuse un e-mail non textuel %j", (v) => {
    expect(parseInvite(v).success).toBe(false);
  });

  it("le message d'erreur ne contient jamais la valeur saisie", () => {
    const secret = "very-secret-input";
    const r = parseInvite(secret);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).not.toContain(secret);
  });
});

describe("inviteMemberSchema : rôle et strictesse", () => {
  it.each(["company_owner", "company_admin", "marketing_manager", "sales_agent", "analyst"])("accepte %s", (role) => {
    expect(parseInvite("a@example.com", role).success).toBe(true);
  });

  it.each(["", "admin", "Company_Owner", "owner", "platform_admin", "superuser", null, undefined, 1])("refuse le rôle %j", (role) => {
    expect(parseInvite("a@example.com", role).success).toBe(false);
  });

  it("refuse toute clé inconnue (mass-assignment : user_id, status, token_hash, expires_at)", () => {
    for (const extra of ["user_id", "status", "token_hash", "expires_at", "accepted_by", "invited_by", "is_admin"]) {
      expect(inviteMemberSchema.safeParse({ email: "a@example.com", role: "analyst", [extra]: ID }).success, extra).toBe(false);
    }
  });

  it("organization_id doit être un uuid ; un id d'une autre forme est refusé", () => {
    expect(inviteMemberSchema.safeParse({ email: "a@example.com", role: "analyst", organization_id: ID }).success).toBe(true);
    for (const bad of ["", "not-a-uuid", "1".repeat(36), ID + "x", 1, null]) {
      expect(inviteMemberSchema.safeParse({ email: "a@example.com", role: "analyst", organization_id: bad }).success, String(bad)).toBe(false);
    }
  });
});

describe("autres schémas : strictesse et uuid", () => {
  const cases = [
    ["changeRoleSchema", changeRoleSchema, { member_id: ID, role: "analyst" }],
    ["removeMemberSchema", removeMemberSchema, { member_id: ID }],
    ["transferOwnershipSchema", transferOwnershipSchema, { member_id: ID }],
    ["revokeInvitationSchema", revokeInvitationSchema, { invitation_id: ID }],
  ] as const;

  it.each(cases)("%s : valide, rejette clé inconnue, id invalide, id manquant", (_name, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, role_override: "company_owner" }).success).toBe(false);
    expect(schema.safeParse({ ...valid, organization_id: ID }).success).toBe(true);
    const idKey = Object.keys(valid)[0] as string;
    expect(schema.safeParse({ ...valid, [idKey]: "'; drop table x;--" }).success).toBe(false);
    expect(schema.safeParse({ ...valid, [idKey]: undefined }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("changeRoleSchema refuse un rôle inconnu", () => {
    expect(changeRoleSchema.safeParse({ member_id: ID, role: "root" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ member_id: ID }).success).toBe(false);
  });
});

describe("invitationTokenSchema : limites 42 / 43 / 44 et jeu de caractères", () => {
  const ok = "A".repeat(43);
  it("43 accepté ; 42 et 44 refusés", () => {
    expect(invitationTokenSchema.safeParse("A".repeat(42)).success).toBe(false);
    expect(invitationTokenSchema.safeParse(ok).success).toBe(true);
    expect(invitationTokenSchema.safeParse("A".repeat(44)).success).toBe(false);
  });

  it("alphabet base64url complet accepté (A-Z a-z 0-9 - _)", () => {
    expect(invitationTokenSchema.safeParse(("abcXYZ019-_" + "k".repeat(43)).slice(0, 43)).success).toBe(true);
  });

  it.each(["+", "/", "=", " ", ".", "%", "é", "а", "\n", "\0", "<", "'", "~"])("refuse le caractère %j en dernière position", (c) => {
    expect(invitationTokenSchema.safeParse("A".repeat(42) + c).success).toBe(false);
    expect(invitationTokenSchema.safeParse(c + "A".repeat(42)).success).toBe(false);
  });

  it("refuse un retour ligne final (43 caractères + \\n) et un remplissage base64 '='", () => {
    expect(invitationTokenSchema.safeParse(ok + "\n").success).toBe(false);
    expect(invitationTokenSchema.safeParse("A".repeat(42) + "=").success).toBe(false);
  });

  it.each([undefined, null, 43, {}, [], [ok]])("refuse un non-texte %j", (v) => {
    expect(invitationTokenSchema.safeParse(v).success).toBe(false);
  });
});

describe("invitationTokenHashSchema : 63 / 64 / 65 et casse", () => {
  it("64 hex minuscules accepté ; 63 et 65 refusés ; majuscules refusées", () => {
    expect(invitationTokenHashSchema.safeParse("a".repeat(63)).success).toBe(false);
    expect(invitationTokenHashSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(invitationTokenHashSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(invitationTokenHashSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(invitationTokenHashSchema.safeParse("g".repeat(64)).success).toBe(false);
    expect(invitationTokenHashSchema.safeParse("a".repeat(64) + "\n").success).toBe(false);
  });
});
