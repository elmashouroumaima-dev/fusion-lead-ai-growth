import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireClaims = vi.fn();
const requireTenantContext = vi.fn();
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => `T:${key}`,
  setRequestLocale: () => undefined,
}));
vi.mock("../../../../i18n/require-locale", () => ({ requireLocale: async (p: Promise<{ locale: string }>) => (await p).locale }));
vi.mock("../../../../lib/auth/require-claims", () => ({ requireClaims: (...a: unknown[]) => requireClaims(...a) }));
vi.mock("../../../../lib/tenant/context", () => ({ requireTenantContext: (...a: unknown[]) => requireTenantContext(...a) }));
vi.mock("../../../../components/members/accept-invitation-form", () => ({ AcceptInvitationForm: () => null }));

import { AcceptInvitationForm } from "../../../../components/members/accept-invitation-form";
import InvitePage, { dynamic, metadata } from "./page";

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props?.children, out);
  }
  return out;
}
const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string"
      ? node
      : node && typeof node === "object" && "props" in node
        ? text((node as El).props?.children)
        : "";

const render = async (locale: string, token: string) => InvitePage({ params: Promise.resolve({ locale, token }) });
const GOOD = "Ab1_-".repeat(8) + "xyz";

beforeEach(() => vi.clearAllMocks());

describe("page /[locale]/invite/[token]", () => {
  it("jeton valide : carte neutre + formulaire d'acceptation recevant le jeton, sans lecture d'organisation", async () => {
    const tree = await render("en", GOOD);
    const form = walk(tree).find((e) => e.type === AcceptInvitationForm);
    expect(form?.props?.token).toBe(GOOD);
    const all = text(tree);
    expect(all).toContain("T:title");
    expect(all).toContain("T:description");
    expect(requireTenantContext).not.toHaveBeenCalled();
    expect(requireClaims).toHaveBeenCalledWith("en");
  });

  it("n'écrit jamais le jeton dans le texte affiché", async () => {
    expect(text(await render("ar", GOOD))).not.toContain(GOOD);
  });

  it.each(["short", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "+", "<img src=x>".padEnd(43, "A")])(
    "jeton mal formé %j : erreur générique en role=alert, pas de formulaire",
    async (token) => {
      const els = walk(await render("en", token));
      expect(els.some((e) => e.type === AcceptInvitationForm)).toBe(false);
      const alert = els.find((e) => e.props?.role === "alert");
      expect(text(alert)).toBe("T:errors.invitation_invalid");
    },
  );

  it("le message d'erreur est identique pour tous les jetons invalides (aucune cause distincte)", async () => {
    const texts = await Promise.all(["x", "A".repeat(50), "é".repeat(43)].map(async (t) => text(await render("en", t))));
    expect(new Set(texts).size).toBe(1);
  });

  it("session requise : la redirection de requireClaims se propage", async () => {
    requireClaims.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(render("en", GOOD)).rejects.toThrow("NEXT_REDIRECT");
  });

  it("la page est dynamique, non indexable et sans Referer", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("la page est HORS du groupe (app) et n'utilise aucun contexte tenant (pas de poussée vers l'onboarding)", () => {
    const file = fileURLToPath(new URL("./page.tsx", import.meta.url));
    expect(file.replace(/\\/g, "/")).not.toContain("/(app)/");
    expect(readFileSync(file, "utf8")).not.toMatch(/requireTenantContext|getTenantContext/);
  });
});
