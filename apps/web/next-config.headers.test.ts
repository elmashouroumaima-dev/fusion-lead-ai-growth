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
    for (const r of matching) {
      const ref = hdr(r, "Referrer-Policy");
      if (ref !== undefined) expect(ref).toBe("no-referrer");
      const cache = hdr(r, "Cache-Control");
      if (cache !== undefined) expect(cache).toBe("no-store");
    }
  });

  it("login et signup (le jeton peut voyager dans next=) envoient Referrer-Policy: no-referrer", async () => {
    const all = await rules();
    for (const page of ["login", "signup"]) {
      for (const locale of ["ar", "en"]) {
        const url = `/${locale}/${page}`;
        const matching = all.filter((r) => toRegExp(r.source).test(url));
        expect(matching.length, url).toBeGreaterThan(0);
        expect(matching.map((r) => hdr(r, "Referrer-Policy")), url).toContain("no-referrer");
      }
    }
    expect(all.some((r) => toRegExp(r.source).test("/en/members") && hdr(r, "Referrer-Policy") !== undefined)).toBe(false);
  });

  it("le package permissions est transpilé et l'en-tête X-Powered-By est coupé", async () => {
    const cfg = (await import("./next.config")).default as unknown as { transpilePackages: string[]; poweredByHeader: boolean };
    expect(cfg.transpilePackages).toContain("@fusion-leap/permissions");
    expect(cfg.poweredByHeader).toBe(false);
  });
});
