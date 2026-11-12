import { createKeyRing, decryptSecret, encryptSecret, platformSecretAad } from "@fusion-leap/adapters";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  captured: [] as Record<string, unknown>[],
  rpc: vi.fn(),
  getUser: vi.fn(),
  getKeyRing: vi.fn(),
  getSmtpDelivery: vi.fn(),
  sendSmtpTest: vi.fn(),
  appEnv: { value: "production" },
  logs: [] as string[],
}));

vi.mock("../service/with-service", () => ({
  withAction: (options: Record<string, unknown>, handler: (ctx: unknown, input: unknown) => Promise<unknown>) => {
    h.captured.push(options);
    return (_prev: unknown, formData: FormData) =>
      handler({ supabase: { rpc: h.rpc, auth: { getUser: h.getUser } }, formData }, Object.fromEntries(formData.entries()));
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../env/server", () => ({ getServerEnv: () => ({ APP_ENV: h.appEnv.value }) }));
vi.mock("./secrets", () => ({ SMTP_SECRET_PURPOSE: "smtp", getKeyRing: () => h.getKeyRing() }));
vi.mock("../service/smtp-delivery", () => ({ getSmtpDelivery: () => h.getSmtpDelivery() }));
vi.mock("./send-test", () => ({ sendSmtpTest: (o: unknown) => h.sendSmtpTest(o) }));
vi.mock("../service/logger", () => ({ logger: { info: (e: string, f?: unknown) => h.logs.push(JSON.stringify({ e, f })) } }));

import { resetSmtpAction, saveSmtpAction, testSmtpAction } from "./actions";

const ring = createKeyRing(1, { 1: randomBytes(32).toString("base64") });
const fakeForm = (data: Record<string, unknown>): FormData =>
  ({
    get: (key: string) => (typeof data[key] === "string" ? data[key] : null),
    entries: () => Object.entries(data)[Symbol.iterator](),
  }) as unknown as FormData;
const input = { host: "sandbox.smtp.mailtrap.io", port: 2525, security: "starttls", username: "u1", from_email: "no-reply@example.test", from_name: "Fusion Leap" };
const save = (extra: Record<string, unknown> = {}) => saveSmtpAction({ status: "idle" }, fakeForm({ uiLocale: "fr", ...input, ...extra }));
const idle = { status: "idle" } as const;

beforeEach(() => {
  h.rpc.mockReset();
  h.getUser.mockReset();
  h.getKeyRing.mockReset();
  h.getSmtpDelivery.mockReset();
  h.sendSmtpTest.mockReset();
  h.logs.length = 0;
  h.appEnv.value = "production";
  h.getKeyRing.mockReturnValue(ring);
  h.rpc.mockResolvedValue({ data: null, error: null });
});

describe("configuration des actions", () => {
  it("session sans organisation, organisation postée refusée, débit sensible, pas d'idempotence", () => {
    const names = h.captured.map((o) => o.name);
    expect(names).toEqual(["settings.save_smtp", "settings.reset_smtp", "settings.test_smtp"]);
    for (const o of h.captured) {
      expect(o).toMatchObject({ auth: "user", forbidOrganizationId: true, rateLimit: "sensitive", idempotency: "none" });
    }
    expect(h.captured[0]?.fields).toEqual(["host", "port", "security", "username", "password", "from_email", "from_name"]);
  });
});

describe("saveSmtpAction", () => {
  it("sans mot de passe : paramètres seuls, aucun secret créé", async () => {
    await expect(save()).resolves.toEqual({ status: "success" });
    expect(h.rpc).toHaveBeenCalledWith("set_smtp_settings", {
      p_settings: { host: input.host, port: 2525, security: "starttls", from_email: input.from_email, username: "u1", from_name: "Fusion Leap" },
      p_secret_id: null, p_ciphertext: null, p_nonce: null, p_key_version: null,
    });
  });

  it("avec mot de passe : chiffré AVANT l'appel (aucun clair vers la base), AAD liée à l'identifiant du secret", async () => {
    await expect(save({ password: "Mot-de-passe-secret-42" })).resolves.toEqual({ status: "success" });
    const args = h.rpc.mock.calls[0]?.[1] as { p_secret_id: string; p_ciphertext: string; p_nonce: string; p_key_version: number };
    expect(JSON.stringify(args)).not.toContain("Mot-de-passe-secret-42");
    expect(args.p_secret_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(decryptSecret({ secret: { ciphertext: args.p_ciphertext, nonce: args.p_nonce, keyVersion: args.p_key_version }, keyRing: ring, aad: platformSecretAad("smtp", args.p_secret_id) })).toBe("Mot-de-passe-secret-42");
    expect(h.logs.join("\n")).not.toContain("Mot-de-passe-secret-42");
  });

  it("clé maître absente : refus explicite, aucun repli en clair, aucun appel à la base", async () => {
    h.getKeyRing.mockReturnValue(null);
    await expect(save({ password: "x1" })).resolves.toEqual({ status: "error", code: "secrets_unavailable" });
    expect(h.rpc).not.toHaveBeenCalled();
    await expect(save()).resolves.toEqual({ status: "success" }); // sans mot de passe : possible
  });

  it("hôte interne refusé hors développement, autorisé en développement", async () => {
    await expect(save({ host: "127.0.0.1" })).resolves.toEqual({ status: "error", code: "blocked_host" });
    expect(h.rpc).not.toHaveBeenCalled();
    h.appEnv.value = "development";
    await expect(save({ host: "127.0.0.1" })).resolves.toEqual({ status: "success" });
  });

  it("traduit les erreurs de la base en codes, sans message brut", async () => {
    h.rpc.mockResolvedValue({ error: { code: "42501", message: "forbidden" } });
    await expect(save()).resolves.toEqual({ status: "error", code: "forbidden" });
    h.rpc.mockResolvedValue({ error: { code: "22023" } });
    await expect(save()).resolves.toEqual({ status: "error", code: "invalid_input" });
    h.rpc.mockResolvedValue({ error: { code: "23514", message: "check secrets_nonce_format" } });
    await expect(save()).resolves.toEqual({ status: "error", code: "invalid_input" });
    h.rpc.mockResolvedValue({ error: { code: "22023", message: "password_required" } });
    await expect(save()).resolves.toEqual({ status: "error", code: "password_required" });
    h.rpc.mockResolvedValue({ error: { code: "XX000", message: "password=secret" } });
    const result = await save();
    expect(result).toEqual({ status: "error", code: "generic" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("resetSmtpAction", () => {
  it("appelle reset_smtp_settings ; refus traduit", async () => {
    await expect(resetSmtpAction(idle, fakeForm({ uiLocale: "fr" }))).resolves.toEqual({ status: "success" });
    expect(h.rpc).toHaveBeenCalledWith("reset_smtp_settings");
    h.rpc.mockResolvedValue({ error: { code: "42501" } });
    await expect(resetSmtpAction(idle, fakeForm({ uiLocale: "fr" }))).resolves.toEqual({ status: "error", code: "forbidden" });
  });
});

describe("testSmtpAction", () => {
  const delivery = (secret: { id: string; ciphertext: string; nonce: string; key_version: number } | null) => ({ ...input, secret });
  const run = () => testSmtpAction(idle, fakeForm({ uiLocale: "fr" }));
  const secretFor = (plaintext: string) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const e = encryptSecret({ plaintext, keyRing: ring, aad: platformSecretAad("smtp", id) });
    return { id, ciphertext: e.ciphertext, nonce: e.nonce, key_version: e.keyVersion };
  };

  beforeEach(() => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "is_platform_admin" ? { data: true, error: null } : { data: null, error: null }));
    h.getUser.mockResolvedValue({ data: { user: { email: "admin@example.test" } }, error: null });
    h.sendSmtpTest.mockResolvedValue({ ok: true });
  });

  it("non administrateur : refusé AVANT toute lecture du secret", async () => {
    h.rpc.mockImplementation(async () => ({ data: false, error: null }));
    await expect(run()).resolves.toEqual({ status: "error", code: "forbidden" });
    expect(h.getSmtpDelivery).not.toHaveBeenCalled();
    h.rpc.mockImplementation(async () => ({ data: true, error: { code: "XX000" } }));
    await expect(run()).resolves.toEqual({ status: "error", code: "forbidden" });
    expect(h.getSmtpDelivery).not.toHaveBeenCalled();
  });

  it("aucune configuration : not_configured", async () => {
    h.getSmtpDelivery.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ status: "error", code: "not_configured" });
  });

  it("déchiffre le mot de passe côté serveur et n'envoie qu'à l'adresse de l'administrateur", async () => {
    h.getSmtpDelivery.mockResolvedValue(delivery(secretFor("pw-du-test")));
    await expect(run()).resolves.toEqual({ status: "success" });
    expect(h.sendSmtpTest).toHaveBeenCalledWith(expect.objectContaining({ password: "pw-du-test", to: "admin@example.test", allowInternalHosts: false }));
    expect(h.logs.join("\n")).not.toContain("pw-du-test");
  });

  it("sans mot de passe enregistré : envoi sans mot de passe", async () => {
    h.getSmtpDelivery.mockResolvedValue(delivery(null));
    await run();
    expect(h.sendSmtpTest).toHaveBeenCalledWith(expect.objectContaining({ password: undefined }));
  });

  it("clé absente, mauvaise clé ou secret altéré : secrets_unavailable, aucun envoi", async () => {
    h.getSmtpDelivery.mockResolvedValue(delivery(secretFor("pw")));
    h.getKeyRing.mockReturnValue(null);
    await expect(run()).resolves.toEqual({ status: "error", code: "secrets_unavailable" });
    h.getKeyRing.mockReturnValue(createKeyRing(1, { 1: randomBytes(32).toString("base64") }));
    await expect(run()).resolves.toEqual({ status: "error", code: "secrets_unavailable" });
    expect(h.sendSmtpTest).not.toHaveBeenCalled();
  });

  it("résultat de l'envoi : code court en cas d'échec, sans détail", async () => {
    h.getSmtpDelivery.mockResolvedValue(delivery(secretFor("pw")));
    h.sendSmtpTest.mockResolvedValue({ ok: false, code: "auth_failed" });
    await expect(run()).resolves.toEqual({ status: "error", code: "auth_failed" });
    expect(h.logs.join("\n")).toContain("auth_failed");
  });

  it("utilisateur sans adresse : refusé", async () => {
    h.getSmtpDelivery.mockResolvedValue(delivery(null));
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(run()).resolves.toEqual({ status: "error", code: "forbidden" });
    expect(h.sendSmtpTest).not.toHaveBeenCalled();
  });
});
