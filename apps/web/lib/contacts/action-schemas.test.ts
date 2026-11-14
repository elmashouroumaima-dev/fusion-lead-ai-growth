import { describe, expect, it } from "vitest";
import {
  CONSENT_RECORD_FIELDS,
  CONSENT_REVOKE_FIELDS,
  DO_NOT_CONTACT_FIELDS,
  recordConsentFormSchema,
  revokeConsentFormSchema,
  setDoNotContactFormSchema,
} from "./action-schemas";
import { toActionCode } from "./action-code";
import { ALL_PURPOSES, CONSENT_PURPOSES, CONSENT_SOURCES } from "./consent-options";

const CONTACT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

describe("recordConsentFormSchema", () => {
  const base = { contact_id: CONTACT, channel: "email", purpose: "marketing", source: "phone" };

  it("accepte un consentement saisi à la main : la preuve se limite au texte et à la version", () => {
    const result = recordConsentFormSchema.safeParse({ ...base, consent_text: "J'accepte les offres", consent_version: "v2", organization_id: ORG });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.proof).toEqual({ consent_text: "J'accepte les offres", consent_version: "v2" });
  });

  it("des champs vides donnent une preuve vide (jamais une chaîne vide enregistrée)", () => {
    const result = recordConsentFormSchema.safeParse({ ...base, consent_text: "   ", consent_version: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.proof).toEqual({});
  });

  it("refuse un canal, une finalité ou une source invalide, et un identifiant de contact invalide", () => {
    expect(recordConsentFormSchema.safeParse({ ...base, channel: "sms" }).success).toBe(false);
    expect(recordConsentFormSchema.safeParse({ ...base, purpose: "Marketing !" }).success).toBe(false);
    expect(recordConsentFormSchema.safeParse({ ...base, source: "" }).success).toBe(false);
    expect(recordConsentFormSchema.safeParse({ ...base, contact_id: "pas-un-uuid" }).success).toBe(false);
  });

  it("une adresse IP ou une URL envoyées à part ne deviennent jamais la preuve : seuls les champs de la liste fermée sont lus", () => {
    expect(CONSENT_RECORD_FIELDS).not.toContain("ip");
    expect(CONSENT_RECORD_FIELDS).not.toContain("url");
    expect(CONSENT_RECORD_FIELDS).not.toContain("proof");
  });
});

describe("revokeConsentFormSchema", () => {
  const base = { contact_id: CONTACT, channel: "whatsapp" };

  it("« toutes les finalités » devient une finalité nulle ; la case « bloquer » est lue (on / true), tout le reste est faux", () => {
    const all = revokeConsentFormSchema.safeParse({ ...base, purpose: ALL_PURPOSES, do_not_contact: "on" });
    expect(all.success).toBe(true);
    if (all.success) {
      expect(all.data.purpose).toBeNull();
      expect(all.data.do_not_contact).toBe(true);
    }
    for (const value of [undefined, "", "off", "false", "1"]) {
      const result = revokeConsentFormSchema.safeParse({ ...base, purpose: "marketing", do_not_contact: value });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.do_not_contact).toBe(false);
    }
  });

  it("une finalité précise est conservée ; un canal inconnu est refusé", () => {
    const one = revokeConsentFormSchema.safeParse({ ...base, purpose: "newsletter" });
    expect(one.success).toBe(true);
    if (one.success) expect(one.data.purpose).toBe("newsletter");
    expect(revokeConsentFormSchema.safeParse({ ...base, channel: "fax", purpose: "marketing" }).success).toBe(false);
  });
});

describe("setDoNotContactFormSchema", () => {
  it("seule la valeur « true » pose le blocage ; l'identifiant doit être un UUID", () => {
    const set = setDoNotContactFormSchema.safeParse({ contact_id: CONTACT, value: "true" });
    const clear = setDoNotContactFormSchema.safeParse({ contact_id: CONTACT, value: "false" });
    expect(set.success && set.data.value).toBe(true);
    expect(clear.success && clear.data.value).toBe(false);
    expect(setDoNotContactFormSchema.safeParse({ contact_id: "x", value: "true" }).success).toBe(false);
  });
});

describe("listes fermées de champs et options", () => {
  it("l'organisation du formulaire est lue pour être COMPARÉE au contexte, jamais crue ; aucune liste ne laisse passer un champ inattendu", () => {
    for (const fields of [CONSENT_RECORD_FIELDS, CONSENT_REVOKE_FIELDS, DO_NOT_CONTACT_FIELDS]) {
      expect(fields).toContain("organization_id");
      expect(fields).toContain("contact_id");
    }
  });

  it("les options proposées sont des codes courts en minuscules acceptés par la base", () => {
    for (const code of [...CONSENT_PURPOSES, ...CONSENT_SOURCES]) expect(code).toMatch(/^[a-z][a-z0-9_]{0,49}$/);
    expect(CONSENT_PURPOSES).not.toContain(ALL_PURPOSES);
  });
});

describe("toActionCode", () => {
  it("traduit les codes de la couche service en codes d'état de formulaire", () => {
    expect(toActionCode("validation_failed")).toBe("invalid_input");
    expect(toActionCode("unauthenticated")).toBe("forbidden");
    expect(toActionCode("forbidden")).toBe("forbidden");
    expect(toActionCode("not_found")).toBe("not_found");
    expect(toActionCode("conflict")).toBe("conflict");
    expect(toActionCode("internal_error")).toBe("generic");
  });
});
