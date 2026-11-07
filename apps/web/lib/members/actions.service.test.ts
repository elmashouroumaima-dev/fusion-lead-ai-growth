import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Couche service branchée sur les actions Membres (J11) : idempotence (invitation sans secret
 * conservé, transfert avec réponse conservée), limitation de débit « sensible », échec fermé.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const INVITATION = "55555555-5555-4555-8555-555555555555";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";

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

import { acceptInvitationAction, inviteMemberAction, removeMemberAction, revokeInvitationAction, transferOwnershipAction } from "./actions";

const idle = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const invite = { email: "new.user@example.com", role: "sales_agent", uiLocale: "fr", organization_id: ORG };
const rpcNames = () => rpc.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("inviteMemberAction : idempotence obligatoire, aucun secret conservé", () => {
  it("sans clé d'idempotence -> invalid_input, aucune invitation", async () => {
    const state = await inviteMemberAction(idle, form(invite));
    expect(state).toMatchObject({ status: "error", code: "invalid_input" });
    expect(rpcNames()).toEqual([]);
  });

  it("succès : le lien est rendu, mais seul { replayed: true } est conservé (jamais le jeton)", async () => {
    const state = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(state.status).toBe("success");
    expect(state.invitePath).toMatch(/^\/fr\/invite\/.{20,}$/);
    expect(complete).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify(complete.mock.calls);
    expect(stored).toContain('"replayed":true');
    expect(stored).not.toContain(state.invitePath?.split("/").pop() ?? "never");
    expect(stored).not.toContain("new.user");
  });

  it("rejeu de la même clé : duplicate_request, AUCUNE seconde invitation (ni révocation de la première)", async () => {
    begin.mockResolvedValue({ state: "replay", statusCode: 200, response: { replayed: true } });
    const state = await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    expect(state).toEqual({ status: "error", code: "duplicate_request" });
    expect(rpcNames()).toEqual([]);
    expect(state.invitePath).toBeUndefined();
  });

  it("même clé avec d'autres valeurs -> idempotency_conflict ; en cours -> idempotency_in_progress", async () => {
    begin.mockResolvedValueOnce({ state: "conflict" });
    expect(await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }))).toMatchObject({ code: "idempotency_conflict" });
    begin.mockResolvedValueOnce({ state: "in_progress" });
    // Distinct de duplicate_request : le résultat n'est pas encore connu, le formulaire garde sa clé.
    expect(await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }))).toMatchObject({ code: "idempotency_in_progress" });
    expect(rpcNames()).toEqual([]);
  });

  it("l'empreinte porte sur l'entrée validée (même e-mail à la casse près = même requête)", async () => {
    await inviteMemberAction(idle, form({ ...invite, email: " New.User@Example.com ", idempotency_key: KEY }));
    await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }));
    const hashes = begin.mock.calls.map((c) => (c[1] as { requestHash: string }).requestHash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("échec métier (already_member) : la ligne est abandonnée, un nouvel essai peut ré-exécuter", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "already_member" } });
    expect(await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }))).toMatchObject({ code: "already_member" });
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("transferOwnershipAction : idempotence obligatoire, réponse conservée", () => {
  const transfer = { member_id: MEMBER, organization_id: ORG, uiLocale: "fr" };

  it("sans clé -> invalid_input, aucun transfert", async () => {
    expect(await transferOwnershipAction(idle, form(transfer))).toMatchObject({ code: "invalid_input" });
    expect(rpcNames()).toEqual([]);
  });

  it("succès : { body: { status: success } } conservé ; rejeu -> même succès sans second transfert", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await transferOwnershipAction(idle, form({ ...transfer, idempotency_key: KEY }))).toEqual({ status: "success" });
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ statusCode: 200, response: { body: { status: "success" } } });

    rpc.mockClear();
    begin.mockResolvedValue({ state: "replay", statusCode: 200, response: { body: { status: "success" } } });
    expect(await transferOwnershipAction(idle, form({ ...transfer, idempotency_key: KEY }))).toEqual({ status: "success" });
    expect(rpcNames()).toEqual([]);
  });
});

describe("actions sensibles : limitation de débit", () => {
  it("révoquer / retirer : jeton « sensitive » pris pour (organisation, utilisateur) avant toute lecture base", async () => {
    await removeMemberAction(idle, form({ member_id: MEMBER, organization_id: ORG, uiLocale: "fr" }));
    await revokeInvitationAction(idle, form({ invitation_id: INVITATION, organization_id: ORG, uiLocale: "fr" }));
    expect(takeToken).toHaveBeenNthCalledWith(1, { organizationId: ORG, userId: ME, scope: "sensitive" });
    expect(takeToken).toHaveBeenNthCalledWith(2, { organizationId: ORG, userId: ME, scope: "sensitive" });
  });

  it("limite atteinte -> rate_limited, aucune écriture", async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 6 });
    expect(await removeMemberAction(idle, form({ member_id: MEMBER, organization_id: ORG, uiLocale: "fr" }))).toEqual({
      status: "error",
      code: "rate_limited",
    });
    expect(await inviteMemberAction(idle, form({ ...invite, idempotency_key: KEY }))).toMatchObject({ code: "rate_limited" });
    expect(rpcNames()).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
  });

  it("backend de limitation en panne -> échec fermé : service_unavailable, aucune écriture", async () => {
    const { ServiceError } = await import("../service/errors");
    takeToken.mockRejectedValue(new ServiceError("service_unavailable"));
    expect(await removeMemberAction(idle, form({ member_id: MEMBER, organization_id: ORG, uiLocale: "fr" }))).toEqual({
      status: "error",
      code: "service_unavailable",
    });
    expect(rpcNames()).toEqual([]);
  });

  it("idempotence optionnelle (retrait) : sans clé, begin n'est jamais appelé", async () => {
    await removeMemberAction(idle, form({ member_id: MEMBER, organization_id: ORG, uiLocale: "fr" }));
    expect(begin).not.toHaveBeenCalled();
  });
});

describe("acceptInvitationAction : couche service (session, limite « sensible », échec générique)", () => {
  const token = "T".repeat(43);
  const accept = () => acceptInvitationAction(idle, form({ token, uiLocale: "fr" }));

  it("succès : jeton haché envoyé à la base, un jeton « sensible » pris (utilisateur sans organisation), redirection vers le tableau de bord", async () => {
    rpc.mockResolvedValue({ data: ORG, error: null });
    await expect(accept()).rejects.toMatchObject({ digest: expect.stringContaining("/fr/dashboard") });
    expect(rpc).toHaveBeenCalledWith("accept_invitation", { p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
    expect(takeToken).toHaveBeenCalledWith({ organizationId: null, userId: expect.any(String), scope: "sensitive" });
    expect(begin).not.toHaveBeenCalled(); // idempotence « none » : le jeton est à usage unique
  });

  it("session absente -> redirection vers la connexion (locale du formulaire), aucun appel base, aucun jeton pris", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(accept()).rejects.toMatchObject({ digest: expect.stringContaining("/fr/login") });
    expect(rpc).not.toHaveBeenCalled();
    expect(takeToken).not.toHaveBeenCalled();
  });

  it("jeton mal formé -> invitation_invalid avant toute authentification", async () => {
    expect(await acceptInvitationAction(idle, form({ token: "court", uiLocale: "fr" }))).toStrictEqual({ status: "error", code: "invitation_invalid" });
    expect(getClaims).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["limite atteinte", () => takeToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 })],
    ["limiteur en panne (échec fermé)", () => takeToken.mockRejectedValue(new Error("down"))],
    ["erreur de la base", () => rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "invitation_invalid" } })],
    ["réponse qui n'est pas un uuid", () => rpc.mockResolvedValue({ data: "pas-un-uuid", error: null })],
  ])("%s -> TOUJOURS le même code générique invitation_invalid", async (_label, arrange) => {
    arrange();
    expect(await accept()).toStrictEqual({ status: "error", code: "invitation_invalid" });
  });
});

describe("contrat des actions réelles : aucune ne conserve un état porteur de secret", () => {
  it("members.invite déclare invitePath comme secret ET refuse de conserver la réponse", async () => {
    const { listRegisteredActions } = await import("../service/with-service");
    const invite = listRegisteredActions().find((a) => a.name === "members.invite");
    expect(invite).toMatchObject({ storeResponse: false, secretFields: ["invitePath"] });
  });

  it("toute action enregistrée qui conserve sa réponse (storeResponse: true) n'a aucun champ secret", async () => {
    const { listRegisteredActions } = await import("../service/with-service");
    const actions = listRegisteredActions();
    expect(actions.map((a) => a.name)).toEqual(expect.arrayContaining(["members.invite", "members.transfer_ownership", "members.accept_invitation"]));
    for (const action of actions) {
      if (action.storeResponse === true) expect(action.secretFields, action.name).toEqual([]);
    }
    // Chaque action qui peut produire invitePath est sans réponse conservée.
    expect(actions.filter((a) => a.secretFields.includes("invitePath")).every((a) => a.storeResponse !== true)).toBe(true);
  });

  it("accept_invitation passe par le pipeline avec idempotence « none » (storeResponse sans objet)", async () => {
    const { listRegisteredActions } = await import("../service/with-service");
    expect(listRegisteredActions().find((a) => a.name === "members.accept_invitation")?.storeResponse).toBeNull();
  });
});
