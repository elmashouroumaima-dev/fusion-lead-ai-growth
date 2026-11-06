import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  confirmQuerySchema,
  emailOtpTypeSchema,
  resetRequestSchema,
  signInSchema,
  signOutSchema,
  signUpSchema,
  updatePasswordSchema,
} from "./schemas";

describe("auth schemas", () => {
  it("signUp normalise l'e-mail et impose 10 caractères", () => {
    const ok = signUpSchema.parse({ email: " A@B.test ", password: "x".repeat(10), locale: "ar" });
    expect(ok.email).toBe("a@b.test");
    expect(signUpSchema.safeParse({ email: "a@b.test", password: "x".repeat(9), locale: "ar" }).success).toBe(false);
    expect(updatePasswordSchema.safeParse({ password: "x".repeat(73), locale: "en" }).success).toBe(false);
  });
  it("rejette une locale inconnue", () => {
    expect(signInSchema.safeParse({ email: "a@b.test", password: "p", locale: "fr" }).success).toBe(false);
  });
  it("confirm n'accepte que les types OTP connus", () => {
    expect(confirmQuerySchema.safeParse({ token_hash: "abc", type: "recovery" }).success).toBe(true);
    expect(confirmQuerySchema.safeParse({ token_hash: "abc", type: "evil" }).success).toBe(false);
    expect(confirmQuerySchema.safeParse({ token_hash: "", type: "signup" }).success).toBe(false);
  });
});

describe("auth schemas : limites et allow-lists", () => {
  const base = { locale: "en" as const };

  it("mot de passe : 9 refusé, 10 accepté, 72 accepté, 73 refusé (inscription)", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    const t = (n: number) =>
      signUpSchema.safeParse({ ...base, email: "a@b.test", password: "x".repeat(n) }).success;
    expect([t(9), t(10), t(PASSWORD_MAX_LENGTH), t(PASSWORD_MAX_LENGTH + 1)]).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("changement de mot de passe : même frontière 9 / 10", () => {
    const t = (n: number) => updatePasswordSchema.safeParse({ ...base, password: "x".repeat(n) }).success;
    expect([t(9), t(10)]).toEqual([false, true]);
  });

  it("connexion : pas de longueur minimale, mais non vide", () => {
    expect(signInSchema.safeParse({ ...base, email: "a@b.test", password: "p" }).success).toBe(true);
    expect(signInSchema.safeParse({ ...base, email: "a@b.test", password: "" }).success).toBe(false);
  });

  it.each(["a@b.test", "user+tag@example.com", "  USER@Example.COM  "])("e-mail valide : %s", (email) => {
    expect(resetRequestSchema.safeParse({ ...base, email }).success).toBe(true);
  });

  it.each(["", "plain", "a@", "@b.test", "a b@c.test", `${"a".repeat(250)}@b.test`])(
    "e-mail invalide : %j",
    (email) => {
      expect(resetRequestSchema.safeParse({ ...base, email }).success).toBe(false);
    },
  );

  it("normalise l'e-mail (trim + minuscules)", () => {
    expect(resetRequestSchema.parse({ ...base, email: "  USER@Example.COM " }).email).toBe("user@example.com");
  });

  it("allow-list des types OTP", () => {
    for (const ok of ["signup", "invite", "magiclink", "recovery", "email_change", "email"]) {
      expect(emailOtpTypeSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "SIGNUP", "phone_change", "sms", "recovery ", "evil", 1, null, undefined]) {
      expect(emailOtpTypeSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("locale : seulement ar / en", () => {
    expect(signOutSchema.safeParse({ locale: "ar" }).success).toBe(true);
    for (const bad of ["fr", "AR", "", "ar-MA", undefined]) {
      expect(signOutSchema.safeParse({ locale: bad }).success, String(bad)).toBe(false);
    }
  });

  it("champs inconnus : non propagés dans data (pas d'organization_id/role depuis le client)", () => {
    const r = signUpSchema.parse({
      ...base,
      email: "a@b.test",
      password: "x".repeat(10),
      organization_id: "evil",
      role: "owner",
    });
    expect(r).not.toHaveProperty("organization_id");
    expect(r).not.toHaveProperty("role");
  });

  it("champs requis manquants refusés", () => {
    expect(signUpSchema.safeParse({}).success).toBe(false);
    expect(signInSchema.safeParse({ ...base, email: "a@b.test" }).success).toBe(false);
  });

  it("confirm : token_hash et next bornés, next optionnel", () => {
    expect(confirmQuerySchema.safeParse({ token_hash: "x".repeat(513), type: "signup" }).success).toBe(false);
    expect(
      confirmQuerySchema.safeParse({ token_hash: "a", type: "signup", next: "/" + "a".repeat(2100) }).success,
    ).toBe(false);
    expect(confirmQuerySchema.safeParse({ token_hash: "a", type: "signup" }).success).toBe(true);
  });
});
