import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Flux bout en bout de la couche service avec les VRAIS modules idempotency et rate-limit, face à un
 * mini-modèle de la machine d'états SQL (idempotency_begin / complete / abandon) et d'un seau à jetons.
 * Toutes les entrées de supabase.rpc (client utilisateur ET client admin) sont enregistrées : on
 * vérifie qu'aucun secret (jeton d'invitation en clair, e-mail) n'y transite jamais.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const INVITATION = "55555555-5555-4555-8555-555555555555";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const EMAIL = "new.user@example.com";

type Row = { actor: string; hash: string; attempt: string; state: "in_progress" | "completed"; status?: number; response?: unknown };
const rows = new Map<string, Row>();
const userCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const adminCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let bucketAllowed = true;
let bucketFails = false;
/** Rang (1 = seau d'organisation, 2 = seau global) du seul appel rate_limit_take qui échoue ; null = aucun. */
let failCall: number | null = null;
/** Rang du seul appel qui refuse (allowed=false) ; null = aucun. */
let denyCall: number | null = null;
let businessError: { code: string; message: string } | null = null;

function userRpc(name: string, args: Record<string, unknown>) {
  userCalls.push({ name, args });
  const id = `${args.p_org as string}:${args.p_key as string}`;
  switch (name) {
    case "idempotency_begin": {
      const row = rows.get(id);
      if (!row) {
        const attempt = crypto.randomUUID();
        rows.set(id, { actor: ME, hash: args.p_request_hash as string, attempt, state: "in_progress" });
        return { data: { state: "new", attempt_id: attempt }, error: null };
      }
      if (row.hash !== args.p_request_hash || row.actor !== ME) return { data: { state: "conflict" }, error: null };
      if (row.state === "in_progress") return { data: { state: "in_progress" }, error: null };
      return { data: { state: "replay", status_code: row.status, response: row.response }, error: null };
    }
    case "idempotency_complete": {
      const row = rows.get(id);
      if (!row || row.state !== "in_progress" || row.attempt !== args.p_attempt_id) {
        return { data: null, error: { code: "P0001", message: "invalid_state" } };
      }
      rows.set(id, { ...row, state: "completed", status: args.p_status_code as number, response: args.p_response });
      return { data: null, error: null };
    }
    case "idempotency_abandon":
      if (rows.get(id)?.attempt === args.p_attempt_id) rows.delete(id);
      return { data: null, error: null };
    case "create_invitation":
      return businessError ? { data: null, error: businessError } : { data: INVITATION, error: null };
    default:
      return { data: null, error: null };
  }
}

vi.mock("../supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => userRpc(name, args),
    from: () => ({}),
    auth: { getClaims: vi.fn() },
  }),
}));
vi.mock("../supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      adminCalls.push({ name, args });
      if (bucketFails || failCall === adminCalls.length) return { data: null, error: { code: "XX000", message: "boom" } };
      const allowed = bucketAllowed && denyCall !== adminCalls.length;
      return { data: { allowed, remaining: 3.25, retry_after_seconds: allowed ? 0 : 5 }, error: null };
    },
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn(), set: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("../tenant/context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTenantContext: async () => ({
    userId: ME,
    organizationId: ORG,
    role: "company_owner",
    organization: { id: ORG, name: "X", slug: "x", locale: "fr", timezone: "UTC" },
  }),
}));

import { inviteMemberAction } from "./actions";

const idle = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const invite = { email: EMAIL, role: "sales_agent", uiLocale: "fr", organization_id: ORG };
const count = (name: string) => userCalls.filter((c) => c.name === name).length;

beforeEach(() => {
  rows.clear();
  userCalls.length = 0;
  adminCalls.length = 0;
  bucketAllowed = true;
  bucketFails = false;
  failCall = null;
  denyCall = null;
  businessError = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("inviteMemberAction : double soumission avec la même clé", () => {
  it("1re soumission : invitation créée ; 2e : duplicate_request, create_invitation appelé UNE seule fois", async () => {
    const first = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(first.status).toBe("success");
    const second = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(second).toEqual({ status: "error", code: "duplicate_request" });
    expect(count("create_invitation")).toBe(1);
    expect(count("revoke_invitation")).toBe(0);
    expect(second.invitePath).toBeUndefined();
  });

  it("le jeton en clair et l'e-mail ne figurent dans AUCUN appel rpc (utilisateur ou admin) ni dans la ligne d'idempotence", async () => {
    const first = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    const token = first.invitePath!.split("/").pop()!;
    expect(token.length).toBeGreaterThan(20);

    const everything = JSON.stringify({ userCalls: userCalls.filter((c) => c.name !== "create_invitation"), adminCalls, rows: [...rows] });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(EMAIL);
    expect(everything).not.toContain("new.user");
    // L'unique réponse conservée est la forme minimale.
    expect([...rows.values()][0]?.response).toEqual({ replayed: true });
    // Seul create_invitation reçoit un HASH du jeton, jamais le jeton lui-même.
    const create = userCalls.find((c) => c.name === "create_invitation")!;
    expect(JSON.stringify(create.args)).not.toContain(token);
  });

  it("même clé mais autre e-mail : idempotency_conflict, pas de seconde invitation", async () => {
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    const other = await inviteMemberAction(idle, form({ ...invite, email: "autre@example.com", idempotency_key: KEY }));
    expect(other).toMatchObject({ status: "error", code: "idempotency_conflict" });
    expect(count("create_invitation")).toBe(1);
  });

  it("échec métier : ligne abandonnée, un nouvel essai avec la MÊME clé ré-exécute", async () => {
    businessError = { code: "P0001", message: "already_member" };
    expect(await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }))).toMatchObject({ code: "already_member" });
    expect(rows.size).toBe(0);
    businessError = null;
    const retry = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(retry.status).toBe("success");
    expect(count("create_invitation")).toBe(2);
  });

  it("deux clés différentes : deux invitations (la clé, pas le contenu, identifie la tentative)", async () => {
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: "another-key-123456" }));
    expect(count("create_invitation")).toBe(2);
  });

  it("requête encore en cours (ligne in_progress) : idempotency_in_progress sans exécution", async () => {
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    const id = `${ORG}:${KEY}`;
    rows.set(id, { actor: ME, hash: rows.get(id)!.hash, attempt: crypto.randomUUID(), state: "in_progress" });
    const r = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    // Distinct de duplicate_request (item 6) : le résultat n'est pas encore connu, la clé doit être conservée.
    expect(r).toEqual({ status: "error", code: "idempotency_in_progress" });
    expect(count("create_invitation")).toBe(1);
  });
});

describe("limitation de débit réelle (module rate-limit non simulé)", () => {
  it("les seaux sont (organisation, scope:utilisateur) et (global, scope:utilisateur), sans e-mail ; coût 1 ; limites 10 et 1/6 pour une invitation", async () => {
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    // Deux jetons : (organisation, utilisateur) PUIS seau global de l'utilisateur (même clé, même capacité).
    expect(adminCalls).toHaveLength(2);
    expect(adminCalls[0]).toEqual({
      name: "rate_limit_take",
      args: {
        p_org: ORG,
        p_provider: null,
        p_bucket_key: `sensitive:${ME}`,
        p_capacity: 10,
        p_refill_per_second: 1 / 6,
        p_cost: 1,
      },
    });
    expect(adminCalls[1]).toEqual({
      name: "rate_limit_take",
      args: {
        p_org: null,
        p_provider: "user_scope",
        p_bucket_key: `sensitive:${ME}`,
        p_capacity: 10,
        p_refill_per_second: 1 / 6,
        p_cost: 1,
      },
    });
    expect(JSON.stringify(adminCalls)).not.toContain("@");
  });

  it("seau vide : rate_limited, ni begin ni create_invitation", async () => {
    bucketAllowed = false;
    const r = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(r).toEqual({ status: "error", code: "rate_limited" });
    expect(userCalls).toEqual([]);
  });

  it("backend du seau en panne : ÉCHEC FERMÉ service_unavailable, aucune écriture, aucune ligne d'idempotence", async () => {
    bucketFails = true;
    const r = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(r).toEqual({ status: "error", code: "service_unavailable" });
    expect(userCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });
});

describe("tentative périmée (attempt_id)", () => {
  it("la tentative tardive ne peut ni clore ni supprimer la ligne d'une tentative plus récente", async () => {
    const id = `${ORG}:${KEY}`;
    const begin = userRpc("idempotency_begin", { p_org: ORG, p_key: KEY, p_request_hash: "h" });
    const stale = (begin.data as { attempt_id: string }).attempt_id;
    // Reprise de la ligne « périmée » par une 2e tentative (nouvel attempt_id).
    const fresh = crypto.randomUUID();
    rows.set(id, { ...rows.get(id)!, attempt: fresh });
    expect(userRpc("idempotency_complete", { p_org: ORG, p_key: KEY, p_attempt_id: stale, p_status_code: 200, p_response: {} }).error).toMatchObject({
      message: "invalid_state",
    });
    userRpc("idempotency_abandon", { p_org: ORG, p_key: KEY, p_attempt_id: stale });
    expect(rows.get(id)?.attempt).toBe(fresh);
    expect(rows.get(id)?.state).toBe("in_progress");
  });

  it("le pipeline transmet l'attempt_id reçu de begin à complete (et le secret reste hors de la ligne)", async () => {
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    const begin = userCalls.find((c) => c.name === "idempotency_begin")!;
    const complete = userCalls.find((c) => c.name === "idempotency_complete")!;
    expect(complete.args.p_attempt_id).toBe([...rows.values()][0]?.attempt);
    expect(begin.args).not.toHaveProperty("p_attempt_id");
  });

  it("échec métier : abandon avec le même attempt_id que celui du begin", async () => {
    businessError = { code: "P0001", message: "already_member" };
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    const abandon = userCalls.find((c) => c.name === "idempotency_abandon")!;
    expect(typeof abandon.args.p_attempt_id).toBe("string");
    expect(rows.size).toBe(0);
  });
});

describe("deux seaux (organisation + global utilisateur) : refus et pannes", () => {
  it.each([
    ["seau d'organisation", 1],
    ["seau global", 2],
  ])("panne du %s : ÉCHEC FERMÉ service_unavailable, handler non appelé, aucune ligne d'idempotence", async (_l, call) => {
    failCall = call;
    const r = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(r).toEqual({ status: "error", code: "service_unavailable" });
    expect(userCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it.each([
    ["seau d'organisation", 1],
    ["seau global", 2],
  ])("refus du %s : rate_limited, handler non appelé", async (_l, call) => {
    denyCall = call;
    const r = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(r).toEqual({ status: "error", code: "rate_limited" });
    expect(userCalls).toEqual([]);
  });
});

