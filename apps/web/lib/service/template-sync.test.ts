import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc: vi.fn() }) }));
vi.mock("./integration-secrets", () => ({ readIntegrationSecret: vi.fn() }));

import { syncWhatsAppTemplates, type TemplateSyncDeps } from "./template-sync";

const ORG = "11111111-1111-4111-8111-111111111111";
const INT = "22222222-2222-4222-8222-222222222222";
const CH = "33333333-3333-4333-8333-333333333333";
const WABA = "102290129340398";
const TOKEN = "EAAG-SECRET-TOKEN-0123456789";
const input = { integrationId: INT, channelId: CH, wabaId: WABA };

type Row = Record<string, unknown> | null;
function supabase(integration: Row, channel: Row, errors: { integration?: unknown; channel?: unknown } = {}) {
  const filters: Array<[string, string, unknown]> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (column: string, value: unknown) => {
      filters.push([table, column, value]);
      return chain;
    };
    chain.maybeSingle = async () => (table === "integrations" ? { data: integration, error: errors.integration ?? null } : { data: channel, error: errors.channel ?? null });
    return chain;
  };
  return { client: { from } as never, filters };
}
const whatsapp = { provider: "whatsapp", status: "active", has_secret: true };

function deps(overrides: Partial<TemplateSyncDeps> = {}) {
  const synced: Array<{ channelId: string; items: unknown[] }> = [];
  const value: TemplateSyncDeps = {
    readSecret: async () => TOKEN,
    list: async () => ({ kind: "ok", items: [{ name: "offre_ete", language: "fr", category: "marketing", status: "approved", components: [] }], skipped: 2 }),
    sync: async ({ channelId, items }) => {
      synced.push({ channelId, items });
      return { inserted: 1, updated: 0, unchanged: 0 };
    },
    ...overrides,
  };
  return { deps: value, synced };
}

describe("synchronisation des modèles WhatsApp (J36)", () => {
  it("liste Meta avec le jeton déchiffré et le compte demandé, écrit pour le canal de la requête ; renvoie les compteurs", async () => {
    const list = vi.fn(async () => ({ kind: "ok" as const, items: [], skipped: 3 }));
    const d = deps({ list });
    const { client, filters } = supabase(whatsapp, { id: CH });
    expect(await syncWhatsAppTemplates(client, ORG, input, d.deps)).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 3 });
    expect(list).toHaveBeenCalledWith({ wabaId: WABA, accessToken: TOKEN });
    expect(d.synced.map((s) => s.channelId)).toEqual([CH]);
    // lectures bornées à l'entreprise du contexte, à l'intégration et au canal demandés
    expect(filters).toEqual([["integrations", "organization_id", ORG], ["integrations", "id", INT], ["channels", "organization_id", ORG], ["channels", "integration_id", INT], ["channels", "id", CH]]);
  });

  it("intégration inconnue ou d'une autre entreprise (RLS), canal d'une autre intégration : not_found, aucun appel à Meta", async () => {
    const list = vi.fn();
    await expect(syncWhatsAppTemplates(supabase(null, { id: CH }).client, ORG, input, deps({ list }).deps)).rejects.toMatchObject({ code: "not_found" });
    await expect(syncWhatsAppTemplates(supabase(whatsapp, null).client, ORG, input, deps({ list }).deps)).rejects.toMatchObject({ code: "not_found" });
    expect(list).not.toHaveBeenCalled();
  });

  it("autre fournisseur, sans jeton, déconnectée ou désactivée : validation_failed, aucun appel", async () => {
    for (const row of [{ ...whatsapp, provider: "email" }, { ...whatsapp, has_secret: false }, { ...whatsapp, status: "disconnected" }, { ...whatsapp, status: "disabled" }]) {
      const list = vi.fn();
      await expect(syncWhatsAppTemplates(supabase(row, { id: CH }).client, ORG, input, deps({ list }).deps)).rejects.toMatchObject({ code: "validation_failed" });
      expect(list).not.toHaveBeenCalled();
    }
  });

  it("jeton ou compte refusé par Meta : validation_failed ; panne ou réponse illisible : 503 ; rien n'est écrit", async () => {
    for (const [code, expected] of [["provider_auth", "validation_failed"], ["provider_account", "validation_failed"], ["provider_unavailable", "service_unavailable"], ["provider_unreadable", "service_unavailable"]] as const) {
      const d = deps({ list: async () => ({ kind: "error", code }) });
      await expect(syncWhatsAppTemplates(supabase(whatsapp, { id: CH }).client, ORG, input, d.deps)).rejects.toMatchObject({ code: expected });
      expect(d.synced).toEqual([]);
    }
  });

  it("jeton illisible : 503 ; jeton absent : validation_failed ; lecture en erreur : 503", async () => {
    await expect(syncWhatsAppTemplates(supabase(whatsapp, { id: CH }).client, ORG, input, deps({ readSecret: async () => { throw new Error("secret_unreadable"); } }).deps)).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(syncWhatsAppTemplates(supabase(whatsapp, { id: CH }).client, ORG, input, deps({ readSecret: async () => null }).deps)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(syncWhatsAppTemplates(supabase(null, null, { integration: { code: "XX000" } }).client, ORG, input, deps().deps)).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("le jeton n'apparaît dans aucun résultat", async () => {
    const out = await syncWhatsAppTemplates(supabase(whatsapp, { id: CH }).client, ORG, input, deps().deps);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
