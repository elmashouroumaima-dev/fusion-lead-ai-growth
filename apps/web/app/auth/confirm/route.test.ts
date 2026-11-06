import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtp = vi.fn();
const getSession = vi.fn();
vi.mock("../../../lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp, getSession } }),
}));

let siteUrl = "http://127.0.0.1:3000";
vi.mock("../../../lib/auth/site-url", () => ({ getSiteUrl: () => siteUrl }));

import { GET } from "./route";

// Le protocole de la requête est volontairement sans effet : seul SITE_URL / NODE_ENV compte.
const call = (qs: string, requestHttps = false) =>
  GET(new NextRequest(`${requestHttps ? "https" : "http"}://127.0.0.1:3000/auth/confirm${qs}`));

beforeEach(() => {
  siteUrl = "http://127.0.0.1:3000";
  verifyOtp.mockReset();
  getSession.mockReset();
  verifyOtp.mockResolvedValue({ data: {}, error: null });
});

const FAIL = "/login?error=link_invalid";

describe("GET /auth/confirm : entrée invalide", () => {
  it.each([
    ["type inconnu", "?token_hash=abc&type=evil"],
    ["type invite (non accepté ici)", "?token_hash=abc&type=invite"],
    ["type magiclink (non accepté ici)", "?token_hash=abc&type=magiclink"],
    ["type email_change (non accepté ici)", "?token_hash=abc&type=email_change"],
    ["type vide", "?token_hash=abc&type="],
    ["type absent", "?token_hash=abc"],
    ["type en majuscules", "?token_hash=abc&type=SIGNUP"],
    ["token_hash absent", "?type=signup"],
    ["token_hash vide", "?token_hash=&type=signup"],
    ["token_hash trop long", `?token_hash=${"a".repeat(513)}&type=signup`],
    ["aucun paramètre", ""],
  ])("%s -> redirection d'erreur, verifyOtp jamais appelé", async (_l, qs) => {
    const res = await call(qs);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(FAIL);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("GET /auth/confirm : verifyOtp", () => {
  it("échec verifyOtp -> redirection d'erreur, sans cookie de récupération", async () => {
    verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: "otp_expired", status: 403, message: "expired" } });
    const res = await call("?token_hash=abc&type=recovery");
    expect(res.headers.get("location")).toBe(FAIL);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("la redirection d'erreur ne reflète ni le jeton ni le message d'erreur", async () => {
    verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: "otp_expired", message: "secret-detail" } });
    const res = await call("?token_hash=TOKEN123&type=signup&next=/en/x");
    const loc = res.headers.get("location")!;
    expect(loc).not.toContain("TOKEN123");
    expect(loc).not.toContain("secret-detail");
  });

  it("appelle verifyOtp avec exactement { type, token_hash }", async () => {
    await call("?token_hash=abc123&type=signup&next=/en/x");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "abc123" });
  });

  it("n'utilise jamais getSession", async () => {
    await call("?token_hash=abc&type=signup");
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("GET /auth/confirm : destination", () => {
  it("next interne valide respecté", async () => {
    const res = await call("?token_hash=abc&type=signup&next=/en/leads%3Ftab%3D1");
    expect(res.headers.get("location")).toBe("/en/leads?tab=1");
  });

  it("sans next -> /dashboard", async () => {
    const res = await call("?token_hash=abc&type=signup");
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it.each([
    ["double slash", "//evil.com"],
    ["schéma https", "https://evil.com"],
    ["backslash", "/\\evil.com"],
    ["encodé %2F%2F", "/%2F%2Fevil.com"],
    ["javascript:", "javascript:alert(1)"],
    ["CRLF encodé", "/ok%0d%0aSet-Cookie:x=1"],
  ])("next hostile (%s) -> repli /dashboard", async (_l, next) => {
    const res = await call(`?token_hash=abc&type=signup&next=${encodeURIComponent(next)}`);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("la Location est toujours RELATIVE (pas d'origine dérivable de l'appelant)", async () => {
    const res = await call(`?token_hash=abc&type=signup&next=${encodeURIComponent("//evil.com")}`);
    expect(res.headers.get("location")!.startsWith("/")).toBe(true);
    expect(res.headers.get("location")!.startsWith("//")).toBe(false);
  });

  it("n'est pas cachable", async () => {
    const res = await call("?token_hash=abc&type=signup");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /auth/confirm : recovery", () => {
  it("ignore next (même hostile) -> /reset-password + cookie httpOnly fl_recovery", async () => {
    const res = await call(`?token_hash=abc&type=recovery&next=${encodeURIComponent("https://evil.com")}`);
    expect(res.headers.get("location")).toBe("/reset-password");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("fl_recovery=1");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toMatch(/Max-Age=900/i);
    expect(cookie.toLowerCase()).not.toContain("secure");
  });

  it("recovery next=/en/dashboard -> toujours /reset-password", async () => {
    const res = await call("?token_hash=abc&type=recovery&next=/en/dashboard");
    expect(res.headers.get("location")).toBe("/reset-password");
  });

  it("cookie Secure si SITE_URL est en https, même si la requête arrive en http", async () => {
    siteUrl = "https://app.example.test";
    const res = await call("?token_hash=abc&type=recovery", false);
    expect(res.headers.get("set-cookie")!.toLowerCase()).toContain("secure");
  });

  it("cookie NON Secure si SITE_URL est en http, même si la requête arrive en https", async () => {
    const res = await call("?token_hash=abc&type=recovery", true);
    expect(res.headers.get("set-cookie")!.toLowerCase()).not.toContain("secure");
  });

  it("cookie Secure en NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await call("?token_hash=abc&type=recovery");
      expect(res.headers.get("set-cookie")!.toLowerCase()).toContain("secure");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["signup", "email"])("type %s accepté", async (type) => {
    const res = await call(`?token_hash=abc&type=${type}`);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(verifyOtp).toHaveBeenCalledWith({ type, token_hash: "abc" });
  });

  it("le cookie de récupération n'est posé QUE pour le type recovery", async () => {
    const res = await call("?token_hash=abc&type=signup");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
