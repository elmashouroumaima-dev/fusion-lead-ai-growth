import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc: vi.fn() }) }));
vi.mock("./integration-secrets", () => ({ readIntegrationSecret: vi.fn() }));

import { validateIntegrationConnection, type ValidationDeps } from "./integration-validation";

const ORG = "11111111-1111-4111-8111-111111111111";
const INT = "22222222-2222-4222-8222-222222222222";
const PHONE = "106540352242922";
const TOKEN = "EAAG-SECRET-TOKEN-0123456789";
const USER = "33333333-3333-4333-8333-333333333333";

function supabase(row: Record<string, unknown> | null, error: unknown = null) {
  const calls: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (column: string, value: unknown) => {
    calls.push([column, value]);
    return chain;
  };
  chain.maybeSingle = async () => ({ data: row, error });
  return { client: { from: () => chain } as never, calls };
}
const whatsapp = { provider: "whatsapp", status: "pending", external_account_id: PHONE, has_secret: true };

function deps(overrides: Partial<ValidationDeps> = {}) {
  const written: Array<{ ok: boolean; code: string | null }> = [];
  const actors: string[] = [];
  const value: ValidationDeps = {
    readSecret: async () => TOKEN,
    validate: async () => ({ kind: "valid" }),
    setValidation: async (input) => {
      written.push({ ok: input.ok, code: input.code });
      actors.push(input.actorId);
    },
    ...overrides,
  };
  return { deps: value, written, actors };
}

describe("vérification d'une connexion WhatsApp (J34)", () => {
  it("jeton valide : essaie le numéro de l'intégration avec le jeton déchiffré, enregistre « ok » et renvoie active", async () => {
    const validate = vi.fn(async () => ({ kind: "valid" as const }));
    const d = deps({ validate });
    const { client, calls } = supabase(whatsapp);
    expect(await validateIntegrationConnection(client, ORG, INT, USER, d.deps)).toEqual({ status: "active" });
    expect(validate).toHaveBeenCalledWith({ phoneNumberId: PHONE, accessToken: TOKEN });
    expect(d.written).toEqual([{ ok: true, code: null }]);
    expect(d.actors).toEqual([USER]);
    // la lecture est bornée à l'entreprise du contexte ET à l'intégration demandée
    expect(calls).toEqual([["organization_id", ORG], ["id", INT]]);
  });

  it("jeton refusé, numéro introuvable ou réponse inexploitable : enregistre le CODE court et renvoie error", async () => {
    for (const code of ["provider_auth", "provider_account", "provider_unreadable"] as const) {
      const d = deps({ validate: async () => ({ kind: "invalid", code }) });
      expect(await validateIntegrationConnection(supabase(whatsapp).client, ORG, INT, USER, d.deps)).toEqual({ status: "error", code });
      expect(d.written).toEqual([{ ok: false, code }]);
    }
  });

  it("panne du fournisseur : 503 et RIEN n'est écrit (une intégration active ne passe pas en erreur pour une coupure)", async () => {
    const d = deps({ validate: async () => ({ kind: "invalid", code: "provider_unavailable" }) });
    await expect(validateIntegrationConnection(supabase({ ...whatsapp, status: "active" }).client, ORG, INT, USER, d.deps)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(d.written).toEqual([]);
  });

  it("intégration inconnue ou d'une autre entreprise (RLS) : not_found, aucun appel au fournisseur", async () => {
    const validate = vi.fn();
    const d = deps({ validate });
    await expect(validateIntegrationConnection(supabase(null).client, ORG, INT, USER, d.deps)).rejects.toMatchObject({ code: "not_found" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("autre fournisseur, sans jeton, déconnectée ou désactivée : validation_failed, aucun appel", async () => {
    for (const row of [
      { ...whatsapp, provider: "email" },
      { ...whatsapp, has_secret: false },
      { ...whatsapp, status: "disconnected" },
      { ...whatsapp, status: "disabled" },
    ]) {
      const validate = vi.fn();
      await expect(validateIntegrationConnection(supabase(row).client, ORG, INT, USER, deps({ validate }).deps)).rejects.toMatchObject({ code: "validation_failed" });
      expect(validate).not.toHaveBeenCalled();
    }
  });

  it("jeton illisible : 503 ; jeton absent : validation_failed ; lecture en erreur : 503 ; rien n'est écrit", async () => {
    let d = deps({ readSecret: async () => { throw new Error("secret_unreadable"); } });
    await expect(validateIntegrationConnection(supabase(whatsapp).client, ORG, INT, USER, d.deps)).rejects.toMatchObject({ code: "service_unavailable" });
    d = deps({ readSecret: async () => null });
    await expect(validateIntegrationConnection(supabase(whatsapp).client, ORG, INT, USER, d.deps)).rejects.toMatchObject({ code: "validation_failed" });
    d = deps();
    await expect(validateIntegrationConnection(supabase(null, { code: "XX000" }).client, ORG, INT, USER, d.deps)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(d.written).toEqual([]);
  });

  it("le jeton n'apparaît dans aucun résultat", async () => {
    const out = await validateIntegrationConnection(supabase(whatsapp).client, ORG, INT, USER, deps({ validate: async () => ({ kind: "invalid", code: "provider_auth" }) }).deps);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
