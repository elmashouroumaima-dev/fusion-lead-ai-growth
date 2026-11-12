import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql } from "../../../supabase/tests/rls/src/harness";
import { postJson, signIn, type Session } from "./app-client";

/**
 * POST /api/projects (J16) par HTTP, avec une vraie session : rôles (matrice ADR 014), Idempotency-Key, entreprise du
 * CONTEXTE (jamais celle du corps), validation par type, quota du plan. Nettoyage : les projets créés portent un préfixe
 * unique par exécution et sont supprimés (SQL local) ; l'abonnement d'Alpha est rétabli.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nm = (n: string) => `acc-${run}-${n}`;
const key = () => randomUUID();
const project = (n: string, extra: Record<string, unknown> = {}) => ({ type: "website_sales", name: nm(n), settings: { offers: ["Pack"] }, ...extra });
const body = (res: { json: Record<string, unknown> }) => res.json as { project?: { id: string; name: string; organization_id: string; status: string; type: string }; code?: string };

const sessions = new Map<string, Session>();
const as = (name: string): Session => {
  const session = sessions.get(name);
  if (!session) throw new Error(`session absente : ${name}`);
  return session;
};
const post = (who: string | null, payload: unknown, opts: { org?: string; key?: string | null; headers?: Record<string, string> } = {}) =>
  postJson(who === null ? null : as(who), "/api/projects", payload, {
    ...(opts.org ? { activeOrg: opts.org } : {}),
    headers: { ...(opts.key === null ? {} : { "idempotency-key": opts.key ?? key() }), ...(opts.headers ?? {}) },
  });

beforeAll(async () => {
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) {
    sessions.set(name, await signIn(`${name}@seed.test`));
  }
});

afterAll(() => {
  psql(`delete from public.products where project_id in (select id from public.projects where name like 'acc-${run}%')`);
  psql(`delete from public.projects where name like 'acc-${run}%'`);
  psql(`update public.subscriptions set plan_id = (select id from public.plans where code = 'growth') where organization_id = '${ORG.alpha}'`);
});

describe("POST /api/projects : accès", () => {
  it("sans session : 401 (corps valide)", async () => {
    const res = await post(null, project("anon"));
    expect(res.status).toBe(401);
    expect(body(res).code).toBe("unauthenticated");
  });

  it("analyste, commercial et marketing : 403 ; aucun projet créé", async () => {
    for (const who of ["alpha-analyst", "alpha-sales", "alpha-marketing"]) {
      const res = await post(who, project(`deny-${who}`), { org: ORG.alpha });
      expect(res.status, who).toBe(403);
      expect(body(res).code, who).toBe("forbidden");
    }
    expect(psql(`select count(*) from public.projects where name like 'acc-${run}-deny-%'`)).toBe("0");
  });

  it("l'utilisateur à deux rôles : 403 dans Beta (commercial), 201 dans Alpha (propriétaire)", async () => {
    expect((await post("shared", project("shared-beta"), { org: ORG.beta })).status).toBe(403);
    const ok = await post("shared", project("shared-alpha"), { org: ORG.alpha });
    expect(ok.status).toBe(201);
    expect(body(ok).project?.organization_id).toBe(ORG.alpha);
  });
});

describe("POST /api/projects : création", () => {
  it("l'administrateur crée : 201, projet actif de l'entreprise du CONTEXTE, avec l'en-tête de requête", async () => {
    const res = await post("alpha-admin", project("admin"));
    expect(res.status).toBe(201);
    expect(body(res).project).toMatchObject({ name: nm("admin"), type: "website_sales", status: "active", organization_id: ORG.alpha });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("le propriétaire de Beta crée chez Beta (jamais chez Alpha), même s'il réclame Alpha dans le corps : 403", async () => {
    const ok = await post("beta-owner", project("beta"));
    expect(ok.status).toBe(201);
    expect(body(ok).project?.organization_id).toBe(ORG.beta);
    const claimed = await post("beta-owner", project("beta-claim", { organization_id: ORG.alpha }));
    expect(claimed.status).toBe(403);
    expect(psql(`select count(*) from public.projects where name = '${nm("beta-claim")}'`)).toBe("0");
  });

  it("Idempotency-Key obligatoire ; rejeu identique = même projet ; même clé et autre corps = 422", async () => {
    expect((await post("alpha-admin", project("nokey"), { key: null })).status).toBe(400);
    const k = key();
    const first = await post("alpha-admin", project("idem"), { key: k });
    const replay = await post("alpha-admin", project("idem"), { key: k });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(body(replay).project?.id).toBe(body(first).project?.id);
    expect(psql(`select count(*) from public.projects where name = '${nm("idem")}'`)).toBe("1");
    expect((await post("alpha-admin", project("idem-other"), { key: k })).status).toBe(422);
  });

  it("validation : type inconnu, champ inconnu, réglages d'un autre type, nom vide, propriétaire non uuid : 400", async () => {
    for (const bad of [
      { ...project("v1"), type: "autre" },
      { ...project("v2"), statut: "archived" },
      { type: "salla_app", name: nm("v3"), settings: { offers: ["x"] } },
      { ...project("v4"), name: "" },
      { ...project("v5"), owner_id: "pas-un-uuid" },
      { ...project("v6"), settings: { landing_pages: [{ name: "x", url: "http://exemple.test" }] } },
    ]) {
      const res = await post("alpha-admin", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("validation_failed");
    }
    expect(psql(`select count(*) from public.projects where name like 'acc-${run}-v%'`)).toBe("0");
  });

  it("propriétaire désigné : membre actif de l'entreprise seulement", async () => {
    const owner = psql(`select user_id from public.organization_members where organization_id = '${ORG.alpha}' and role = 'company_admin' limit 1`);
    const ok = await post("alpha-admin", project("owner-ok", { owner_id: owner }));
    expect(ok.status).toBe(201);
    const betaMember = "00000000-0000-4000-8000-000000000006";
    expect((await post("alpha-admin", project("owner-ko", { owner_id: betaMember }))).status).toBe(400);
  });

  it("chaque type de projet est accepté avec ses réglages", async () => {
    const cases = [
      { type: "website_sales", settings: { target_market: "PME", landing_pages: [{ name: "Accueil", url: "https://exemple.test/lp" }] } },
      { type: "salla_app", settings: { app_name: "Relance", store_url: "https://exemple.test/app", faqs: [{ question: "Prix ?", answer: "Voir les formules." }] } },
      { type: "salla_theme", settings: { preview_url: "https://exemple.test/theme", sectors: ["mode"] } },
      { type: "custom", settings: { notes: "libre", fields: { budget: "5 000" } } },
    ];
    // Place pour 4 projets chez Beta (plan croissance : 10, 2 déjà au seed + 1 créé plus haut).
    for (const c of cases) {
      const res = await post("beta-owner", { ...c, name: nm(`type-${c.type}`) });
      expect(res.status, c.type).toBe(201);
      expect(body(res).project?.type).toBe(c.type);
    }
  });
});

describe("POST /api/projects : quota du plan", () => {
  it("plan Essai (1 projet) : la création est refusée (429 quota_exceeded) ; rétabli, elle redevient possible", async () => {
    psql(`update public.subscriptions set plan_id = (select id from public.plans where code = 'trial') where organization_id = '${ORG.alpha}'`);
    const refused = await post("alpha-admin", project("quota"));
    expect(refused.status).toBe(429);
    expect(body(refused).code).toBe("quota_exceeded");
    expect(psql(`select count(*) from public.projects where name = '${nm("quota")}'`)).toBe("0");
    psql(`update public.subscriptions set plan_id = (select id from public.plans where code = 'growth') where organization_id = '${ORG.alpha}'`);
    expect((await post("alpha-admin", project("quota-ok"))).status).toBe(201);
  });
});
