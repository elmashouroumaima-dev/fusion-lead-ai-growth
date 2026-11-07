import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";

const rpc = vi.fn();
const takeToken = vi.fn();
const cookieSet = vi.fn();
const reads: unknown[][] = [];

vi.mock("../../../lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
    rpc,
    from: () => {
      let calls = 0;
      const q: { select: () => unknown; eq: () => unknown } = {
        select: () => q,
        eq: () => {
          calls += 1;
          return calls === 2 ? Promise.resolve({ data: reads.shift() ?? [], error: null }) : q;
        },
      };
      return q;
    },
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet, get: vi.fn() }) }));
vi.mock("../../../lib/service/rate-limit", () => ({ LIMITS: {}, takeToken: (...a: unknown[]) => takeToken(...a) }));

import { ServiceError } from "../../../lib/service/errors";
import { captureLogs } from "../../../lib/service/log-capture.testkit";
import { POST } from "./route";

const req = () =>
  new Request("http://localhost:3000/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": KEY, "x-request-id": "req-12345678" },
    body: JSON.stringify({ name: "Acme" }),
  });

let cap: ReturnType<typeof captureLogs>;

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  takeToken.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  cap = captureLogs();
});
afterEach(() => cap.stop());

describe("POST /api/orgs : limitation de débit « sensible »", () => {
  it("prend un jeton sensible pour l'utilisateur, sans organisation (seau par portée utilisateur)", async () => {
    reads.push([], [{ organization_id: ORG, role: "company_owner", organizations: { id: ORG, name: "Acme", slug: "acme", locale: "fr", timezone: "UTC", status: "active" } }]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    expect((await POST(req())).status).toBe(201);
    expect(takeToken).toHaveBeenCalledWith({ organizationId: null, userId: USER, scope: "sensitive" });
  });

  it("limite atteinte -> 429 rate_limited + Retry-After + request_id ; aucune organisation créée", async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 6 });
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("6");
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(requestId).not.toBe("req-12345678"); // le x-request-id du client n'est jamais repris
    expect(await res.json()).toEqual({ code: "rate_limited", message: expect.any(String), request_id: requestId });
    expect(rpc).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("backend en panne -> ÉCHEC FERMÉ 503 service_unavailable ; aucune organisation créée", async () => {
    takeToken.mockRejectedValue(new ServiceError("service_unavailable"));
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("service_unavailable");
    expect(rpc).not.toHaveBeenCalled();
  });
});
