import type { CreateProductInput, CreateProjectInput, ProductRow, ProjectRow } from "@fusion-leap/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { createProduct, createProject, setProjectStatus, updateProduct, updateProject } from "./service";

const ORG = "7b000000-0000-4000-8000-00000000000a";
const PROJECT = "7c000000-0000-4000-8000-0000000000a1";
const PRODUCT = "7d000000-0000-4000-8000-0000000000a1";
const OWNER = "7a000000-0000-4000-8000-000000000001";
const NOW = "2026-11-18T10:00:00+00:00";

const projectRow = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: PROJECT, organization_id: ORG, type: "salla_app", name: "App", status: "active", owner_id: OWNER, settings: {}, created_at: NOW, updated_at: NOW, ...over,
});
const productRow = (over: Partial<ProductRow> = {}): ProductRow => ({
  id: PRODUCT, organization_id: ORG, project_id: PROJECT, kind: "pack", offer: "Offre", price_hint: null, landing_url: null, assets: [], created_at: NOW, updated_at: NOW, ...over,
});

/** Faux client : `rpc` programmable ; `from(table)...maybeSingle()` renvoie la ligne programmée pour la table. */
function fakeClient() {
  const rpc = vi.fn();
  const rows: { projects: unknown; products: unknown; failRead: boolean } = { projects: projectRow(), products: productRow(), failRead: false };
  const from = (table: "projects" | "products") => {
    const q: Record<string, unknown> = {};
    for (const name of ["select", "eq"]) q[name] = () => q;
    q.maybeSingle = () => (rows.failRead ? Promise.resolve({ data: null, error: { code: "XX000" } }) : Promise.resolve({ data: rows[table], error: null }));
    return q;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, rows };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const createInput = (over: Partial<CreateProjectInput> = {}): CreateProjectInput => ({ type: "salla_app", name: "App", settings: {}, ...over }) as CreateProjectInput;

describe("createProject", () => {
  it("appelle la fonction SQL avec l'entreprise du CONTEXTE et relit la ligne", async () => {
    c.rpc.mockResolvedValue({ data: PROJECT, error: null });
    const result = await createProject(c.client, ORG, createInput({ owner_id: OWNER }));
    expect(c.rpc).toHaveBeenCalledWith("create_project", { p_org: ORG, p_type: "salla_app", p_name: "App", p_settings: {}, p_owner: OWNER });
    expect(result).toEqual({ ok: true, value: projectRow() });
  });

  it("propriétaire absent -> null ; un organization_id réclamé n'est jamais transmis", async () => {
    c.rpc.mockResolvedValue({ data: PROJECT, error: null });
    await createProject(c.client, ORG, { ...createInput(), organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const args = c.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_owner).toBeNull();
    expect(args.p_org).toBe(ORG);
    expect(JSON.stringify(args)).not.toContain("bbbbbbbb");
  });

  it.each([
    [{ code: "P0001", message: "quota_exceeded" }, "quota_exceeded"],
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "P0001", message: "owner_invalid" }, "validation_failed"],
    [{ code: "XX000", message: "boom" }, "internal_error"],
  ] as const)("erreur de base %j -> code %s", async (error, code) => {
    c.rpc.mockResolvedValue({ data: null, error });
    expect(await createProject(c.client, ORG, createInput())).toEqual({ ok: false, code });
  });

  it("réponse inattendue ou relecture impossible -> internal_error", async () => {
    c.rpc.mockResolvedValue({ data: 42, error: null });
    expect(await createProject(c.client, ORG, createInput())).toEqual({ ok: false, code: "internal_error" });
    c.rpc.mockResolvedValue({ data: PROJECT, error: null });
    c.rows.failRead = true;
    expect(await createProject(c.client, ORG, createInput())).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("updateProject", () => {
  const input = { project_id: PROJECT, name: "Nouveau nom", settings: { app_name: "A" } };

  it("valide les réglages selon le TYPE du projet (lu en base) puis appelle la fonction", async () => {
    c.rpc.mockResolvedValue({ data: null, error: null });
    const result = await updateProject(c.client, ORG, { ...input, owner_id: null });
    expect(c.rpc).toHaveBeenCalledWith("update_project", { p_org: ORG, p_id: PROJECT, p_name: "Nouveau nom", p_settings: { app_name: "A" }, p_owner: null });
    expect(result.ok).toBe(true);
  });

  it("propriétaire non précisé : conservé ; null explicite : retiré", async () => {
    c.rpc.mockResolvedValue({ data: null, error: null });
    await updateProject(c.client, ORG, input);
    expect((c.rpc.mock.calls[0]?.[1] as { p_owner: unknown }).p_owner).toBe(OWNER);
    await updateProject(c.client, ORG, { ...input, owner_id: null });
    expect((c.rpc.mock.calls[1]?.[1] as { p_owner: unknown }).p_owner).toBeNull();
  });

  it("réglages d'un autre type refusés avant tout appel d'écriture", async () => {
    const result = await updateProject(c.client, ORG, { ...input, settings: { offers: ["x"] } });
    expect(result).toEqual({ ok: false, code: "validation_failed" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("projet introuvable (ou d'une autre entreprise) -> not_found, sans appel d'écriture", async () => {
    c.rows.projects = null;
    expect(await updateProject(c.client, ORG, input)).toEqual({ ok: false, code: "not_found" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("lecture impossible -> internal_error ; projet archivé -> conflict", async () => {
    c.rows.failRead = true;
    expect(await updateProject(c.client, ORG, input)).toEqual({ ok: false, code: "internal_error" });
    c.rows.failRead = false;
    c.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "project_archived" } });
    expect(await updateProject(c.client, ORG, input)).toEqual({ ok: false, code: "conflict" });
  });
});

describe("setProjectStatus", () => {
  it("archive et réactive par la fonction SQL ; le quota de réactivation est jugé par la base", async () => {
    c.rpc.mockResolvedValue({ data: null, error: null });
    expect((await setProjectStatus(c.client, ORG, { project_id: PROJECT, status: "archived" })).ok).toBe(true);
    expect(c.rpc).toHaveBeenCalledWith("set_project_status", { p_org: ORG, p_id: PROJECT, p_status: "archived" });
    c.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "quota_exceeded" } });
    expect(await setProjectStatus(c.client, ORG, { project_id: PROJECT, status: "active" })).toEqual({ ok: false, code: "quota_exceeded" });
  });
});

describe("produits", () => {
  const input: CreateProductInput = { project_id: PROJECT, kind: "pack", offer: "Offre", assets: [] };

  it("crée un produit (champs facultatifs -> null) et relit la ligne", async () => {
    c.rpc.mockResolvedValue({ data: PRODUCT, error: null });
    const result = await createProduct(c.client, ORG, input);
    expect(c.rpc).toHaveBeenCalledWith("create_product", { p_org: ORG, p_project: PROJECT, p_kind: "pack", p_offer: "Offre", p_price_hint: null, p_landing_url: null, p_assets: [] });
    expect(result).toEqual({ ok: true, value: productRow() });
  });

  it("projet d'une autre entreprise -> not_found ; projet archivé -> conflict", async () => {
    c.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found" } });
    expect(await createProduct(c.client, ORG, input)).toEqual({ ok: false, code: "not_found" });
    c.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "project_archived" } });
    expect(await createProduct(c.client, ORG, input)).toEqual({ ok: false, code: "conflict" });
  });

  it("modifie un produit", async () => {
    c.rpc.mockResolvedValue({ data: null, error: null });
    const result = await updateProduct(c.client, ORG, { product_id: PRODUCT, kind: "pack", offer: "Offre v2", assets: [], landing_url: "https://exemple.test" });
    expect(c.rpc).toHaveBeenCalledWith("update_product", { p_org: ORG, p_id: PRODUCT, p_kind: "pack", p_offer: "Offre v2", p_price_hint: null, p_landing_url: "https://exemple.test", p_assets: [] });
    expect(result.ok).toBe(true);
  });
});
