import { randomBytes } from "node:crypto";
import { createKeyRing, createUnsubscribeToken } from "@fusion-leap/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, getKeyRing } = vi.hoisted(() => ({ rpc: vi.fn(), getKeyRing: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("../smtp/secrets", () => ({ getKeyRing }));

import { applyUnsubscribe, isValidUnsubscribeToken } from "./unsubscribe";

const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const ring = createKeyRing(1, { 1: randomBytes(32).toString("base64") });
const token = createUnsubscribeToken(ring, { organizationId: ORG, messageId: MSG });

beforeEach(() => {
  rpc.mockReset();
  getKeyRing.mockReset();
  getKeyRing.mockReturnValue(ring);
});

describe("désabonnement public (service_role)", () => {
  it("jeton valide : appelle unsubscribe_apply avec l'entreprise et le message DU JETON, rien d'autre", async () => {
    rpc.mockResolvedValue({ data: { outcome: "applied", revoked: 1, cancelled: 0 }, error: null });
    expect(await applyUnsubscribe(token)).toBe("applied");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("unsubscribe_apply", { p_org: ORG, p_message: MSG });
  });

  it("déjà désabonné : « already » (idempotent)", async () => {
    rpc.mockResolvedValue({ data: { outcome: "already" }, error: null });
    expect(await applyUnsubscribe(token)).toBe("already");
  });

  it("jeton falsifié, mal formé ou d'une autre clé : « invalid » SANS appel à la base", async () => {
    const other = createUnsubscribeToken(createKeyRing(1, { 1: randomBytes(32).toString("base64") }), { organizationId: ORG, messageId: MSG });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of [other, tampered, "", "n'importe quoi", token.replace(MSG, "33333333-3333-4333-8333-333333333333")]) {
      expect(await applyUnsubscribe(bad)).toBe("invalid");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("message inconnu (PT404) ou valeur refusée (22023) : « invalid » ; autre erreur de la base : 503 opaque", async () => {
    for (const code of ["PT404", "22023"]) {
      rpc.mockResolvedValue({ data: null, error: { code, message: "détail SQL" } });
      expect(await applyUnsubscribe(token)).toBe("invalid");
    }
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "détail SQL secret" } });
    await expect(applyUnsubscribe(token)).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("réponse inattendue de la base : 500", async () => {
    rpc.mockResolvedValue({ data: { outcome: "bizarre" }, error: null });
    await expect(applyUnsubscribe(token)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("sans clé de signature : 503 (le lien reste utilisable plus tard), la base n'est pas appelée", async () => {
    getKeyRing.mockReturnValue(null);
    await expect(applyUnsubscribe(token)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
    expect(isValidUnsubscribeToken(token)).toBe(false);
  });

  it("isValidUnsubscribeToken : vrai seulement pour une signature valide, aucune écriture", () => {
    expect(isValidUnsubscribeToken(token)).toBe(true);
    expect(isValidUnsubscribeToken(token + "x")).toBe(false);
    expect(isValidUnsubscribeToken("v1.1.a.b.c")).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
