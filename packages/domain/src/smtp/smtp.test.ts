import { describe, expect, it } from "vitest";
import { MAILTRAP_PRESET, isInternalSmtpHost, isPrivateIp, smtpDeliverySchema, smtpSettingsSchema, smtpSettingsViewSchema } from "../index";

const base = {
  host: "sandbox.smtp.mailtrap.io",
  port: "2525",
  security: "starttls",
  username: "user-test",
  password: "mot-de-passe",
  from_email: "no-reply@example.test",
  from_name: "Fusion Leap",
};

describe("smtpSettingsSchema", () => {
  it("accepte une configuration valide et convertit le port", () => {
    const r = smtpSettingsSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.port).toBe(2525);
  });

  it("champs facultatifs vides = absents (le mot de passe vide conserve l'ancien)", () => {
    const r = smtpSettingsSchema.safeParse({ ...base, username: "", password: "", from_name: "  " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.password).toBeUndefined();
      expect(r.data.username).toBeUndefined();
      expect(r.data.from_name).toBeUndefined();
    }
  });

  it("refuse hôte, port, sécurité et expéditeur invalides", () => {
    for (const bad of [
      { host: "hôte invalide!" }, { host: "-debut.example.test" }, { host: "x".repeat(254) }, { host: "http://smtp.example.test" },
      { port: "0" }, { port: "70000" }, { port: "25.5" }, { port: "abc" },
      { security: "ssl" }, { from_email: "pas-un-email" }, { from_email: "a b@example.test" },
      { username: "u\nv" }, { from_name: "nom ‮" }, { password: "x".repeat(513) },
    ]) {
      expect(smtpSettingsSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuse un champ inconnu (aucun secret_id ni organization_id imposé par le client)", () => {
    expect(smtpSettingsSchema.safeParse({ ...base, secret_id: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(smtpSettingsSchema.safeParse({ ...base, organization_id: "x" }).success).toBe(false);
  });

  it("le préréglage Mailtrap est une configuration valide", () => {
    expect(smtpSettingsSchema.safeParse({ ...base, ...MAILTRAP_PRESET, port: String(MAILTRAP_PRESET.port) }).success).toBe(true);
    expect(MAILTRAP_PRESET).toMatchObject({ host: "sandbox.smtp.mailtrap.io", port: 2525, security: "starttls" });
    expect(smtpSettingsSchema.safeParse({ ...base, from_email: MAILTRAP_PRESET.from_email, from_name: MAILTRAP_PRESET.from_name }).success).toBe(true);
  });
});

describe("vues renvoyées par la base", () => {
  it("la vue administrateur ne porte que has_password", () => {
    const view = { host: "h.example.test", port: 587, security: "tls", from_email: "a@b.cd", has_password: true };
    expect(smtpSettingsViewSchema.safeParse(view).success).toBe(true);
    expect(smtpSettingsViewSchema.safeParse({ ...view, has_password: "oui" }).success).toBe(false);
  });
  it("la configuration d'envoi porte le secret chiffré ou null", () => {
    const delivery = { host: "h.example.test", port: 587, security: "tls", from_email: "a@b.cd", secret: null };
    expect(smtpDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(smtpDeliverySchema.safeParse({ ...delivery, secret: { id: "11111111-1111-4111-8111-111111111111", ciphertext: "QUJD", nonce: "AAAAAAAAAAAAAAAA", key_version: 1 } }).success).toBe(true);
  });
});

describe("expéditeur et caractères (revue sécurité)", () => {
  it("refuse virgule, chevrons, guillemets, espaces et domaine sans point dans l'adresse de l'expéditeur", () => {
    for (const bad of ["a,b@example.test", "x<a@example.test>", '"a"@example.test', "a b@example.test", "a@example", "a@.test", "a@-x.test", "a@example.t1"]) {
      expect(smtpSettingsSchema.safeParse({ ...base, from_email: bad }).success, bad).toBe(false);
    }
    for (const good of ["no-reply@example.test", "a.b+tag@sub.example.co", "o'brien@example.test"]) {
      expect(smtpSettingsSchema.safeParse({ ...base, from_email: good }).success, good).toBe(true);
    }
  });
  it("refuse séparateurs de ligne, BOM, caractères de balise et bidi dans le nom et l'utilisateur", () => {
    for (const bad of ["a\u2028b", "a\u2029b", "a\ufeffb", "a\u{e0041}b", "a\u202eb", "a\u200bb"]) {
      expect(smtpSettingsSchema.safeParse({ ...base, from_name: bad }).success, JSON.stringify(bad)).toBe(false);
      expect(smtpSettingsSchema.safeParse({ ...base, username: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("hôtes internes (SSRF)", () => {
  it("détecte localhost, réseaux internes et IPv4 privées", () => {
    for (const h of ["localhost", "db.localhost", "srv.local", "mail.internal", "x.lan", "127.0.0.1", "10.0.0.5", "172.16.4.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "LOCALHOST."]) {
      expect(isInternalSmtpHost(h), h).toBe(true);
    }
  });
  it("refuse les notations numériques exotiques (décimale, hexadécimale, octale, abrégée)", () => {
    for (const h of ["2130706433", "0x7f.1", "0x7f000001", "017700000001", "127.1", "010.0.0.1", "1.2.3", "256.1.1.1", "0177.0.0.1"]) {
      expect(isInternalSmtpHost(h), h).toBe(true);
    }
  });
  it("laisse passer les hôtes publics", () => {
    for (const h of ["sandbox.smtp.mailtrap.io", "smtp.example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "mail1.example.com", "smtp-2.example.org"]) {
      expect(isInternalSmtpHost(h), h).toBe(false);
    }
  });
  it("isPrivateIp contrôle le résultat DNS : IPv4, IPv4 mappée, IPv6 par défaut refusée", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "300.1.1.1", "::1", "::", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1",
      "64:ff9b::7f00:1", "2002:7f00:1::", "fec0::1", "fd00::1", "fe80::1", "ff02::1", "2001::1", "2001:db8::1", "pas une ip", "1:2:3:4:5:6:7:8:9", "::g", "",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4007:80f::200e", "::ffff:8.8.8.8", "::ffff:808:808", "[2606:4700:4700::1111]"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});
