import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, apiAsUser, cleanupTestUsers, createTestUser, isDenied, psql } from "./harness";

/**
 * Paramètres SMTP par la Data API : écriture, lecture et suppression réservées aux administrateurs de la plateforme,
 * mot de passe (chiffré côté application) jamais renvoyé, lecture du chiffré par service_role seulement, aucun accès
 * direct aux tables. La configuration locale éventuelle est sauvegardée puis restaurée.
 */

type Account = { id: string; email: string };
const createdUsers: string[] = [];
async function newAccount(label: string): Promise<Account> {
  const account = await createTestUser(label);
  createdUsers.push(account.id);
  return account;
}
const rpc = (user: Account, fn: string, args: Record<string, unknown> = {}) => apiAsUser(user.id, "POST", `rpc/${fn}`, args);
const one = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0).pop() ?? "";

const cfg = (host = "sandbox.smtp.mailtrap.io") => ({ host, port: 2525, security: "starttls", username: "u-test", from_email: "no-reply@example.test", from_name: "Fusion Leap" });
const CIPHER = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
const NONCE = "AAAAAAAAAAAAAAAA";
const set = (user: Account, settings: unknown, secretId: string | null = null, withPassword = false) =>
  rpc(user, "set_smtp_settings", { p_settings: settings, p_secret_id: secretId, p_ciphertext: withPassword ? CIPHER : null, p_nonce: withPassword ? NONCE : null, p_key_version: withPassword ? 1 : null });

let admin: Account;
let user: Account;
let backupConfig = "";
let backupSecret = "";

beforeAll(async () => {
  [admin, user] = await Promise.all([newAccount("sm-admin"), newAccount("sm-user")]);
  backupConfig = one("select coalesce((select value::text from public.platform_config where key = 'smtp.settings'), '')");
  backupSecret = one("select coalesce((select row_to_json(s)::text from private.secrets s where s.purpose = 'smtp' limit 1), '')");
  psql("delete from public.platform_config where key = 'smtp.settings'");
  psql("delete from private.secrets where purpose = 'smtp'");
  psql(`insert into private.platform_admins (user_id) values ('${admin.id}')`);
});

afterAll(async () => {
  psql(`delete from private.platform_admins where user_id = '${admin.id}'`);
  psql("delete from public.platform_config where key = 'smtp.settings'");
  psql("delete from private.secrets where purpose = 'smtp'");
  if (backupSecret.startsWith("{")) {
    psql(`insert into private.secrets select * from json_populate_record(null::private.secrets, '${backupSecret.replace(/'/g, "''")}'::json)`);
  }
  if (backupConfig.startsWith("{")) {
    psql(`insert into public.platform_config (key, value) values ('smtp.settings', '${backupConfig.replace(/'/g, "''")}'::jsonb)`);
  }
  await cleanupTestUsers(createdUsers);
});

describe("administrateur de la plateforme", () => {
  it("enregistre sans mot de passe, relit has_password = false", async () => {
    expect((await set(admin, cfg())).status).toBeLessThan(300);
    const read = await rpc(admin, "get_smtp_settings");
    expect(read.body).toMatchObject({ host: "sandbox.smtp.mailtrap.io", port: 2525, has_password: false });
  });

  it("enregistre avec mot de passe chiffré : la lecture ne renvoie jamais le secret ni son chiffré", async () => {
    const id = randomUUID();
    expect((await set(admin, cfg(), id, true)).status).toBeLessThan(300);
    const read = await rpc(admin, "get_smtp_settings");
    expect((read.body as { has_password: boolean }).has_password).toBe(true);
    const text = JSON.stringify(read.body);
    for (const forbidden of [id, CIPHER, "secret_id", "ciphertext", '"password":']) expect(text).not.toContain(forbidden);
    expect(one("select count(*) from private.secrets where purpose = 'smtp'")).toBe("1");
  });

  it("mise à jour sans mot de passe : le secret est conservé ; remplacement : l'ancien est supprimé", async () => {
    const before = one("select id from private.secrets where purpose = 'smtp'");
    expect((await set(admin, { ...cfg(), from_name: "Autre nom" })).status).toBeLessThan(300);
    expect(one("select id from private.secrets where purpose = 'smtp'")).toBe(before);
    // Autre destination SANS nouveau mot de passe : refusé (le mot de passe ne se réutilise pas) ; rien ne change.
    const refused = await set(admin, cfg("attacker.example.net"));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("password_required");
    expect(one("select value ->> 'host' from public.platform_config where key = 'smtp.settings'")).toBe("sandbox.smtp.mailtrap.io");
    const next = randomUUID();
    expect((await set(admin, cfg("smtp.example.test"), next, true)).status).toBeLessThan(300);
    expect(one("select count(*) from private.secrets where purpose = 'smtp'")).toBe("1");
    expect(one("select id from private.secrets where purpose = 'smtp'")).toBe(next);
  });

  it("valeurs invalides refusées (mot de passe en clair, secret_id imposé, hôte, port, nonce)", async () => {
    const bad: unknown[] = [
      { ...cfg(), password: "clair" },
      { ...cfg(), secret_id: randomUUID() },
      cfg("hôte invalide!"),
      { ...cfg(), port: 0 },
      { ...cfg(), security: "ssl" },
      { ...cfg(), from_email: "x" },
    ];
    for (const settings of bad) expect((await set(admin, settings)).status, JSON.stringify(settings)).toBeGreaterThanOrEqual(400);
    const badNonce = await rpc(admin, "set_smtp_settings", { p_settings: cfg(), p_secret_id: randomUUID(), p_ciphertext: CIPHER, p_nonce: "court", p_key_version: 1 });
    expect(badNonce.status).toBeGreaterThanOrEqual(400);
    expect(one("select value ->> 'host' from public.platform_config where key = 'smtp.settings'")).toBe("smtp.example.test");
  });
});

describe("lecture serveur du chiffré et isolation", () => {
  it("service_role lit les paramètres et le chiffré ; ni l'administrateur ni anon ; get_platform_config ne donne pas smtp", async () => {
    const delivery = await api<{ host: string; secret: { ciphertext: string; key_version: number } | null }>("service", "POST", "rpc/get_smtp_delivery");
    expect(delivery.status).toBe(200);
    expect(delivery.body.host).toBe("smtp.example.test");
    expect(delivery.body.secret?.ciphertext).toBe(CIPHER);
    expect((await rpc(admin, "get_smtp_delivery")).status).toBeGreaterThanOrEqual(400);
    expect(isDenied(await api("anon", "POST", "rpc/get_smtp_delivery"))).toBe(true);
    const generic = await api<unknown>("service", "POST", "rpc/get_platform_config", { p_key: "smtp.settings" });
    expect(generic.body).toBeNull();
  });

  it("utilisateur ordinaire et anon : écriture, lecture et suppression refusées ; rien ne change", async () => {
    expect((await set(user, cfg("evil.example.test"))).status).toBeGreaterThanOrEqual(400);
    expect((await rpc(user, "get_smtp_settings")).status).toBeGreaterThanOrEqual(400);
    expect((await rpc(user, "reset_smtp_settings")).status).toBeGreaterThanOrEqual(400);
    expect(isDenied(await api("anon", "POST", "rpc/set_smtp_settings", { p_settings: cfg(), p_secret_id: null, p_ciphertext: null, p_nonce: null, p_key_version: null }))).toBe(true);
    expect(one("select value ->> 'host' from public.platform_config where key = 'smtp.settings'")).toBe("smtp.example.test");
  });

  it("aucun accès direct : platform_config, private.secrets (non exposé), même admin et service_role", async () => {
    expect(isDenied(await apiAsUser(admin.id, "GET", "platform_config?key=eq.smtp.settings"))).toBe(true);
    expect(isDenied(await apiAsUser(admin.id, "POST", "platform_config", { key: "smtp.settings", value: cfg() }))).toBe(true);
    expect(isDenied(await api("service", "GET", "platform_config?key=eq.smtp.settings"))).toBe(true);
    expect((await apiAsUser(admin.id, "GET", "secrets")).status).toBeGreaterThanOrEqual(400);
    expect((await api("service", "GET", "secrets")).status).toBeGreaterThanOrEqual(400);
  });
});

describe("suppression", () => {
  it("l'administrateur supprime la configuration et le secret", async () => {
    expect((await rpc(admin, "reset_smtp_settings")).status).toBeLessThan(300);
    expect(one("select count(*) from public.platform_config where key = 'smtp.settings'")).toBe("0");
    expect(one("select count(*) from private.secrets where purpose = 'smtp'")).toBe("0");
    expect((await rpc(admin, "get_smtp_settings")).body).toBeNull();
  });
});
