import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de sécurité des Server Actions Membres (J10, agent A4) : refus AVANT la base, escalade de
 * rôle, isolation d'organisation, dernier owner, lien d'invitation affiché une seule fois, aucune
 * fuite de jeton / e-mail / empreinte (retours, appels, journaux), échecs d'acceptation indiscernables.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const INVITATION = "55555555-5555-4555-8555-555555555555";

type Result = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };
const results = new Map<string, Result>();
const calls: { op: string; table?: string; args: unknown[] }[] = [];

function builder(table: string) {
  let op = "select";
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "order", "maybeSingle", "update", "delete", "insert", "upsert"]) {
    q[m] = (...args: unknown[]) => {
      if (m === "update" || m === "delete" || m === "insert" || m === "upsert") op = m;
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
const from = vi.fn((t: string) => {
  calls.push({ op: `from.${t}`, table: t, args: [] });
  return builder(t);
});
const getTenantContext = vi.fn();
const getClaims = vi.fn();
const setCookie = vi.fn();

vi.mock("../supabase/server", () => ({
  createClient: async () => ({ from, rpc, auth: { getClaims } }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn(), set: setCookie }) }));
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
const dbCalls = () => calls.filter((c) => c.op.startsWith("rpc.") || c.op.startsWith("from."));
const writes = () => calls.filter((c) => /\.(update|delete|insert|upsert)$/.test(c.op) || c.op.startsWith("rpc."));
const FORBIDDEN = { status: "error", code: "forbidden" } as const;

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  results.clear();
  calls.length = 0;
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: ME } }, error: null });
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
const consoleOutput = () => JSON.stringify(logSpies.flatMap((s) => s.mock.calls));

const NON_PRIVILEGED = ["marketing_manager", "sales_agent", "analyst"] as const;

describe("refus RBAC : aucun appel d'écriture, jamais", () => {
  const actions: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
    ["invite", (fd) => inviteMemberAction(idle, fd), { email: "a@example.com", role: "analyst", organization_id: ORG }],
    ["revoke", (fd) => revokeInvitationAction(idle, fd), { invitation_id: INVITATION, organization_id: ORG }],
    ["changeRole", (fd) => changeMemberRoleAction(idle, fd), { member_id: MEMBER, role: "analyst", organization_id: ORG }],
    ["remove", (fd) => removeMemberAction(idle, fd), { member_id: MEMBER, organization_id: ORG }],
    ["transfer", (fd) => transferOwnershipAction(idle, fd), { member_id: MEMBER, organization_id: ORG }],
  ];

  for (const role of NON_PRIVILEGED) {
    for (const [name, run, input] of actions) {
      it(`${role} -> ${name} : forbidden, aucune écriture ni RPC`, async () => {
        asRole(role);
        results.set("organization_members.select", { data: member() });
        results.set("invitations.select", { data: { role: "analyst" } });
        expect(await run(form(input))).toEqual(FORBIDDEN);
        expect(writes()).toEqual([]);
      });
    }
  }

  // Refus AVANT TOUTE requête (lecture comprise) : vrai pour invite et transfert.
  for (const role of NON_PRIVILEGED) {
    for (const name of ["invite", "transfer"]) {
      it(`${role} -> ${name} : refus avant toute requête base`, async () => {
        asRole(role);
        const entry = actions.find((a) => a[0] === name);
        if (!entry) throw new Error("action");
        await entry[1](form(entry[2]));
        expect(dbCalls()).toEqual([]);
      });
    }
  }

  // Refus AVANT toute lecture base aussi pour revoke / changeRole / remove (can() précoce).
  for (const role of NON_PRIVILEGED) {
    for (const name of ["revoke", "changeRole", "remove"]) {
      it(`${role} -> ${name} : refus avant toute requête base (aucune lecture)`, async () => {
        asRole(role);
        results.set("organization_members.select", { data: member() });
        results.set("invitations.select", { data: { role: "analyst" } });
        const entry = actions.find((a) => a[0] === name);
        if (!entry) throw new Error("action");
        await entry[1](form(entry[2]));
        expect(dbCalls()).toEqual([]);
      });
    }
  }

  it("company_admin ne transfère jamais la propriété (refus avant toute requête)", async () => {
    asRole("company_admin");
    expect(await transferOwnershipAction(idle, form({ member_id: MEMBER, organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(dbCalls()).toEqual([]);
  });
});

describe("escalade de rôle par un company_admin", () => {
  beforeEach(() => asRole("company_admin"));

  it("invite company_owner : refusé avant la base", async () => {
    expect(await inviteMemberAction(idle, form({ email: "a@example.com", role: "company_owner", organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(dbCalls()).toEqual([]);
  });

  it("promeut un membre en company_owner : aucune écriture", async () => {
    results.set("organization_members.select", { data: member({ role: "analyst" }) });
    expect(await changeMemberRoleAction(idle, form({ member_id: MEMBER, role: "company_owner", organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(writes()).toEqual([]);
  });

  it("rétrograde / modifie un company_owner : aucune écriture", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }) });
    for (const role of ["company_admin", "analyst", "company_owner"]) {
      expect(await changeMemberRoleAction(idle, form({ member_id: MEMBER, role, organization_id: ORG }))).toEqual(FORBIDDEN);
    }
    expect(writes()).toEqual([]);
  });

  it("retire un company_owner : aucune écriture", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 5 });
    expect(await removeMemberAction(idle, form({ member_id: MEMBER, organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(writes()).toEqual([]);
  });

  it("révoque une invitation company_owner : aucun RPC", async () => {
    results.set("invitations.select", { data: { role: "company_owner" } });
    expect(await revokeInvitationAction(idle, form({ invitation_id: INVITATION, organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(writes()).toEqual([]);
  });

  it("transfère la propriété : aucun RPC", async () => {
    results.set("organization_members.select", { data: member({ role: "company_admin" }) });
    expect(await transferOwnershipAction(idle, form({ member_id: MEMBER, organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(writes()).toEqual([]);
  });

  it("le rôle de la cible vient de la base : un champ target_role forgé est ignoré", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }) });
    const state = await changeMemberRoleAction(
      idle,
      form({ member_id: MEMBER, role: "analyst", organization_id: ORG, target_role: "analyst", targetRole: "analyst", current_role: "analyst" }),
    );
    expect(state).toEqual(FORBIDDEN);
    expect(writes()).toEqual([]);
  });

  it("un rôle d'acteur forgé dans le formulaire est sans effet (le contexte décide)", async () => {
    const state = await inviteMemberAction(
      idle,
      form({ email: "a@example.com", role: "company_owner", organization_id: ORG, actor_role: "company_owner", role_actor: "company_owner" }),
    );
    expect(state).toEqual(FORBIDDEN);
    expect(dbCalls()).toEqual([]);
  });
});

describe("isolation d'organisation", () => {
  const forged: Array<[string, (fd: FormData) => Promise<unknown>, Record<string, string>]> = [
    ["invite", (fd) => inviteMemberAction(idle, fd), { email: "a@example.com", role: "analyst" }],
    ["revoke", (fd) => revokeInvitationAction(idle, fd), { invitation_id: INVITATION }],
    ["changeRole", (fd) => changeMemberRoleAction(idle, fd), { member_id: MEMBER, role: "analyst" }],
    ["remove", (fd) => removeMemberAction(idle, fd), { member_id: MEMBER }],
    ["transfer", (fd) => transferOwnershipAction(idle, fd), { member_id: MEMBER }],
  ];

  it.each(forged)("%s : organization_id d'une autre organisation -> forbidden, aucune requête base", async (_n, run, input) => {
    asRole("company_owner");
    expect(await run(form({ ...input, organization_id: OTHER_ORG }))).toEqual(FORBIDDEN);
    expect(dbCalls()).toEqual([]);
  });

  it.each(forged)("%s : organization_id mal formé -> invalid_input, aucune requête base", async (_n, run, input) => {
    asRole("company_owner");
    expect(await run(form({ ...input, organization_id: "x' or 1=1 --" }))).toMatchObject({ status: "error", code: "invalid_input" });
    expect(dbCalls()).toEqual([]);
  });

  it("les requêtes sur les membres / invitations sont toujours filtrées par l'organisation du CONTEXTE", async () => {
    asRole("company_owner");
    results.set("organization_members.select", { data: member(), count: 2 });
    results.set("organization_members.update", { data: [{ id: MEMBER }] });
    await removeMemberAction(idle, form({ member_id: MEMBER })); // sans organization_id posté
    await changeMemberRoleAction(idle, form({ member_id: MEMBER, role: "analyst" }));
    const orgFilters = calls.filter((c) => c.op === "organization_members.eq" && c.args[0] === "organization_id");
    expect(orgFilters.length).toBeGreaterThanOrEqual(4);
    for (const f of orgFilters) expect(f.args[1]).toBe(ORG);
    expect(calls.some((c) => JSON.stringify(c.args).includes(OTHER_ORG))).toBe(false);
  });

  it("revoke : l'invitation est cherchée dans l'organisation du contexte et le RPC reçoit cette organisation", async () => {
    asRole("company_owner");
    results.set("invitations.select", { data: { role: "analyst" } });
    expect(await revokeInvitationAction(idle, form({ invitation_id: INVITATION }))).toEqual({ status: "success" });
    expect(calls.find((c) => c.op === "invitations.eq" && c.args[0] === "organization_id")?.args[1]).toBe(ORG);
    expect(calls.find((c) => c.op === "rpc.revoke_invitation")?.args[0]).toEqual({ p_org: ORG, p_invitation_id: INVITATION });
  });

  it("création : p_org vient du contexte même si le formulaire omet organization_id", async () => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { data: INVITATION });
    await inviteMemberAction(idle, form({ email: "a@example.com", role: "analyst" }));
    expect((calls.find((c) => c.op === "rpc.create_invitation")?.args[0] as { p_org: string }).p_org).toBe(ORG);
  });

  it("aucune adhésion active : l'erreur du contexte ferme tout (forbidden), sans requête base", async () => {
    const { TenantError } = await import("../tenant/tenant-error");
    getTenantContext.mockRejectedValue(new TenantError("forbidden"));
    for (const [, run, input] of forged) expect(await run(form({ ...input, organization_id: ORG }))).toEqual(FORBIDDEN);
    expect(dbCalls()).toEqual([]);
  });

  it("erreur inattendue du contexte -> generic, sans fuite du message", async () => {
    getTenantContext.mockRejectedValue(new Error("connection string postgres://secret"));
    const state = await inviteMemberAction(idle, form({ email: "a@example.com", role: "analyst" }));
    expect(state).toEqual({ status: "error", code: "generic" });
    expect(JSON.stringify(state)).not.toContain("secret");
  });
});

describe("dernier owner", () => {
  const input = { member_id: MEMBER, organization_id: ORG };
  beforeEach(() => asRole("company_owner"));

  it("retirer le dernier owner actif : last_owner, AUCUNE écriture", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 0 });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "error", code: "last_owner" });
    expect(writes()).toEqual([]);
  });

  it("rétrograder le dernier owner actif : last_owner, AUCUNE écriture", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 0 });
    expect(await changeMemberRoleAction(idle, form({ ...input, role: "company_admin" }))).toEqual({ status: "error", code: "last_owner" });
    expect(writes()).toEqual([]);
  });

  it("comptage en erreur : generic et aucune écriture (fail closed)", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: null });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "error", code: "generic" });
    expect(writes()).toEqual([]);
  });

  it("un autre owner actif existe : le retrait est écrit (statut removed uniquement)", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 1 });
    results.set("organization_members.update", { data: [{ id: MEMBER }] });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "success" });
    expect(calls.filter((c) => c.op.endsWith(".update")).map((c) => c.args[0])).toEqual([{ status: "removed" }]);
    expect(calls.some((c) => c.op.endsWith(".delete"))).toBe(false);
  });

  it("le trigger protect_last_owner (course concurrente) est aussi mappé : last_owner", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner" }), count: 1 });
    results.set("organization_members.update", { error: { code: "23514", message: "last owner" } });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "error", code: "last_owner" });
  });

  it("un owner suspendu ou invité (non actif) n'est pas protégé par le comptage mais reste soumis à can()", async () => {
    results.set("organization_members.select", { data: member({ role: "company_owner", status: "suspended" }), count: 0 });
    results.set("organization_members.update", { data: [{ id: MEMBER }] });
    expect(await removeMemberAction(idle, form(input))).toEqual({ status: "success" });
  });

  it("jamais de suppression de ligne, quelle que soit l'action", async () => {
    results.set("organization_members.select", { data: member(), count: 3 });
    results.set("organization_members.update", { data: [{ id: MEMBER }] });
    await removeMemberAction(idle, form(input));
    await changeMemberRoleAction(idle, form({ ...input, role: "analyst" }));
    expect(calls.some((c) => /\.(delete|insert|upsert)$/.test(c.op))).toBe(false);
  });

  it("transfert : la cible 'removed' ou 'invited' est refusée sans RPC", async () => {
    for (const status of ["removed", "invited", "suspended"]) {
      results.set("organization_members.select", { data: member({ status }) });
      expect(await transferOwnershipAction(idle, form(input))).toEqual(FORBIDDEN);
    }
    expect(calls.some((c) => c.op.startsWith("rpc."))).toBe(false);
  });
});

describe("lien d'invitation : affiché une seule fois, la base ne reçoit que l'empreinte", () => {
  const base = { email: "Invitee@Example.com", role: "sales_agent", uiLocale: "en", organization_id: ORG };

  it("le lien contient le jeton ; la base ne reçoit QUE l'empreinte sha256 de ce jeton", async () => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { data: INVITATION });
    const state = await inviteMemberAction(idle, form(base));
    const token = /^\/en\/invite\/([A-Za-z0-9_-]{43})$/.exec(state.invitePath ?? "")?.[1] ?? "";
    expect(token).toHaveLength(43);

    const serializedCalls = JSON.stringify(calls);
    expect(serializedCalls).not.toContain(token);
    expect(serializedCalls).toContain(hashInvitationToken(token));
    // le jeton n'est ni dans les journaux ni dans autre chose que invitePath
    expect(consoleOutput()).not.toContain(token);
    const { invitePath: _omit, ...rest } = state;
    void _omit;
    expect(JSON.stringify(rest)).not.toContain(token);
  });

  it("deux invitations successives (même e-mail) : jetons et empreintes différents", async () => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { data: INVITATION });
    const a = await inviteMemberAction(idle, form(base));
    const b = await inviteMemberAction(idle, form(base));
    expect(a.invitePath).not.toBe(b.invitePath);
    const hashes = calls.filter((c) => c.op === "rpc.create_invitation").map((c) => (c.args[0] as { p_token_hash: string }).p_token_hash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("échec (déjà membre, interdit, générique) : aucun invitePath dans la réponse", async () => {
    asRole("company_owner");
    for (const error of [{ code: "P0001", message: "already_member" }, { code: "42501", message: "forbidden" }, { code: "XX000", message: "x" }]) {
      results.set("rpc.create_invitation", { error });
      const state = await inviteMemberAction(idle, form(base));
      expect(state.invitePath).toBeUndefined();
      expect(state.status).toBe("error");
    }
  });

  it("réponse base inattendue (pas un uuid) : generic, pas de lien renvoyé", async () => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { data: "pas-un-uuid" });
    const state = await inviteMemberAction(idle, form(base));
    expect(state).toEqual({ status: "error", code: "generic" });
  });

  it("l'e-mail n'apparaît ni dans les réponses d'erreur ni dans les journaux", async () => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { error: { code: "XX000", message: "duplicate key invitee@example.com" } });
    const state = await inviteMemberAction(idle, form(base));
    expect(JSON.stringify(state).toLowerCase()).not.toContain("invitee");
    expect(consoleOutput().toLowerCase()).not.toContain("invitee");
  });

  it("uiLocale hostile (open redirect) : repli sur la locale par défaut dans le lien", async () => {
    asRole("company_owner");
    results.set("rpc.create_invitation", { data: INVITATION });
    for (const uiLocale of ["//evil.example", "https://evil.example", "../x", "EN", ""]) {
      const state = await inviteMemberAction(idle, form({ ...base, uiLocale }));
      expect(state.invitePath, uiLocale).toMatch(/^\/fr\/invite\/[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("acceptInvitationAction", () => {
  const token = "Zx9_-".repeat(8) + "abc"; // 43 caractères
  const hash = hashInvitationToken(token);
  const accept = (extra: Record<string, string> = {}) => acceptInvitationAction(idle, form({ token, uiLocale: "en", ...extra }));

  it("le jeton de test est bien un jeton valide de 43 caractères", () => {
    expect(token).toHaveLength(43);
  });

  it("toutes les causes d'échec produisent un retour STRICTEMENT identique, sans jeton ni empreinte", async () => {
    const causes: Array<{ error: { code: string; message: string } }> = [
      { error: { code: "P0001", message: "invitation_invalid" } }, // inconnu / expiré / révoqué / accepté / e-mail différent / non confirmé
      { error: { code: "42501", message: "forbidden" } },
      { error: { code: "28000", message: "unauthenticated" } },
      { error: { code: "22023", message: "validation_failed" } },
      { error: { code: "P0001", message: "already_member" } },
      { error: { code: "XX000", message: `boom ${token} ${hash} user@example.com` } },
      { error: { code: "", message: "" } },
    ];
    const outcomes: unknown[] = [];
    for (const c of causes) {
      results.set("rpc.accept_invitation", c);
      outcomes.push(await accept());
    }
    // Réponse inattendue (non-uuid) et réponse vide
    results.set("rpc.accept_invitation", { data: "xx" });
    outcomes.push(await accept());
    results.set("rpc.accept_invitation", { data: null });
    outcomes.push(await accept());
    for (const o of outcomes) expect(o).toStrictEqual({ status: "error", code: "invitation_invalid" });
    expect(JSON.stringify(outcomes)).not.toContain(token);
    expect(JSON.stringify(outcomes)).not.toContain(hash);
    expect(setCookie).not.toHaveBeenCalled();
    expect(consoleOutput()).not.toContain(token);
    expect(consoleOutput()).not.toContain(hash);
  });

  it("jeton absent, vide, trop court / long, caractères hors alphabet : même retour, aucun appel base", async () => {
    for (const bad of ["", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "+", "A".repeat(42) + "\n", "<script>".padEnd(43, "A")]) {
      expect(await acceptInvitationAction(idle, form({ token: bad, uiLocale: "en" }))).toStrictEqual({ status: "error", code: "invitation_invalid" });
    }
    expect(await acceptInvitationAction(idle, form({ uiLocale: "en" }))).toStrictEqual({ status: "error", code: "invitation_invalid" });
    expect(dbCalls()).toEqual([]);
  });

  it("n'envoie que l'empreinte (jamais le jeton) et exactement un paramètre", async () => {
    results.set("rpc.accept_invitation", { data: ORG });
    await expect(accept()).rejects.toBeInstanceOf(RedirectSignal);
    const rpcs = calls.filter((c) => c.op.startsWith("rpc."));
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]?.args[0]).toStrictEqual({ p_token_hash: hash });
    expect(JSON.stringify(calls)).not.toContain(token);
    expect(consoleOutput()).not.toContain(token);
  });

  it("succès : le cookie d'organisation active reçoit l'id RENVOYÉ par la base, pas celui posté", async () => {
    results.set("rpc.accept_invitation", { data: OTHER_ORG });
    await expect(accept({ organization_id: ORG, org: ORG })).rejects.toMatchObject({ url: "/en/dashboard" });
    expect(setCookie).toHaveBeenCalledTimes(1);
    expect(setCookie.mock.calls[0]?.[0]).toBe("fl_active_org");
    expect(setCookie.mock.calls[0]?.[1]).toBe(OTHER_ORG);
    expect(setCookie.mock.calls[0]?.[2]).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("la redirection ne contient ni jeton ni empreinte, et reste sur la locale validée", async () => {
    results.set("rpc.accept_invitation", { data: ORG });
    const err = await accept({ uiLocale: "//evil.example" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectSignal);
    const url = (err as RedirectSignal).url;
    expect(url).toMatch(/^\/fr\/dashboard$/);
    expect(url).not.toContain(token);
    expect(url).not.toContain("evil");
  });

  it("n'appelle jamais getTenantContext (l'invité n'a pas encore d'organisation)", async () => {
    results.set("rpc.accept_invitation", { error: { code: "P0001", message: "invitation_invalid" } });
    await accept();
    expect(getTenantContext).not.toHaveBeenCalled();
  });

  it("sans session : redirigé vers la connexion, aucun RPC", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "pas-un-uuid" } }, error: null });
    await expect(accept()).rejects.toMatchObject({ url: "/en/login" });
    expect(dbCalls()).toEqual([]);
  });
});
