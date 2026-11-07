import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, apiAsUser, cleanupTestUsers, createTestUser, isDenied, psql } from "./harness";

/**
 * platform_config par la Data API : aucun accès direct à la table (anon, authenticated, service_role),
 * écriture uniquement par set_platform_config / reset_platform_config pour les owner / admin ACTIFS d'une
 * organisation, lecture par get_platform_config réservée à service_role (lecture serveur). La palette locale
 * éventuelle est sauvegardée puis restaurée.
 */

type Account = { id: string; email: string };
const createdUsers: string[] = [];
const KEY = "appearance.palette";
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pal = (primary: string) => ({ light: { primary, background: "#ffffff" } });

async function newAccount(label: string): Promise<Account> {
  const account = await createTestUser(label);
  createdUsers.push(account.id);
  return account;
}
const rpc = (user: Account, fn: string, args: Record<string, unknown>) => apiAsUser(user.id, "POST", `rpc/${fn}`, args);
const stored = (): string =>
  psql("select coalesce((select value #>> '{light,primary}' from public.platform_config where key = 'appearance.palette'), '-')")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .pop() ?? "";

let owner: Account;
let sales: Account;
let outsider: Account;
let backup = "";

beforeAll(async () => {
  [owner, sales, outsider] = await Promise.all([newAccount("pc-owner"), newAccount("pc-sales"), newAccount("pc-outsider")]);
  backup = psql("select coalesce((select value::text from public.platform_config where key = 'appearance.palette'), '')").trim();
  psql("delete from public.platform_config");

  const created = await rpc(owner, "create_organization", { p_name: `PC ${run}`, p_creation_key: `pc-${run}` });
  expect(created.status).toBe(200);
  const orgId = created.body as string;
  const hash = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex");
  expect((await rpc(owner, "create_invitation", { p_org: orgId, p_email: sales.email, p_role: "sales_agent", p_token_hash: hash })).status).toBe(200);
  expect((await rpc(sales, "accept_invitation", { p_token_hash: hash })).status).toBe(200);
});

afterAll(async () => {
  psql("delete from public.platform_config");
  const json = backup.split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (json) psql(`insert into public.platform_config (key, value) values ('${KEY}', '${json.replace(/'/g, "''")}'::jsonb)`);
  await cleanupTestUsers(createdUsers);
});

describe("owner / admin d'organisation", () => {
  it("can_manage_platform_config : true pour l'owner, false pour sales et pour un compte sans adhésion", async () => {
    expect((await rpc(owner, "can_manage_platform_config", {})).body).toBe(true);
    expect((await rpc(sales, "can_manage_platform_config", {})).body).toBe(false);
    expect((await rpc(outsider, "can_manage_platform_config", {})).body).toBe(false);
  });

  it("l'owner enregistre, remplace puis réinitialise la palette", async () => {
    expect((await rpc(owner, "set_platform_config", { p_key: KEY, p_value: pal("#1d4ed8") })).status).toBeLessThan(300);
    expect(stored()).toBe("#1d4ed8");
    expect((await rpc(owner, "set_platform_config", { p_key: KEY, p_value: pal("#6d28d9") })).status).toBeLessThan(300);
    expect(stored()).toBe("#6d28d9");
    expect((await rpc(owner, "reset_platform_config", { p_key: KEY })).status).toBeLessThan(300);
    expect(stored()).toBe("-");
  });

  it("valeurs invalides refusées (clé, hex, injection CSS, jeton, forme)", async () => {
    await rpc(owner, "set_platform_config", { p_key: KEY, p_value: pal("#6d28d9") });
    const bad: Array<[string, unknown]> = [
      ["other.key", pal("#000000")],
      [KEY, pal("red")],
      [KEY, pal("#FFFFFF")],
      [KEY, pal("#fff;}body{x:y")],
      [KEY, { light: { evil: "#000000" } }],
      [KEY, []],
    ];
    for (const [key, value] of bad) {
      const r = await rpc(owner, "set_platform_config", { p_key: key, p_value: value });
      expect(r.status, JSON.stringify(value)).toBeGreaterThanOrEqual(400);
    }
    expect(stored()).toBe("#6d28d9");
  });
});

describe("membre ordinaire, étranger et anonyme", () => {
  it("refusés : écriture et reset ; la valeur ne change pas", async () => {
    for (const who of [sales, outsider]) {
      expect((await rpc(who, "set_platform_config", { p_key: KEY, p_value: pal("#c2410c") })).status).toBeGreaterThanOrEqual(400);
      expect((await rpc(who, "reset_platform_config", { p_key: KEY })).status).toBeGreaterThanOrEqual(400);
    }
    const anon = await api("anon", "POST", "rpc/set_platform_config", { p_key: KEY, p_value: pal("#c2410c") });
    expect(anon.status).toBeGreaterThanOrEqual(400);
    expect(stored()).toBe("#6d28d9");
  });

  it("aucun accès direct à la table, même owner et service_role", async () => {
    const row = { key: KEY, value: pal("#000000") };
    expect(isDenied(await apiAsUser(owner.id, "POST", "platform_config", row))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "GET", "platform_config?select=*"))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "PATCH", `platform_config?key=eq.${KEY}`, { value: pal("#000000") }))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "DELETE", `platform_config?key=eq.${KEY}`))).toBe(true);
    expect(isDenied(await api("service", "POST", "platform_config", row))).toBe(true);
    expect(isDenied(await api("anon", "GET", "platform_config?select=*"))).toBe(true);
    expect(stored()).toBe("#6d28d9");
  });
});

describe("lecture serveur (get_platform_config)", () => {
  it("service_role lit la palette ; anon et authenticated sont refusés", async () => {
    const read = await api<unknown>("service", "POST", "rpc/get_platform_config", { p_key: KEY });
    expect(read.status).toBe(200);
    expect((read.body as { light: { primary: string } }).light.primary).toBe("#6d28d9");
    expect(isDenied(await api("anon", "POST", "rpc/get_platform_config", { p_key: KEY }))).toBe(true);
    expect((await rpc(sales, "get_platform_config", { p_key: KEY })).status).toBeGreaterThanOrEqual(400);
    expect((await api<unknown>("service", "POST", "rpc/get_platform_config", { p_key: "other.key" })).body).toBeNull();
  });
});
