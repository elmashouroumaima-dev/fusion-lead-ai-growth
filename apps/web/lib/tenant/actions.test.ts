import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";

const getClaims = vi.fn();
const rpc = vi.fn();
const cookieSet = vi.fn();
const membershipReads: unknown[][] = [];

vi.mock("../supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims },
    rpc,
    from: () => {
      let calls = 0;
      const q: { select: () => unknown; eq: () => unknown } = {
        select: () => q,
        eq: () => {
          calls += 1;
          return calls === 2 ? Promise.resolve({ data: membershipReads.shift() ?? [], error: null }) : q;
        },
      };
      return q;
    },
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet, get: vi.fn() }) }));
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

import { createOrganizationAction, switchOrganizationAction } from "./actions";
import type { TenantActionState } from "./types";

const IDLE: TenantActionState = { status: "idle" };
const row = (id: string, status = "active") => ({
  organization_id: id,
  role: "company_owner",
  organizations: { id, name: "Acme", slug: "acme-x1", locale: "ar", timezone: "UTC", status },
});
function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
async function outcome(p: Promise<TenantActionState>): Promise<TenantActionState | string> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipReads.length = 0;
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("createOrganizationAction", () => {
  const valid = { name: "Acme", timezone: "UTC", locale: "ar", creation_key: KEY, uiLocale: "en" };

  it("succès : pose le cookie puis redirige vers le tableau de bord de la locale de l'interface", async () => {
    membershipReads.push([], [row(ORG)]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    await expect(outcome(createOrganizationAction(IDLE, form(valid)))).resolves.toBe("/en/dashboard");
    expect(cookieSet).toHaveBeenCalledWith("fl_active_org", ORG, expect.objectContaining({ httpOnly: true }));
  });

  it("ignore tout organization_id du formulaire (le serveur crée, le client ne choisit pas)", async () => {
    membershipReads.push([], [row(ORG)]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    await outcome(createOrganizationAction(IDLE, form({ ...valid, organization_id: OTHER })));
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("organization_id");
    expect(cookieSet).toHaveBeenCalledWith("fl_active_org", ORG, expect.anything());
  });

  it.each([
    ["nom vide", { name: " " }, "name"],
    ["fuseau inconnu", { timezone: "Mars/Olympus" }, "timezone"],
    ["locale inconnue", { locale: "es" }, "locale"],
    ["locale en majuscules", { locale: "FR" }, "locale"],
    ["clé de création invalide", { creation_key: "x" }, "creation_key"],
  ])("invalid_input : %s (noms de champs seulement)", async (_l, patch, fieldName) => {
    const result = await outcome(createOrganizationAction(IDLE, form({ ...valid, ...patch })));
    expect(result).toMatchObject({ status: "error", code: "invalid_input" });
    expect((result as TenantActionState).fieldErrors).toHaveProperty(fieldName);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("non authentifié -> redirection vers la connexion", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(outcome(createOrganizationAction(IDLE, form(valid)))).resolves.toBe("/en/login");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("idempotency_conflict et erreur interne -> codes seulement, pas de cookie", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "idempotency_conflict" } });
    await expect(outcome(createOrganizationAction(IDLE, form(valid)))).resolves.toEqual({
      status: "error",
      code: "idempotency_conflict",
    });
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(outcome(createOrganizationAction(IDLE, form(valid)))).resolves.toEqual({
      status: "error",
      code: "generic",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe("switchOrganizationAction", () => {
  it("vérifie l'adhésion active AVANT de poser le cookie", async () => {
    membershipReads.push([row(ORG)]);
    await expect(
      outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG, uiLocale: "ar" }))),
    ).resolves.toBe("/ar/dashboard");
    expect(cookieSet).toHaveBeenCalledWith("fl_active_org", ORG, expect.objectContaining({ sameSite: "lax" }));
  });

  it("organisation sans adhésion active -> forbidden, aucun cookie", async () => {
    membershipReads.push([row(ORG)]);
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: OTHER })))).resolves.toEqual({
      status: "error",
      code: "forbidden",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("organisation suspendue -> forbidden", async () => {
    membershipReads.push([row(ORG, "suspended")]);
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })))).resolves.toMatchObject({
      code: "forbidden",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("identifiant malformé -> invalid_input ; non authentifié -> connexion", async () => {
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: "nope" })))).resolves.toMatchObject({
      code: "invalid_input",
    });
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })))).resolves.toBe("/fr/login");
  });
});
