import { beforeEach, describe, expect, it, vi } from "vitest";

const ATTEMPT = "11111111-2222-4333-8444-555555555555";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const INVITATION = "55555555-5555-4555-8555-555555555555";

// --- Mocks -----------------------------------------------------------------
type Result = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };
const results = new Map<string, Result>();
const calls: { op: string; table?: string; args: unknown[] }[] = [];

/** Constructeur de requête chaînable : seul le résultat final (clé `table.op`) est configurable. */
function builder(table: string) {
  let op = "select";
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "order", "maybeSingle", "update"]) {
    q[m] = (...args: unknown[]) => {
      if (m === "update") op = "update";
      calls.push({ op: `${table}.${m}`, table, args });
      return q;
    };
  }
  q.then = (resolve: (value: Result) => unknown) =>
    resolve({ data: null, error: null, count: null, ...(results.get(`${table}.${op}`) ?? {}) });
  return q;
}

const rpc = vi.fn(async (name: string, args: unknown) => {
  calls.push({ op: `rpc.${name}`, args: [args] });
  return { data: null, error: null, ...(results.get(`rpc.${name}`) ?? {}) };
});
const getTenantContext = vi.fn();
const getClaims = vi.fn();
const setCookie = vi.fn();

vi.mock("../supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => builder(t), rpc, auth: { getClaims } }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn(), set: setCookie }) }));

// La limitation de débit passe par service_role (J11) : son backend est simulé, jamais appelé ici.
vi.mock("../service/rate-limit", () => ({
  LIMITS: {},
  takeToken: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("../service/idempotency", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  idempotencyBegin: async () => ({ state: "new", attemptId: ATTEMPT }),
  idempotencyComplete: async () => undefined,
  idempotencyAbandon: async () => undefined,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
vi.mock("../tenant/context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTenantContext: (...args: unknown[]) => getTenantContext(...args),
}));

import {
  acceptInvitationAction,
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  transferOwnershipAction,
} from "./actions";
import { hashInvitationToken } from "./token";

const idle = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  fd.set("idempotency_key", "idem-key-0123456789");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const asRole = (role: string) =>
  getTenantContext.mockResolvedValue({
    userId: ME,
    organizationId: ORG,
    role,
    organization: { id: ORG, name: "X", slug: "x", locale: "ar", timezone: "UTC" },
  });
const member = (over: Record<string, unknown> = {}) => ({
  id: MEMBER,
  user_id: OTHER,
  role: "sales_agent",
  status: "active",
  created_at: "2026-11-06T00:00:00Z",
  ...over,
});
const rpcCalls = () => calls.filter((c) => c.op.startsWith("rpc."));
const updates = () => calls.filter((c) => c.op.endsWith(".update"));

beforeEach(() => {
  results.clear();
  calls.length = 0;
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: ME } }, error: null });
});

describe("inviteMemberAction", () => {
  const base = { email: " New.User@Example.com ", role: "sales_agent", uiLocale: "en", organization_id: ORG };

  it("e-mail invalide -> invalid_input avec erreurs de champ, aucun appel base", async () => {
    asRole("company_owner");
    const state = await inviteMemberAction(idle, form({ ...base, email: "pas-un-email" }));
    expect(state).toMatchObject({ status: "error", code: "invalid_input" });
    expect(state.fieldErrors?.email?.length).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain("pas-un-email");
    expect(rpcCalls()).toEqual([]);
  });

  it.each(["marketing_manager", "sales_agent", "analyst"])("%s : refusé avant la base", async (role) => {
    asRole(role);
    expect(await inviteMemberAction(idle, form(base))).toEqual({ status: "error", code: "forbidden" });
    expect(rpcCalls()).toEqual([]);
  });

  it("company_admin ne peut pas inviter un company_owner (refusé avant la base)", async () => {
    asRole("company_admin");
    expect(await inviteMemberAction(idle, form({ ...base, role: "company_owner" }))).toEqual({ status: "error", code: "forbidden" });
    expect(rpcCalls()).toEqual([]);
  });

  it("organization_id revendiqué différent du contexte -> forbidden", async () => {
    asRole("company_owner");
    const state = await inviteMemberAction(idle, form({ ...base, organization_id: OTHER }));
    expect(state).toEqual({ status: "error", code: "forbidden" });
    expect(rpcCalls()).toEqual([]);
  });

  it("succès : n'envoie que le HASH, normalise l'e-mail, renvoie le lien une fois", async () => {
    asRole("company_admin");
    results.set("rpc.create_invitation", { data: INVITATION });
    const state = await inviteMemberAction(idle, form(base));
    expect(state.status).toBe("success");
    const path = state.invitePath ?? "";
    const token = /^\/en\/invite\/([A-Za-z0-9_-]{43})$/.exec(path)?.[1];
    expect(token).toBeDefined();

    const [call] = rpcCalls();
    expect(call?.op).toBe("rpc.create_invitation");
    const args = call?.args[0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["p_email", "p_org", "p_role", "p_token_hash"]);
    expect(args).toMatchObject({ p_org: ORG, p_email: "new.user@example.com", p_role: "sales_agent" });
    expect(args.p_token_hash).toBe(hashInvitationToken(token ?? ""));
    expect(JSON.stringify(args)).not.toContain(token ?? "?");
  });

  it.each([
    [{ code: "P0001", message: "already_member" }, "already_member"],
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "22023", message: "validation_failed" }, "invalid_input"],
    [{ code: "XX000", message: "boom with secret@example.com" }, "generic"],
  ])("erreur base %j -> %s (jamais le message brut)", async (error, code) => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { error });
    const state = await inviteMemberAction(idle, form(base));
    expect(state).toEqual({ status: "error", code });
  });

  it("session expirée -> redirection vers la connexion", async () => {
    getTenantContext.mockRejectedValue(new (await import("../tenant/tenant-error")).TenantError("unauthenticated"));
    await expect(inviteMemberAction(idle, form(base))).rejects.toMatchObject({ url: "/en/login" });
  });
});

describe("revokeInvitationAction", () => {
  it("company_admin ne révoque pas une invitation company_owner", async () => {
    asRole("company_admin");
    results.set("invitations.select", { data: { role: "company_owner" } });
    const state = await revokeInvitationAction(idle, form({ invitation_id: INVITATION, organization_id: ORG }));
    expect(state).toEqual({ status: "error", code: "forbidden" });
    expect(rpcCalls()).toEqual([]);
  });

  it("owner révoque : appel RPC et succès", async () => {
    asRole("company_owner");
    results.set("invitations.select", { data: { role: "company_owner" } });
    const state = await revokeInvitationAction(idle, form({ invitation_id: INVITATION }));
    expect(state).toEqual({ status: "success" });
    expect(rpcCalls()[0]?.args[0]).toEqual({ p_org: ORG, p_invitation_id: INVITATION });
  });

  it("invitation introuvable (autre organisation) -> forbidden", async () => {
    asRole("company_owner");
    results.set("invitations.select", { data: null });
    expect(await revokeInvitationAction(idle, form({ invitation_id: INVITATION }))).toEqual({ status: "error", code: "forbidden" });
  });
});

describe("changeMemberRoleAction", () => {
  const input = { member_id: MEMBER, role: "analyst", organization_id: ORG };

  it("company_admin ne touche pas un company_owner", async () => {
    asRole("company_admin");
    results.set("organization_members.select", { data: member({ role: "company_owner" }) });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    expect(updates()).toEqual([]);
  });

  it("company_admin ne peut pas attribuer company_owner", async () => {
    asRole("company_admin");
    results.set("organization_members.select", { data: member() });
    expect(await changeMemberRoleAction(idle, form({ ...input, role: "company_owner" }))).toEqual({ status: "error", code: "forbidden" });
    expect(updates()).toEqual([]);
  });

  it("pas d'auto-modification", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member({ user_id: ME }) });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    expect(updates()).toEqual([]);
  });

  it("rétrograder le dernier owner actif -> last_owner avant l'écriture", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 0 });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "error", code: "last_owner" });
    expect(updates()).toEqual([]);
  });

  it("succès : met à jour le rôle dans l'organisation du contexte seulement", async () => {
    asRole("company_admin");
    results.set("organization_members.select", { data: member() });
    results.set("organization_members.update", { data: [{ id: MEMBER }] });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "success" });
    expect(updates()[0]?.args).toEqual([{ role: "analyst" }]);
    expect(calls.some((c) => c.op === "organization_members.eq" && c.args[0] === "organization_id" && c.args[1] === ORG)).toBe(true);
  });

  it("la RLS filtre silencieusement (0 ligne) -> forbidden", async () => {
    asRole("company_admin");
    results.set("organization_members.select", { data: member() });
    results.set("organization_members.update", { data: [] });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
  });

  it("trigger du dernier owner (23514) -> last_owner", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 1 });
    results.set("organization_members.update", { error: { code: "23514", message: "cannot remove" } });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "error", code: "last_owner" });
  });

  it.each(["marketing_manager", "sales_agent", "analyst"])("%s : refusé", async (role) => {
    asRole(role);
    results.set("organization_members.select", { data: member() });
    expect(await changeMemberRoleAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    expect(updates()).toEqual([]);
  });
});

describe("removeMemberAction", () => {
  const input = { member_id: MEMBER, organization_id: ORG };

  it("passe le statut à removed (jamais de suppression de ligne)", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member() });
    results.set("organization_members.update", { data: [{ id: MEMBER }] });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "success" });
    expect(updates()[0]?.args).toEqual([{ status: "removed" }]);
    expect(calls.some((c) => c.op.endsWith(".delete"))).toBe(false);
  });

  it("dernier owner -> last_owner ; admin sur owner -> forbidden ; soi-même -> forbidden", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 0 });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "error", code: "last_owner" });

    asRole("company_admin");
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });

    asRole("company_owner");
    results.set("organization_members.select", { data: member({ user_id: ME }) });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    expect(updates()).toEqual([]);
  });
});

describe("transferOwnershipAction", () => {
  const input = { member_id: MEMBER, organization_id: ORG };

  it("company_admin ne peut pas transférer la propriété (refusé avant la base)", async () => {
    asRole("company_admin");
    expect(await transferOwnershipAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    expect(rpcCalls()).toEqual([]);
  });

  it("owner : cible relue en base, RPC avec l'identifiant utilisateur de la cible", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member() });
    expect(await transferOwnershipAction(idle, form(input))).toEqual({ status: "success" });
    expect(rpcCalls()[0]).toMatchObject({ op: "rpc.transfer_ownership", args: [{ p_org: ORG, p_new_owner: OTHER }] });
  });

  it("cible inactive ou soi-même -> forbidden sans RPC", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member({ status: "suspended" }) });
    expect(await transferOwnershipAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    results.set("organization_members.select", { data: member({ user_id: ME }) });
    expect(await transferOwnershipAction(idle, form(input))).toEqual({ status: "error", code: "forbidden" });
    expect(rpcCalls()).toEqual([]);
  });

  it("invalid_target de la base -> invalid_input", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member() });
    results.set("rpc.transfer_ownership", { error: { code: "P0001", message: "invalid_target" } });
    expect(await transferOwnershipAction(idle, form(input))).toEqual({ status: "error", code: "invalid_input" });
  });
});

describe("acceptInvitationAction", () => {
  const token = "A".repeat(43);

  it("jeton mal formé -> invitation_invalid sans appel base", async () => {
    expect(await acceptInvitationAction(idle, form({ token: "court", uiLocale: "en" }))).toEqual({ status: "error", code: "invitation_invalid" });
    expect(rpcCalls()).toEqual([]);
  });

  it("sans session -> redirection vers la connexion", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "x" } });
    await expect(acceptInvitationAction(idle, form({ token, uiLocale: "en" }))).rejects.toMatchObject({ url: "/en/login" });
    expect(rpcCalls()).toEqual([]);
  });

  it.each([
    [{ code: "P0001", message: "invitation_invalid" }],
    [{ code: "42501", message: "forbidden" }],
    [{ code: "XX000", message: "internal" }],
    [{ code: "28000", message: "unauthenticated" }],
  ])("toute erreur %j -> le MÊME code invitation_invalid", async (error) => {
    results.set("rpc.accept_invitation", { error });
    expect(await acceptInvitationAction(idle, form({ token, uiLocale: "en" }))).toEqual({ status: "error", code: "invitation_invalid" });
  });

  it("réponse inattendue (pas un uuid) -> invitation_invalid", async () => {
    results.set("rpc.accept_invitation", { data: "pas-un-uuid" });
    expect(await acceptInvitationAction(idle, form({ token, uiLocale: "en" }))).toEqual({ status: "error", code: "invitation_invalid" });
  });

  it("succès : envoie le HASH, pose le cookie d'organisation active, redirige vers le tableau de bord", async () => {
    results.set("rpc.accept_invitation", { data: ORG });
    await expect(acceptInvitationAction(idle, form({ token, uiLocale: "en" }))).rejects.toMatchObject({ url: "/en/dashboard" });
    expect(rpcCalls()[0]?.args[0]).toEqual({ p_token_hash: hashInvitationToken(token) });
    expect(setCookie).toHaveBeenCalledWith("fl_active_org", ORG, expect.objectContaining({ httpOnly: true }));
  });
});
