import { beforeEach, describe, expect, it, vi } from "vitest";

const getClaims = vi.fn();
const getSession = vi.fn();
vi.mock("../supabase/server", () => ({
  createClient: async () => ({ auth: { getClaims, getSession } }),
}));
class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

import { requireClaims } from "./require-claims";

beforeEach(() => {
  getClaims.mockReset();
  getSession.mockReset();
});

describe("requireClaims", () => {
  it("retourne les claims vérifiés", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "u1" } }, error: null });
    await expect(requireClaims("en")).resolves.toEqual({ sub: "u1" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    ["erreur", { data: null, error: new Error("x") }],
    ["claims absents", { data: { claims: null }, error: null }],
    ["data null", { data: null, error: null }],
  ])("%s -> redirection vers /en/login", async (_l, result) => {
    getClaims.mockResolvedValue(result);
    await expect(requireClaims("en")).rejects.toMatchObject({ url: "/en/login" });
  });

  it("locale inconnue/hostile -> repli sur la locale par défaut, jamais reflétée", async () => {
    getClaims.mockResolvedValue({ data: null, error: new Error("x") });
    await expect(requireClaims("//evil.com")).rejects.toMatchObject({ url: "/fr/login" });
    await expect(requireClaims("FR")).rejects.toMatchObject({ url: "/fr/login" });
  });
  it.each(["fr", "ar", "en"])("locale valide %s -> conservée dans la redirection", async (locale) => {
    getClaims.mockResolvedValue({ data: null, error: new Error("x") });
    await expect(requireClaims(locale)).rejects.toMatchObject({ url: `/${locale}/login` });
  });
});
