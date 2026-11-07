import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const getClaims = vi.fn();
const createServerClient = vi.fn();

vi.mock("@supabase/ssr", () => ({ createServerClient: (...a: unknown[]) => createServerClient(...a) }));

const CACHE = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
};
const COOKIE = "sb-127-auth-token";

type CookieOpts = {
  cookies: {
    getAll: () => Array<{ name: string }>;
    setAll: (c: Array<{ name: string; value: string; options: object }>, h: Record<string, string>) => void;
  };
};

type Setup = { claims: unknown | null; refresh?: boolean; error?: boolean };

/** Simule Supabase : getClaims() déclenche setAll (jeton rafraîchi) comme le ferait @supabase/ssr. */
function mockSupabase({ claims, refresh = true, error = false }: Setup): void {
  createServerClient.mockImplementation((_url: string, _key: string, opts: CookieOpts) => ({
    auth: {
      getSession,
      getClaims: async () => {
        getClaims();
        if (refresh) opts.cookies.setAll([{ name: COOKIE, value: "refreshed", options: { path: "/" } }], CACHE);
        return error ? { data: null, error: new Error("boom") } : { data: { claims }, error: null };
      },
    },
  }));
}

async function run(path: string, init: { cookie?: string } = {}) {
  const { default: proxy } = await import("./proxy");
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  const request = new NextRequest(`http://127.0.0.1:3000${path}`, { headers });
  const response = await proxy(request);
  return { request, response };
}

const locationOf = (r: Response) => {
  const l = r.headers.get("location");
  return l ? new URL(l, "http://127.0.0.1:3000") : null;
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_0123456789abcdef");
  getSession.mockReset();
  getClaims.mockReset();
  createServerClient.mockReset();
});
afterEach(() => {
  // Garde transversale : le proxy ne doit JAMAIS s'appuyer sur getSession() côté serveur.
  expect(getSession).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

function expectSessionState(res: Response) {
  expect(res.headers.get("set-cookie") ?? "").toContain(`${COOKIE}=refreshed`);
  expect(res.headers.get("cache-control")).toBe(CACHE["Cache-Control"]);
  expect(res.headers.get("expires")).toBe("0");
  expect(res.headers.get("pragma")).toBe("no-cache");
}

describe("proxy : routes protégées", () => {
  it("anonyme sur /ar/dashboard -> redirection /ar/login?next=/ar/dashboard", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/ar/dashboard");
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const loc = locationOf(response)!;
    expect(loc.pathname).toBe("/ar/login");
    expect(loc.searchParams.get("next")).toBe("/ar/dashboard");
    expect(getClaims).toHaveBeenCalledTimes(1);
  });

  it("conserve la query dans next (encodée) et la locale en", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/en/leads?tab=2&q=a%26b");
    const loc = locationOf(response)!;
    expect(loc.pathname).toBe("/en/login");
    expect(loc.searchParams.get("next")).toBe("/en/leads?tab=2&q=a%26b");
  });

  it("une erreur de getClaims équivaut à anonyme", async () => {
    mockSupabase({ claims: { sub: "u1" }, error: true });
    const { response } = await run("/ar/dashboard");
    expect(locationOf(response)!.pathname).toBe("/ar/login");
  });

  it("claims vides/absents (null) -> anonyme", async () => {
    mockSupabase({ claims: null, refresh: false });
    const { response } = await run("/ar/settings");
    expect(locationOf(response)!.pathname).toBe("/ar/login");
  });

  it("session valide sur /ar/dashboard : pas de redirection", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/ar/dashboard");
    expect(response.status).toBe(200);
    expect(locationOf(response)).toBeNull();
  });

  it.each(["/fr", "/ar", "/en", "/fr/login", "/ar/login", "/en/signup", "/fr/signup", "/fr/forgot-password", "/ar/forgot-password", "/en/login/", "/fr/login/"])(
    "chemin public %s accessible sans session",
    async (path) => {
      mockSupabase({ claims: null });
      const { response } = await run(path);
      const loc = locationOf(response);
      // jamais de redirection de protection (?next=) pour une page publique
      expect(loc?.searchParams.has("next") ?? false).toBe(false);
      expect(response.status).toBeLessThan(400);
    },
  );

  it("utilisateur connecté sur /ar/login -> /ar/dashboard", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/ar/login");
    expect(locationOf(response)!.pathname).toBe("/ar/dashboard");
  });

  it("anonyme sur /fr/dashboard -> /fr/login?next=/fr/dashboard (locale par défaut)", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/fr/dashboard");
    const loc = locationOf(response)!;
    expect(loc.pathname).toBe("/fr/login");
    expect(loc.searchParams.get("next")).toBe("/fr/dashboard");
  });

  it("utilisateur connecté sur /fr/login -> /fr/dashboard", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/fr/login");
    expect(locationOf(response)!.pathname).toBe("/fr/dashboard");
  });

  it("utilisateur connecté sur /en/signup -> /en/dashboard", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/en/signup");
    expect(locationOf(response)!.pathname).toBe("/en/dashboard");
  });

  it("chemin sans locale : next-intl préfixe, aucune décision d'accès prise sur le chemin brut", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/dashboard");
    const loc = locationOf(response)!;
    expect(loc.pathname).toBe("/fr/dashboard"); // fr est la locale par défaut
    expect(loc.searchParams.has("next")).toBe(false);
  });
});

describe("proxy : fail closed (contournements de chemin)", () => {
  // Chaque chemin vise la page privée /ar/dashboard : sans session, JAMAIS de 200 servi.
  const noBypass = async (path: string) => {
    mockSupabase({ claims: null });
    const { response } = await run(path);
    const loc = locationOf(response);
    const protectedRedirect = ["/fr/login", "/ar/login", "/en/login"].includes(loc?.pathname ?? "");
    const intlRedirect = loc !== null && response.status >= 300 && response.status < 400;
    const refused = response.status === 404;
    expect(protectedRedirect || intlRedirect || refused).toBe(true);
    // jamais de contenu servi (200) sans session
    expect(response.status).not.toBe(200);
    return { response, loc };
  };

  it.each([
    "/%61r/dashboard",
    "/%41r/dashboard",
    "/%41R/dashboard",
    "/AR/dashboard",
    "/ar/dashboard/",
    "/ar/dashboard//",
    "/ar./dashboard",
    "/ar/dashboard.",
    // le parseur d'URL normalise déjà les segments point encodés : le proxy voit /dashboard
    "/ar/%2e%2e/dashboard",
    "/ar/%2E/dashboard",
  ])("%s ne passe pas sans session", async (path) => {
    await noBypass(path);
  });

  it.each([
    "/ar%2Fdashboard",
    "/ar%2fdashboard",
    "/ar%5Cdashboard",
    "//ar/dashboard",
    "/ar//dashboard",
    "/%2561r/dashboard",
    "/%252561r/dashboard",
    "/ar%00/dashboard",
    "/%ZZar/dashboard",
    "/%c0%af",
  ])("%s est refusé (404) avant toute logique", async (path) => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run(path);
    expect(response.status).toBe(404);
    expect(locationOf(response)).toBeNull();
  });

  // Même grille d'attaques sur la nouvelle locale fr (et sur la casse / les préfixes proches).
  it.each([
    "/%66r/dashboard",
    "/%46r/dashboard",
    "/%46R/dashboard",
    "/FR/dashboard",
    "/Fr/dashboard",
    "/fr./dashboard",
    "/fr/dashboard.",
    "/fr/dashboard/",
    "/fr/dashboard//",
    "/fr/%2e%2e/dashboard",
    "/fra/dashboard",
    "/frx/dashboard",
    "/f/dashboard",
  ])("%s ne passe pas sans session", async (path) => {
    await noBypass(path);
  });

  it.each([
    "/fr//dashboard",
    "//fr/dashboard",
    "/fr%2Fdashboard",
    "/fr%2fdashboard",
    "/fr%5Cdashboard",
    "/%2566r/dashboard",
    "/fr%00/dashboard",
  ])("%s est refusé (404) avant toute logique (fr)", async (path) => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run(path);
    expect(response.status).toBe(404);
    expect(locationOf(response)).toBeNull();
  });

  it("/%66r/dashboard anonyme -> /fr/login?next=/fr/dashboard ; avec session -> passe", async () => {
    const { loc } = await noBypass("/%66r/dashboard");
    expect(loc?.pathname).toBe("/fr/login");
    expect(loc?.searchParams.get("next")).toBe("/fr/dashboard");
    mockSupabase({ claims: { sub: "u1" } });
    expect((await run("/%66r/dashboard")).response.status).toBe(200);
  });

  it("/FR/dashboard n'est jamais servi tel quel : redirigé vers une locale canonique ou 404", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/FR/dashboard");
    expect(response.status).not.toBe(200);
    const loc = locationOf(response);
    if (loc) expect(["/fr/dashboard", "/fr/FR/dashboard"].some((p) => loc.pathname === p) || /^\/(fr|ar|en)\//.test(loc.pathname)).toBe(true);
  });

  it("locale encodée %61r + anonyme -> login protégé (pas de 200)", async () => {
    const { loc } = await noBypass("/%61r/dashboard");
    expect(loc?.pathname).toBe("/ar/login");
    expect(loc?.searchParams.get("next")).toBe("/ar/dashboard");
  });

  it("locale encodée + session valide -> passe (la décision est prise sur le chemin décodé)", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/%61r/dashboard");
    expect(response.status).toBe(200);
  });

  it("locale encodée sur une page invité : un connecté est redirigé comme avec /ar/login", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/%65n/login");
    expect(locationOf(response)!.pathname).toBe("/en/dashboard");
  });

  it("/arx/dashboard (préfixe de locale inexistant) n'est jamais servi tel quel", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/arx/dashboard");
    expect(locationOf(response)?.pathname).not.toBe("/arx/dashboard");
    expect(response.status === 404 || locationOf(response) !== null).toBe(true);
  });

  it("chemin sans locale, réponse non redirigée par next-intl -> 404 (jamais servi sans contrôle)", async () => {
    // Garde du comportement fail closed lui-même : un chemin non analysable ne renvoie pas 200.
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/AR/dashboard");
    expect(response.status).not.toBe(200);
  });
});

describe("proxy : cookies de session et en-têtes anti-cache", () => {
  it("présents sur la réponse qui laisse passer", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/ar/dashboard");
    expectSessionState(response);
  });

  it("présents sur la redirection vers /login", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/ar/dashboard");
    expect(locationOf(response)!.pathname).toBe("/ar/login");
    expectSessionState(response);
  });

  it("présents sur la redirection login -> dashboard", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/en/login");
    expect(locationOf(response)!.pathname).toBe("/en/dashboard");
    expectSessionState(response);
  });

  it("présents sur la redirection reset-password -> forgot-password", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/en/reset-password");
    expect(locationOf(response)!.pathname).toBe("/en/forgot-password");
    expectSessionState(response);
  });

  it("le jeton rafraîchi est aussi écrit sur la requête (Server Components du même rendu)", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { request } = await run("/ar/dashboard");
    expect(request.cookies.get(COOKIE)?.value).toBe("refreshed");
  });

  it("sans rafraîchissement : pas de Set-Cookie de session inventé", async () => {
    mockSupabase({ claims: { sub: "u1" }, refresh: false });
    const { response } = await run("/ar/dashboard");
    expect(response.headers.get("set-cookie") ?? "").not.toContain(COOKIE);
  });

  it("le client Supabase est créé avec la clé publishable et lit les cookies de la requête", async () => {
    mockSupabase({ claims: null, refresh: false });
    await run("/ar/dashboard", { cookie: `${COOKIE}=abc` });
    const [url, key, opts] = createServerClient.mock.calls[0] as [string, string, CookieOpts];
    expect(url).toBe("http://127.0.0.1:54321");
    expect(key).toMatch(/^sb_publishable_/);
    expect(opts.cookies.getAll().map((c) => c.name)).toContain(COOKIE);
  });
});

describe("proxy : reset-password exige la session de récupération", () => {
  it("anonyme -> forgot-password", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/ar/reset-password");
    expect(locationOf(response)!.pathname).toBe("/ar/forgot-password");
  });

  it("cookie de récupération SANS session valide -> forgot-password", async () => {
    mockSupabase({ claims: null });
    const { response } = await run("/ar/reset-password", { cookie: "fl_recovery=1" });
    expect(locationOf(response)!.pathname).toBe("/ar/forgot-password");
  });

  it("session valide SANS cookie de récupération -> forgot-password", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/ar/reset-password");
    expect(locationOf(response)!.pathname).toBe("/ar/forgot-password");
  });

  it("session + cookie de récupération -> accès autorisé", async () => {
    mockSupabase({ claims: { sub: "u1" } });
    const { response } = await run("/ar/reset-password", { cookie: "fl_recovery=1" });
    expect(response.status).toBe(200);
    expect(locationOf(response)).toBeNull();
  });
});

describe("proxy : matcher", () => {
  async function matcherRegexes(): Promise<RegExp[]> {
    const { config } = await import("./proxy");
    return config.matcher.map((m: string) => new RegExp(`^${m}$`));
  }
  const matches = (res: RegExp[], p: string) => res.some((r) => r.test(p));

  it.each(["/auth/confirm", "/auth/confirm?x=1", "/api/health", "/api/webhooks/x", "/_next/static/a.js", "/_vercel/insights/x", "/favicon.ico", "/robots.txt"])(
    "%s n'est pas traité par le proxy (ni préfixé par locale)",
    async (p) => {
      expect(matches(await matcherRegexes(), p.split("?")[0]!)).toBe(false);
    },
  );

  it.each(["/", "/ar", "/en/login", "/ar/dashboard", "/ar/auth/x", "/authx", "/authentic/x", "/apidocs", "/api2/x", "/_nextish"])(
    "%s est traité par le proxy (frontières exactes)",
    async (p) => {
      expect(matches(await matcherRegexes(), p)).toBe(true);
    },
  );

  it.each(["/api", "/auth", "/_next", "/_vercel"])("%s (sans slash final) n'est pas traité", async (p) => {
    expect(matches(await matcherRegexes(), p)).toBe(false);
  });
});

describe("garde statique : jamais getSession côté serveur", () => {
  const root = __dirname;
  const files = [
    "proxy.ts",
    "lib/supabase/session.ts",
    "lib/supabase/server.ts",
    "lib/auth/actions.ts",
    "app/auth/confirm/route.ts",
    "app/[locale]/(app)/dashboard/page.tsx",
  ];
  it.each(files)("%s ne référence pas getSession(", (f) => {
    const src = readFileSync(join(root, f), "utf8");
    // ignore les commentaires de ligne et de bloc
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/getSession\s*\(/);
  });
});
