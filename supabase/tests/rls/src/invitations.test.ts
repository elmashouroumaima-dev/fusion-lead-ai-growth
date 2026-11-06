import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  apiAsUser,
  cleanupTestUsers,
  createTestUser,
  isDenied,
  rowsOf,
  select,
} from "./harness";

/**
 * Invitations, acceptation, transfert de propriété par la Data API (J10) — ADR 014, menace B6.
 * Les fonctions sont appelées comme le ferait un client (POST /rest/v1/rpc/<nom>) avec un JWT signé
 * pour de VRAIS comptes créés par le test. Tests ré-exécutables : comptes, e-mails et jetons uniques par
 * exécution ; assertions bornées aux identifiants créés ; nettoyage best-effort en fin de fichier.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Account = { id: string; email: string };
const createdUsers: string[] = [];

/** Jeton aléatoire factice + son sha256 : la base ne voit jamais que le hash. */
function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

const rpc = <T = unknown>(user: Account, fn: string, args: Record<string, unknown>) =>
  apiAsUser<T>(user.id, "POST", `rpc/${fn}`, args);

async function newAccount(label: string, confirmed = true): Promise<Account> {
  const account = await createTestUser(label, { confirmed });
  createdUsers.push(account.id);
  return account;
}

async function newOrg(owner: Account, label: string): Promise<string> {
  const result = await rpc<string>(owner, "create_organization", {
    p_name: `Inv ${label} ${run}`,
    p_creation_key: `inv-${label}-${run}`,
  });
  expect(result.status).toBe(200);
  return result.body;
}

async function invite(
  actor: Account,
  org: string,
  email: string,
  role: string,
  hash = newToken().hash,
) {
  return { hash, result: await rpc<string>(actor, "create_invitation", { p_org: org, p_email: email, p_role: role, p_token_hash: hash }) };
}

const invitationsOf = async (user: Account, org: string) =>
  rowsOf<Record<string, unknown>>(
    await apiAsUser(
      user.id,
      "GET",
      `invitations?select=id,email_normalized,role,expires_at,accepted_at,revoked_at,organization_id&organization_id=eq.${org}&order=created_at`,
    ),
  );

const membershipOf = async (user: Account, org: string) =>
  rowsOf<{ user_id: string; role: string; status: string }>(
    await apiAsUser(
      user.id,
      "GET",
      `organization_members?select=user_id,role,status&organization_id=eq.${org}&user_id=eq.${user.id}`,
    ),
  );

let owner: Account;
let admin: Account;
let sales: Account;
let outsider: Account;
let otherOwner: Account;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  [owner, admin, sales, outsider, otherOwner] = await Promise.all([
    newAccount("inv-owner"),
    newAccount("inv-admin"),
    newAccount("inv-sales"),
    newAccount("inv-outsider"),
    newAccount("inv-other-owner"),
  ]);
  orgA = await newOrg(owner, "alpha");
  orgB = await newOrg(otherOwner, "beta");
  // admin et sales entrent par invitation (chemin réel), puis l'owner ajuste le rôle de l'admin (UPDATE J7).
  for (const [user, role] of [
    [admin, "company_admin"],
    [sales, "sales_agent"],
  ] as const) {
    const { hash, result } = await invite(owner, orgA, user.email, role);
    expect(result.status).toBe(200);
    expect((await rpc<string>(user, "accept_invitation", { p_token_hash: hash })).body).toBe(orgA);
  }
});

afterAll(async () => {
  await cleanupTestUsers(createdUsers);
});

describe("accès aux fonctions (privilèges)", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["create_invitation", { p_org: "20000000-0000-4000-8000-000000000001", p_email: "a@b.cd", p_role: "analyst", p_token_hash: "0".repeat(64) }],
    ["revoke_invitation", { p_org: "20000000-0000-4000-8000-000000000001", p_invitation_id: "20000000-0000-4000-8000-000000000002" }],
    ["accept_invitation", { p_token_hash: "0".repeat(64) }],
    ["transfer_ownership", { p_org: "20000000-0000-4000-8000-000000000001", p_new_owner: "20000000-0000-4000-8000-000000000002" }],
  ];

  it.each(calls)("%s : anon refusé", async (fn, args) => {
    const result = await api("anon", "POST", `rpc/${fn}`, args);
    expect(isDenied(result)).toBe(true);
    expect(result.code).toBe("42501");
  });

  it.each(calls)("%s : service_role refusé", async (fn, args) => {
    const result = await api("service", "POST", `rpc/${fn}`, args);
    expect(isDenied(result)).toBe(true);
  });

  it.each(["create_invitation", "revoke_invitation", "accept_invitation", "transfer_ownership"])(
    "private.%s n'est pas exposée par la Data API",
    async (fn) => {
      const result = await api("anon", "POST", `rpc/private.${fn}`, {});
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).not.toBe(200);
    },
  );
});

describe("invitations : création, visibilité, jeton", () => {
  it("l'owner invite : e-mail normalisé, expiration à 7 jours, hash seul stocké", async () => {
    const email = `  New.Person-${run}@Seed.Test `;
    const { hash, result } = await invite(owner, orgA, email, "analyst");
    expect(result.status).toBe(200);
    const rows = await invitationsOf(owner, orgA);
    const row = rows.find((r) => r.id === result.body);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      email_normalized: `new.person-${run}@seed.test`,
      role: "analyst",
      accepted_at: null,
      revoked_at: null,
      organization_id: orgA,
    });
    const days = (Date.parse(String(row?.expires_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // La base ne contient que le hash (lu par le serveur de test via service_role).
    const stored = rowsOf<{ token_hash: string }>(
      await select("service", `invitations?select=token_hash&id=eq.${result.body}`),
    );
    expect(stored).toEqual([{ token_hash: hash }]);
  });

  it("owner et admin voient les invitations ; sales et outsider non ; l'owner d'une autre entreprise non", async () => {
    expect((await invitationsOf(owner, orgA)).length).toBeGreaterThan(0);
    expect((await invitationsOf(admin, orgA)).length).toBeGreaterThan(0);
    expect(await invitationsOf(sales, orgA)).toEqual([]);
    expect(await invitationsOf(outsider, orgA)).toEqual([]);
    expect(await invitationsOf(otherOwner, orgA)).toEqual([]);
  });

  it("token_hash n'est lisible par aucun client authentifié", async () => {
    for (const user of [owner, admin]) {
      const direct = await apiAsUser(user.id, "GET", `invitations?select=token_hash&organization_id=eq.${orgA}`);
      expect(direct.status).toBe(403);
      expect(direct.code).toBe("42501");
      const star = await apiAsUser(user.id, "GET", `invitations?select=*&organization_id=eq.${orgA}`);
      expect(star.status).toBe(403);
    }
  });

  it("aucune écriture directe sur la table (INSERT / PATCH / DELETE)", async () => {
    const insert = await apiAsUser(owner.id, "POST", "invitations", {
      organization_id: orgA,
      email_normalized: `direct-${run}@seed.test`,
      role: "analyst",
      token_hash: newToken().hash,
      expires_at: "2099-01-01T00:00:00Z",
    });
    expect(isDenied(insert)).toBe(true);
    const patch = await apiAsUser(owner.id, "PATCH", `invitations?organization_id=eq.${orgA}`, {
      revoked_at: new Date().toISOString(),
    });
    expect(isDenied(patch)).toBe(true);
    const del = await apiAsUser(owner.id, "DELETE", `invitations?organization_id=eq.${orgA}`);
    expect(isDenied(del)).toBe(true);
    expect((await invitationsOf(owner, orgA)).every((r) => r.revoked_at === null || r.accepted_at === null)).toBe(true);
  });

  it("anon ne lit rien", async () => {
    const result = await api("anon", "GET", "invitations?select=id");
    expect(isDenied(result)).toBe(true);
  });

  it.each([
    ["admin", () => admin],
    ["sales", () => sales],
    ["outsider", () => outsider],
    ["owner d'une autre entreprise", () => otherOwner],
  ] as const)("%s : création refusée (forbidden)", async (_label, who) => {
    const actor = who();
    const attempt = await invite(actor, orgA, `x-${run}@seed.test`, actor === admin ? "company_owner" : "analyst");
    expect(attempt.result.status).toBe(403);
    expect(attempt.result.code).toBe("42501");
    expect((attempt.result.body as unknown as { message: string }).message).toBe("forbidden");
  });

  it("un admin invite un rôle non-owner mais jamais company_owner", async () => {
    const ok = await invite(admin, orgA, `by-admin-${run}@seed.test`, "marketing_manager");
    expect(ok.result.status).toBe(200);
    const denied = await invite(admin, orgA, `by-admin-owner-${run}@seed.test`, "company_owner");
    expect(denied.result.status).toBe(403);
    expect((denied.result.body as unknown as { message: string }).message).toBe("forbidden");
  });

  it("l'e-mail d'un membre actif est refusé (already_member)", async () => {
    const result = await invite(owner, orgA, sales.email.toUpperCase(), "analyst");
    expect(result.result.status).toBe(400);
    expect(result.result.code).toBe("P0001");
    expect((result.result.body as unknown as { message: string }).message).toBe("already_member");
  });

  it("entrées invalides : validation_failed (22023)", async () => {
    const badEmail = await invite(owner, orgA, "pas-un-email", "analyst");
    expect(badEmail.result.code).toBe("22023");
    const badHash = await rpc(owner, "create_invitation", {
      p_org: orgA,
      p_email: `ok-${run}@seed.test`,
      p_role: "analyst",
      p_token_hash: "ABC",
    });
    expect((badHash.body as { code?: string }).code).toBe("22023");
  });

  it("ré-invitation : l'ancienne est révoquée, l'ancien jeton ne marche plus, le nouveau marche", async () => {
    const invitee = await newAccount("reinvite");
    const first = await invite(owner, orgA, invitee.email, "sales_agent");
    const second = await invite(owner, orgA, invitee.email, "marketing_manager");
    expect(first.result.status).toBe(200);
    expect(second.result.status).toBe(200);
    const rows = (await invitationsOf(owner, orgA)).filter((r) => r.email_normalized === invitee.email);
    expect(rows.filter((r) => r.revoked_at === null && r.accepted_at === null)).toHaveLength(1);
    const old = await rpc(invitee, "accept_invitation", { p_token_hash: first.hash });
    expect(old.status).toBe(400);
    expect((old.body as { message?: string }).message).toBe("invitation_invalid");
    const fresh = await rpc<string>(invitee, "accept_invitation", { p_token_hash: second.hash });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe(orgA);
    expect((await membershipOf(invitee, orgA))[0]).toMatchObject({ role: "marketing_manager", status: "active" });
  });
});

describe("révocation", () => {
  it("l'owner révoque ; une seconde révocation est invitation_invalid ; l'invité ne peut plus accepter", async () => {
    const invitee = await newAccount("revoked");
    const { hash, result } = await invite(owner, orgA, invitee.email, "analyst");
    const revoke = await rpc(owner, "revoke_invitation", { p_org: orgA, p_invitation_id: result.body });
    expect(revoke.status).toBe(204);
    const again = await rpc(owner, "revoke_invitation", { p_org: orgA, p_invitation_id: result.body });
    expect((again.body as { message?: string }).message).toBe("invitation_invalid");
    const accept = await rpc(invitee, "accept_invitation", { p_token_hash: hash });
    expect((accept.body as { message?: string }).message).toBe("invitation_invalid");
  });

  it("sales ne peut pas révoquer ; l'admin ne révoque pas une invitation company_owner", async () => {
    const forOwner = await invite(owner, orgA, `owner-inv-${run}@seed.test`, "company_owner");
    const byAdmin = await rpc(admin, "revoke_invitation", { p_org: orgA, p_invitation_id: forOwner.result.body });
    expect(byAdmin.status).toBe(403);
    const bySales = await rpc(sales, "revoke_invitation", { p_org: orgA, p_invitation_id: forOwner.result.body });
    expect(bySales.status).toBe(403);
    const byOwner = await rpc(owner, "revoke_invitation", { p_org: orgA, p_invitation_id: forOwner.result.body });
    expect(byOwner.status).toBe(204);
  });

  it("le propriétaire d'une autre entreprise ne révoque pas (organisation falsifiée)", async () => {
    const mine = await invite(owner, orgA, `mine-${run}@seed.test`, "analyst");
    const cross = await rpc(otherOwner, "revoke_invitation", { p_org: orgA, p_invitation_id: mine.result.body });
    expect(cross.status).toBe(403);
    const swapped = await rpc(otherOwner, "revoke_invitation", { p_org: orgB, p_invitation_id: mine.result.body });
    expect((swapped.body as { message?: string }).message).toBe("invitation_invalid");
    const row = (await invitationsOf(owner, orgA)).find((r) => r.id === mine.result.body);
    expect(row?.revoked_at).toBeNull();
  });
});

describe("acceptation", () => {
  it("l'invité (e-mail confirmé identique) devient membre avec le rôle invité ; usage unique", async () => {
    const invitee = await newAccount("accept");
    const { hash } = await invite(owner, orgA, invitee.email, "analyst");
    const accept = await rpc<string>(invitee, "accept_invitation", { p_token_hash: hash });
    expect(accept.status).toBe(200);
    expect(accept.body).toBe(orgA);
    expect(await membershipOf(invitee, orgA)).toEqual([
      { user_id: invitee.id, role: "analyst", status: "active" },
    ]);
    const replay = await rpc(invitee, "accept_invitation", { p_token_hash: hash });
    expect((replay.body as { message?: string }).message).toBe("invitation_invalid");
    const row = (await invitationsOf(owner, orgA)).find((r) => r.email_normalized === invitee.email);
    expect(row?.accepted_at).not.toBeNull();
  });

  it("toutes les causes d'échec renvoient EXACTEMENT la même réponse", async () => {
    const target = await newAccount("target");
    const wrong = await newAccount("wrong");
    const expired = await newAccount("expired");
    const revokedUser = await newAccount("revoked2");
    const { hash: pendingHash } = await invite(owner, orgA, target.email, "analyst");
    const { hash: expiredHash, result: expiredInv } = await invite(owner, orgA, expired.email, "analyst");
    const { hash: revokedHash, result: revokedInv } = await invite(owner, orgA, revokedUser.email, "analyst");
    // Simule l'expiration (serveur de test, service_role).
    const patch = await api("service", "PATCH", `invitations?id=eq.${expiredInv.body}`, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(patch.status).toBe(200);
    await rpc(owner, "revoke_invitation", { p_org: orgA, p_invitation_id: revokedInv.body });

    const responses = await Promise.all([
      rpc(target, "accept_invitation", { p_token_hash: newToken().hash }), // jeton inconnu
      rpc(wrong, "accept_invitation", { p_token_hash: pendingHash }), // mauvais compte (e-mail différent)
      rpc(expired, "accept_invitation", { p_token_hash: expiredHash }), // expirée
      rpc(revokedUser, "accept_invitation", { p_token_hash: revokedHash }), // révoquée
      rpc(target, "accept_invitation", { p_token_hash: "pas-un-hash" }), // format invalide
    ]);
    const shapes = responses.map((r) => JSON.stringify({ status: r.status, body: r.body }));
    expect(new Set(shapes).size).toBe(1);
    expect(responses[0]?.status).toBe(400);
    expect(responses[0]?.body).toMatchObject({ code: "P0001", message: "invitation_invalid" });
    // Rien n'a changé : l'invitation en attente est toujours valable pour son vrai destinataire.
    expect(await membershipOf(wrong, orgA)).toEqual([]);
    const ok = await rpc<string>(target, "accept_invitation", { p_token_hash: pendingHash });
    expect(ok.status).toBe(200);
  });

  it("e-mail non confirmé : refusé comme les autres échecs", async () => {
    // GoTrue (local) : compte créé SANS confirmation d'e-mail.
    const unconfirmed = await newAccount("unconfirmed", false);
    const { hash } = await invite(owner, orgA, unconfirmed.email, "analyst");
    const result = await rpc(unconfirmed, "accept_invitation", { p_token_hash: hash });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "P0001", message: "invitation_invalid" });
  });

  it("un membre retiré est ré-activé avec le nouveau rôle ; un suspendu est refusé", async () => {
    const returning = await newAccount("returning");
    const first = await invite(owner, orgA, returning.email, "sales_agent");
    await rpc(returning, "accept_invitation", { p_token_hash: first.hash });
    // L'owner retire le membre (UPDATE status par le client, GRANT J7).
    const remove = await apiAsUser(
      owner.id,
      "PATCH",
      `organization_members?organization_id=eq.${orgA}&user_id=eq.${returning.id}`,
      { status: "removed" },
    );
    expect(remove.status).toBe(200);
    expect((await membershipOf(returning, orgA))[0]?.status).toBe("removed");
    expect(rowsOf(await apiAsUser(returning.id, "GET", `organizations?select=id&id=eq.${orgA}`))).toEqual([]); // plus d'accès
    const second = await invite(owner, orgA, returning.email, "marketing_manager");
    expect(second.result.status).toBe(200);
    const back = await rpc<string>(returning, "accept_invitation", { p_token_hash: second.hash });
    expect(back.status).toBe(200);
    expect(await membershipOf(returning, orgA)).toEqual([
      { user_id: returning.id, role: "marketing_manager", status: "active" },
    ]);

    // Suspension : l'invitation ne la lève pas.
    const suspend = await apiAsUser(
      owner.id,
      "PATCH",
      `organization_members?organization_id=eq.${orgA}&user_id=eq.${returning.id}`,
      { status: "suspended" },
    );
    expect(suspend.status).toBe(200);
    const third = await invite(owner, orgA, returning.email, "analyst");
    expect(third.result.status).toBe(200);
    const refused = await rpc(returning, "accept_invitation", { p_token_hash: third.hash });
    expect(refused.body).toMatchObject({ code: "P0001", message: "invitation_invalid" });
    const states = rowsOf<{ status: string; role: string }>(
      await select("service", `organization_members?select=status,role&organization_id=eq.${orgA}&user_id=eq.${returning.id}`),
    );
    expect(states).toEqual([{ status: "suspended", role: "marketing_manager" }]);
  });

  it("acceptations simultanées du même jeton : une seule réussit", async () => {
    const racer = await newAccount("racer");
    const { hash } = await invite(owner, orgA, racer.email, "analyst");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc<string>(racer, "accept_invitation", { p_token_hash: hash })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const failures = results.filter((r) => r.status !== 200);
    expect(failures).toHaveLength(7);
    for (const failure of failures) {
      expect(failure.body).toMatchObject({ code: "P0001", message: "invitation_invalid" });
    }
    const members = rowsOf(
      await select("service", `organization_members?select=id&organization_id=eq.${orgA}&user_id=eq.${racer.id}`),
    );
    expect(members).toHaveLength(1);
  });

  it("acceptations simultanées pour un membre RETIRÉ (ré-activation) : une seule réussit", async () => {
    const racer = await newAccount("racer-removed");
    const first = await invite(owner, orgA, racer.email, "analyst");
    await rpc(racer, "accept_invitation", { p_token_hash: first.hash });
    await apiAsUser(owner.id, "PATCH", `organization_members?organization_id=eq.${orgA}&user_id=eq.${racer.id}`, {
      status: "removed",
    });
    const second = await invite(owner, orgA, racer.email, "sales_agent");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc<string>(racer, "accept_invitation", { p_token_hash: second.hash })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const failure of results.filter((r) => r.status !== 200)) {
      expect(failure.body).toMatchObject({ code: "P0001", message: "invitation_invalid" });
    }
    expect(await membershipOf(racer, orgA)).toEqual([
      { user_id: racer.id, role: "sales_agent", status: "active" },
    ]);
  });

  it("un compte ne peut pas accepter l'invitation d'un autre même en rejouant le hash de l'organisation", async () => {
    const victim = await newAccount("victim");
    const attacker = await newAccount("attacker");
    const { hash } = await invite(owner, orgA, victim.email, "company_owner");
    const stolen = await rpc(attacker, "accept_invitation", { p_token_hash: hash });
    expect(stolen.body).toMatchObject({ code: "P0001", message: "invitation_invalid" });
    expect(await membershipOf(attacker, orgA)).toEqual([]);
    const legit = await rpc<string>(victim, "accept_invitation", { p_token_hash: hash });
    expect(legit.status).toBe(200);
    expect((await membershipOf(victim, orgA))[0]?.role).toBe("company_owner");
  });
});

describe("transfert de propriété", () => {
  it("un admin ne peut pas transférer ; l'owner ne cible ni un non-membre ni un autre tenant ni lui-même", async () => {
    const asAdmin = await rpc(admin, "transfer_ownership", { p_org: orgA, p_new_owner: admin.id });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body).toMatchObject({ code: "42501", message: "forbidden" });
    for (const target of [outsider.id, otherOwner.id, owner.id]) {
      const result = await rpc(owner, "transfer_ownership", { p_org: orgA, p_new_owner: target });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: "P0001", message: "invalid_target" });
    }
    const crossTenant = await rpc(owner, "transfer_ownership", { p_org: orgB, p_new_owner: admin.id });
    expect(crossTenant.status).toBe(403);
  });

  it("l'owner transfère à un membre actif : un seul owner actif, l'ancien devient admin", async () => {
    const heir = await newAccount("heir");
    const boss = await newAccount("boss");
    const org = await newOrg(boss, "transfer");
    const { hash } = await invite(boss, org, heir.email, "sales_agent");
    await rpc(heir, "accept_invitation", { p_token_hash: hash });

    const transfer = await rpc(boss, "transfer_ownership", { p_org: org, p_new_owner: heir.id });
    expect(transfer.status).toBe(204);
    const roles = rowsOf<{ user_id: string; role: string; status: string }>(
      await select("service", `organization_members?select=user_id,role,status&organization_id=eq.${org}`),
    );
    expect(roles.find((m) => m.user_id === heir.id)).toMatchObject({ role: "company_owner", status: "active" });
    expect(roles.find((m) => m.user_id === boss.id)).toMatchObject({ role: "company_admin", status: "active" });
    expect(roles.filter((m) => m.role === "company_owner" && m.status === "active")).toHaveLength(1);

    // L'ancien owner (admin) ne peut plus transférer ; le dernier owner reste protégé.
    const again = await rpc(boss, "transfer_ownership", { p_org: org, p_new_owner: heir.id });
    expect(again.status).toBe(403);
    const demote = await apiAsUser(
      heir.id,
      "PATCH",
      `organization_members?organization_id=eq.${org}&user_id=eq.${heir.id}`,
      { role: "company_admin" },
    );
    expect(demote.status).toBeGreaterThanOrEqual(400);
    expect(
      rowsOf<{ role: string }>(
        await select("service", `organization_members?select=role&organization_id=eq.${org}&user_id=eq.${heir.id}`),
      )[0]?.role,
    ).toBe("company_owner");
  });
});

describe("acceptation : l'inviteur est revérifié au moment de l'acceptation", () => {
  const generic = { code: "P0001", message: "invitation_invalid" };

  /** Crée un admin d'une entreprise fraîche, lui fait inviter `invitee`, puis laisse le test dégrader l'inviteur. */
  async function setup(label: string, inviteeRole: string, inviterRole = "company_admin") {
    const boss = await newAccount(`rc-boss-${label}`);
    const inviter = await newAccount(`rc-inv-${label}`);
    const invitee = await newAccount(`rc-guest-${label}`);
    const org = await newOrg(boss, `rc-${label}`);
    const join = await invite(boss, org, inviter.email, inviterRole);
    expect((await rpc(inviter, "accept_invitation", { p_token_hash: join.hash })).status).toBe(200);
    const { hash, result } = await invite(inviter, org, invitee.email, inviteeRole);
    expect(result.status).toBe(200);
    return { boss, inviter, invitee, org, hash, invitationId: result.body };
  }

  const patchMember = (boss: Account, org: string, userId: string, patch: Record<string, unknown>) =>
    apiAsUser(boss.id, "PATCH", `organization_members?organization_id=eq.${org}&user_id=eq.${userId}`, patch);

  async function expectRefused(ctx: { invitee: Account; org: string; hash: string }) {
    const result = await rpc(ctx.invitee, "accept_invitation", { p_token_hash: ctx.hash });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject(generic);
    expect(await membershipOf(ctx.invitee, ctx.org)).toEqual([]);
    return result;
  }

  it.each([
    ["removed", { status: "removed" }],
    ["suspended", { status: "suspended" }],
    ["marketing", { role: "marketing_manager" }],
    ["sales", { role: "sales_agent" }],
    ["analyst", { role: "analyst" }],
  ])("inviteur dégradé (%s) : invitation_invalid générique, aucune adhésion", async (label, patch) => {
    const ctx = await setup(`p-${label}`, "analyst");
    expect((await patchMember(ctx.boss, ctx.org, ctx.inviter.id, patch)).status).toBe(200);
    await expectRefused(ctx);
  });

  it("ligne d'adhésion de l'inviteur supprimée, ou invited_by NULL : même réponse générique", async () => {
    const deleted = await setup("del", "analyst");
    expect((await api("service", "DELETE", `organization_members?organization_id=eq.${deleted.org}&user_id=eq.${deleted.inviter.id}`)).status).toBe(200);
    const first = await expectRefused(deleted);

    const nulled = await setup("nul", "analyst");
    expect((await api("service", "PATCH", `invitations?id=eq.${nulled.invitationId}`, { invited_by: null })).status).toBe(200);
    const second = await expectRefused(nulled);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });

  it("invitation company_owner dont l'inviteur (co-owner) a été rétrogradé admin : refusée", async () => {
    const ctx = await setup("own", "company_owner", "company_owner");
    expect((await patchMember(ctx.boss, ctx.org, ctx.inviter.id, { role: "company_admin" })).status).toBe(200);
    await expectRefused(ctx);
  });

  it("contrôles positifs : inviteur admin inchangé => accepté ; owner invitant un owner => accepté", async () => {
    const admin1 = await setup("pos1", "analyst");
    const ok1 = await rpc<string>(admin1.invitee, "accept_invitation", { p_token_hash: admin1.hash });
    expect(ok1.status).toBe(200);
    expect((await membershipOf(admin1.invitee, admin1.org))[0]).toMatchObject({ role: "analyst", status: "active" });

    const owner2 = await setup("pos2", "company_owner", "company_owner");
    const ok2 = await rpc<string>(owner2.invitee, "accept_invitation", { p_token_hash: owner2.hash });
    expect(ok2.status).toBe(200);
    expect((await membershipOf(owner2.invitee, owner2.org))[0]).toMatchObject({ role: "company_owner", status: "active" });
  });
});

describe("transfer_ownership : concurrence avec des mises à jour directes", () => {
  it("12 tours : ni interblocage (40P01), ni 5xx, jamais zéro owner actif", async () => {
    const boss = await newAccount("cc-boss");
    const heir = await newAccount("cc-heir");
    const org = await newOrg(boss, "concurrency");
    const join = await invite(boss, org, heir.email, "sales_agent");
    expect((await rpc(heir, "accept_invitation", { p_token_hash: join.hash })).status).toBe(200);

    const where = (id: string) => `organization_members?organization_id=eq.${org}&user_id=eq.${id}`;
    const seen: { status: number; code: string | undefined }[] = [];
    const watch = <T extends { status: number; code: string | undefined }>(r: T): T => {
      seen.push({ status: r.status, code: r.code });
      return r;
    };

    for (let round = 0; round < 12; round += 1) {
      // État de départ : boss owner actif, heir sales_agent actif (restauré par le serveur de test).
      await api("service", "PATCH", where(boss.id), { role: "company_owner", status: "active" });
      await api("service", "PATCH", where(heir.id), { role: "sales_agent", status: "active" });

      await Promise.all([
        rpc(boss, "transfer_ownership", { p_org: org, p_new_owner: heir.id }).then(watch),
        apiAsUser(boss.id, "PATCH", where(boss.id), { role: "company_admin" }).then(watch),
        apiAsUser(boss.id, "PATCH", where(heir.id), { role: "company_owner" }).then(watch),
        apiAsUser(boss.id, "PATCH", where(heir.id), { status: "removed" }).then(watch),
        rpc(boss, "transfer_ownership", { p_org: org, p_new_owner: heir.id }).then(watch),
        apiAsUser(heir.id, "PATCH", where(boss.id), { status: "suspended" }).then(watch),
      ]);

      const members = rowsOf<{ role: string; status: string }>(
        await select("service", `organization_members?select=role,status&organization_id=eq.${org}`),
      );
      expect(members.filter((m) => m.role === "company_owner" && m.status === "active").length).toBeGreaterThanOrEqual(1);
    }
    expect(seen.filter((r) => r.code === "40P01")).toEqual([]);
    expect(seen.filter((r) => r.status >= 500)).toEqual([]);
  }, 120_000);
});

describe("hygiène de l'e-mail (RPC directe et CHECK de table)", () => {
  const bad: [string, string][] = [
    ["U+202E interne", "a\u202Eb@seed.test"],
    ["U+202E final", "x@seed.test\u202E"],
    ["U+200B", "a\u200Bb@seed.test"],
    ["U+0085", "a\u0085b@seed.test"],
    ["U+00A0", "a\u00A0b@seed.test"],
    ["U+00A0 en t\u00EAte", "\u00A0x@seed.test"],
    ["pleine chasse majuscule", "\uFF21bc@seed.test"],
    ["pleine chasse minuscule", "\uFF41bc@seed.test"],
    ["arobase pleine chasse", "abc＠seed.test"],
    ["domaine IDN", "user@b\u00FCcher.test"],
    ["signe Kelvin", "\u212Ax@seed.test"],
    ["tabulation", "a\tb@seed.test"],
    ["tabulation finale", "x@seed.test\t"],
    ["saut de ligne", "a\nb@seed.test"],
    ["CRLF final", "x@seed.test\r\n"],
    ["255 caract\u00E8res", `${"a".repeat(250)}@b.cd`],
  ];

  it.each(bad)("RPC create_invitation : %s => 22023 validation_failed, rien de stocké", async (_label, email) => {
    const before = (await invitationsOf(owner, orgA)).length;
    const result = await rpc(owner, "create_invitation", {
      p_org: orgA,
      p_email: email,
      p_role: "analyst",
      p_token_hash: newToken().hash,
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "22023", message: "validation_failed" });
    expect(await invitationsOf(owner, orgA)).toHaveLength(before);
  });

  it.each(bad.filter(([label]) => label !== "U+00A0 en tête"))(
    "CHECK de table (insertion service) : %s => 23514, rien de stocké",
    async (_label, email) => {
      const before = rowsOf(await select("service", `invitations?select=id&organization_id=eq.${orgA}`)).length;
      const result = await api("service", "POST", "invitations", {
        organization_id: orgA,
        email_normalized: email,
        role: "analyst",
        token_hash: newToken().hash,
        expires_at: "2099-01-01T00:00:00Z",
      });
      expect(result.status).toBe(400);
      expect(result.code).toBe("23514");
      expect(rowsOf(await select("service", `invitations?select=id&organization_id=eq.${orgA}`))).toHaveLength(before);
    },
  );

  it("majuscules normalisées, +tag conservé, 254 caractères acceptés", async () => {
    const upper = await invite(owner, orgA, `Hy.Upper-${run}@SEED.Test`, "analyst");
    const plus = await invite(owner, orgA, `hy+tag-${run}@seed.test`, "analyst");
    const longEmail = `${"l".repeat(249 - run.length)}${run}@b.cd`;
    expect(longEmail).toHaveLength(254);
    const long = await invite(owner, orgA, longEmail, "analyst");
    for (const r of [upper, plus, long]) expect(r.result.status).toBe(200);
    const rows = await invitationsOf(owner, orgA);
    const emailOf = (id: unknown) => rows.find((r) => r.id === id)?.email_normalized;
    expect(emailOf(upper.result.body)).toBe(`hy.upper-${run}@seed.test`);
    expect(emailOf(plus.result.body)).toBe(`hy+tag-${run}@seed.test`);
    expect(emailOf(long.result.body)).toBe(longEmail);
  });
});
