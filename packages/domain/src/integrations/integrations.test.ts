import { describe, expect, it } from "vitest";
import {
  createChannelSchema,
  createProviderIntegrationSchema,
  disconnectIntegrationSchema,
  integrationRowSchema,
  integrationSecretSchema,
  replaceIntegrationSecretSchema,
  replaceWebhookSecretSchema,
  updateChannelSchema,
} from "./schemas";

const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("integrationSecretSchema", () => {
  it("accepte un jeton usuel, une clé multi-lignes ; refuse trop court, trop long, caractères de contrôle", () => {
    expect(integrationSecretSchema.safeParse("EAAB-jeton-0123456789").success).toBe(true);
    expect(integrationSecretSchema.safeParse("-----BEGIN KEY-----\nabc\n-----END KEY-----").success).toBe(true);
    expect(integrationSecretSchema.safeParse("court").success).toBe(false);
    expect(integrationSecretSchema.safeParse("x".repeat(4097)).success).toBe(false);
    expect(integrationSecretSchema.safeParse("jeton\u0000valide-8").success).toBe(false);
    expect(integrationSecretSchema.safeParse("jeton\u001b[31mvalide").success).toBe(false);
  });
  it("le plafond est en OCTETS UTF-8 : 4096 octets passent, 4097 non, même avec moins de caractères", () => {
    expect(integrationSecretSchema.safeParse("a".repeat(4096)).success).toBe(true);
    expect(integrationSecretSchema.safeParse("a".repeat(4097)).success).toBe(false);
    expect(integrationSecretSchema.safeParse("é".repeat(2048)).success).toBe(true);
    expect(integrationSecretSchema.safeParse("é".repeat(2049)).success).toBe(false);
    expect(integrationSecretSchema.safeParse("中".repeat(1365)).success).toBe(true);
    expect(integrationSecretSchema.safeParse("中".repeat(1366)).success).toBe(false);
  });
});

describe("createProviderIntegrationSchema", () => {
  const base = { provider: "whatsapp", external_account_id: "104957249", secret: "EAAB-jeton-0123456789" };
  it("accepte email et whatsapp, portée vide par défaut", () => {
    expect(createProviderIntegrationSchema.parse(base).scopes).toEqual([]);
    expect(createProviderIntegrationSchema.safeParse({ ...base, provider: "email" }).success).toBe(true);
  });
  it("refuse csv, un compte mal formé, des portées en double ou mal formées, et un organization_id", () => {
    expect(createProviderIntegrationSchema.safeParse({ ...base, provider: "csv" }).success).toBe(false);
    expect(createProviderIntegrationSchema.safeParse({ ...base, external_account_id: "a b" }).success).toBe(false);
    expect(createProviderIntegrationSchema.safeParse({ ...base, scopes: ["messages", "messages"] }).success).toBe(false);
    expect(createProviderIntegrationSchema.safeParse({ ...base, scopes: ["mes sages"] }).success).toBe(false);
    expect(createProviderIntegrationSchema.safeParse({ ...base, organization_id: ORG }).success).toBe(false);
  });
});

describe("autres schémas d'entrée", () => {
  it("remplacement et déconnexion : identifiant valide, aucun champ de plus", () => {
    expect(replaceIntegrationSecretSchema.safeParse({ integration_id: ID, secret: "nouveau-jeton-1" }).success).toBe(true);
    expect(replaceIntegrationSecretSchema.safeParse({ integration_id: "x", secret: "nouveau-jeton-1" }).success).toBe(false);
    // secret de webhook (J32) : 32 à 200 caractères ASCII imprimables sans espace
    const WEBHOOK = "w".repeat(32);
    expect(replaceWebhookSecretSchema.safeParse({ integration_id: ID, secret: WEBHOOK }).success).toBe(true);
    expect(replaceWebhookSecretSchema.safeParse({ integration_id: ID, secret: "w".repeat(200) }).success).toBe(true);
    for (const secret of ["w".repeat(31), "w".repeat(201), `${"w".repeat(32)} espace`, `${"w".repeat(31)}é`, `${"w".repeat(31)}
`, "", 5]) {
      expect(replaceWebhookSecretSchema.safeParse({ integration_id: ID, secret }).success, String(secret)).toBe(false);
    }
    expect(replaceWebhookSecretSchema.safeParse({ integration_id: "x", secret: WEBHOOK }).success).toBe(false);
    expect(replaceWebhookSecretSchema.safeParse({ integration_id: ID, secret: WEBHOOK, organization_id: ID }).success).toBe(false);
    expect(replaceIntegrationSecretSchema.safeParse({ integration_id: ID, secret: "nouveau-jeton-1", organization_id: ORG }).success).toBe(false);
    expect(disconnectIntegrationSchema.safeParse({ integration_id: ID }).success).toBe(true);
    expect(disconnectIntegrationSchema.safeParse({ integration_id: ID, force: true }).success).toBe(false);
  });
  it("canal : type connu, portée d'identifiants ; mise à jour : au moins un champ", () => {
    expect(createChannelSchema.safeParse({ integration_id: ID, type: "email", sender_identity: "ventes@exemple.test" }).success).toBe(true);
    expect(createChannelSchema.safeParse({ integration_id: ID, type: "sms", sender_identity: "x" }).success).toBe(false);
    expect(createChannelSchema.safeParse({ integration_id: ID, type: "whatsapp", sender_identity: "+212600000000" }).success).toBe(true);
    for (const bad of [{ type: "email", sender_identity: "pas-une-adresse" }, { type: "email", sender_identity: "a b@x.test" }, { type: "whatsapp", sender_identity: "0600000000" }, { type: "whatsapp", sender_identity: "+0123456789" }, { type: "whatsapp", sender_identity: "ventes@exemple.test" }]) {
      expect(createChannelSchema.safeParse({ integration_id: ID, ...bad }).success, bad.sender_identity).toBe(false);
    }
    expect(updateChannelSchema.safeParse({ channel_id: ID }).success).toBe(false);
    expect(updateChannelSchema.safeParse({ channel_id: ID, send_paused: true }).success).toBe(true);
  });
});

describe("integrationRowSchema", () => {
  it("ne porte aucune colonne de secret : secret_ref n'est pas un champ connu", () => {
    const row = {
      id: ID, organization_id: ORG, provider: "email", status: "pending", external_account_id: "acc", scopes: [], has_secret: true,
      last_sync_at: null, last_sync_finished_at: null, last_error: null, created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-09T00:00:00Z",
    };
    const parsed = integrationRowSchema.parse({ ...row, secret_ref: ID });
    expect(parsed).not.toHaveProperty("secret_ref");
  });
});
