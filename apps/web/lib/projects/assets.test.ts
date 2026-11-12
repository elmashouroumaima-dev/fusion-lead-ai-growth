import { ASSET_MAX_BYTES, assetPathSchema, isAssetPathOf, type ProductRow, type ProjectRow } from "@fusion-leap/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { assetLinks, removeProductAsset, uploadProductAsset } from "./assets";

vi.mock("../service/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const ORG = "7f000000-0000-4000-8000-00000000000a";
const PROJECT = "7c100000-0000-4000-8000-0000000000a1";
const PRODUCT = "7d100000-0000-4000-8000-0000000000a1";
const NOW = "2026-11-18T10:00:00+00:00";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const file = (bytes: Uint8Array, name: string, type = "application/octet-stream") => new File([bytes as unknown as BlobPart], name, { type });

const product = (over: Partial<ProductRow> = {}): ProductRow => ({
  id: PRODUCT, organization_id: ORG, project_id: PROJECT, kind: "pack", offer: "Offre", price_hint: null, landing_url: null, assets: [], created_at: NOW, updated_at: NOW, ...over,
});
const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: PROJECT, organization_id: ORG, type: "custom", name: "P", status: "active", owner_id: null, settings: {}, created_at: NOW, updated_at: NOW, ...over,
});

function fakeClient() {
  const calls: string[] = [];
  const state: { product: ProductRow | null; project: ProjectRow | null; rpcError: unknown; rpcData: unknown; uploadError: unknown; signed: { path: string; signedUrl: string }[] } = {
    product: product(), project: project(), rpcError: null, rpcData: 0, uploadError: null, signed: [],
  };
  const upload = vi.fn(async () => {
    calls.push("upload");
    return { data: null, error: state.uploadError };
  });
  const remove = vi.fn(async () => {
    calls.push("remove");
    return { data: null, error: null };
  });
  const createSignedUrls = vi.fn(async (paths: string[]) => ({ data: state.signed.filter((s) => paths.includes(s.path)), error: null }));
  const rpc = vi.fn(async () => {
    calls.push("rpc");
    return { data: state.rpcError ? null : state.rpcData, error: state.rpcError };
  });
  const from = (table: "products" | "projects") => {
    const q: Record<string, unknown> = {};
    for (const name of ["select", "eq"]) q[name] = () => q;
    q.maybeSingle = () => Promise.resolve({ data: table === "products" ? state.product : state.project, error: null });
    return q;
  };
  const client = { rpc, from, storage: { from: () => ({ upload, remove, createSignedUrls }) } } as unknown as ServerSupabase;
  return { client, state, calls, upload, remove, createSignedUrls, rpc };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

describe("uploadProductAsset", () => {
  it("envoie avec le type RÉEL, un nom généré sous {entreprise}/{projet}/{uuid}/, puis associe le chemin au produit", async () => {
    const result = await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "Mon Logo (1).JPG", "image/jpeg"));
    expect(result.ok).toBe(true);
    const [path, , options] = c.upload.mock.calls[0] as unknown as [string, Uint8Array, { contentType: string; upsert: boolean }];
    expect(path).toMatch(new RegExp(`^${ORG}/${PROJECT}/[0-9a-f-]{36}/mon-logo-1\\.png$`));
    expect(assetPathSchema.safeParse(path).success).toBe(true);
    expect(isAssetPathOf(path, ORG, PROJECT)).toBe(true);
    // le type annoncé (jpeg) et l'extension du nom (.JPG) sont ignorés : ce sont les octets qui décident
    expect(options).toEqual({ contentType: "image/png", upsert: false });
    const args = c.rpc.mock.calls[0] as unknown as [string, { p_path: string; p_org: string; p_product: string }];
    expect(args[0]).toBe("append_product_asset");
    expect(args[1]).toEqual({ p_org: ORG, p_product: PRODUCT, p_path: path });
    expect(c.calls).toEqual(["upload", "rpc"]);
  });

  it("un PDF est envoyé en application/pdf", async () => {
    await uploadProductAsset(c.client, ORG, PRODUCT, file(PDF, "contrat.png"));
    const [path, , options] = c.upload.mock.calls[0] as unknown as [string, Uint8Array, { contentType: string }];
    expect(options.contentType).toBe("application/pdf");
    expect(path.endsWith("/contrat.pdf")).toBe(true);
  });

  it.each([
    ["aucun fichier", null, "file_missing"],
    ["fichier vide", file(new Uint8Array(0), "a.png"), "file_empty"],
    ["trop gros (taille annoncée)", file(new Uint8Array(ASSET_MAX_BYTES + 1), "a.png"), "file_too_large"],
    ["SVG déguisé en .png", file(new TextEncoder().encode("<svg><script>alert(1)</script></svg>"), "a.png", "image/png"), "file_type"],
    ["HTML", file(new TextEncoder().encode("<html></html>"), "a.pdf", "application/pdf"), "file_type"],
  ] as const)("%s : refusé, rien n'est envoyé ni enregistré", async (_label, input, code) => {
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, input)).toEqual({ ok: false, code });
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("produit introuvable ou d'une autre entreprise : not_found, rien n'est envoyé", async () => {
    c.state.product = null;
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "a.png"))).toEqual({ ok: false, code: "not_found" });
    expect(c.upload).not.toHaveBeenCalled();
  });

  it("projet archivé : conflict ; 50 fichiers déjà : too_many_files", async () => {
    c.state.project = project({ status: "archived" });
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "a.png"))).toEqual({ ok: false, code: "conflict" });
    c.state.project = project();
    c.state.product = product({ assets: Array.from({ length: 50 }, (_, i) => `${ORG}/${PROJECT}/7d100000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}/f.png`) });
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "a.png"))).toEqual({ ok: false, code: "too_many_files" });
    expect(c.upload).not.toHaveBeenCalled();
  });

  it("refus de la politique Storage (403) -> forbidden ; autre panne -> internal_error ; aucun enregistrement", async () => {
    c.state.uploadError = { message: "new row violates row-level security policy", statusCode: "403" };
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "a.png"))).toEqual({ ok: false, code: "forbidden" });
    c.state.uploadError = { message: "boom", statusCode: "500" };
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "a.png"))).toEqual({ ok: false, code: "internal_error" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("échec de l'enregistrement : l'objet envoyé est supprimé (aucun orphelin)", async () => {
    c.state.rpcError = { code: "P0001", message: "project_archived" };
    expect(await uploadProductAsset(c.client, ORG, PRODUCT, file(PNG, "a.png"))).toEqual({ ok: false, code: "conflict" });
    expect(c.calls).toEqual(["upload", "rpc", "remove"]);
    expect((c.remove.mock.calls[0] as unknown as [string[]])[0]).toEqual([(c.upload.mock.calls[0] as unknown as [string])[0]]);
  });
});

describe("removeProductAsset", () => {
  const owned = `${ORG}/${PROJECT}/7d100000-0000-4000-8000-000000000001/logo.png`;

  it("retire le chemin du produit D'ABORD (base), puis supprime l'objet", async () => {
    c.state.product = product({ assets: [owned, `${ORG}/${PROJECT}/7d100000-0000-4000-8000-000000000002/autre.pdf`] });
    const result = await removeProductAsset(c.client, ORG, PRODUCT, owned);
    expect(result.ok).toBe(true);
    expect(c.calls).toEqual(["rpc", "remove"]);
    expect(c.rpc.mock.calls[0]).toEqual(["remove_product_asset", { p_org: ORG, p_product: PRODUCT, p_path: owned }]);
    expect((c.remove.mock.calls[0] as unknown as [string[]])[0]).toEqual([owned]);
  });

  it("un objet encore référencé par un autre produit n'est PAS supprimé du Storage", async () => {
    c.state.product = product({ assets: [owned] });
    c.state.rpcData = 1;
    expect((await removeProductAsset(c.client, ORG, PRODUCT, owned)).ok).toBe(true);
    expect(c.remove).not.toHaveBeenCalled();
  });

  it("un chemin qui n'est PAS associé au produit n'est jamais supprimé (fichier d'un autre produit, d'une autre entreprise, inventé)", async () => {
    c.state.product = product({ assets: [owned] });
    for (const path of [
      `${ORG}/${PROJECT}/7d100000-0000-4000-8000-000000000009/inconnu.png`,
      `7f000000-0000-4000-8000-00000000000b/7c100000-0000-4000-8000-0000000000b1/7d100000-0000-4000-8000-000000000003/beta.png`,
      "n-importe-quoi",
    ]) {
      expect(await removeProductAsset(c.client, ORG, PRODUCT, path), path).toEqual({ ok: false, code: "not_found" });
    }
    expect(c.rpc).not.toHaveBeenCalled();
    expect(c.remove).not.toHaveBeenCalled();
  });

  it("produit introuvable : not_found ; projet archivé : conflict ; échec de l'enregistrement : l'objet est conservé", async () => {
    c.state.product = null;
    expect(await removeProductAsset(c.client, ORG, PRODUCT, owned)).toEqual({ ok: false, code: "not_found" });
    c.state.product = product({ assets: [owned] });
    c.state.project = project({ status: "archived" });
    expect(await removeProductAsset(c.client, ORG, PRODUCT, owned)).toEqual({ ok: false, code: "conflict" });
    c.state.project = project();
    c.state.rpcError = { code: "42501", message: "forbidden" };
    expect(await removeProductAsset(c.client, ORG, PRODUCT, owned)).toEqual({ ok: false, code: "forbidden" });
    expect(c.remove).not.toHaveBeenCalled();
  });
});

describe("assetLinks", () => {
  const image = `${ORG}/${PROJECT}/7d100000-0000-4000-8000-000000000001/logo.png`;
  const doc = `${ORG}/${PROJECT}/7d100000-0000-4000-8000-000000000002/contrat.pdf`;

  it("liens signés de 60 s ; les PDF en téléchargement forcé, les images en affichage", async () => {
    c.state.signed = [{ path: image, signedUrl: "https://s/img?token=a" }, { path: doc, signedUrl: "https://s/doc?token=b" }];
    const links = await assetLinks(c.client, [image, doc]);
    expect(links).toEqual([
      { path: image, name: "logo.png", image: true, url: "https://s/img?token=a" },
      { path: doc, name: "contrat.pdf", image: false, url: "https://s/doc?token=b" },
    ]);
    const calls = c.createSignedUrls.mock.calls as unknown as [string[], number, { download: boolean } | undefined][];
    expect(calls.map((call) => call[1])).toEqual([60, 60]);
    expect(calls.find((call) => call[0].includes(doc))?.[2]).toEqual({ download: true });
    expect(calls.find((call) => call[0].includes(image))?.[2]).toBeUndefined();
  });

  it("aucun chemin : aucun appel ; lien indisponible : url null (jamais d'erreur)", async () => {
    expect(await assetLinks(c.client, [])).toEqual([]);
    expect(c.createSignedUrls).not.toHaveBeenCalled();
    const links = await assetLinks(c.client, [image]);
    expect(links).toEqual([{ path: image, name: "logo.png", image: true, url: null }]);
  });
});
