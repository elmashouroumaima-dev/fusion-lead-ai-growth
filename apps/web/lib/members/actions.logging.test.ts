import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../service/log-capture.testkit";

/**
 * J12 : aucun flux d'invitation / de transfert n'écrit un jeton, une empreinte, une clé d'idempotence
 * ou une adresse e-mail dans une ligne de journal, quel que soit le niveau et que l'appel réussisse,
 * échoue côté métier ou plante avec un message d'erreur piégé.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const INVITATION = "55555555-5555-4555-8555-555555555555";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const EMAIL = "new.user@example.com";

const rpc = vi.fn();
const takeToken = vi.fn();
const begin = vi.fn();
const complete = vi.fn();
const abandon = vi.fn();
const getTenantContext = vi.fn();
const getClaims = vi.fn();

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "maybeSingle"]) q[m] = () => q;
  q.then = (resolve: (value: unknown) => unknown) =>
    resolve({
      data: { id: MEMBER, user_id: OTHER, role: "sales_agent", status: "active", created_at: "2026-11-06T00:00:00Z" },
      error: null,
    });
  return q;
}

vi.mock("../supabase/server", () => ({
  createClient: async () => ({ from: () => builder(), rpc: (...a: unknown[]) => rpc(...a), auth: { getClaims: (...a: unknown[]) => getClaims(...a) } }),
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
  getTenantContext: (...a: unknown[]) => getTenantContext(...a),
}));
vi.mock("../service/rate-limit", () => ({ LIMITS: {}, takeToken: (...a: unknown[]) => takeToken(...a) }));
vi.mock("../service/idempotency", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  idempotencyBegin: (...a: unknown[]) => begin(...a),
  idempotencyComplete: (...a: unknown[]) => complete(...a),
  idempotencyAbandon: (...a: unknown[]) => abandon(...a),
}));

import { acceptInvitationAction, inviteMemberAction, transferOwnershipAction } from "./actions";

const idle = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const invite = { email: EMAIL, role: "sales_agent", uiLocale: "fr", organization_id: ORG };
const transfer = { member_id: MEMBER, organization_id: ORG, uiLocale: "fr" };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let cap: ReturnType<typeof captureLogs>;

beforeEach(() => {
  vi.clearAllMocks();
  cap = captureLogs();
  getTenantContext.mockResolvedValue({
    userId: ME,
    organizationId: ORG,
    role: "company_owner",
    organization: { id: ORG, name: "X", slug: "x", locale: "fr", timezone: "UTC" },
  });
  getClaims.mockResolvedValue({ data: { claims: { sub: ME } }, error: null });
  takeToken.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  begin.mockResolvedValue({ state: "new", attemptId: ATTEMPT });
  complete.mockResolvedValue(undefined);
  abandon.mockResolvedValue(undefined);
  rpc.mockResolvedValue({ data: INVITATION, error: null });
});
afterEach(() => cap.stop());

/** Tout ce qui a été journalisé, tous niveaux confondus, ne doit contenir aucun de ces motifs. */
function expectNoLeak(forbidden: string[]): string {
  const all = cap.lines().join("\n");
  for (const value of forbidden) expect(all).not.toContain(value);
  expect(all).not.toMatch(/new\.user|example\.com|@/);
  expect(all).not.toMatch(/token_hash|invitePath|\/invite\//);
  return all;
}

describe("flux d'invitation : aucune fuite dans les journaux", () => {
  it("succès : le lien d'invitation, son jeton et l'e-mail n'apparaissent jamais", async () => {
    const state = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(state.status).toBe("success");
    const tokenValue = state.invitePath?.split("/").pop() ?? "never-matches";
    expectNoLeak([tokenValue, sha256(tokenValue), KEY]);
  });

  it("échec du RPC avec un message SQL piégé (e-mail + jeton) : aucune trace du message SQL", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: `insert into invitations (email, token_hash) values ('${EMAIL}', 'deadbeef${"0".repeat(56)}')` } });
    const state = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(state).toMatchObject({ status: "error", code: "generic" });
    expectNoLeak(["deadbeef", KEY, "insert into"]);
  });

  it("exception inattendue dont le message contient e-mail, jeton et clé : seul le code interne est journalisé", async () => {
    const secret = `Bearer abc.def.ghi ${EMAIL} sb_secret_ABCDEF123456 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln`;
    rpc.mockRejectedValue(new Error(secret));
    const state = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(state).toMatchObject({ status: "error", code: "generic" });
    expect(cap.lines("error").length).toBeGreaterThan(0);
    expectNoLeak(["sb_secret_", "eyJhbGci", "Bearer", KEY]);
  });

  it("échec de la clôture d'idempotence après succès : journal d'erreur sans lien ni jeton", async () => {
    complete.mockRejectedValue(new Error(`db down ${EMAIL}`));
    const state = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(state.status).toBe("success");
    expect(cap.lines("error").join(" ")).toContain("idempotency_complete");
    expectNoLeak([state.invitePath?.split("/").pop() ?? "never-matches", KEY]);
  });

  it("limite de débit atteinte et clé en conflit : lignes d'avertissement sans donnée saisie", async () => {
    takeToken.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 4 });
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    begin.mockResolvedValueOnce({ state: "conflict" });
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(cap.lines("warn")).toHaveLength(2);
    expectNoLeak([KEY]);
  });

  it("acceptation : ni le jeton en clair ni son empreinte, en succès comme en échec", async () => {
    const token = "T".repeat(43);
    rpc.mockResolvedValue({ data: ORG, error: null });
    await expect(acceptInvitationAction(idle, form({ token, uiLocale: "fr" }))).rejects.toMatchObject({ digest: expect.any(String) });
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: `invitation_invalid ${token}` } });
    await acceptInvitationAction(idle, form({ token, uiLocale: "fr" }));
    rpc.mockRejectedValue(new Error(`boom ${token} ${sha256(token)}`));
    await acceptInvitationAction(idle, form({ token, uiLocale: "fr" }));
    expect(cap.lines().length).toBeGreaterThan(0);
    expectNoLeak([token, sha256(token)]);
  });
});

describe("flux de transfert de propriété : aucune fuite dans les journaux", () => {
  it("succès, échec métier et panne piégée : seulement des identifiants techniques", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await transferOwnershipAction(idle, form({ ...transfer, idempotency_key: KEY }))).toEqual({ status: "success" });
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: `not_owner ${EMAIL}` } });
    await transferOwnershipAction(idle, form({ ...transfer, idempotency_key: KEY }));
    rpc.mockRejectedValue(new Error(`connection string postgres://u:p@db ${EMAIL}`));
    expect(await transferOwnershipAction(idle, form({ ...transfer, idempotency_key: KEY }))).toMatchObject({ status: "error", code: "generic" });
    expect(cap.lines("error").length).toBeGreaterThan(0);
    expectNoLeak(["postgres://", KEY]);
  });

  it("toutes les lignes sont du JSON valide avec ts, level, event", async () => {
    rpc.mockRejectedValue(new Error("x"));
    await transferOwnershipAction(idle, form({ ...transfer, idempotency_key: KEY }));
    const lines = cap.parsed();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatchObject({ ts: expect.any(String), level: expect.any(String), event: expect.any(String) });
  });
});
