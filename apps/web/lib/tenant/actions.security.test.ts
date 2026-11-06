import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const getClaims = vi.fn();
const cookieSet = vi.fn();
const membershipQuery = vi.fn();
const eqCalls: Array<[string, unknown]> = [];
let membershipResult: { data: unknown; error: unknown } = { data: [], error: null };

vi.mock("../supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims },
    from: () => {
      membershipQuery();
      let calls = 0;
      const q: { select: () => unknown; eq: (c: string, v: unknown) => unknown } = {
        select: () => q,
        eq: (c, v) => {
          eqCalls.push([c, v]);
          calls += 1;
          return calls === 2 ? Promise.resolve(membershipResult) : q;
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

import { switchOrganizationAction } from "./actions";
import type { TenantActionState } from "./types";

const IDLE: TenantActionState = { status: "idle" };
const row = (id: string, status = "active", role = "analyst") => ({
  organization_id: id,
  role,
  organizations: { id, name: "Acme", slug: "acme", locale: "ar", timezone: "UTC", status },
});
const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
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
  eqCalls.length = 0;
  membershipResult = { data: [], error: null };
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
});

describe("switchOrganizationAction : vérification AVANT le cookie", () => {
  it("la lecture des adhésions précède l'écriture du cookie (ordre d'appel)", async () => {
    membershipResult = { data: [row(ORG)], error: null };
    await outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })));
    expect(membershipQuery).toHaveBeenCalledTimes(1);
    expect(cookieSet).toHaveBeenCalledTimes(1);
    expect(membershipQuery.mock.invocationCallOrder[0]).toBeLessThan(cookieSet.mock.invocationCallOrder[0] ?? 0);
  });

  it("la lecture est faite pour l'utilisateur des claims, sur les adhésions actives seulement", async () => {
    membershipResult = { data: [row(ORG)], error: null };
    await outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })));
    expect(eqCalls).toContainEqual(["user_id", USER]);
    expect(eqCalls).toContainEqual(["status", "active"]);
  });

  it.each([
    ["aucune adhésion active", []],
    ["adhésion à une autre organisation seulement", [row(OTHER)]],
    ["organisation suspendue", [row(ORG, "suspended")]],
    ["organisation fermée", [row(ORG, "closed")]],
    ["organisation masquée par la RLS", [{ organization_id: ORG, role: "analyst", organizations: null }]],
  ])("%s -> forbidden et AUCUN cookie", async (_l, rows) => {
    membershipResult = { data: rows, error: null };
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })))).resolves.toEqual({
      status: "error",
      code: "forbidden",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("erreur de lecture en base -> generic et AUCUN cookie (échec fermé)", async () => {
    membershipResult = { data: null, error: { message: "db down" } };
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })))).resolves.toEqual({
      status: "error",
      code: "generic",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("ligne illisible (rôle inconnu) -> generic et AUCUN cookie", async () => {
    membershipResult = { data: [{ organization_id: ORG, role: "root", organizations: null }], error: null };
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })))).resolves.toMatchObject({
      code: "generic",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", {}],
    ["vide", { organization_id: "" }],
    ["non uuid", { organization_id: "abc" }],
    ["injection", { organization_id: `${ORG}; Path=/` }],
  ])("organization_id %s -> invalid_input, sans lecture ni cookie", async (_l, values) => {
    await expect(outcome(switchOrganizationAction(IDLE, form(values)))).resolves.toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    expect(membershipQuery).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("non authentifié -> redirection login, sans lecture ni cookie", async () => {
    getClaims.mockResolvedValue({ data: null, error: new Error("expired") });
    await expect(outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG, uiLocale: "en" })))).resolves.toBe(
      "/en/login",
    );
    expect(membershipQuery).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("le cookie posé contient l'uuid DEMANDÉ validé, avec les attributs de sécurité", async () => {
    membershipResult = { data: [row(OTHER), row(ORG)], error: null };
    await outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })));
    expect(cookieSet).toHaveBeenCalledWith("fl_active_org", ORG, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  });

  it("une locale d'interface falsifiée ne permet pas de redirection ouverte", async () => {
    membershipResult = { data: [row(ORG)], error: null };
    const url = await outcome(
      switchOrganizationAction(IDLE, form({ organization_id: ORG, uiLocale: "//evil.example.com" })),
    );
    expect(url).toBe("/ar/dashboard");
  });

  it("les erreurs ne contiennent jamais de message lisible : code seulement", async () => {
    membershipResult = { data: [], error: null };
    const result = (await outcome(switchOrganizationAction(IDLE, form({ organization_id: ORG })))) as TenantActionState;
    expect(Object.keys(result).sort()).toEqual(["code", "status"]);
  });
});
