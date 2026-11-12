import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc }), deriveServerSecret: (purpose: string) => `derive-${purpose}-de-test` }));
vi.mock("../env/server", () => ({ getServerEnv: () => ({ TRUSTED_PROXY_HOPS: 1 }) }));

import type { CapturePayload } from "@fusion-leap/domain";
import { captureLead, clientIp, hashFormKey, ipBucketKey, ipBucketPrefix, isFormKeyOriginOk, isOriginAllowed } from "./capture-lead";
import { ServiceError } from "./errors";

const KEY = `flk_${"a1".repeat(32)}`;
const payload = (over: Partial<CapturePayload> = {}): CapturePayload => ({
  honeypot: false, name: "Nadia", email_raw: "Nadia@Exemple.ma", email_normalized: "nadia@exemple.ma", phone_e164: "+212611111111", language: "fr", country: "MA",
  utm: { utm_source: "newsletter" }, consent: null, ...over,
});

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { contact_created: true, lead_created: true, consent_recorded: false }, error: null });
});

describe("hashFormKey / ipBucketKey / clientIp", () => {
  it("l'empreinte est le SHA-256 hexadécimal de la clé (jamais la clé)", () => {
    expect(hashFormKey(KEY)).toBe(createHash("sha256").update(KEY).digest("hex"));
    expect(hashFormKey(KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFormKey(KEY)).not.toContain(KEY);
  });

  it("l'identifiant de seau d'une IP est opaque, stable et ne contient pas l'adresse", () => {
    const a = ipBucketKey("203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(ipBucketKey("203.0.113.7"));
    expect(a).not.toBe(ipBucketKey("203.0.113.8"));
    expect(a).not.toContain("203");
  });

  it("clientIp : élément de x-forwarded-for à `hops` rangs en partant de la DROITE (le client ne forge que la gauche)", () => {
    const h = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null });
    // un proxy de confiance qui AJOUTE l'adresse vue : la valeur forgée par le client est à gauche, la vraie à droite
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }), 1)).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), 1)).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.1" }), 2)).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), 2)).toBeNull(); // moins de proxys que prévu
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), 0)).toBeNull(); // aucun proxy de confiance : en-tête ignoré
    expect(clientIp(h({ "x-real-ip": "203.0.113.7" }), 1)).toBeNull(); // x-real-ip n'est plus cru
    expect(clientIp(h({}), 1)).toBeNull();
  });

  it("clientIp : port retiré, IPv6 acceptée, valeur illisible : null", () => {
    const h = (value: string) => ({ get: (name: string) => (name === "x-forwarded-for" ? value : null) });
    expect(clientIp(h("203.0.113.7:51234"), 1)).toBe("203.0.113.7");
    expect(clientIp(h("[2001:db8::1]:443"), 1)).toBe("2001:db8::1");
    expect(clientIp(h("2001:db8::1"), 1)).toBe("2001:db8::1");
    for (const bad of ["pas une ip", "999.1.1.1", "1.2.3", "1.2.3.4.5", "<script>"]) expect(clientIp(h(bad), 1), bad).toBeNull();
  });

  it("clientIp : par défaut, le nombre de proxys vient de l'environnement (1)", () => {
    expect(clientIp({ get: (name: string) => (name === "x-forwarded-for" ? "1.1.1.1, 203.0.113.7" : null) })).toBe("203.0.113.7");
  });

  it("ipBucketPrefix : IPv4 telle quelle, IPv6 regroupée par /64", () => {
    expect(ipBucketPrefix("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucketPrefix("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002");
    expect(ipBucketPrefix("2001:db8:1:2::1")).toBe(ipBucketPrefix("2001:db8:1:2:ffff::9"));
    expect(ipBucketPrefix("2001:db8::1")).toBe("2001:0db8:0000:0000");
    expect(ipBucketKey("2001:db8:1:2::1")).toBe(ipBucketKey("2001:db8:1:2:ffff::9"));
    expect(ipBucketKey("2001:db8:1:2::1")).not.toBe(ipBucketKey("2001:db8:1:3::1"));
  });
});

describe("captureLead", () => {
  it("appelle capture_lead avec l'EMPREINTE de la clé, l'origine et les valeurs normalisées (jamais la clé en clair)", async () => {
    const result = await captureLead({ keyHash: hashFormKey(KEY), origin: "https://exemple.ma", ip: "203.0.113.7", payload: payload() });
    expect(result).toEqual({ contactCreated: true, leadCreated: true, consentRecorded: false });
    expect(rpc).toHaveBeenCalledWith("capture_lead", {
      p_key_hash: hashFormKey(KEY), p_origin: "https://exemple.ma", p_name: "Nadia", p_email_raw: "Nadia@Exemple.ma", p_email_normalized: "nadia@exemple.ma",
      p_phone_e164: "+212611111111", p_language: "fr", p_country: "MA", p_utm: { utm_source: "newsletter" }, p_consent: null,
    });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain(KEY);
  });

  it("le consentement part avec sa preuve : texte, version, page et IP", async () => {
    const consent = { channel: "email" as const, purpose: "marketing", text: "J'accepte.", version: "v2", page_url: "https://exemple.ma/inscription" };
    await captureLead({ keyHash: hashFormKey(KEY), origin: "https://exemple.ma", ip: "203.0.113.7", payload: payload({ consent }) });
    const args = rpc.mock.calls[0]?.[1] as { p_consent: unknown };
    expect(args.p_consent).toEqual({
      channel: "email", purpose: "marketing",
      proof: { consent_text: "J'accepte.", consent_version: "v2", url: "https://exemple.ma/inscription", ip: "203.0.113.7" },
    });
  });

  it.each([
    [{ code: "P0001", message: "form_key_invalid" }, "forbidden"],
    [{ code: "P0001", message: "quota_exceeded" }, "quota_exceeded"],
    [{ code: "P0001", message: "subscription_inactive" }, "quota_exceeded"],
    [{ code: "P0001", message: "too_many_leads" }, "conflict"],
    [{ code: "22023", message: "validation_failed" }, "validation_failed"],
    [{ code: "XX000", message: "boom" }, "internal_error"],
  ] as const)("erreur %j -> %s (même refus pour clé, origine ou projet)", async (error, expected) => {
    rpc.mockResolvedValue({ data: null, error });
    await expect(captureLead({ keyHash: hashFormKey(KEY), origin: "https://exemple.ma", ip: null, payload: payload() })).rejects.toMatchObject({ code: expected });
  });

  it("panne réseau ou réponse illisible : internal_error", async () => {
    rpc.mockRejectedValue(new Error("réseau"));
    await expect(captureLead({ keyHash: "a".repeat(64), origin: "https://exemple.ma", ip: null, payload: payload() })).rejects.toBeInstanceOf(ServiceError);
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(captureLead({ keyHash: "a".repeat(64), origin: "https://exemple.ma", ip: null, payload: payload() })).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("isFormKeyOriginOk", () => {
  it("vrai seulement si la base répond vrai pour CETTE clé et CETTE origine ; toute erreur : faux", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await isFormKeyOriginOk(hashFormKey(KEY), "https://exemple.ma")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("form_key_origin_ok", { p_key_hash: hashFormKey(KEY), p_origin: "https://exemple.ma" });
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await isFormKeyOriginOk(hashFormKey(KEY), "https://exemple.ma")).toBe(false);
    rpc.mockResolvedValue({ data: true, error: { code: "XX000" } });
    expect(await isFormKeyOriginOk(hashFormKey(KEY), "https://exemple.ma")).toBe(false);
    rpc.mockRejectedValue(new Error("réseau"));
    expect(await isFormKeyOriginOk(hashFormKey(KEY), "https://exemple.ma")).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("vrai seulement si la base répond vrai ; toute erreur : faux (échec fermé)", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await isOriginAllowed("https://exemple.ma")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("form_origin_allowed", { p_origin: "https://exemple.ma" });
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await isOriginAllowed("https://exemple.ma")).toBe(false);
    rpc.mockResolvedValue({ data: true, error: { code: "XX000" } });
    expect(await isOriginAllowed("https://exemple.ma")).toBe(false);
    rpc.mockRejectedValue(new Error("réseau"));
    expect(await isOriginAllowed("https://exemple.ma")).toBe(false);
  });
});
