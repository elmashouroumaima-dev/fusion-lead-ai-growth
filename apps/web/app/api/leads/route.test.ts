import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CaptureModule from "../../../lib/service/capture-lead";

const captureLead = vi.fn();
const isOriginAllowed = vi.fn();
const isFormKeyOriginOk = vi.fn();
const takePublicToken = vi.fn();

vi.mock("../../../lib/service/capture-lead", async (importOriginal) => {
  const actual = await importOriginal<typeof CaptureModule>();
  return {
    ...actual,
    captureLead: (...a: unknown[]) => captureLead(...a),
    isOriginAllowed: (...a: unknown[]) => isOriginAllowed(...a),
    isFormKeyOriginOk: (...a: unknown[]) => isFormKeyOriginOk(...a),
  };
});
vi.mock("../../../lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: vi.fn() }), deriveServerSecret: () => "derive-de-test" }));
const serverEnv: { TRUSTED_PROXY_HOPS: number; TURNSTILE_SECRET_KEY?: string; TURNSTILE_ENFORCE: boolean } = { TRUSTED_PROXY_HOPS: 1, TURNSTILE_ENFORCE: false };
vi.mock("../../../lib/env/server", () => ({ getServerEnv: () => serverEnv }));
const verifyTurnstile = vi.fn();
vi.mock("../../../lib/service/turnstile", () => ({ verifyTurnstile: (...a: unknown[]) => verifyTurnstile(...a) }));
vi.mock("../../../lib/service/rate-limit", () => ({ takePublicToken: (...a: unknown[]) => takePublicToken(...a) }));

import { ServiceError } from "../../../lib/service/errors";
import { captureLogs } from "../../../lib/service/log-capture.testkit";
import { OPTIONS, POST } from "./route";

const KEY = `flk_${"a1".repeat(32)}`;
const ORIGIN = "https://exemple.ma";

const request = (body: unknown, headers: Record<string, string> = {}, raw?: string): Request =>
  new Request("http://localhost/api/leads", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-form-key": KEY, "x-forwarded-for": "203.0.113.7", ...headers },
    body: raw ?? JSON.stringify(body),
  });

const valid = { email: "Nadia@Exemple.ma", name: "Nadia", utm: { utm_source: "newsletter" }, consent: { channel: "email", text: "J'accepte.", version: "v2" }, page_url: "https://exemple.ma/inscription" };

beforeEach(() => {
  vi.clearAllMocks();
  delete serverEnv.TURNSTILE_SECRET_KEY;
  serverEnv.TURNSTILE_ENFORCE = false;
  verifyTurnstile.mockResolvedValue("ok");
  isOriginAllowed.mockResolvedValue(true);
  isFormKeyOriginOk.mockResolvedValue(true);
  takePublicToken.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  captureLead.mockResolvedValue({ contactCreated: true, leadCreated: true, consentRecorded: true });
});

describe("POST /api/leads : réponse publique", () => {
  it("202 { status: received } avec CORS pour l'origine autorisée, sans aucun identifiant", async () => {
    const response = await POST(request(valid));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "received" });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("la réponse est IDENTIQUE pour un nouveau contact et un doublon (aucun oracle)", async () => {
    const first = await POST(request(valid));
    captureLead.mockResolvedValue({ contactCreated: false, leadCreated: false, consentRecorded: false });
    const second = await POST(request(valid));
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
  });

  it("transmet l'EMPREINTE de la clé, l'origine, l'IP et le corps normalisé (jamais la clé en clair)", async () => {
    await POST(request(valid));
    const input = captureLead.mock.calls[0]?.[0] as { keyHash: string; origin: string; ip: string | null; payload: { email_normalized: string } };
    expect(input.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(input.keyHash).not.toContain(KEY);
    expect(input.origin).toBe(ORIGIN);
    expect(input.ip).toBe("203.0.113.7");
    expect(input.payload.email_normalized).toBe("nadia@exemple.ma");
    expect(JSON.stringify(captureLead.mock.calls[0])).not.toContain(KEY);
  });

  it("champ piège rempli : même réponse, RIEN n'est écrit", async () => {
    const response = await POST(request({ ...valid, website: "http://spam.example" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "received" });
    expect(captureLead).not.toHaveBeenCalled();
  });
});

describe("POST /api/leads : refus", () => {
  const code = async (response: Response) => ((await response.json()) as { code: string }).code;

  it("origine absente : 403 forbidden, sans CORS, sans lecture de la base ni limitation consommée", async () => {
    const missing = await POST(request(valid, { origin: "" }));
    expect(missing.status).toBe(403);
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
    expect(isFormKeyOriginOk).not.toHaveBeenCalled();
    expect(takePublicToken).not.toHaveBeenCalled();
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("clé inexistante ou origine d'une AUTRE clé : 403 sans CORS, et AUCUN seau de débit par clé n'est ouvert", async () => {
    isFormKeyOriginOk.mockResolvedValue(false);
    const denied = await POST(request(valid));
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe("forbidden");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(captureLead).not.toHaveBeenCalled();
    expect(takePublicToken.mock.calls.map((call) => (call[0] as { scope: string }).scope)).toEqual(["capture_ip"]);
    expect(isFormKeyOriginOk).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), ORIGIN);
  });

  it("l'adresse du visiteur est lue à droite de x-forwarded-for (un proxy de confiance) : la valeur forgée à gauche n'est pas crue", async () => {
    await POST(request(valid, { "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    const input = captureLead.mock.calls[0]?.[0] as { ip: string | null };
    expect(input.ip).toBe("203.0.113.7");
  });

  it("clé absente ou mal formée : 403 forbidden (même refus), aucune écriture", async () => {
    for (const key of ["", "flk_abc", `FLK_${"a1".repeat(32)}`]) {
      const response = await POST(request(valid, { "x-form-key": key }));
      expect(response.status, key).toBe(403);
      expect(await code(response)).toBe("forbidden");
    }
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("clé / origine / projet refusés par la base : le même 403, avec CORS pour que le site lise l'erreur", async () => {
    captureLead.mockRejectedValue(new ServiceError("forbidden"));
    const response = await POST(request(valid));
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("forbidden");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("limitation de débit par IP ou par clé : 429 rate_limited + Retry-After, aucune écriture", async () => {
    takePublicToken.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const byIp = await POST(request(valid));
    expect(byIp.status).toBe(429);
    expect(await code(byIp)).toBe("rate_limited");
    expect(byIp.headers.get("retry-after")).toBe("7");
    takePublicToken.mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 }).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3 });
    const byKey = await POST(request(valid));
    expect(byKey.status).toBe(429);
    expect(byKey.headers.get("retry-after")).toBe("3");
    expect(captureLead).not.toHaveBeenCalled();
    expect(takePublicToken.mock.calls[0]?.[0]).toMatchObject({ scope: "capture_ip" });
    expect(takePublicToken.mock.calls[2]?.[0]).toMatchObject({ scope: "capture_key" });
  });

  it("panne du limiteur : 503 service_unavailable (échec fermé), aucune écriture", async () => {
    takePublicToken.mockRejectedValue(new ServiceError("service_unavailable"));
    const response = await POST(request(valid));
    expect(response.status).toBe(503);
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("corps invalide : 400 validation_failed ; champ inconnu, entreprise ou projet nommés : 400", async () => {
    for (const body of [{}, { email: "pas-un-email" }, { ...valid, organization_id: "7a000000-0000-4000-8000-000000000001" }, { ...valid, project_id: "7a000000-0000-4000-8000-000000000002" }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await code(response)).toBe("validation_failed");
    }
    const notJson = await POST(request(undefined, {}, "pas du json"));
    expect(notJson.status).toBe(400);
    const wrongType = await POST(request(valid, { "content-type": "text/plain" }));
    expect(wrongType.status).toBe(400);
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("corps de plus de 16 Kio : 413 payload_too_large", async () => {
    const response = await POST(request({ ...valid, name: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
    expect(await code(response)).toBe("payload_too_large");
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("quota « contacts » ou abonnement : le même 429 rate_limited que la limitation de débit (S-10 : l'état du quota n'est pas révélé)", async () => {
    captureLead.mockRejectedValue(new ServiceError("quota_exceeded"));
    const response = await POST(request(valid));
    expect(response.status).toBe(429);
    expect(await code(response)).toBe("rate_limited");
    expect(response.headers.get("retry-after")).toBe("3600");
  });

  it("plafond journalier par clé atteint : 429 rate_limited avec Retry-After, rien n'est écrit (S-10)", async () => {
    takePublicToken.mockImplementation(async ({ scope }: { scope: string }) => (scope === "capture_key_day" ? { allowed: false, retryAfterSeconds: 77 } : { allowed: true, retryAfterSeconds: 0 }));
    const response = await POST(request(valid));
    expect(response.status).toBe(429);
    expect(await code(response)).toBe("rate_limited");
    expect(response.headers.get("retry-after")).toBe("77");
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("erreur inattendue : 500 internal_error normalisée, sans détail", async () => {
    captureLead.mockRejectedValue(new Error("boom avec nadia@exemple.ma"));
    const response = await POST(request(valid));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; message: string; request_id: string };
    expect(body.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("nadia");
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("POST /api/leads : journaux sans donnée personnelle", () => {
  it("ni e-mail, ni nom, ni texte de consentement, ni clé, ni IP dans les journaux", async () => {
    const capture = captureLogs();
    try {
      await POST(request(valid));
      captureLead.mockRejectedValue(new ServiceError("forbidden"));
      await POST(request(valid));
      await POST(request({ ...valid, website: "spam" }));
    } finally {
      capture.stop();
    }
    const text = capture.lines().join("\n");
    expect(text).toContain("capture.accepted");
    for (const secret of ["nadia", "Nadia", "exemple.ma", "J'accepte", KEY, "203.0.113.7", "a1a1a1a1"]) expect(text, secret).not.toContain(secret);
  });
});

describe("OPTIONS /api/leads : préflight CORS", () => {
  const preflight = (origin: string | null) =>
    OPTIONS(new Request("http://localhost/api/leads", { method: "OPTIONS", headers: origin === null ? {} : { origin } }));

  it("origine autorisée : 204 avec méthodes et en-têtes permis, sans identifiants", async () => {
    const response = await preflight(ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-form-key");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("origine inconnue ou absente : 403 sans en-tête CORS", async () => {
    isOriginAllowed.mockResolvedValue(false);
    const denied = await preflight("https://pirate.ma");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const none = await preflight(null);
    expect(none.status).toBe(403);
  });

  it("le préflight est limité par adresse AVANT toute lecture de la base : 429 + Retry-After, sans appel à la base", async () => {
    takePublicToken.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 4 });
    const limited = await preflight(ORIGIN);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("4");
    expect(isOriginAllowed).not.toHaveBeenCalled();
    expect(takePublicToken.mock.calls[0]?.[0]).toMatchObject({ scope: "capture_preflight" });
  });

  it("panne du limiteur : 503 sans CORS", async () => {
    takePublicToken.mockRejectedValueOnce(new ServiceError("service_unavailable"));
    const down = await preflight(ORIGIN);
    expect(down.status).toBe(503);
    expect(down.headers.get("access-control-allow-origin")).toBeNull();
    expect(isOriginAllowed).not.toHaveBeenCalled();
  });
});

describe("POST /api/leads : défi Turnstile (S-10, ADR 019)", () => {
  const code = async (response: Response) => ((await response.json()) as { code: string }).code;
  const enable = (enforce: boolean) => {
    serverEnv.TURNSTILE_SECRET_KEY = "secret-de-test-turnstile";
    serverEnv.TURNSTILE_ENFORCE = enforce;
  };

  it("sans clé secrète : aucune vérification, la soumission passe", async () => {
    const response = await POST(request({ ...valid, turnstile_token: "tok" }));
    expect(response.status).toBe(202);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("exigé et jeton valide : vérifié avec l'adresse et l'origine de la clé, soumission acceptée ; le jeton n'est jamais transmis à la base", async () => {
    enable(true);
    const response = await POST(request({ ...valid, turnstile_token: "tok-valide" }));
    expect(response.status).toBe(202);
    expect(verifyTurnstile).toHaveBeenCalledWith(expect.objectContaining({ secret: "secret-de-test-turnstile", token: "tok-valide", ip: "203.0.113.7", origin: ORIGIN }));
    expect(captureLead).toHaveBeenCalledTimes(1);
  });

  it("exigé et jeton absent : 403 forbidden, rien n'est écrit, Cloudflare n'est pas appelé", async () => {
    enable(true);
    const response = await POST(request(valid));
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("forbidden");
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("jeton refusé : 403 forbidden (exigé ou non), rien n'est écrit", async () => {
    verifyTurnstile.mockResolvedValue("failed");
    for (const enforce of [true, false]) {
      enable(enforce);
      const response = await POST(request({ ...valid, turnstile_token: "tok-faux" }));
      expect(response.status).toBe(403);
      expect(await code(response)).toBe("forbidden");
    }
    expect(captureLead).not.toHaveBeenCalled();
  });

  it("non exigé et jeton absent : la soumission passe (déploiement progressif)", async () => {
    enable(false);
    const response = await POST(request(valid));
    expect(response.status).toBe(202);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("Cloudflare injoignable : échec fermé (503) si exigé, soumission acceptée sinon", async () => {
    verifyTurnstile.mockResolvedValue("unavailable");
    enable(true);
    const closed = await POST(request({ ...valid, turnstile_token: "tok" }));
    expect(closed.status).toBe(503);
    expect(captureLead).not.toHaveBeenCalled();
    enable(false);
    const open = await POST(request({ ...valid, turnstile_token: "tok" }));
    expect(open.status).toBe(202);
  });

  it("champ piège rempli : même réponse, Cloudflare n'est pas appelé", async () => {
    enable(true);
    const response = await POST(request({ ...valid, website: "http://spam.example", turnstile_token: "tok" }));
    expect(response.status).toBe(202);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});
