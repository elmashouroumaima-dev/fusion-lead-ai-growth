import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Paramétrage global (ADR 016) : la décision d'autorisation est celle de la base (administrateur de la plateforme
 * seulement). Ici : un refus 42501 de la base (owner / admin d'organisation) devient le code « forbidden », sans
 * jamais être présenté comme un succès ; un succès revalide la mise en page ; aucune clé tenant n'est acceptée.
 */
vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  captured: [] as Record<string, unknown>[],
  rpc: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("../service/with-service", () => ({
  withAction: (options: Record<string, unknown>, handler: (ctx: unknown, input: unknown) => Promise<unknown>) => {
    h.captured.push(options);
    return (_prev: unknown, formData: FormData) => handler({ supabase: { rpc: h.rpc }, formData }, { palette: { light: {} }, logo: { mime: "image/png", data: "AAAA" } });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => h.revalidate(...a) }));

import { resetLogoAction, resetPaletteAction, saveLogoAction, savePaletteAction } from "./actions";

const form = { get: (k: string) => (k === "uiLocale" ? "fr" : null), entries: () => [][Symbol.iterator]() } as unknown as FormData;
const idle = { status: "idle" } as const;

beforeEach(() => {
  h.rpc.mockReset();
  h.revalidate.mockReset();
});

describe.each([
  ["savePaletteAction", savePaletteAction, "set_platform_config"],
  ["resetPaletteAction", resetPaletteAction, "reset_platform_config"],
  ["saveLogoAction", saveLogoAction, "set_platform_config"],
  ["resetLogoAction", resetLogoAction, "reset_platform_config"],
] as const)("%s", (_name, action, fn) => {
  it("refus de la base (42501, non administrateur de la plateforme) : forbidden, rien n'est revalidé", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    await expect(action(idle, form)).resolves.toEqual({ status: "error", code: "forbidden" });
    expect(h.rpc).toHaveBeenCalledWith(fn, expect.any(Object));
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it("autre erreur de la base : generic ; succès : success et mise en page revalidée", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "validation_failed" } });
    await expect(action(idle, form)).resolves.toEqual({ status: "error", code: "generic" });
    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(action(idle, form)).resolves.toEqual({ status: "success" });
    expect(h.revalidate).toHaveBeenCalledWith("/fr", "layout");
  });
});

it("aucune action n'accepte un organization_id (donnée globale, non tenant)", () => {
  expect(h.captured).toHaveLength(4);
  for (const o of h.captured) expect(o.forbidOrganizationId).toBe(true);
});
