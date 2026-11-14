import { beforeEach, describe, expect, it, vi } from "vitest";

const { takePublicToken, env } = vi.hoisted(() => ({ takePublicToken: vi.fn(), env: { value: { WHATSAPP_VERIFY_TOKEN: "jeton-plateforme-0123456789", SITE_URL: "https://app.acme.test", TRUSTED_PROXY_HOPS: 0 } as Record<string, unknown> } }));
vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: vi.fn() }) }));
vi.mock("../../../../lib/service/rate-limit", () => ({ takePublicToken }));
vi.mock("../../../../lib/service/capture-lead", () => ({ clientIp: () => "203.0.113.9", ipBucketKey: (ip: string) => `bucket:${ip}` }));
vi.mock("../../../../lib/env/server", () => ({ getServerEnv: () => env.value }));
vi.mock("../../../../lib/service/integration-secrets", () => ({ readIntegrationWebhookSecret: vi.fn() }));

import { GET } from "./route";

const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const get = (provider: string, query: string) => GET(new Request(`https://app.acme.test/api/webhooks/${provider}?${query}`), ctx(provider));
const OK = "hub.mode=subscribe&hub.verify_token=jeton-plateforme-0123456789&hub.challenge=1158201444";

beforeEach(() => {
  takePublicToken.mockReset();
  takePublicToken.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  env.value = { WHATSAPP_VERIFY_TOKEN: "jeton-plateforme-0123456789", SITE_URL: "https://app.acme.test", TRUSTED_PROXY_HOPS: 0 };
});

describe("GET /api/webhooks/whatsapp : poignée de main d'abonnement de Meta", () => {
  it("jeton correct : 200 et le défi en texte brut", async () => {
    const res = await get("whatsapp", OK);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("mauvais jeton, mauvais mode ou défi dangereux : 403", async () => {
    expect((await get("whatsapp", OK.replace("jeton-plateforme-0123456789", "autre-jeton-0123456789"))).status).toBe(403);
    expect((await get("whatsapp", OK.replace("subscribe", "unsubscribe"))).status).toBe(403);
    expect((await get("whatsapp", "hub.mode=subscribe&hub.verify_token=jeton-plateforme-0123456789&hub.challenge=%3Cscript%3E")).status).toBe(403);
  });
  it("jeton de la plateforme non configuré : 404 (aucune poignée de main possible)", async () => {
    env.value = { SITE_URL: "https://app.acme.test", TRUSTED_PROXY_HOPS: 0 };
    expect((await get("whatsapp", OK)).status).toBe(404);
  });
  it("autre fournisseur : 404", async () => {
    expect((await get("email", OK)).status).toBe(404);
  });
  it("limite atteinte : 429 avec Retry-After ; panne du limiteur : 503 ; le défi n'est pas renvoyé", async () => {
    takePublicToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 4 });
    const limited = await get("whatsapp", OK);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("4");
    expect(await limited.text()).not.toContain("1158201444");
    takePublicToken.mockRejectedValue(new Error("db"));
    expect((await get("whatsapp", OK)).status).toBe(503);
  });
});
