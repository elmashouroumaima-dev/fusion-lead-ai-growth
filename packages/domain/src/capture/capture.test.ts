import { describe, expect, it } from "vitest";
import {
  allowedOriginsSchema,
  buildConsentProof,
  capturePayloadSchema,
  createFormKeySchema,
  formKeySchema,
  setFormKeyActiveSchema,
  setFormKeyOriginsSchema,
} from "./index";

const UUID = (n: number) => `7a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEY = `flk_${"a1".repeat(32)}`;

describe("formKeySchema", () => {
  it("préfixe flk_ et 64 caractères hexadécimaux minuscules", () => {
    expect(formKeySchema.safeParse(KEY).success).toBe(true);
    for (const bad of ["", "flk_abc", `flk_${"A1".repeat(32)}`, `key_${"a1".repeat(32)}`, `${KEY}0`, ` ${KEY}`]) {
      expect(formKeySchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("capturePayloadSchema", () => {
  it("normalise e-mail et téléphone (marocain et saoudien), conserve l'e-mail saisi", () => {
    const parsed = capturePayloadSchema.safeParse({ name: "Nadia", email: " Nadia@Exemple.MA ", phone: "0612345678", default_country: "MA", language: "fr", country: "MA" });
    expect(parsed.success && parsed.data).toMatchObject({
      honeypot: false, name: "Nadia", email_raw: "Nadia@Exemple.MA", email_normalized: "nadia@exemple.ma", phone_e164: "+212612345678", language: "fr", country: "MA", utm: {}, consent: null,
    });
    const saudi = capturePayloadSchema.safeParse({ phone: "050 123 4567", country: "SA" });
    expect(saudi.success && saudi.data.phone_e164).toBe("+966501234567");
  });

  it("au moins un identifiant ; e-mail ou téléphone invalide : refusé avec le champ en cause", () => {
    expect(capturePayloadSchema.safeParse({ name: "Sans identifiant" }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "", phone: " " }).success).toBe(false);
    const email = capturePayloadSchema.safeParse({ email: "pas-un-email" });
    expect(!email.success && email.error.issues[0]?.path).toEqual(["email"]);
    const phone = capturePayloadSchema.safeParse({ phone: "0612345678" });
    expect(!phone.success && phone.error.issues[0]?.path).toEqual(["phone"]);
  });

  it("corps STRICT : aucune entreprise, aucun projet, aucun champ inconnu", () => {
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", organization_id: UUID(1) }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", project_id: UUID(2) }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", role: "owner" }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", consent: { channel: "email", text: "t", version: "v1", extra: 1 } }).success).toBe(false);
  });

  it("UTM : clés connues et textes courts, landing_page_id compris", () => {
    const ok = capturePayloadSchema.safeParse({ email: "a@x.com", utm: { utm_source: "newsletter", landing_page_id: "lp-1" } });
    expect(ok.success && ok.data.utm).toEqual({ utm_source: "newsletter", landing_page_id: "lp-1" });
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", utm: { cookie: "x" } }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", utm: { utm_source: "a؜b" } }).success).toBe(false);
  });

  it("champ piège : rempli = honeypot vrai ; vide ou absent = faux", () => {
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", website: "http://spam" }).success && true).toBe(true);
    const filled = capturePayloadSchema.safeParse({ email: "a@x.com", website: "http://spam" });
    expect(filled.success && filled.data.honeypot).toBe(true);
    const empty = capturePayloadSchema.safeParse({ email: "a@x.com", website: "" });
    expect(empty.success && empty.data.honeypot).toBe(false);
    const blank = capturePayloadSchema.safeParse({ email: "a@x.com", website: "   " });
    expect(blank.success && blank.data.honeypot).toBe(false);
  });

  it("consentement : canal connu, texte ET version obligatoires, page en https", () => {
    const ok = capturePayloadSchema.safeParse({
      email: "a@x.com",
      page_url: "https://exemple.ma/inscription",
      consent: { channel: "email", text: "J'accepte de recevoir des offres.", version: "v2" },
    });
    expect(ok.success && ok.data.consent).toEqual({ channel: "email", purpose: "marketing", text: "J'accepte de recevoir des offres.", version: "v2", page_url: "https://exemple.ma/inscription" });
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", consent: { channel: "sms", text: "t", version: "v" } }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", consent: { channel: "email", text: "t" } }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", consent: { channel: "email", version: "v1" } }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", consent: { channel: "email", text: "x".repeat(2001), version: "v1" } }).success).toBe(false);
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", page_url: "http://exemple.ma" }).success).toBe(false);
  });

  it("finalité : « marketing » (défaut) ou « newsletter » seulement, jamais un code libre", () => {
    const base = { email: "a@x.com", consent: { channel: "email", text: "t", version: "v1" } };
    const dflt = capturePayloadSchema.safeParse(base);
    expect(dflt.success && dflt.data.consent?.purpose).toBe("marketing");
    const news = capturePayloadSchema.safeParse({ ...base, consent: { ...base.consent, purpose: "newsletter" } });
    expect(news.success && news.data.consent?.purpose).toBe("newsletter");
    for (const purpose of ["transactional", "Marketing", "autre", ""]) {
      expect(capturePayloadSchema.safeParse({ ...base, consent: { ...base.consent, purpose } }).success, purpose).toBe(false);
    }
  });

  it("caractères invisibles ou de direction dans le nom : refusés", () => {
    expect(capturePayloadSchema.safeParse({ email: "a@x.com", name: "a؜b" }).success).toBe(false);
  });
});

describe("buildConsentProof", () => {
  const consent = { channel: "email" as const, purpose: "marketing", text: "Texte", version: "v1", page_url: null };

  it("texte, version, page et IP ; rien d'autre", () => {
    expect(buildConsentProof({ ...consent, page_url: "https://exemple.ma/x" }, "203.0.113.7")).toEqual({
      consent_text: "Texte", consent_version: "v1", url: "https://exemple.ma/x", ip: "203.0.113.7",
    });
    expect(buildConsentProof(consent, null)).toEqual({ consent_text: "Texte", consent_version: "v1" });
  });

  it("une IP illisible n'est jamais conservée", () => {
    expect(buildConsentProof(consent, "pas une ip !")).toEqual({ consent_text: "Texte", consent_version: "v1" });
    expect(buildConsentProof(consent, "2001:db8::1")).toMatchObject({ ip: "2001:db8::1" });
  });
});

describe("clés de formulaire : origines et gestion", () => {
  it("1 à 10 origines https exactes, minuscules, sans chemin ni doublon", () => {
    expect(allowedOriginsSchema.safeParse(["https://exemple.ma", "https://www.exemple.ma:8443"]).success).toBe(true);
    for (const bad of [[], ["http://exemple.ma"], ["https://Exemple.ma"], ["https://exemple.ma/page"], ["https://exemple.ma", "https://exemple.ma"], ["*"], Array.from({ length: 11 }, (_, i) => `https://s${i}.ma`)]) {
      expect(allowedOriginsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("création, activation et origines : identifiants et origines valides", () => {
    expect(createFormKeySchema.safeParse({ project_id: UUID(1), allowed_origins: ["https://exemple.ma"] }).success).toBe(true);
    expect(createFormKeySchema.safeParse({ allowed_origins: ["https://exemple.ma"] }).success).toBe(false);
    expect(setFormKeyActiveSchema.safeParse({ key_id: UUID(2), active: false }).success).toBe(true);
    expect(setFormKeyActiveSchema.safeParse({ key_id: UUID(2) }).success).toBe(false);
    expect(setFormKeyOriginsSchema.safeParse({ key_id: UUID(2), allowed_origins: ["https://autre.ma"] }).success).toBe(true);
  });
});
