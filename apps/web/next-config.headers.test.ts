import { describe, expect, it, vi } from "vitest";

/**
 * En-têtes du lien d'invitation (le jeton est dans l'URL) : testés sur la configuration réelle,
 * avec la même logique de correspondance de chemin que Next (path-to-regexp via `next/dist`).
 */
vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));
vi.mock("@next/env", () => ({ loadEnvConfig: () => undefined }));

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<HeaderRule[]> {
  const mod = (await import("./next.config")).default as unknown as { headers: () => Promise<HeaderRule[]> };
  return mod.headers();
}

/** Traduction minimale des motifs Next (`:locale`, `:path*`) en expression régulière. */
function toRegExp(source: string): RegExp {
  const body = source
    .replace(/:path\*/g, "(?:.*)")
    .replace(/:[a-zA-Z]+/g, "[^/]+");
  return new RegExp(`^${body}$`);
}

const hdr = (rule: HeaderRule | undefined, key: string) => rule?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

/** Valeur effective d'un en-tête pour une URL : Next applique les règles dans l'ordre, la dernière qui correspond l'emporte. */
function effective(all: HeaderRule[], url: string, key: string): string | undefined {
  let value: string | undefined;
  for (const r of all) if (toRegExp(r.source).test(url)) value = hdr(r, key) ?? value;
  return value;
}

describe("next.config headers() : en-têtes de sécurité globaux", () => {
  const URLS = ["/", "/fr", "/fr/login", "/ar/dashboard", "/en/members", "/en/invite/" + "A".repeat(43), "/_next/static/chunks/a.js", "/api/health"];

  it("une règle globale est déclarée en premier, avant les règles spécifiques", async () => {
    const all = await rules();
    expect(all[0]?.source).toBe("/:path*");
    expect(all.filter((r) => r.source === "/:path*")).toHaveLength(1);
  });

  it.each(URLS)("%s : X-Frame-Options DENY, frame-ancestors 'none', nosniff", async (url) => {
    const all = await rules();
    expect(effective(all, url, "X-Frame-Options")).toBe("DENY");
    expect(effective(all, url, "Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(effective(all, url, "X-Content-Type-Options")).toBe("nosniff");
    expect(effective(all, url, "Referrer-Policy"), url).toBeDefined();
  });

  it("la CSP est limitée à frame-ancestors (une CSP complète casserait le script inline de next-themes)", async () => {
    const global = (await rules())[0];
    expect(hdr(global, "Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(hdr(global, "Content-Security-Policy")).not.toMatch(/script-src|default-src/);
  });

  it("Referrer-Policy : strict-origin-when-cross-origin par défaut ; no-referrer pour invite / login / signup", async () => {
    const all = await rules();
    for (const url of ["/fr/members", "/ar/dashboard", "/en", "/"]) {
      expect(effective(all, url, "Referrer-Policy"), url).toBe("strict-origin-when-cross-origin");
    }
    for (const url of ["/fr/login", "/ar/signup", "/en/invite/" + "A".repeat(43)]) {
      expect(effective(all, url, "Referrer-Policy"), url).toBe("no-referrer");
    }
    expect(effective(all, "/en/invite/" + "A".repeat(43), "Cache-Control")).toBe("no-store");
  });

  it("aucune clé n'est dupliquée dans une même règle", async () => {
    for (const r of await rules()) {
      const keys = r.headers.map((h) => h.key.toLowerCase());
      expect(new Set(keys).size, r.source).toBe(keys.length);
    }
  });
});

describe("next.config headers() : /:locale/invite/:path*", () => {
  it("une règle cible les pages d'invitation avec Referrer-Policy: no-referrer et Cache-Control: no-store", async () => {
    const rule = (await rules()).find((r) => r.source === "/:locale/invite/:path*");
    expect(rule).toBeDefined();
    expect(hdr(rule, "Referrer-Policy")).toBe("no-referrer");
    expect(hdr(rule, "Cache-Control")).toBe("no-store");
  });

  it("la source correspond aux URL d'invitation ar / en (avec jeton) et à aucune autre page", async () => {
    const rule = (await rules()).find((r) => r.source.includes("invite"));
    const re = toRegExp(rule?.source ?? "");
    const token = "A".repeat(43);
    expect(re.test(`/ar/invite/${token}`)).toBe(true);
    expect(re.test(`/en/invite/${token}`)).toBe(true);
    expect(re.test("/en/members")).toBe(false);
    expect(re.test("/en/dashboard")).toBe(false);
    expect(re.test("/en/login")).toBe(false);
  });

  it("aucune règle d'en-tête n'assouplit no-referrer / no-store pour les URL d'invitation", async () => {
    const url = `/en/invite/${"A".repeat(43)}`;
    const matching = (await rules()).filter((r) => toRegExp(r.source).test(url));
    expect(matching.length).toBeGreaterThan(0);
    // la règle globale (strict-origin-when-cross-origin) est écrasée par la règle invite, qui vient après
    expect(effective(await rules(), url, "Referrer-Policy")).toBe("no-referrer");
    for (const r of matching.filter((x) => x.source !== "/:path*")) {
      const ref = hdr(r, "Referrer-Policy");
      if (ref !== undefined) expect(ref).toBe("no-referrer");
      const cache = hdr(r, "Cache-Control");
      if (cache !== undefined) expect(cache).toBe("no-store");
    }
  });

  it("login et signup (le jeton peut voyager dans next=) envoient Referrer-Policy: no-referrer", async () => {
    const all = await rules();
    for (const page of ["login", "signup"]) {
      for (const locale of ["fr", "ar", "en"]) {
        const url = `/${locale}/${page}`;
        const matching = all.filter((r) => toRegExp(r.source).test(url));
        expect(matching.length, url).toBeGreaterThan(0);
        expect(matching.map((r) => hdr(r, "Referrer-Policy")), url).toContain("no-referrer");
      }
    }
    // une page ordinaire n'est pas durcie : elle garde la valeur par défaut
    expect(effective(all, "/en/members", "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("le package permissions est transpilé et l'en-tête X-Powered-By est coupé", async () => {
    const cfg = (await import("./next.config")).default as unknown as { transpilePackages: string[]; poweredByHeader: boolean };
    expect(cfg.transpilePackages).toContain("@fusion-leap/permissions");
    expect(cfg.poweredByHeader).toBe(false);
  });
});
