import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.fn();
const createClient = vi.fn(async () => ({ rpc }));
vi.mock("../supabase/server", () => ({ createClient: () => createClient() }));
const adminRpc = vi.fn();
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc: adminRpc }) }));

import { getSmtpDelivery } from "../service/smtp-delivery";
import { getSmtpSettings } from "./queries";

const VIEW = { host: "h.example.test", port: 587, security: "tls", from_email: "a@b.cd", has_password: true };

beforeEach(() => {
  rpc.mockReset();
  adminRpc.mockReset();
  createClient.mockClear();
});

describe("getSmtpSettings", () => {
  it("appelle get_smtp_settings et renvoie la vue sans mot de passe", async () => {
    rpc.mockResolvedValue({ data: VIEW, error: null });
    await expect(getSmtpSettings()).resolves.toEqual(VIEW);
    expect(rpc).toHaveBeenCalledWith("get_smtp_settings");
  });

  it("refus, absence, valeur illisible ou exception => null", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(getSmtpSettings()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getSmtpSettings()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: { ...VIEW, port: "587" }, error: null });
    await expect(getSmtpSettings()).resolves.toBeNull();
    createClient.mockRejectedValueOnce(new Error("boom"));
    await expect(getSmtpSettings()).resolves.toBeNull();
  });
});

describe("getSmtpDelivery (service_role)", () => {
  const delivery = { host: "h.example.test", port: 587, security: "tls", from_email: "a@b.cd", secret: { id: "11111111-1111-4111-8111-111111111111", ciphertext: "QUJD", nonce: "AAAAAAAAAAAAAAAA", key_version: 1 } };

  it("lit la configuration d'envoi avec le secret chiffré", async () => {
    adminRpc.mockResolvedValue({ data: delivery, error: null });
    await expect(getSmtpDelivery()).resolves.toEqual(delivery);
    expect(adminRpc).toHaveBeenCalledWith("get_smtp_delivery");
  });

  it("absence, erreur, valeur illisible ou exception => null", async () => {
    adminRpc.mockResolvedValue({ data: null, error: null });
    await expect(getSmtpDelivery()).resolves.toBeNull();
    adminRpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(getSmtpDelivery()).resolves.toBeNull();
    adminRpc.mockResolvedValue({ data: { ...delivery, secret: { id: "x" } }, error: null });
    await expect(getSmtpDelivery()).resolves.toBeNull();
    adminRpc.mockRejectedValue(new Error("boom"));
    await expect(getSmtpDelivery()).resolves.toBeNull();
  });
});
