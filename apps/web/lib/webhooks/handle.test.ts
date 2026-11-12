import { signHmacSha256Hex, verifyHmacSha256Hex, type WebhookAdapter, type WebhookStore } from "@fusion-leap/adapters";
import { describe, expect, it, vi } from "vitest";
import { readBoundedBytes } from "../service/with-service";
import { handleWebhookRequest, type WebhookRouteDeps } from "./handle";
import { getWebhookAdapter } from "./registry";

// with-service tire le client de session et la limitation de débit (modules serveur) : seule la lecture bornée du corps sert ici
vi.mock("../supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("../service/rate-limit", () => ({ LIMITS: {}, takeToken: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));

const SECRET = "secret-webhook-de-test";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INT = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000;

const adapter: WebhookAdapter = {
  provider: "whatsapp",
  maxBytes: 256,
  parse(raw) {
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      return null;
    }
  },
  extractAccount: (payload) => ((payload as { account?: string }).account ?? null),
  extractEventId: (payload) => ((payload as { event?: string }).event ?? null),
  extractTimestamp: (payload) => ((payload as { ts?: number }).ts ?? null),
  verify: ({ rawBody, headers, secret }) => verifyHmacSha256Hex({ secret, rawBody, signature: headers["x-signature"], prefix: "sha256=" }),
};

function setup(over: Partial<WebhookRouteDeps> = {}) {
  const records: unknown[] = [];
  const rejections: unknown[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const store: WebhookStore = {
    async resolve(_provider, account) {
      return account === "acc" ? { organizationId: ORG, integrationId: INT } : null;
    },
    async record(input) {
      records.push(input);
      return { eventId: "evt-1", duplicate: records.length > 1 };
    },
    async recordRejection(input) {
      rejections.push(input);
    },
  };
  const deps: WebhookRouteDeps = {
    getAdapter: (provider) => (provider === "whatsapp" ? adapter : null),
    limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    clientIp: () => "203.0.113.9",
    readBody: readBoundedBytes,
    store,
    readSecret: async () => SECRET,
    log: (event, fields) => logs.push({ event, fields }),
    now: () => NOW,
    ...over,
  };
  return { deps, records, rejections, logs };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/webhooks/whatsapp", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const signedPost = (payload: object, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return post(body, { "x-signature": `sha256=${signHmacSha256Hex(secret, new TextEncoder().encode(body))}` });
};
const GOOD = { account: "acc", event: "e1", ts: NOW };

describe("transport sécurisé (J32)", () => {
  const secure = (request: Request): boolean => (request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")) === "https";
  const http = (headers: Record<string, string> = {}) =>
    new Request("http://app.test/api/webhooks/whatsapp", { method: "POST", body: "{}", headers: { "content-type": "application/json", ...headers } });

  it("HTTP refusé 400 AVANT toute lecture quand le HTTPS est exigé ; l'en-tête du proxy « https » ou une adresse https passent", async () => {
    const { deps, records, logs } = setup({ requireHttps: true, isSecure: secure });
    const readBody = vi.spyOn(deps, "readBody");
    const refused = await handleWebhookRequest(http(), "whatsapp", "req-1", deps);
    expect(refused.status).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(logs.map((l) => l.event)).toContain("webhook.insecure_transport");
    expect(JSON.stringify(logs)).not.toContain("authorization");
    await handleWebhookRequest(http({ "x-forwarded-proto": "https" }), "whatsapp", "req-2", deps);
    expect(readBody).toHaveBeenCalledTimes(1);
    await handleWebhookRequest(post("{}"), "whatsapp", "req-2b", deps);
    expect(readBody).toHaveBeenCalledTimes(2);
  });

  it("sans exigence (développement local) : HTTP accepté ; exigence sans fonction de contrôle : refus (échec fermé)", async () => {
    const dev = setup({ requireHttps: false });
    const devRead = vi.spyOn(dev.deps, "readBody");
    await handleWebhookRequest(http(), "whatsapp", "req-3", dev.deps);
    expect(devRead).toHaveBeenCalledTimes(1);
    const noCheck = setup({ requireHttps: true });
    const noCheckRead = vi.spyOn(noCheck.deps, "readBody");
    expect((await handleWebhookRequest(post("{}"), "whatsapp", "req-4", noCheck.deps)).status).toBe(400);
    expect(noCheckRead).not.toHaveBeenCalled();
  });
});

describe("fournisseur", () => {
  it("registre de production : seul l'e-mail (J32) a un adaptateur ; WhatsApp (J34 et J35) et tout autre fournisseur répondent 404", () => {
    expect(getWebhookAdapter("whatsapp")).toBeNull();
    expect(getWebhookAdapter("email")?.provider).toBe("email");
    expect(getWebhookAdapter("salla")).toBeNull();
    expect(getWebhookAdapter("__proto__")).toBeNull();
    expect(getWebhookAdapter("constructor")).toBeNull();
  });

  it("fournisseur inconnu ou mal formé : 404 sans rien lire ni limiter", async () => {
    const { deps } = setup();
    const limit = vi.spyOn(deps, "limit");
    for (const name of ["inconnu", "Whatsapp", "../x", "a", "whatsapp1", ""]) {
      const res = await handleWebhookRequest(signedPost(GOOD), name, "req-1", deps);
      expect(res.status, name).toBe(404);
    }
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("réponses", () => {
  it("événement valide : 200 accepted, enregistré ; rejeu : 200 duplicate ; en-tête de requête renvoyé, jamais de payload", async () => {
    const { deps, records } = setup();
    const first = await handleWebhookRequest(signedPost(GOOD), "whatsapp", "req-1", deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-request-id")).toBe("req-1");
    const second = await handleWebhookRequest(signedPost(GOOD), "whatsapp", "req-2", deps);
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(records).toHaveLength(2);
  });

  it("signature invalide : 401 normalisé, trace de rejet, rien d'enregistré", async () => {
    const { deps, records, rejections } = setup();
    const res = await handleWebhookRequest(signedPost(GOOD, "mauvais-secret"), "whatsapp", "req-1", deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated", request_id: "req-1" });
    expect(records).toHaveLength(0);
    expect(rejections).toHaveLength(1);
  });

  it("compte inconnu : EXACTEMENT la même réponse qu'une signature invalide (statut, corps, en-têtes), sans trace ni enregistrement", async () => {
    const { deps, records, rejections } = setup();
    const unknown = await handleWebhookRequest(signedPost({ ...GOOD, account: "inconnu" }), "whatsapp", "req-1", deps);
    const badSignature = await handleWebhookRequest(signedPost(GOOD, "mauvais-secret"), "whatsapp", "req-1", deps);
    expect(unknown.status).toBe(401);
    expect(unknown.status).toBe(badSignature.status);
    expect(await unknown.json()).toEqual(await badSignature.json());
    expect([...unknown.headers.entries()].sort()).toEqual([...badSignature.headers.entries()].sort());
    expect(records).toHaveLength(0);
    expect(rejections).toHaveLength(1);
  });

  it("adresse source introuvable (proxy mal configuré) : 503 visible, corps non lu, jamais un seau commun à tous", async () => {
    const readBody = vi.fn(readBoundedBytes);
    const limit = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const { deps, logs } = setup({ clientIp: () => null, readBody, limit });
    const res = await handleWebhookRequest(signedPost(GOOD), "whatsapp", "req-1", deps);
    expect(res.status).toBe(503);
    expect(readBody).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(logs.map((l) => l.event)).toContain("webhook.no_client_ip");
  });

  it("le seau de débit reçoit le fournisseur ET l'adresse", async () => {
    const limit = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const { deps } = setup({ limit });
    await handleWebhookRequest(signedPost(GOOD), "whatsapp", "req-1", deps);
    expect(limit).toHaveBeenCalledWith({ provider: "whatsapp", ip: "203.0.113.9" });
  });

  it("corps illisible ou sans compte : 400 ; trop gros : 413 (rejeté pendant la lecture, avant tout parse)", async () => {
    const { deps } = setup();
    expect((await handleWebhookRequest(post("pas du json"), "whatsapp", "req-1", deps)).status).toBe(400);
    expect((await handleWebhookRequest(signedPost({ event: "e1" }), "whatsapp", "req-1", deps)).status).toBe(400);
    const big = await handleWebhookRequest(post(JSON.stringify({ ...GOOD, pad: "x".repeat(400) })), "whatsapp", "req-1", deps);
    expect(big.status).toBe(413);
    const declared = await handleWebhookRequest(post("{}", { "content-length": "99999" }), "whatsapp", "req-1", deps);
    expect(declared.status).toBe(413);
  });

  it("limitation de débit : 429 avec Retry-After, corps non lu", async () => {
    const readBody = vi.fn(readBoundedBytes);
    const { deps } = setup({ limit: async () => ({ allowed: false, retryAfterSeconds: 7 }), readBody });
    const res = await handleWebhookRequest(signedPost(GOOD), "whatsapp", "req-1", deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(readBody).not.toHaveBeenCalled();
  });

  it("file saturée ou panne de la base : 503 (le fournisseur réessaie) ; panne du secret : jamais 200", async () => {
    const down = setup({ readSecret: async () => { throw new Error("secret_lookup_failed"); } });
    const res = await handleWebhookRequest(signedPost(GOOD), "whatsapp", "req-1", down.deps);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(down.records).toHaveLength(0);
  });
});

describe("journaux", () => {
  it("une ligne par requête : événement et fournisseur seulement, jamais le payload, le compte, un en-tête ni un secret", async () => {
    const { deps, logs } = setup();
    await handleWebhookRequest(signedPost({ ...GOOD, secretField: "contenu-sensible" }), "whatsapp", "req-1", deps);
    await handleWebhookRequest(signedPost(GOOD, "mauvais-secret"), "whatsapp", "req-2", deps);
    expect(logs.map((l) => l.event)).toEqual(["webhook.accepted", "webhook.invalid_signature", "webhook.refused"]);
    const text = JSON.stringify(logs);
    for (const forbidden of ["contenu-sensible", SECRET, "mauvais-secret", "sha256=", '"acc"', "x-signature"]) expect(text).not.toContain(forbidden);
  });
});
