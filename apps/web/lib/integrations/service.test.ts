import { randomBytes } from "node:crypto";
import { createKeyRing, openOrganizationSecret } from "@fusion-leap/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";

const state = vi.hoisted(() => ({ keyRing: null as unknown }));
vi.mock("../smtp/secrets", () => ({ getKeyRing: () => state.keyRing }));

import {
  createChannel,
  createProviderIntegration,
  disconnectIntegration,
  isEncryptionConfigured,
  listIntegrationViews,
  replaceIntegrationSecret,
  replaceWebhookSecret,
  updateChannel,
} from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const INT = "7a000000-0000-4000-8000-000000000001";
const CH = "7c000000-0000-4000-8000-000000000001";
const NOW = "2026-11-28T10:00:00+00:00";
const TOKEN = "EAAB-jeton-de-test-0123456789";
const keyRing = createKeyRing(1, { 1: randomBytes(32).toString("base64") });

function fakeClient() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const result = {
    integrations: [] as unknown[],
    channels: [] as unknown[],
    dbError: null as unknown,
    rpc: ((): { data: unknown; error: unknown } => ({ data: null, error: null })) as (name: string) => { data: unknown; error: unknown },
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ op: `rpc:${name}`, args: [args] });
    return result.rpc(name);
  });
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${method}`, args });
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: table === "integrations" ? result.integrations : result.channels, error: result.dbError }).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, result, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
  state.keyRing = keyRing;
});

const integrationRow = {
  id: INT, organization_id: ORG, provider: "whatsapp", status: "pending", external_account_id: "104957249", scopes: ["messages"], has_secret: true,
  last_sync_at: null, last_sync_finished_at: null, last_error: null, created_at: NOW, updated_at: NOW,
};
const channelRow = { id: CH, organization_id: ORG, type: "whatsapp", integration_id: INT, sender_identity: "+212600000000", status: "pending", project_scope: [], send_paused: false, created_at: NOW, updated_at: NOW };

describe("listIntegrationViews", () => {
  it("intégrations de l'entreprise du contexte avec leurs canaux ; colonnes explicites, jamais secret_ref", async () => {
    c.result.integrations = [integrationRow];
    c.result.channels = [channelRow];
    const views = await listIntegrationViews(c.client, ORG);
    expect(views).toHaveLength(1);
    expect(views[0]?.integration.has_secret).toBe(true);
    expect(views[0]?.channels).toHaveLength(1);
    const selected = c.calls.filter((call) => call.op.endsWith(".select")).map((call) => String(call.args[0]));
    expect(selected.length).toBe(2);
    for (const columns of selected) {
      expect(columns).not.toContain("secret_ref");
      expect(columns).not.toBe("*");
    }
    expect(c.calls.filter((call) => call.op.endsWith(".eq")).every((call) => call.args[0] === "organization_id" && call.args[1] === ORG)).toBe(true);
  });

  it("ligne illisible (champ inconnu de la liste fermée) : erreur, jamais une ligne partielle", async () => {
    c.result.integrations = [{ ...integrationRow, status: "inconnu" }];
    await expect(listIntegrationViews(c.client, ORG)).rejects.toThrow("rows_unreadable");
    c.result.integrations = [];
    c.result.dbError = { code: "42501" };
    await expect(listIntegrationViews(c.client, ORG)).rejects.toThrow();
  });
});

describe("createProviderIntegration", () => {
  const input = { provider: "whatsapp" as const, external_account_id: "104957249", scopes: ["messages"], secret: TOKEN };

  it("chiffre le jeton avant l'appel : la base ne reçoit que le chiffré, déchiffrable avec l'entreprise du contexte seulement", async () => {
    c.result.rpc = () => ({ data: INT, error: null });
    const result = await createProviderIntegration(c.client, ORG, input);
    expect(result).toEqual({ ok: true, value: { id: INT } });
    const args = c.calls[0]?.args[0] as Record<string, unknown>;
    expect(args.p_org).toBe(ORG);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(Object.keys(args)).not.toContain("secret");
    const stored = { secretId: String(args.p_secret_id), ciphertext: String(args.p_ciphertext), nonce: String(args.p_nonce), keyVersion: Number(args.p_key_version) };
    expect(openOrganizationSecret({ organizationId: ORG, stored, keyRing: keyRing })).toBe(TOKEN);
    expect(() => openOrganizationSecret({ organizationId: "aa000000-0000-4000-8000-00000000000b", stored, keyRing })).toThrow();
  });

  it("sans clé maître : 503, AUCUN appel à la base (jamais de repli en clair)", async () => {
    state.keyRing = null;
    expect(isEncryptionConfigured()).toBe(false);
    expect(await createProviderIntegration(c.client, ORG, input)).toEqual({ ok: false, code: "service_unavailable" });
    expect(c.calls).toHaveLength(0);
  });

  it("erreurs de la base : compte déjà connecté (23505) = conflict ; quota = conflict ; rôle = forbidden ; valeur invalide = validation_failed", async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: "23505" }, "conflict"],
      [{ code: "P0001", message: "too_many_integrations" }, "conflict"],
      [{ code: "42501" }, "forbidden"],
      [{ code: "22023" }, "validation_failed"],
    ];
    for (const [error, code] of cases) {
      c.result.rpc = () => ({ data: null, error });
      expect(await createProviderIntegration(c.client, ORG, input)).toEqual({ ok: false, code });
    }
  });

  it("réponse inattendue de la base : internal_error", async () => {
    c.result.rpc = () => ({ data: { x: 1 }, error: null });
    expect(await createProviderIntegration(c.client, ORG, input)).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("replaceIntegrationSecret (rotation)", () => {
  it("un nouvel identifiant de secret et un nouveau chiffré à chaque remplacement ; l'ancien n'est jamais renvoyé", async () => {
    const input = { integration_id: INT, secret: TOKEN };
    expect(await replaceIntegrationSecret(c.client, ORG, input)).toEqual({ ok: true, value: true });
    expect(await replaceIntegrationSecret(c.client, ORG, input)).toEqual({ ok: true, value: true });
    const [first, second] = c.calls.map((call) => call.args[0] as Record<string, unknown>);
    expect(first?.p_secret_id).not.toBe(second?.p_secret_id);
    expect(first?.p_ciphertext).not.toBe(second?.p_ciphertext);
    expect(JSON.stringify(c.calls)).not.toContain(TOKEN);
  });

  it("intégration inconnue (PT404) = not_found ; déconnectée (P0001) = conflict ; sans clé maître = 503 sans appel", async () => {
    c.result.rpc = () => ({ data: null, error: { code: "PT404" } });
    expect(await replaceIntegrationSecret(c.client, ORG, { integration_id: INT, secret: TOKEN })).toEqual({ ok: false, code: "not_found" });
    c.result.rpc = () => ({ data: null, error: { code: "P0001", message: "integration_not_replaceable" } });
    expect(await replaceIntegrationSecret(c.client, ORG, { integration_id: INT, secret: TOKEN })).toEqual({ ok: false, code: "conflict" });
    state.keyRing = null;
    c.calls.length = 0;
    expect(await replaceIntegrationSecret(c.client, ORG, { integration_id: INT, secret: TOKEN })).toEqual({ ok: false, code: "service_unavailable" });
    expect(c.calls).toHaveLength(0);
  });
});

describe("replaceWebhookSecret (secret de webhook, J32)", () => {
  const WEBHOOK_SECRET = "mot-de-passe-de-webhook-de-test-0123456789";

  it("chiffre avant l'appel (AAD de l'entreprise), appelle la fonction du secret de WEBHOOK, ne renvoie ni ne journalise le secret", async () => {
    expect(await replaceWebhookSecret(c.client, ORG, { integration_id: INT, secret: WEBHOOK_SECRET })).toEqual({ ok: true, value: true });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.op).toBe("rpc:set_integration_webhook_secret");
    const args = c.calls[0]?.args[0] as Record<string, unknown>;
    expect(args).toMatchObject({ p_org: ORG, p_integration: INT, p_key_version: 1 });
    expect(JSON.stringify(c.calls)).not.toContain(WEBHOOK_SECRET);
    const opened = openOrganizationSecret({
      organizationId: ORG,
      stored: { secretId: String(args.p_secret_id), ciphertext: String(args.p_ciphertext), nonce: String(args.p_nonce), keyVersion: 1 },
      keyRing,
    });
    expect(opened).toBe(WEBHOOK_SECRET);
  });

  it("un secret chiffré pour une entreprise ne s'ouvre pas pour une autre", async () => {
    await replaceWebhookSecret(c.client, ORG, { integration_id: INT, secret: WEBHOOK_SECRET });
    const args = c.calls[0]?.args[0] as Record<string, unknown>;
    expect(() =>
      openOrganizationSecret({
        organizationId: "bb000000-0000-4000-8000-00000000000b",
        stored: { secretId: String(args.p_secret_id), ciphertext: String(args.p_ciphertext), nonce: String(args.p_nonce), keyVersion: 1 },
        keyRing,
      }),
    ).toThrow();
  });

  it("intégration inconnue (PT404) = not_found ; déconnectée (P0001) = conflict ; sans clé maître = 503 sans appel", async () => {
    c.result.rpc = () => ({ data: null, error: { code: "PT404" } });
    expect(await replaceWebhookSecret(c.client, ORG, { integration_id: INT, secret: WEBHOOK_SECRET })).toEqual({ ok: false, code: "not_found" });
    c.result.rpc = () => ({ data: null, error: { code: "P0001", message: "integration_not_replaceable" } });
    expect(await replaceWebhookSecret(c.client, ORG, { integration_id: INT, secret: WEBHOOK_SECRET })).toEqual({ ok: false, code: "conflict" });
    state.keyRing = null;
    c.calls.length = 0;
    expect(await replaceWebhookSecret(c.client, ORG, { integration_id: INT, secret: WEBHOOK_SECRET })).toEqual({ ok: false, code: "service_unavailable" });
    expect(c.calls).toHaveLength(0);
  });
});

describe("disconnectIntegration, createChannel, updateChannel", () => {
  it("déconnexion : appelle la fonction avec l'entreprise du contexte seulement", async () => {
    expect(await disconnectIntegration(c.client, ORG, { integration_id: INT })).toEqual({ ok: true, value: true });
    expect(c.calls[0]).toEqual({ op: "rpc:disconnect_integration", args: [{ p_org: ORG, p_integration: INT }] });
  });

  it("canal : création et mise à jour passent par les fonctions ; valeurs absentes envoyées nulles (inchangées)", async () => {
    c.result.rpc = (name) => ({ data: name === "create_channel" ? CH : null, error: null });
    expect(await createChannel(c.client, ORG, { integration_id: INT, type: "email", sender_identity: "ventes@exemple.test", project_scope: [] })).toEqual({ ok: true, value: { id: CH } });
    expect(await updateChannel(c.client, ORG, { channel_id: CH, send_paused: true })).toEqual({ ok: true, value: true });
    expect(c.calls[1]).toEqual({ op: "rpc:update_channel", args: [{ p_org: ORG, p_id: CH, p_scope: null, p_paused: true }] });
  });

  it("canal : type différent de l'intégration (P0001) = conflict ; projet étranger (22023) = validation_failed", async () => {
    c.result.rpc = () => ({ data: null, error: { code: "P0001", message: "integration_not_replaceable" } });
    expect(await createChannel(c.client, ORG, { integration_id: INT, type: "email", sender_identity: "x", project_scope: [] })).toEqual({ ok: false, code: "conflict" });
    c.result.rpc = () => ({ data: null, error: { code: "22023" } });
    expect(await updateChannel(c.client, ORG, { channel_id: CH, project_scope: ["aa000000-0000-4000-8000-00000000000c"] })).toEqual({ ok: false, code: "validation_failed" });
  });
});
