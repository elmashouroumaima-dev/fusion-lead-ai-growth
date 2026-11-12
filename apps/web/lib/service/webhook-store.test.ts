import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import { createWebhookStore } from "./webhook-store";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INT = "11111111-1111-4111-8111-111111111111";
const store = createWebhookStore();
const record = () => store.record({ organizationId: ORG, integrationId: INT, provider: "whatsapp", externalEventId: "wamid.1", payload: { a: 1 } });

beforeEach(() => {
  rpc.mockReset();
});

describe("magasin des webhooks (service_role)", () => {
  it("resolve : appelle la fonction avec fournisseur et compte seulement ; renvoie l'entreprise et l'intégration, ou null", async () => {
    rpc.mockResolvedValue({ data: { organization_id: ORG, integration_id: INT }, error: null });
    expect(await store.resolve("whatsapp", "compte")).toEqual({ organizationId: ORG, integrationId: INT });
    expect(rpc).toHaveBeenCalledWith("webhook_resolve_integration", { p_provider: "whatsapp", p_account: "compte" });
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await store.resolve("whatsapp", "inconnu")).toBeNull();
  });

  it("resolve : erreur de la base = 503 opaque ; réponse inattendue = 500", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "détail SQL secret" } });
    await expect(store.resolve("whatsapp", "c")).rejects.toMatchObject({ code: "service_unavailable" });
    rpc.mockResolvedValue({ data: { organization_id: 12 }, error: null });
    await expect(store.resolve("whatsapp", "c")).rejects.toMatchObject({ code: "internal_error" });
  });

  it("record : transmet l'entreprise résolue, l'intégration, l'identifiant et le payload ; renvoie l'identifiant et le rejeu", async () => {
    rpc.mockResolvedValue({ data: { event_id: "evt-1", duplicate: false }, error: null });
    expect(await record()).toEqual({ eventId: "evt-1", duplicate: false });
    expect(rpc).toHaveBeenCalledWith("webhook_record", { p_org: ORG, p_integration: INT, p_provider: "whatsapp", p_event_id: "wamid.1", p_payload: { a: 1 } });
    rpc.mockResolvedValue({ data: { event_id: "evt-1", duplicate: true }, error: null });
    expect(await record()).toEqual({ eventId: "evt-1", duplicate: true });
  });

  it("record : identifiant mal formé (23514), valeur invalide (22023), caractère non représentable en jsonb (22P05), ligne trop grosse (54000) = 400", async () => {
    for (const code of ["23514", "22023", "22P05", "54000"]) {
      rpc.mockResolvedValue({ data: null, error: { code } });
      await expect(record(), code).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  it("record : file saturée (P0001), panne ou intégration introuvable = 503 (le fournisseur réessaie) ; réponse inattendue = 500", async () => {
    for (const error of [{ code: "P0001", message: "too_many_webhooks" }, { code: "PT404" }, { code: "08006" }]) {
      rpc.mockResolvedValue({ data: null, error });
      await expect(record()).rejects.toMatchObject({ code: "service_unavailable" });
    }
    rpc.mockResolvedValue({ data: { event_id: 1 }, error: null });
    await expect(record()).rejects.toMatchObject({ code: "internal_error" });
  });

  it("recordRejection : ne lève jamais (réponse en erreur ou exception), pour que le refus 401 soit renvoyé quand même", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(store.recordRejection({ organizationId: ORG, integrationId: INT, provider: "whatsapp" })).resolves.toBeUndefined();
    rpc.mockImplementation(async () => {
      throw new Error("réseau coupé");
    });
    await expect(store.recordRejection({ organizationId: ORG, integrationId: INT, provider: "whatsapp" })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenLastCalledWith("webhook_record_rejection", { p_org: ORG, p_integration: INT, p_provider: "whatsapp" });
  });
});
