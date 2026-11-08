import { describe, expect, it } from "vitest";
import {
  createContactSchema,
  findDuplicate,
  normalizeContactEmail,
  normalizePhone,
  recordConsentSchema,
  revokeConsentSchema,
  updateContactSchema,
} from "./index";

const ORG = "7f000000-0000-4000-8000-00000000000a";
const CONTACT = "7e100000-0000-4000-8000-0000000000a1";

describe("normalizeContactEmail", () => {
  it("minuscules et espaces de bordure retirés", () => {
    expect(normalizeContactEmail("  Ahmed.Benali@Example.COM ")).toEqual({ ok: true, value: "ahmed.benali@example.com" });
    expect(normalizeContactEmail("a+promo@exemple.ma")).toEqual({ ok: true, value: "a+promo@exemple.ma" });
  });

  it("le signe Kelvin et les lettres pleine chasse (hors ASCII) sont refusés", () => {
    expect(normalizeContactEmail("\u212Aevin@x.com")).toEqual({ ok: false });
    expect(normalizeContactEmail("\uFF41@x.com")).toEqual({ ok: false });
  });

  it.each(["", "sans-arobase", "a@b", "a@@b.com", "a b@c.com", "a@exemple..com", ".a@c.com", "a.@c.com", "a..b@c.com", "é@c.com", "a@-c.com", `${"x".repeat(65)}@c.com`, `a@${"x".repeat(250)}.com`])(
    "refuse %j",
    (value) => {
      expect(normalizeContactEmail(value)).toEqual({ ok: false });
    },
  );
});

describe("normalizePhone", () => {
  it.each([
    ["06 12 34 56 78", "MA", "+212612345678"],
    ["0612345678", "MA", "+212612345678"],
    ["+212 6 12-34-56-78", undefined, "+212612345678"],
    ["00212612345678", undefined, "+212612345678"],
    ["0522 123 456", "MA", "+212522123456"],
    ["050 123 4567", "SA", "+966501234567"],
    ["0501234567", "SA", "+966501234567"],
    ["+966 50 123 4567", undefined, "+966501234567"],
    ["00966501234567", "MA", "+966501234567"],
    ["+33 6 12 34 56 78", undefined, "+33612345678"],
  ] as const)("%s (%s) -> %s", (raw, country, expected) => {
    expect(normalizePhone(raw, country)).toEqual({ ok: true, value: expected });
  });

  it("un numéro national sans pays par défaut est refusé", () => {
    expect(normalizePhone("0612345678")).toEqual({ ok: false });
  });

  it.each(["", "abc", "123", "+212", "0000000000", "+999 123", "x".repeat(41)])("refuse %j", (raw) => {
    expect(normalizePhone(raw, "MA")).toEqual({ ok: false });
  });

  it("un code pays invalide est ignoré (pas d'exception)", () => {
    expect(normalizePhone("0612345678", "ZZZ")).toEqual({ ok: false });
  });
});

describe("findDuplicate", () => {
  const a = { id: "a", email_normalized: "a@x.com", phone_e164: "+212612345678" };
  const b = { id: "b", email_normalized: "b@x.com", phone_e164: "+966501234567" };
  const phoneOnly = { id: "p", email_normalized: null, phone_e164: "+212600000000" };

  it("aucun contact correspondant : none ; aucun identifiant : none", () => {
    expect(findDuplicate({ email_normalized: "z@x.com", phone_e164: null }, [a, b])).toEqual({ kind: "none" });
    expect(findDuplicate({ email_normalized: null, phone_e164: null }, [a, b, phoneOnly])).toEqual({ kind: "none" });
  });

  it("même e-mail, même téléphone, ou les deux du MÊME contact : match", () => {
    expect(findDuplicate({ email_normalized: "a@x.com", phone_e164: null }, [a, b])).toEqual({ kind: "match", id: "a" });
    expect(findDuplicate({ email_normalized: null, phone_e164: "+966501234567" }, [a, b])).toEqual({ kind: "match", id: "b" });
    expect(findDuplicate({ email_normalized: "a@x.com", phone_e164: "+212612345678" }, [a, b])).toEqual({ kind: "match", id: "a" });
    expect(findDuplicate({ email_normalized: "nouveau@x.com", phone_e164: "+212600000000" }, [a, phoneOnly])).toEqual({ kind: "match", id: "p" });
  });

  it("l'e-mail d'un contact et le téléphone d'un AUTRE : conflict, jamais de fusion", () => {
    expect(findDuplicate({ email_normalized: "a@x.com", phone_e164: "+966501234567" }, [a, b])).toEqual({ kind: "conflict", ids: ["a", "b"] });
  });

  it("un identifiant nul ne correspond jamais à un autre identifiant nul", () => {
    expect(findDuplicate({ email_normalized: null, phone_e164: "+212600000000" }, [a, phoneOnly])).toEqual({ kind: "match", id: "p" });
  });
});

describe("createContactSchema", () => {
  it("normalise e-mail et téléphone, conserve l'e-mail saisi", () => {
    const parsed = createContactSchema.safeParse({ name: "Ahmed", email: " Ahmed@Exemple.MA ", phone: "0612345678", default_country: "MA", language: "fr", country: "MA" });
    expect(parsed.success && parsed.data).toMatchObject({
      name: "Ahmed",
      email_raw: "Ahmed@Exemple.MA",
      email_normalized: "ahmed@exemple.ma",
      phone_e164: "+212612345678",
      language: "fr",
      country: "MA",
      external_source: null,
      attributes: {},
    });
  });

  it("le pays du contact sert de pays par défaut pour un numéro national", () => {
    const parsed = createContactSchema.safeParse({ phone: "0501234567", country: "SA" });
    expect(parsed.success && parsed.data.phone_e164).toBe("+966501234567");
  });

  it("champs vides = absents ; au moins un identifiant", () => {
    expect(createContactSchema.safeParse({ email: "", phone: "  " }).success).toBe(false);
    expect(createContactSchema.safeParse({ name: "Sans identifiant" }).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "+212612345678", email: "" }).success).toBe(true);
  });

  it("e-mail ou téléphone invalide : refusé avec le champ en cause", () => {
    const email = createContactSchema.safeParse({ email: "pas-un-email" });
    expect(!email.success && email.error.issues[0]?.path).toEqual(["email"]);
    const phone = createContactSchema.safeParse({ phone: "0612345678" });
    expect(!phone.success && phone.error.issues[0]?.path).toEqual(["phone"]);
  });

  it("source et identifiant externes vont ensemble", () => {
    expect(createContactSchema.safeParse({ email: "a@x.com", external_source: "salla" }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", external_source: "salla", external_id: "42" }).success).toBe(true);
  });

  it("nom avec caractère invisible, langue ou pays mal formés, attributs trop gros : refusés", () => {
    expect(createContactSchema.safeParse({ email: "a@x.com", name: "a؜b" }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", language: "fra" }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", country: "ma" }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", attributes: { note: "x".repeat(501) } }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", attributes: { nested: { a: 1 } } }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", attributes: { note: "a\u202Eb" } }).success).toBe(false);
    expect(createContactSchema.safeParse({ email: "a@x.com", attributes: { "cle\u202E": "ok" } }).success).toBe(false);
  });

  it("organization_id revendiqué est conservé tel quel pour comparaison, jamais utilisé comme source", () => {
    const parsed = createContactSchema.safeParse({ email: "a@x.com", organization_id: ORG });
    expect(parsed.success && parsed.data.organization_id).toBe(ORG);
    expect(createContactSchema.safeParse({ email: "a@x.com", organization_id: "pas-un-uuid" }).success).toBe(false);
  });
});

describe("updateContactSchema", () => {
  it("exige l'identifiant du contact et applique les mêmes règles", () => {
    expect(updateContactSchema.safeParse({ email: "a@x.com" }).success).toBe(false);
    const parsed = updateContactSchema.safeParse({ contact_id: CONTACT, email: "A@X.com" });
    expect(parsed.success && parsed.data).toMatchObject({ contact_id: CONTACT, email_normalized: "a@x.com" });
    expect(updateContactSchema.safeParse({ contact_id: CONTACT, name: "Sans identifiant" }).success).toBe(false);
  });
});

describe("consentement", () => {
  it("enregistrement : canal connu, finalité et source en code court, preuve limitée", () => {
    const ok = recordConsentSchema.safeParse({
      contact_id: CONTACT,
      channel: "email",
      purpose: "marketing",
      source: "web_form",
      proof: { consent_text: "J'accepte de recevoir des offres.", consent_version: "v2", ip: "203.0.113.7", url: "https://exemple.ma/inscription" },
    });
    expect(ok.success).toBe(true);
    expect(recordConsentSchema.safeParse({ contact_id: CONTACT, channel: "sms", purpose: "marketing", source: "web_form" }).success).toBe(false);
    expect(recordConsentSchema.safeParse({ contact_id: CONTACT, channel: "email", purpose: "Marketing!", source: "web_form" }).success).toBe(false);
    expect(recordConsentSchema.safeParse({ contact_id: CONTACT, channel: "email", purpose: "marketing", source: "web_form", proof: { cookie: "x" } }).success).toBe(false);
    expect(recordConsentSchema.safeParse({ contact_id: CONTACT, channel: "email", purpose: "marketing", source: "web_form", proof: { url: "http://exemple.ma" } }).success).toBe(false);
  });

  it("sans preuve : objet vide", () => {
    const parsed = recordConsentSchema.safeParse({ contact_id: CONTACT, channel: "whatsapp", purpose: "marketing", source: "manual" });
    expect(parsed.success && parsed.data.proof).toEqual({});
  });

  it("révocation : do_not_contact faux par défaut, finalité facultative", () => {
    const parsed = revokeConsentSchema.safeParse({ contact_id: CONTACT, channel: "email" });
    expect(parsed.success && parsed.data).toMatchObject({ do_not_contact: false });
    expect(revokeConsentSchema.safeParse({ contact_id: CONTACT, channel: "email", purpose: "marketing", do_not_contact: true }).success).toBe(true);
    expect(revokeConsentSchema.safeParse({ contact_id: "x", channel: "email" }).success).toBe(false);
  });
});
