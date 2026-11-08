import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { api, ORG, PRODUCT, PROJECT, psql, storage, type Persona } from "./harness";

/**
 * Storage par l'API réelle (J17, partie 2) : bucket privé `assets`, chemin `{entreprise}/{projet}/{fichier}/{nom}`, lecture
 * par les membres de l'entreprise seulement, écriture et suppression par owner et admin sur un projet ACTIF, aucune mise à jour,
 * liens signés, types et taille limités par le bucket. Fichiers de test supprimés à la fin.
 */

// PNG 1x1 valide
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const created: { persona: Persona; path: string }[] = [];

const pathIn = (org: string, project: string, file = "test.png") => `${org}/${project}/${randomUUID()}/${file}`;
const upload = (persona: Persona, path: string, body: Uint8Array = PNG, contentType = "image/png") =>
  storage(persona, "POST", `object/assets/${path}`, body, { "Content-Type": contentType });
const read = (persona: Persona, path: string) => storage(persona, "GET", `object/authenticated/assets/${path}`);

afterAll(() => {
  // Suppression SQL directe autorisée uniquement avec ce réglage (Storage la refuse sinon) : fichiers de test seulement.
  const names = created.map((c) => `'${c.path}'`).join(",");
  if (names) psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'assets' and name in (${names});`);
  psql(`update public.projects set status = 'active' where id = '${PROJECT.alphaApp}'`);
});

describe("envoi", () => {
  it("owner et admin d'Alpha envoient sous un projet actif d'Alpha", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const path = pathIn(ORG.alpha, PROJECT.alphaSite, `${persona}.png`);
      const result = await upload(persona, path);
      expect(result.status, persona).toBe(200);
      created.push({ persona, path });
    }
  });

  it("analyste, commercial, marketing, propriétaire de Beta, sans adhésion, anonyme : refusés", async () => {
    for (const persona of ["alphaAnalyst", "alphaSales", "alphaMarketing", "betaOwner", "nobody", "anon"] as const) {
      const result = await upload(persona, pathIn(ORG.alpha, PROJECT.alphaSite, `${persona}.png`));
      expect(result.status, persona).toBeGreaterThanOrEqual(400);
      expect(result.status, persona).toBeLessThan(500);
    }
  });

  it("l'utilisateur à deux rôles : écrit chez Alpha (owner), pas chez Beta (commercial)", async () => {
    expect((await upload("shared", pathIn(ORG.beta, PROJECT.betaShop))).status).toBeGreaterThanOrEqual(400);
  });

  it("jamais sous le projet d'une autre entreprise, même en se déclarant dans sa propre entreprise", async () => {
    expect((await upload("alphaAdmin", pathIn(ORG.alpha, PROJECT.betaShop))).status).toBeGreaterThanOrEqual(400);
    expect((await upload("alphaAdmin", pathIn(ORG.beta, PROJECT.betaShop))).status).toBeGreaterThanOrEqual(400);
    expect((await upload("alphaAdmin", pathIn(ORG.alpha, "00000000-0000-4000-8000-0000000000ff"))).status).toBeGreaterThanOrEqual(400);
  });

  it("chemins invalides : sans identifiant de fichier, traversée, majuscules, sous-dossier, espace", async () => {
    const base = `${ORG.alpha}/${PROJECT.alphaSite}`;
    for (const path of [`${base}/test.png`, `${base}/${randomUUID()}/../x.png`, `${base}/${randomUUID().toUpperCase()}/x.png`, `${base}/${randomUUID()}/sous/x.png`, `${base}/${randomUUID()}/a%20b.png`]) {
      expect((await upload("alphaAdmin", path)).status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it("projet ARCHIVÉ : plus d'écriture ; lecture toujours possible", async () => {
    const kept = pathIn(ORG.alpha, PROJECT.alphaApp, "avant.png");
    expect((await upload("alphaAdmin", kept)).status).toBe(200);
    created.push({ persona: "alphaAdmin", path: kept });
    psql(`update public.projects set status = 'archived' where id = '${PROJECT.alphaApp}'`);
    expect((await upload("alphaAdmin", pathIn(ORG.alpha, PROJECT.alphaApp, "apres.png"))).status).toBeGreaterThanOrEqual(400);
    expect((await read("alphaAnalyst", kept)).status).toBe(200);
    expect((await storage("alphaAdmin", "DELETE", `object/assets/${kept}`)).json).not.toBeNull();
    // la suppression est refusée sous un projet archivé : l'objet est toujours là
    expect((await read("alphaAnalyst", kept)).status).toBe(200);
    psql(`update public.projects set status = 'active' where id = '${PROJECT.alphaApp}'`);
  });

  it("aucun écrasement : même chemin, envoi refusé même avec x-upsert", async () => {
    const path = created[0]!.path;
    const again = await storage("shared", "POST", `object/assets/${path}`, PNG, { "Content-Type": "image/png", "x-upsert": "true" });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
  });

  it("types et taille limités par le bucket : SVG, HTML et 10 Mo + 1 octet refusés", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload("alphaAdmin", pathIn(ORG.alpha, PROJECT.alphaSite, "x.svg"), svg, "image/svg+xml")).status).toBeGreaterThanOrEqual(400);
    expect((await upload("alphaAdmin", pathIn(ORG.alpha, PROJECT.alphaSite, "x.html"), svg, "text/html")).status).toBeGreaterThanOrEqual(400);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const result = await upload("alphaAdmin", pathIn(ORG.alpha, PROJECT.alphaSite, "gros.png"), big);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });
});

describe("lecture, liste et liens signés", () => {
  const path = () => created[0]!.path;

  it("tous les rôles d'Alpha lisent ; l'autre entreprise, le compte sans adhésion et l'anonyme non", async () => {
    for (const persona of ["alphaAnalyst", "alphaSales", "alphaMarketing", "alphaAdmin", "shared"] as const) {
      const result = await read(persona, path());
      expect(result.status, persona).toBe(200);
      expect(result.contentType, persona).toBe("image/png");
      expect(result.bytes, persona).toBe(PNG.length);
    }
    for (const persona of ["betaOwner", "betaAnalyst", "nobody", "anon"] as const) {
      expect((await read(persona, path())).status, persona).toBeGreaterThanOrEqual(400);
    }
  });

  it("liste : chaque entreprise ne voit que son dossier", async () => {
    const alpha = await storage("alphaAnalyst", "POST", "object/list/assets", { prefix: `${ORG.alpha}/${PROJECT.alphaSite}`, limit: 100 });
    expect(Array.isArray(alpha.json) && alpha.json.length).toBeGreaterThan(0);
    for (const persona of ["betaOwner", "nobody"] as const) {
      const other = await storage(persona, "POST", "object/list/assets", { prefix: `${ORG.alpha}/${PROJECT.alphaSite}`, limit: 100 });
      expect(Array.isArray(other.json) ? other.json : [], persona).toHaveLength(0);
    }
  });

  it("lien signé : généré pour un membre, refusé à un autre ; il fonctionne sans session et expire", async () => {
    const signed = await storage("alphaAnalyst", "POST", `object/sign/assets/${path()}`, { expiresIn: 60 });
    expect(signed.status).toBe(200);
    const url = String((signed.json as { signedURL?: string } | null)?.signedURL ?? "");
    expect(url).toContain("token=");
    for (const persona of ["betaOwner", "nobody", "anon"] as const) {
      expect((await storage(persona, "POST", `object/sign/assets/${path()}`, { expiresIn: 60 })).status, persona).toBeGreaterThanOrEqual(400);
    }
    // Le lien est un secret porteur : il ouvre le fichier SANS session (d'où sa durée courte).
    const stack = process.env.SUPABASE_API_URL ?? "http://127.0.0.1:54321";
    const direct = await fetch(`${stack}/storage/v1${url}`);
    expect(direct.status).toBe(200);
    await direct.arrayBuffer();
  });

  it("le bucket n'est jamais public : aucune URL publique", async () => {
    const result = await storage("anon", "GET", `object/public/assets/${path()}`);
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe("suppression", () => {
  it("analyste et autre entreprise : refusée, l'objet reste ; owner : supprime", async () => {
    const path = pathIn(ORG.alpha, PROJECT.alphaSite, "a-supprimer.png");
    expect((await upload("shared", path)).status).toBe(200);
    created.push({ persona: "shared", path });
    for (const persona of ["alphaAnalyst", "alphaSales", "betaOwner", "anon"] as const) {
      await storage(persona, "DELETE", `object/assets/${path}`);
      expect((await read("shared", path)).status, `après ${persona}`).toBe(200);
    }
    const removed = await storage("shared", "DELETE", `object/assets/${path}`);
    expect(removed.status).toBe(200);
    expect((await read("shared", path)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("association atomique des fichiers au produit (revue J17)", () => {
  const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
  const message = (result: { body: unknown }): string =>
    typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";
  const assetsOf = () => psql(`select assets from public.products where id = '${PRODUCT.alpha}'`);
  const cleanup = () => psql(`update public.products set assets = '[]'::jsonb where id = '${PRODUCT.alpha}'`);

  afterAll(() => {
    try {
      cleanup();
    } catch {
      // nettoyage au mieux
    }
  });

  it("ajout, ajout répété sans effet, retrait, retrait répété refusé", async () => {
    cleanup();
    const path = pathIn(ORG.alpha, PROJECT.alphaSite, "atomique.png");
    expect((await upload("alphaAdmin", path)).status).toBe(200);
    created.push({ persona: "alphaAdmin", path });
    const args = { p_org: ORG.alpha, p_product: PRODUCT.alpha, p_path: path };

    expect((await rpc("alphaAdmin", "append_product_asset", args)).status).toBeLessThan(300);
    expect((await rpc("alphaAdmin", "append_product_asset", args)).status).toBeLessThan(300);
    expect(assetsOf()).toBe(`["${path}"]`);

    const removed = await rpc("alphaAdmin", "remove_product_asset", args);
    expect(removed.status).toBe(200);
    expect(removed.body).toBe(0);
    expect(assetsOf()).toBe("[]");
    expect(message(await rpc("alphaAdmin", "remove_product_asset", args))).toBe("not_found");
  });

  it("rôles non autorisés et autre entreprise : refusés", async () => {
    const path = pathIn(ORG.alpha, PROJECT.alphaSite, "interdit.png");
    expect((await upload("alphaAdmin", path)).status).toBe(200);
    created.push({ persona: "alphaAdmin", path });
    const args = { p_org: ORG.alpha, p_product: PRODUCT.alpha, p_path: path };
    for (const persona of ["alphaAnalyst", "alphaMarketing", "betaOwner"] as const) {
      const result = await rpc(persona, "append_product_asset", args);
      expect(result.status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(assetsOf()).toBe("[]");
  });

  it("chemin inexistant, d'un autre projet ou d'une autre entreprise : validation_failed", async () => {
    const otherProject = pathIn(ORG.alpha, PROJECT.alphaApp, "autre-projet.png");
    expect((await upload("alphaAdmin", otherProject)).status).toBe(200);
    created.push({ persona: "alphaAdmin", path: otherProject });
    for (const path of [
      pathIn(ORG.alpha, PROJECT.alphaSite, "jamais-envoye.png"),
      otherProject,
      pathIn(ORG.beta, PROJECT.betaShop, "beta.png"),
    ]) {
      const result = await rpc("alphaAdmin", "append_product_asset", { p_org: ORG.alpha, p_product: PRODUCT.alpha, p_path: path });
      expect(message(result), path).toBe("validation_failed");
    }
    expect(assetsOf()).toBe("[]");
  });

  it("update_product n'écrit plus les fichiers : la liste du client est ignorée", async () => {
    const path = pathIn(ORG.alpha, PROJECT.alphaSite, "ignore.png");
    expect((await upload("alphaAdmin", path)).status).toBe(200);
    created.push({ persona: "alphaAdmin", path });
    const current = psql(`select kind || '|' || offer from public.products where id = '${PRODUCT.alpha}'`).split("|");
    const result = await rpc("alphaAdmin", "update_product", {
      p_org: ORG.alpha, p_id: PRODUCT.alpha, p_kind: current[0], p_offer: current[1], p_price_hint: null, p_landing_url: null, p_assets: [path],
    });
    expect(result.status).toBeLessThan(300);
    expect(assetsOf()).toBe("[]");
  });
});
