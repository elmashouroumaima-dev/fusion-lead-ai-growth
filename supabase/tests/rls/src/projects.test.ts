import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  apiAsUser,
  cleanupTestUsers,
  createTestUser,
  isDenied,
  ORG,
  PRODUCT,
  PROJECT,
  psql,
  rowsOf,
  select,
  type Persona,
} from "./harness";

/**
 * Projets et produits par la Data API (J16) : lecture par tous les rôles de l'entreprise seulement, AUCUNE écriture
 * directe (même service_role), écriture par les fonctions réservées à owner et admin, FK composites (pas de produit sur
 * le projet d'une autre entreprise), assets limités au dossier du projet, archivage en lecture seule, quota « projects »
 * sous VRAIE concurrence. Tests ré-exécutables : noms uniques par exécution, nettoyage des lignes créées.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const name = (n: string) => `rlsp-${run}-${n}`;
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";
const settingsOf = (overrides: Record<string, unknown> = {}) => ({ target_market: "MA", ...overrides });

const createdUsers: string[] = [];

afterAll(async () => {
  psql(`delete from public.products where offer like 'rlsp-${run}%'`);
  psql(`delete from public.projects where name like 'rlsp-${run}%'`);
  await cleanupTestUsers(createdUsers);
});

describe("lecture : chacun ne voit que ses entreprises", () => {
  it("analyste d'Alpha : les 2 projets d'Alpha et son produit, rien de Beta", async () => {
    const projects = rowsOf<{ id: string; organization_id: string }>(await select("alphaAnalyst", "projects?select=id,organization_id"));
    expect(projects.map((p) => p.id).sort()).toEqual([PROJECT.alphaSite, PROJECT.alphaApp].sort());
    expect(new Set(projects.map((p) => p.organization_id))).toEqual(new Set([ORG.alpha]));
    const products = rowsOf<{ id: string }>(await select("alphaAnalyst", "products?select=id"));
    expect(products.map((p) => p.id)).toEqual([PRODUCT.alpha]);
  });

  it("propriétaire de Beta : uniquement Beta ; l'identifiant d'Alpha dans le filtre ne révèle rien", async () => {
    const projects = rowsOf<{ id: string }>(await select("betaOwner", "projects?select=id"));
    expect(projects.map((p) => p.id).sort()).toEqual([PROJECT.betaShop, PROJECT.betaTheme].sort());
    expect(rowsOf(await select("betaOwner", `projects?select=id&id=eq.${PROJECT.alphaSite}`))).toEqual([]);
    expect(rowsOf(await select("betaOwner", `projects?select=id&organization_id=eq.${ORG.alpha}`))).toEqual([]);
    expect(rowsOf(await select("betaOwner", `products?select=id&id=eq.${PRODUCT.alpha}`))).toEqual([]);
  });

  it("utilisateur à deux rôles : voit les projets des deux entreprises", async () => {
    expect(rowsOf(await select("shared", "projects?select=id"))).toHaveLength(4);
  });

  it("sans adhésion : rien ; anonyme : refusé", async () => {
    expect(rowsOf(await select("nobody", "projects?select=id"))).toEqual([]);
    expect(isDenied(await select("anon", "projects?select=id"))).toBe(true);
    expect(isDenied(await select("anon", "products?select=id"))).toBe(true);
  });
});

describe("aucune écriture directe, même pour service_role", () => {
  const body = { organization_id: ORG.alpha, type: "custom", name: name("direct") };
  for (const persona of ["shared", "alphaAdmin", "alphaAnalyst", "service", "anon"] as const) {
    it(`${persona} : insertion, modification et suppression refusées`, async () => {
      expect((await api(persona, "POST", "projects", body)).status).toBeGreaterThanOrEqual(400);
      expect((await api(persona, "PATCH", `projects?id=eq.${PROJECT.alphaSite}`, { name: "piraté" })).status).toBeGreaterThanOrEqual(400);
      expect((await api(persona, "DELETE", `projects?id=eq.${PROJECT.alphaSite}`)).status).toBeGreaterThanOrEqual(400);
      expect((await api(persona, "POST", "products", { organization_id: ORG.alpha, project_id: PROJECT.alphaSite, kind: "k", offer: "o" })).status).toBeGreaterThanOrEqual(400);
      expect((await api(persona, "PATCH", `products?id=eq.${PRODUCT.alpha}`, { offer: "piraté" })).status).toBeGreaterThanOrEqual(400);
    });
  }

  it("rien n'a bougé", async () => {
    const rows = rowsOf<{ name: string }>(await select("service", `projects?select=name&id=eq.${PROJECT.alphaSite}`));
    expect(rows[0]?.name).toBe("Site vitrine Alpha");
  });
});

describe("fonctions d'écriture : rôles", () => {
  const args = (orgId: string, n: string) => ({ p_org: orgId, p_type: "website_sales", p_name: name(n), p_settings: settingsOf() });

  it("analyste, marketing, commercial : création refusée ; propriétaire de Beta : refusée chez Alpha", async () => {
    for (const persona of ["alphaAnalyst", "alphaMarketing", "alphaSales", "betaOwner", "nobody"] as const) {
      const result = await rpc(persona, "create_project", args(ORG.alpha, `deny-${persona}`));
      expect(isDenied(result), persona).toBe(true);
    }
    expect(isDenied(await rpc("anon", "create_project", args(ORG.alpha, "anon")))).toBe(true);
    expect(isDenied(await rpc("service", "create_project", args(ORG.alpha, "service")))).toBe(true);
  });

  it("admin et propriétaire d'Alpha créent ; l'utilisateur à deux rôles crée chez Alpha (owner), pas chez Beta (commercial)", async () => {
    const byAdmin = await rpc("alphaAdmin", "create_project", args(ORG.alpha, "admin"));
    expect(byAdmin.status).toBe(200);
    const byOwner = await rpc("shared", "create_project", args(ORG.alpha, "owner"));
    expect(byOwner.status).toBe(200);
    expect(isDenied(await rpc("shared", "create_project", args(ORG.beta, "shared-beta")))).toBe(true);
    const created = rowsOf<{ name: string; status: string; organization_id: string }>(
      await select("alphaAdmin", `projects?select=name,status,organization_id&name=like.rlsp-${run}-*`),
    );
    expect(created.map((p) => p.name).sort()).toEqual([name("admin"), name("owner")].sort());
    expect(new Set(created.map((p) => p.organization_id))).toEqual(new Set([ORG.alpha]));
  });

  it("validation : nom, réglages et propriétaire invalides", async () => {
    expect(message(await rpc("alphaAdmin", "create_project", { ...args(ORG.alpha, "x"), p_name: "" }))).toBe("validation_failed");
    expect(message(await rpc("alphaAdmin", "create_project", { ...args(ORG.alpha, "x"), p_settings: [] }))).toBe("validation_failed");
    expect(
      message(await rpc("alphaAdmin", "create_project", { ...args(ORG.alpha, "x"), p_owner: "00000000-0000-4000-8000-000000000006" })),
    ).toBe("owner_invalid");
  });
});

describe("isolation des écritures entre entreprises", () => {
  it("modification, archivage et produit sur un projet d'une AUTRE entreprise : refusés ou introuvables", async () => {
    // Admin d'Alpha vise un projet de Beta en se déclarant Alpha : introuvable (jamais modifié) ; en se déclarant Beta : refusé.
    expect(message(await rpc("alphaAdmin", "update_project", { p_org: ORG.alpha, p_id: PROJECT.betaShop, p_name: "piraté", p_settings: {}, p_owner: null }))).toBe("not_found");
    expect(isDenied(await rpc("alphaAdmin", "update_project", { p_org: ORG.beta, p_id: PROJECT.betaShop, p_name: "piraté", p_settings: {}, p_owner: null }))).toBe(true);
    expect(message(await rpc("alphaAdmin", "set_project_status", { p_org: ORG.alpha, p_id: PROJECT.betaShop, p_status: "archived" }))).toBe("not_found");
    expect(
      message(await rpc("alphaAdmin", "create_product", { p_org: ORG.alpha, p_project: PROJECT.betaShop, p_kind: "k", p_offer: "piraté", p_price_hint: null, p_landing_url: null, p_assets: [] })),
    ).toBe("not_found");
    expect(
      message(await rpc("alphaAdmin", "update_product", { p_org: ORG.alpha, p_id: PRODUCT.beta, p_kind: "k", p_offer: "piraté", p_price_hint: null, p_landing_url: null, p_assets: [] })),
    ).toBe("not_found");
    const beta = rowsOf<{ name: string; status: string }>(await select("service", `projects?select=name,status&id=eq.${PROJECT.betaShop}`));
    expect(beta[0]).toEqual({ name: "Boutique en ligne Beta", status: "active" });
    const product = rowsOf<{ offer: string }>(await select("service", `products?select=offer&id=eq.${PRODUCT.beta}`));
    expect(product[0]?.offer).toBe("Boutique en ligne clé en main");
  });

  it("assets : seuls les chemins du dossier du projet sont acceptés", async () => {
    const good = `${ORG.alpha}/${PROJECT.alphaSite}/logo.png`;
    const base = { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_kind: "pack", p_offer: `rlsp-${run} offre`, p_price_hint: null, p_landing_url: null };
    expect((await rpc("alphaAdmin", "create_product", { ...base, p_assets: [good] })).status).toBe(200);
    for (const bad of [
      `${ORG.beta}/${PROJECT.betaShop}/logo.png`,
      `${ORG.alpha}/${PROJECT.alphaApp}/logo.png`,
      `${ORG.alpha}/${PROJECT.alphaSite}/../x.png`,
    ]) {
      expect(message(await rpc("alphaAdmin", "create_product", { ...base, p_assets: [bad] })), bad).toBe("validation_failed");
    }
  });

  it("not_found répond HTTP 404 (jamais 500), identique pour un identifiant inconnu et pour celui d'une autre entreprise", async () => {
    const unknown = await rpc("alphaAdmin", "update_project", { p_org: ORG.alpha, p_id: "00000000-0000-4000-8000-0000000000ff", p_name: "x", p_settings: {}, p_owner: null });
    const foreign = await rpc("alphaAdmin", "update_project", { p_org: ORG.alpha, p_id: PROJECT.betaShop, p_name: "x", p_settings: {}, p_owner: null });
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(message(unknown)).toBe(message(foreign));
  });

  it("appel direct de la fonction : la base refuse caractères invisibles, clés inconnues, liens dangereux et hôtes internes", async () => {
    const base = { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_offer: `rlsp-${run} invisible`, p_price_hint: null, p_landing_url: null, p_assets: [] };
    for (const kind of ["a؜b", "a⁠b", "a­b"]) {
      expect(message(await rpc("alphaAdmin", "create_product", { ...base, p_kind: kind })), JSON.stringify(kind)).toBe("validation_failed");
    }
    for (const url of ["https://127.0.0.1/", "https://localhost/", "https://169.254.169.254/latest/meta-data", "https://exemple.test:99999/"]) {
      expect(message(await rpc("alphaAdmin", "create_product", { ...base, p_kind: "pack", p_landing_url: url })), url).toBe("validation_failed");
    }
    const createWith = (type: string, settings: unknown) => rpc("alphaAdmin", "create_project", { p_org: ORG.alpha, p_type: type, p_name: name("settings"), p_settings: settings });
    expect(message(await createWith("website_sales", { inconnue: 1 }))).toBe("validation_failed");
    expect(message(await createWith("salla_theme", { preview_url: "javascript:alert(1)" }))).toBe("validation_failed");
    expect(message(await createWith("custom", { fields: { a: { b: { c: { d: 1 } } } } }))).toBe("validation_failed");
  });

  it("modification : le propriétaire est explicite (appel sans p_owner refusé, rien n'est effacé)", async () => {
    const before = rowsOf<{ owner_id: string | null }>(await select("service", `projects?select=owner_id&id=eq.${PROJECT.alphaSite}`));
    const result = await rpc("alphaAdmin", "update_project", { p_org: ORG.alpha, p_id: PROJECT.alphaSite, p_name: "x", p_settings: {} });
    expect(result.status).toBeGreaterThanOrEqual(400);
    const after = rowsOf<{ owner_id: string | null }>(await select("service", `projects?select=owner_id&id=eq.${PROJECT.alphaSite}`));
    expect(after[0]?.owner_id).toBe(before[0]?.owner_id);
  });

  it("URL de page d'atterrissage : https seulement", async () => {
    const base = { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_kind: "pack", p_offer: `rlsp-${run} url`, p_price_hint: null, p_assets: [] };
    expect((await rpc("alphaAdmin", "create_product", { ...base, p_landing_url: "https://exemple.test/p" })).status).toBe(200);
    for (const bad of ["http://exemple.test", "javascript:alert(1)", "https://u:p@exemple.test"]) {
      expect(message(await rpc("alphaAdmin", "create_product", { ...base, p_landing_url: bad })), bad).toBe("validation_failed");
    }
  });
});

describe("archivage et quota « projects »", () => {
  type Account = { id: string; email: string };
  let owner: Account;
  let orgQ: string;

  beforeAll(async () => {
    owner = await createTestUser("pq-owner");
    createdUsers.push(owner.id);
    const org = await apiAsUser(owner.id, "POST", "rpc/create_organization", { p_name: `PQ ${run}`, p_creation_key: `pq-${run}` });
    expect(org.status).toBe(200);
    orgQ = org.body as string;
  });
  const create = (n: string) =>
    apiAsUser(owner.id, "POST", "rpc/create_project", { p_org: orgQ, p_type: "custom", p_name: `pq-${run}-${n}`, p_settings: {} });
  const usage = async (): Promise<number> => {
    const result = await apiAsUser<{ metric: string; used: number }[]>(owner.id, "POST", "rpc/get_org_usage", { p_org: orgQ });
    return Number(rowsOf<{ metric: string; used: number }>(result).find((r) => r.metric === "projects")?.used ?? -1);
  };

  it("12 créations simultanées pour 5 places : exactement 5 réussissent", async () => {
    psql(`update public.subscriptions set limits_override = '{"projects": 5}' where organization_id = '${orgQ}'`);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => create(`c${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => message(r) === "quota_exceeded")).toHaveLength(7);
    expect(await usage()).toBe(5);
  });

  it("un projet archivé libère une place ; la réactivation ne contourne pas le quota", async () => {
    const list = rowsOf<{ id: string }>(await apiAsUser(owner.id, "GET", `projects?select=id&organization_id=eq.${orgQ}&order=created_at`));
    const first = list[0]?.id;
    expect(first).toBeDefined();
    const archive = await apiAsUser(owner.id, "POST", "rpc/set_project_status", { p_org: orgQ, p_id: first, p_status: "archived" });
    expect(archive.status).toBeLessThan(300);
    expect(await usage()).toBe(4);
    expect((await create("after-archive")).status).toBe(200);
    expect(await usage()).toBe(5);
    const reactivate = await apiAsUser(owner.id, "POST", "rpc/set_project_status", { p_org: orgQ, p_id: first, p_status: "active" });
    expect(message(reactivate)).toBe("quota_exceeded");
    expect(await usage()).toBe(5);
  });

  it("un projet archivé est en lecture seule (projet et produits)", async () => {
    const archived = rowsOf<{ id: string }>(await apiAsUser(owner.id, "GET", `projects?select=id&organization_id=eq.${orgQ}&status=eq.archived`));
    const id = archived[0]?.id;
    expect(id).toBeDefined();
    expect(message(await apiAsUser(owner.id, "POST", "rpc/update_project", { p_org: orgQ, p_id: id, p_name: "x", p_settings: {}, p_owner: null }))).toBe("project_archived");
    expect(
      message(await apiAsUser(owner.id, "POST", "rpc/create_product", { p_org: orgQ, p_project: id, p_kind: "k", p_offer: `rlsp-${run} archive`, p_price_hint: null, p_landing_url: null, p_assets: [] })),
    ).toBe("project_archived");
  });

  it("abonnement suspendu : création refusée", async () => {
    psql(`update public.subscriptions set status = 'suspended' where organization_id = '${orgQ}'`);
    expect(message(await create("suspended"))).toBe("subscription_inactive");
  });

  it("le journal d'audit voit les créations, sans le contenu des réglages", async () => {
    const logs = rowsOf<{ action: string; after: Record<string, unknown> | null }>(
      await apiAsUser(owner.id, "GET", `audit_logs?select=action,after&organization_id=eq.${orgQ}&action=in.(project.created,project.archived)`),
    );
    expect(logs.filter((l) => l.action === "project.created").length).toBeGreaterThanOrEqual(5);
    expect(logs.some((l) => l.action === "project.archived")).toBe(true);
    for (const log of logs) expect(JSON.stringify(log.after ?? {})).not.toContain("settings");
  });
});
