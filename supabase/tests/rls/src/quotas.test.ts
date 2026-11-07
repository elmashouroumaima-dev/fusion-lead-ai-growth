import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, apiAsUser, cleanupTestUsers, createTestUser, isDenied, psql, rowsOf } from "./harness";

/**
 * Plans et quotas par la Data API (J14) : consommation atomique sous VRAIE concurrence (jamais de dépassement),
 * compteurs isolés par organisation, limite d'utilisateurs sur les invitations, lecture de l'usage par
 * owner/admin, administration des abonnements réservée aux administrateurs de la plateforme, aucune
 * auto-promotion. Tests ré-exécutables : comptes et organisations uniques par exécution.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Account = { id: string; email: string };
const createdUsers: string[] = [];

async function newAccount(label: string): Promise<Account> {
  const account = await createTestUser(label);
  createdUsers.push(account.id);
  return account;
}
const rpcAs = (user: Account, fn: string, args: Record<string, unknown>) => apiAsUser(user.id, "POST", `rpc/${fn}`, args);
const svc = <T = unknown>(fn: string, args: Record<string, unknown>) => api<T>("service", "POST", `rpc/${fn}`, args);
const one = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0).pop() ?? "";
const newHash = () => createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex");

let owner: Account;
let ownerB: Account;
let sales: Account;
let platformAdmin: Account;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  [owner, ownerB, sales, platformAdmin] = await Promise.all([
    newAccount("qt-owner"),
    newAccount("qt-ownerb"),
    newAccount("qt-sales"),
    newAccount("qt-admin"),
  ]);
  const a = await rpcAs(owner, "create_organization", { p_name: `QT A ${run}`, p_creation_key: `qt-a-${run}` });
  const b = await rpcAs(ownerB, "create_organization", { p_name: `QT B ${run}`, p_creation_key: `qt-b-${run}` });
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  orgA = a.body as string;
  orgB = b.body as string;
  psql(`insert into private.platform_admins (user_id) values ('${platformAdmin.id}')`);
});

afterAll(async () => {
  psql(`delete from private.platform_admins where user_id = '${platformAdmin.id}'`);
  psql(`delete from public.usage_counters where organization_id in ('${orgA}', '${orgB}')`);
  await cleanupTestUsers(createdUsers);
});

describe("consommation de flux sous concurrence réelle", () => {
  it("60 consommations simultanées, limite 25 : exactement 25 réussissent, le compteur ne dépasse jamais", async () => {
    psql(`update public.subscriptions set limits_override = '{"messages_per_month": 25}' where organization_id = '${orgA}'`);
    const results = await Promise.all(
      Array.from({ length: 60 }, () => svc("consume_quota", { p_org: orgA, p_metric: "messages_per_month", p_amount: 1 })),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status >= 400);
    expect(ok).toBe(25);
    expect(refused).toHaveLength(35);
    expect(refused.every((r) => r.code === "P0001")).toBe(true);
    expect(one(`select value from public.usage_counters where organization_id = '${orgA}' and metric = 'messages_per_month'`)).toBe("25");
  }, 60_000);

  it("l'autre organisation a son propre compteur", async () => {
    const r = await svc<{ used: number }>("consume_quota", { p_org: orgB, p_metric: "messages_per_month", p_amount: 7 });
    expect(r.status).toBe(200);
    expect(r.body.used).toBe(7);
    expect(one(`select value from public.usage_counters where organization_id = '${orgA}' and metric = 'messages_per_month'`)).toBe("25");
  });

  it("authenticated et anon ne peuvent pas consommer", async () => {
    expect((await rpcAs(owner, "consume_quota", { p_org: orgA, p_metric: "ai_runs", p_amount: 1 })).status).toBeGreaterThanOrEqual(400);
    expect(isDenied(await api("anon", "POST", "rpc/consume_quota", { p_org: orgA, p_metric: "ai_runs", p_amount: 1 }))).toBe(true);
  });
});

describe("limite d'utilisateurs sur les invitations", () => {
  it("le plan trial (3 utilisateurs) : la 3e place est prise, la 4e invitation est refusée", async () => {
    psql(`update public.subscriptions set limits_override = '{}' where organization_id = '${orgB}'`);
    // orgB : 1 owner. Deux invitations en attente = 3 places occupées.
    for (const n of [1, 2]) {
      const r = await rpcAs(ownerB, "create_invitation", { p_org: orgB, p_email: `qt${n}-${run}@example.test`, p_role: "sales_agent", p_token_hash: newHash() });
      expect(r.status, `invitation ${n}`).toBe(200);
    }
    const refused = await rpcAs(ownerB, "create_invitation", { p_org: orgB, p_email: `qt3-${run}@example.test`, p_role: "sales_agent", p_token_hash: newHash() });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("quota_exceeded");
    expect(one(`select count(*) from public.invitations where organization_id = '${orgB}' and email_normalized = 'qt3-${run}@example.test'`)).toBe("0");
  });

  it("owner lit l'usage (near_limit) ; sales et l'autre organisation sont refusés", async () => {
    const usage = rowsOf<{ metric: string; used: number; limit: number | null; near_limit: boolean }>(await rpcAs(ownerB, "get_org_usage", { p_org: orgB }));
    const users = usage.find((u) => u.metric === "users");
    expect(users).toMatchObject({ used: 3, limit: 3, near_limit: true });
    expect((await rpcAs(sales, "get_org_usage", { p_org: orgB })).status).toBeGreaterThanOrEqual(400);
    expect((await rpcAs(owner, "get_org_usage", { p_org: orgB })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("administration de la plateforme", () => {
  it("is_platform_admin : vrai pour l'administrateur, faux pour les autres ; aucune auto-promotion", async () => {
    expect((await rpcAs(platformAdmin, "is_platform_admin", {})).body).toBe(true);
    expect((await rpcAs(owner, "is_platform_admin", {})).body).toBe(false);
    // Table du schéma private : non exposée par l'API (404) ou refusée ; jamais acceptée.
    expect((await apiAsUser(owner.id, "POST", "platform_admins", { user_id: owner.id })).status).toBeGreaterThanOrEqual(400);
    expect((await api("service", "POST", "platform_admins", { user_id: owner.id })).status).toBeGreaterThanOrEqual(400);
    expect(one(`select count(*) from private.platform_admins where user_id = '${owner.id}'`)).toBe("0");
  });

  it("l'administrateur liste les organisations et change l'abonnement ; l'audit consigne le changement", async () => {
    const list = rowsOf<{ organization_id: string; plan_code: string }>(await rpcAs(platformAdmin, "admin_list_organizations", { p_limit: 200, p_offset: 0 }));
    expect(list.find((o) => o.organization_id === orgA)?.plan_code).toBe("trial");
    const set = await rpcAs(platformAdmin, "admin_set_subscription", {
      p_org: orgA, p_plan_code: "growth", p_status: "active", p_limits_override: {}, p_reason: "Contrat signé (test)",
    });
    expect(set.status).toBeLessThan(300);
    expect(one(`select p.code || ':' || s.status from public.subscriptions s join public.plans p on p.id = s.plan_id where s.organization_id = '${orgA}'`)).toBe("growth:active");
    // Les `update` du test (psql, sans utilisateur) ont aussi écrit des lignes système : on filtre sur l'acteur.
    expect(one(`select count(*) from public.audit_logs where action = 'subscription.changed' and organization_id = '${orgA}' and actor_id = '${platformAdmin.id}'`)).toBe("1");
    // Les 25 messages déjà consommés restent comptés ; la limite du plan growth s'applique désormais.
    const usage = rowsOf<{ metric: string; used: number; limit: number }>(await rpcAs(owner, "get_org_usage", { p_org: orgA }));
    expect(usage.find((u) => u.metric === "messages_per_month")).toMatchObject({ used: 25, limit: 20000 });
  });

  it("owner d'organisation, sales et anon ne peuvent ni lister ni modifier ; rien ne change", async () => {
    for (const who of [owner, sales]) {
      expect((await rpcAs(who, "admin_list_organizations", { p_limit: 10, p_offset: 0 })).status).toBeGreaterThanOrEqual(400);
      expect((await rpcAs(who, "admin_set_subscription", { p_org: orgA, p_plan_code: "trial", p_status: "trial", p_limits_override: {}, p_reason: "tentative" })).status).toBeGreaterThanOrEqual(400);
    }
    expect(isDenied(await api("anon", "POST", "rpc/admin_set_subscription", { p_org: orgA, p_plan_code: "trial", p_status: "trial", p_limits_override: {}, p_reason: "tentative" }))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "PATCH", `subscriptions?organization_id=eq.${orgA}`, { status: "trial" }))).toBe(true);
    expect(one(`select p.code from public.subscriptions s join public.plans p on p.id = s.plan_id where s.organization_id = '${orgA}'`)).toBe("growth");
  });

  it("valeurs invalides refusées (plan inconnu, surcharge, raison courte, statut)", async () => {
    const base = { p_org: orgA, p_plan_code: "growth", p_status: "active", p_limits_override: {}, p_reason: "raison valable" };
    for (const bad of [{ p_plan_code: "nope" }, { p_limits_override: { users: -1 } }, { p_limits_override: { clef: 1 } }, { p_reason: "x" }, { p_status: "inconnu" }]) {
      expect((await rpcAs(platformAdmin, "admin_set_subscription", { ...base, ...bad })).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    expect(one(`select p.code from public.subscriptions s join public.plans p on p.id = s.plan_id where s.organization_id = '${orgA}'`)).toBe("growth");
  });
});
