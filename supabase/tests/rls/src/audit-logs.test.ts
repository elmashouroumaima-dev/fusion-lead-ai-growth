import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  apiAsUser,
  cleanupTestUsers,
  createTestUser,
  isDenied,
  ORG,
  rowsOf,
  select,
  USER,
} from "./harness";

/**
 * Journal d'audit (J12) par la Data API : lecture réservée aux owner/admin ACTIFS de l'entreprise,
 * aucune écriture possible par l'API (INSERT / PATCH / DELETE refusés à tous), lignes écrites par les
 * triggers avec l'acteur, le request_id de l'en-tête x-request-id et sans aucun secret.
 * Tests ré-exécutables : comptes, organisations, e-mails, jetons et request_id uniques par exécution ;
 * assertions bornées aux identifiants créés.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface AuditRow {
  id: string;
  organization_id: string;
  actor_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  request_id: string | null;
}

type Account = { id: string; email: string };
const createdUsers: string[] = [];

async function newAccount(label: string): Promise<Account> {
  const account = await createTestUser(label);
  createdUsers.push(account.id);
  return account;
}

const rid = (label: string) => `req-${label}-${run}`;
const withRid = (label: string) => ({ "x-request-id": rid(label) });

const rpc = <T = unknown>(
  user: Account,
  fn: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) => apiAsUser<T>(user.id, "POST", `rpc/${fn}`, args, {}, headers);

const auditOf = async (userId: string, org: string, extra = ""): Promise<AuditRow[]> =>
  rowsOf<AuditRow>(
    await apiAsUser(
      userId,
      "GET",
      `audit_logs?select=*&organization_id=eq.${org}${extra}&order=created_at,id`,
    ),
  );

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

let owner: Account;
let member: Account;
let outsider: Account;
let otherOwner: Account;
let orgA: string;
let orgB: string;
let inviteHash: string;
let inviteEmail: string;
let inviteId: string;
let memberRowId: string;

beforeAll(async () => {
  [owner, member, outsider, otherOwner] = await Promise.all([
    newAccount("aud-owner"),
    newAccount("aud-member"),
    newAccount("aud-outsider"),
    newAccount("aud-other"),
  ]);

  const created = await rpc<string>(
    owner,
    "create_organization",
    { p_name: `Aud A ${run}`, p_creation_key: `aud-a-${run}` },
    withRid("create"),
  );
  expect(created.status).toBe(200);
  orgA = created.body;
  const createdB = await rpc<string>(otherOwner, "create_organization", {
    p_name: `Aud B ${run}`,
    p_creation_key: `aud-b-${run}`,
  });
  expect(createdB.status).toBe(200);
  orgB = createdB.body;

  // Invitation (chemin réel) puis acceptation par le membre.
  const token = newToken();
  inviteHash = token.hash;
  inviteEmail = member.email;
  const invited = await rpc<string>(
    owner,
    "create_invitation",
    { p_org: orgA, p_email: inviteEmail, p_role: "sales_agent", p_token_hash: inviteHash },
    withRid("invite"),
  );
  expect(invited.status).toBe(200);
  inviteId = invited.body;
  const accepted = await rpc<string>(member, "accept_invitation", { p_token_hash: inviteHash }, withRid("accept"));
  expect(accepted.status).toBe(200);
  const rows = rowsOf<{ id: string }>(
    await apiAsUser(
      owner.id,
      "GET",
      `organization_members?select=id&organization_id=eq.${orgA}&user_id=eq.${member.id}`,
    ),
  );
  memberRowId = rows[0]!.id;
});

afterAll(async () => {
  await cleanupTestUsers(createdUsers);
});

describe("lecture : owner et admin actifs seulement", () => {
  it("l'owner lit le journal de son entreprise", async () => {
    const rows = await auditOf(owner.id, orgA);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.organization_id === orgA)).toBe(true);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["organization.created", "member.joined", "invitation.created", "invitation.accepted"]),
    );
  });

  it("l'admin du seed lit le journal d'Alpha, jamais celui de Beta", async () => {
    const alpha = await auditOf(USER.alphaAdmin, ORG.alpha);
    expect(alpha.length).toBeGreaterThan(0);
    expect(alpha.every((r) => r.organization_id === ORG.alpha)).toBe(true);
    expect(await auditOf(USER.alphaAdmin, ORG.beta)).toEqual([]);
  });

  it("l'utilisateur à deux rôles (owner Alpha, sales Beta) ne lit que le journal d'Alpha", async () => {
    const all = rowsOf<AuditRow>(await apiAsUser(USER.shared, "GET", "audit_logs?select=organization_id"));
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.organization_id === ORG.alpha)).toBe(true);
  });

  it.each([
    ["marketing_manager", USER.alphaMarketing],
    ["sales_agent", USER.alphaSales],
    ["analyst", USER.alphaAnalyst],
    ["owner d'une autre entreprise", USER.betaOwner],
    ["analyst d'une autre entreprise", USER.betaAnalyst],
    ["utilisateur sans adhésion", USER.nobody],
  ])("%s : aucune ligne d'Alpha", async (_label, userId) => {
    const result = await apiAsUser(userId, "GET", `audit_logs?select=id&organization_id=eq.${ORG.alpha}`);
    expect(result.status).toBe(200);
    expect(rowsOf(result)).toEqual([]);
  });

  it("le membre (sales_agent) et l'étranger ne lisent rien d'une entreprise créée par le test", async () => {
    expect(await auditOf(member.id, orgA)).toEqual([]);
    expect(await auditOf(outsider.id, orgA)).toEqual([]);
    expect(await auditOf(otherOwner.id, orgA)).toEqual([]);
    expect(await auditOf(owner.id, orgB)).toEqual([]);
  });

  it("le propriétaire de B lit le journal de B, qui ne contient rien d'A", async () => {
    const rows = await auditOf(otherOwner.id, orgB);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.organization_id === orgB)).toBe(true);
  });

  it("anon est refusé (aucun privilège)", async () => {
    const result = await api("anon", "GET", "audit_logs?select=id");
    expect(isDenied(result)).toBe(true);
    expect(result.code).toBe("42501");
  });

  it("service_role peut lire (lecture serveur)", async () => {
    const result = await select<AuditRow>("service", `audit_logs?select=id,organization_id&organization_id=eq.${orgA}`);
    expect(result.status).toBe(200);
    expect(rowsOf(result).length).toBeGreaterThan(0);
  });
});

describe("écriture : aucune par l'API, pour personne", () => {
  const forged = (org: string) => ({
    organization_id: org,
    actor_kind: "user",
    action: "forged.entry",
    entity_type: "forged",
  });

  it.each([
    ["owner", () => owner.id],
    ["membre", () => member.id],
    ["owner du seed", () => USER.shared],
    ["admin du seed", () => USER.alphaAdmin],
  ])("%s : INSERT, PATCH et DELETE refusés", async (_label, who) => {
    const insert = await apiAsUser(who(), "POST", "audit_logs", forged(orgA));
    expect(isDenied(insert)).toBe(true);
    expect(insert.code).toBe("42501");
    const patch = await apiAsUser(who(), "PATCH", `audit_logs?organization_id=eq.${orgA}`, { action: "forged.entry" });
    expect(isDenied(patch)).toBe(true);
    expect(patch.code).toBe("42501");
    const del = await apiAsUser(who(), "DELETE", `audit_logs?organization_id=eq.${orgA}`);
    expect(isDenied(del)).toBe(true);
    expect(del.code).toBe("42501");
  });

  it("service_role : INSERT, PATCH et DELETE refusés", async () => {
    const insert = await api("service", "POST", "audit_logs", forged(orgA));
    expect(isDenied(insert)).toBe(true);
    const patch = await api("service", "PATCH", `audit_logs?organization_id=eq.${orgA}`, { action: "forged.entry" });
    expect(isDenied(patch)).toBe(true);
    const del = await api("service", "DELETE", `audit_logs?organization_id=eq.${orgA}`);
    expect(isDenied(del)).toBe(true);
  });

  it("anon : INSERT, PATCH et DELETE refusés", async () => {
    expect(isDenied(await api("anon", "POST", "audit_logs", forged(orgA)))).toBe(true);
    expect(isDenied(await api("anon", "PATCH", `audit_logs?organization_id=eq.${orgA}`, { action: "forged.entry" }))).toBe(true);
    expect(isDenied(await api("anon", "DELETE", `audit_logs?organization_id=eq.${orgA}`))).toBe(true);
  });

  it("le journal n'a pas bougé après toutes ces tentatives", async () => {
    const rows = await auditOf(owner.id, orgA);
    expect(rows.some((r) => r.action === "forged.entry")).toBe(false);
    expect(rows.every((r) => r.organization_id === orgA)).toBe(true);
  });

  it("la fonction d'audit n'est pas exposée par la Data API", async () => {
    for (const fn of ["audit_write", "private.audit_write", "audit_redact", "mask_email"]) {
      const result = await apiAsUser(owner.id, "POST", `rpc/${fn}`, { p_org: orgA });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).not.toBe(200);
    }
  });
});

describe("lignes écrites par les triggers : acteur, request_id, contenu", () => {
  it("create_organization : request_id de l'en-tête, acteur = créateur, aucune IP", async () => {
    const rows = await auditOf(owner.id, orgA, "&request_id=eq." + rid("create"));
    expect(rows.map((r) => r.action).sort()).toEqual(["member.joined", "organization.created"]);
    for (const row of rows) {
      expect(row.actor_id).toBe(owner.id);
      expect(row.actor_kind).toBe("user");
      expect(row.request_id).toBe(rid("create"));
      expect(row.ip).toBeNull();
    }
    const org = rows.find((r) => r.action === "organization.created")!;
    expect(org.entity_type).toBe("organization");
    expect(org.entity_id).toBe(orgA);
    expect(org.before).toBeNull();
    expect(org.after).toMatchObject({ name: `Aud A ${run}`, status: "active" });
    expect(["ar", "en", "fr"]).toContain(org.after?.locale);
  });

  it("une requête sans en-tête ne porte aucun request_id ; un en-tête invalide non plus", async () => {
    const plain = await rpc<string>(otherOwner, "create_organization", {
      p_name: `Aud C ${run}`,
      p_creation_key: `aud-c-${run}`,
    });
    expect(plain.status).toBe(200);
    const bad = await rpc<string>(
      otherOwner,
      "create_organization",
      { p_name: `Aud D ${run}`, p_creation_key: `aud-d-${run}` },
      { "x-request-id": "bad id with spaces" },
    );
    expect(bad.status).toBe(200);
    for (const org of [plain.body, bad.body]) {
      const rows = await auditOf(otherOwner.id, org);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.request_id === null)).toBe(true);
    }
  });

  it("invitation créée : e-mail masqué, id de l'invitation, jamais le hash ni l'e-mail", async () => {
    const rows = await auditOf(owner.id, orgA, `&action=eq.invitation.created&entity_id=eq.${inviteId}`);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.request_id).toBe(rid("invite"));
    expect(row.actor_id).toBe(owner.id);
    expect(Object.keys(row.after ?? {}).sort()).toEqual(["email_masked", "expires_at", "role"]);
    expect(row.after).toMatchObject({ role: "sales_agent" });
    expect(String(row.after?.email_masked)).toMatch(/^r\*\*\*@seed\.test$/);
    const text = JSON.stringify(row);
    expect(text).not.toContain(inviteHash);
    expect(text).not.toContain(inviteEmail);
    expect(text).not.toContain("token");
  });

  it("invitation acceptée : acteur = l'invité, member.joined avec le même request_id", async () => {
    const rows = await auditOf(owner.id, orgA, "&request_id=eq." + rid("accept"));
    expect(rows.map((r) => r.action).sort()).toEqual(["invitation.accepted", "member.joined"]);
    for (const row of rows) {
      expect(row.actor_id).toBe(member.id);
      expect(row.actor_kind).toBe("user");
    }
    const accepted = rows.find((r) => r.action === "invitation.accepted")!;
    expect(accepted.entity_id).toBe(inviteId);
    expect(accepted.after).toMatchObject({ accepted_by: member.id });
    const joined = rows.find((r) => r.action === "member.joined")!;
    expect(joined.after).toEqual({ user_id: member.id, role: "sales_agent", status: "active" });
  });

  it("PATCH de l'organisation par l'owner : organization.updated avec le request_id, settings jamais journalisés", async () => {
    const patched = await apiAsUser(
      owner.id,
      "PATCH",
      `organizations?id=eq.${orgA}`,
      { name: `Aud A renamed ${run}`, settings: { api_key: "must-not-appear", note: "x" } },
      {},
      withRid("rename"),
    );
    expect(patched.status).toBe(200);
    const rows = await auditOf(owner.id, orgA, "&request_id=eq." + rid("rename"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "organization.updated",
      actor_id: owner.id,
      before: { name: `Aud A ${run}` },
      after: { name: `Aud A renamed ${run}` },
    });
    expect(JSON.stringify(rows[0])).not.toContain("must-not-appear");
  });

  it("PATCH des seuls settings : aucune ligne d'audit", async () => {
    const before = (await auditOf(owner.id, orgA)).length;
    const patched = await apiAsUser(owner.id, "PATCH", `organizations?id=eq.${orgA}`, { settings: { note: "y" } });
    expect(patched.status).toBe(200);
    expect((await auditOf(owner.id, orgA)).length).toBe(before);
  });

  it("changement de rôle puis retrait par l'owner : member.role_changed puis member.deleted", async () => {
    const role = await apiAsUser(
      owner.id,
      "PATCH",
      `organization_members?id=eq.${memberRowId}`,
      { role: "analyst" },
      {},
      withRid("role"),
    );
    expect(role.status).toBe(200);
    const status = await apiAsUser(
      owner.id,
      "PATCH",
      `organization_members?id=eq.${memberRowId}`,
      { status: "suspended" },
      {},
      withRid("suspend"),
    );
    expect(status.status).toBe(200);
    const react = await apiAsUser(owner.id, "PATCH", `organization_members?id=eq.${memberRowId}`, { status: "active" }, {}, withRid("react"));
    expect(react.status).toBe(200);
    const removed = await apiAsUser(owner.id, "PATCH", `organization_members?id=eq.${memberRowId}`, { status: "removed" }, {}, withRid("remove"));
    expect(removed.status).toBe(200);

    const rows = await auditOf(owner.id, orgA, `&entity_id=eq.${memberRowId}&actor_id=eq.${owner.id}`);
    expect(rows.map((r) => r.action)).toEqual([
      "member.role_changed",
      "member.suspended",
      "member.reactivated",
      "member.removed",
    ]);
    expect(rows[0]).toMatchObject({
      request_id: rid("role"),
      before: { user_id: member.id, role: "sales_agent", status: "active" },
      after: { user_id: member.id, role: "analyst", status: "active" },
    });
    expect(rows[3]).toMatchObject({
      request_id: rid("remove"),
      before: { user_id: member.id, role: "analyst", status: "active" },
      after: { user_id: member.id, role: "analyst", status: "removed" },
    });
  });

  it("révocation d'une invitation : invitation.revoked par l'acteur", async () => {
    const token = newToken();
    const invited = await rpc<string>(owner, "create_invitation", {
      p_org: orgA,
      p_email: `revoke-${run}@seed.test`,
      p_role: "analyst",
      p_token_hash: token.hash,
    });
    expect(invited.status).toBe(200);
    const revoked = await rpc(owner, "revoke_invitation", { p_org: orgA, p_invitation_id: invited.body }, withRid("revoke"));
    expect(revoked.status).toBe(204);
    const rows = await auditOf(owner.id, orgA, "&request_id=eq." + rid("revoke"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "invitation.revoked", entity_id: invited.body, actor_id: owner.id });
    expect(Object.keys(rows[0]!.after ?? {})).toEqual(["revoked_at"]);
  });

  it("transfert de propriété : deux member.role_changed attribués à l'ancien owner", async () => {
    const heir = await newAccount("aud-heir");
    const token = newToken();
    const invited = await rpc<string>(owner, "create_invitation", {
      p_org: orgA,
      p_email: heir.email,
      p_role: "company_admin",
      p_token_hash: token.hash,
    });
    expect(invited.status).toBe(200);
    expect((await rpc(heir, "accept_invitation", { p_token_hash: token.hash })).status).toBe(200);
    const transfer = await rpc(owner, "transfer_ownership", { p_org: orgA, p_new_owner: heir.id }, withRid("transfer"));
    expect(transfer.status).toBe(204);
    const rows = await auditOf(owner.id, orgA, "&request_id=eq." + rid("transfer"));
    // L'ancien owner est devenu admin : il lit encore le journal.
    expect(rows.map((r) => r.action)).toEqual(["member.role_changed", "member.role_changed"]);
    expect(rows.every((r) => r.actor_id === owner.id && r.actor_kind === "user")).toBe(true);
    const byUser = new Map(rows.map((r) => [String(r.after?.user_id), r]));
    expect(byUser.get(heir.id)?.after).toMatchObject({ role: "company_owner" });
    expect(byUser.get(owner.id)?.after).toMatchObject({ role: "company_admin" });
  });

  it("aucun secret ni e-mail complet dans tout le journal de l'entreprise", async () => {
    const rows = await auditOf(owner.id, orgA);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(inviteHash);
    expect(text).not.toContain(inviteEmail);
    expect(text).not.toContain(`revoke-${run}@`);
    expect(text).not.toMatch(/"[a-z_-]*(token|hash|secret|password|api[_-]?key|authorization|cookie|jwt)[a-z_-]*":/i);
    expect(rows.every((r) => r.ip === null)).toBe(true);
  });
});
