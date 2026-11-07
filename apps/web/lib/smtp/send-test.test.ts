import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { sendMail, createTransport, lookup } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn((options: Record<string, unknown>) => ({ sendMail, options })), lookup: vi.fn() };
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("node:dns/promises", () => ({ lookup }));

import type { SmtpDelivery } from "@fusion-leap/domain";
import { sendSmtpTest } from "./send-test";

const delivery: SmtpDelivery = {
  host: "sandbox.smtp.mailtrap.io",
  port: 2525,
  security: "starttls",
  username: "user-test",
  from_email: "no-reply@example.test",
  from_name: "Fusion Leap",
  secret: null,
};
const base = { delivery, password: "pw-test", to: "admin@example.test", allowInternalHosts: false };

beforeEach(() => {
  sendMail.mockReset();
  createTransport.mockClear();
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "34.1.2.3", family: 4 }]);
  sendMail.mockResolvedValue({ messageId: "x" });
});

describe("sendSmtpTest : envoi", () => {
  it("se connecte à l'adresse résolue (anti-rebinding), avec STARTTLS exigé, et n'envoie qu'à l'administrateur", async () => {
    await expect(sendSmtpTest(base)).resolves.toEqual({ ok: true });
    const options = createTransport.mock.calls[0]![0];
    expect(options).toMatchObject({
      host: "34.1.2.3", port: 2525, secure: false, requireTLS: true, ignoreTLS: false,
      tls: { servername: "sandbox.smtp.mailtrap.io" }, auth: { user: "user-test", pass: "pw-test" },
    });
    expect(options.connectionTimeout).toBeLessThanOrEqual(10_000);
    const mail = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mail.to).toBe("admin@example.test");
    expect(mail.from).toEqual({ name: "Fusion Leap", address: "no-reply@example.test" });
  });

  it("modes de sécurité : TLS direct, aucune", async () => {
    await sendSmtpTest({ ...base, delivery: { ...delivery, security: "tls" } });
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({ secure: true, requireTLS: false });
    await sendSmtpTest({ ...base, delivery: { ...delivery, security: "none" } });
    expect(createTransport.mock.calls[1]?.[0]).toMatchObject({ secure: false, ignoreTLS: true });
  });

  it("sans utilisateur : pas d'authentification", async () => {
    const withoutUser: SmtpDelivery = { ...delivery };
    delete withoutUser.username;
    await sendSmtpTest({ ...base, delivery: withoutUser, password: undefined });
    expect(createTransport.mock.calls[0]?.[0]).not.toHaveProperty("auth");
  });
});

describe("sendSmtpTest : garde-fous SSRF", () => {
  it("hôte interne refusé hors développement, sans aucune connexion ni résolution", async () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "db.internal"]) {
      await expect(sendSmtpTest({ ...base, delivery: { ...delivery, host } })).resolves.toEqual({ ok: false, code: "blocked_host" });
    }
    expect(createTransport).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("nom public dont la résolution donne une adresse privée (rebinding) : refusé", async () => {
    lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.7", family: 4 }]);
    await expect(sendSmtpTest(base)).resolves.toEqual({ ok: false, code: "blocked_host" });
    lookup.mockResolvedValue([{ address: "::1", family: 6 }]);
    await expect(sendSmtpTest(base)).resolves.toEqual({ ok: false, code: "blocked_host" });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("développement : hôte local autorisé, connexion par le nom", async () => {
    await expect(sendSmtpTest({ ...base, allowInternalHosts: true, delivery: { ...delivery, host: "127.0.0.1", port: 1025, security: "none" } })).resolves.toEqual({ ok: true });
    expect(lookup).not.toHaveBeenCalled();
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({ host: "127.0.0.1", port: 1025 });
  });
});

describe("sendSmtpTest : erreurs", () => {
  it("traduit les codes nodemailer en codes courts, sans message", async () => {
    const cases: Array<[string, string]> = [
      ["EAUTH", "auth_failed"], ["ETIMEDOUT", "timeout"], ["ESOCKETTIMEDOUT", "timeout"], ["ECONNECTION", "connection_failed"],
      ["ECONNREFUSED", "connection_failed"], ["ENOTFOUND", "connection_failed"], ["EENVELOPE", "rejected"], ["AUTRE", "failed"],
    ];
    for (const [code, expected] of cases) {
      sendMail.mockRejectedValueOnce(Object.assign(new Error("535 login user-test pw-test rejected by smtp.secret.host"), { code }));
      const result = await sendSmtpTest(base);
      expect(result).toEqual({ ok: false, code: expected });
      expect(JSON.stringify(result)).not.toContain("pw-test");
    }
  });

  it("erreur de résolution DNS : connection_failed ; exception inattendue : failed", async () => {
    lookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND h"), { code: "ENOTFOUND" }));
    await expect(sendSmtpTest(base)).resolves.toEqual({ ok: false, code: "connection_failed" });
    lookup.mockRejectedValueOnce(new Error("boom"));
    await expect(sendSmtpTest(base)).resolves.toEqual({ ok: false, code: "failed" });
  });
});
