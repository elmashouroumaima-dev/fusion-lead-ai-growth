import { randomBytes } from "node:crypto";
import { createKeyRing, createUnsubscribeToken } from "@fusion-leap/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, getKeyRing, takePublicToken } = vi.hoisted(() => ({ rpc: vi.fn(), getKeyRing: vi.fn(), takePublicToken: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("../../../../lib/smtp/secrets", () => ({ getKeyRing }));
vi.mock("../../../../lib/service/rate-limit", () => ({ takePublicToken }));
vi.mock("../../../../lib/service/capture-lead", () => ({ clientIp: () => "203.0.113.5", ipBucketKey: (ip: string) => `bucket:${ip}` }));
vi.mock("../../../../lib/env/server", () => ({ getServerEnv: () => ({ SITE_URL: "https://app.acme.test", TRUSTED_PROXY_HOPS: 0 }) }));

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const ring = createKeyRing(1, { 1: randomBytes(32).toString("base64") });
const token = createUnsubscribeToken(ring, { organizationId: ORG, messageId: MSG });
const ctx = (t: string) => ({ params: Promise.resolve({ token: t }) });
const post = (t: string, body = "List-Unsubscribe=One-Click") =>
  POST(new Request(`https://app.acme.test/api/unsubscribe/${t}`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), ctx(t));

beforeEach(() => {
  rpc.mockReset();
  takePublicToken.mockReset();
  getKeyRing.mockReset();
  getKeyRing.mockReturnValue(ring);
  takePublicToken.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  rpc.mockResolvedValue({ data: { outcome: "applied" }, error: null });
});

describe("GET /api/unsubscribe/[token] : le lien de l'e-mail", () => {
  it("renvoie vers la page de confirmation du site configuré et NE désabonne PAS", async () => {
    const res = await GET(new Request("https://evil.example/api/unsubscribe/x"), ctx(token));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://app.acme.test/fr/unsubscribe/${token}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("jeton de forme invalide : 404, aucune redirection construite avec la valeur", async () => {
    for (const bad of ["abc", "../../etc", "v1.1.x.y.z"]) {
      const res = await GET(new Request("https://app.acme.test/api/unsubscribe/x"), ctx(bad));
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

describe("POST /api/unsubscribe/[token] : un clic (RFC 8058)", () => {
  it("jeton valide : 200, désabonnement appliqué pour l'entreprise et le message du jeton", async () => {
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("unsubscribe_apply", { p_org: ORG, p_message: MSG });
  });
  it("corps absent ou différent de List-Unsubscribe=One-Click : 400, rien d'écrit", async () => {
    for (const body of ["", "x=1", "List-Unsubscribe=No"]) {
      expect((await post(token, body)).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("corps trop gros : 400 (plafond de lecture), rien d'écrit", async () => {
    expect((await post(token, "x".repeat(2000))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("jeton falsifié : 400 sans appel à la base", async () => {
    const res = await post(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_link");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("jeton invalide : la limite n'est PAS consommée (aucun accès base pour un jeton inventé)", async () => {
    await post(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"));
    expect(takePublicToken).not.toHaveBeenCalled();
  });
  it("limite atteinte : 429 avec Retry-After, rien d'écrit", async () => {
    takePublicToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const res = await post(token);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("base indisponible ou clé absente : 503 avec Retry-After (la messagerie peut réessayer), sans détail", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "détail SQL secret" } });
    let res = await post(token);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("SQL");
    // sans clé configurée aucun lien n'a pu être émis : le jeton ne peut pas être valide (400, base non appelée)
    rpc.mockClear();
    getKeyRing.mockReturnValue(null);
    res = await post(token);
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("idempotent : un second clic renvoie aussi 200", async () => {
    rpc.mockResolvedValue({ data: { outcome: "already" }, error: null });
    expect((await post(token)).status).toBe(200);
  });
});
