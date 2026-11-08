import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, USER, type Persona } from "./harness";

/**
 * Recherche de leads et export audité par la Data API (J24) : `search_leads` (SECURITY INVOKER) rend ce que la RLS de l'appelant
 * permet (owner, admin, marketing : tous ; commercial : les siens ; analyste : rien ; autre entreprise : rien), les caractères spéciaux
 * sont échappés, `log_export` est réservé à owner et admin, anon n'appelle rien. Ré-exécutable : données de l'exécution supprimées.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `rlscrm${run}`;
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";
const search = async (persona: Persona, org: string, extra: Record<string, unknown> = {}) => {
  const result = await rpc(persona, "search_leads", { p_org: org, p_query: TAG, ...extra });
  return { status: result.status, rows: (Array.isArray(result.body) ? result.body : []) as Array<{ contact_name: string; total_count: number | string }>, body: result.body };
};

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.name like '%${TAG}%');
    delete from public.leads where contact_id in (select id from public.contacts where name like '%${TAG}%');
    delete from public.contacts where name like '%${TAG}%';
  `);

beforeAll(() => {
  cleanup();
  psql(`
    insert into public.contacts (organization_id, name, email_raw, email_normalized) values
      ('${ORG.alpha}', 'Own ${TAG}', 'own.${TAG}@exemple.test', 'own.${TAG}@exemple.test'),
      ('${ORG.alpha}', 'Queue ${TAG}', 'queue.${TAG}@exemple.test', 'queue.${TAG}@exemple.test'),
      ('${ORG.alpha}', '100% ${TAG}', 'pct.${TAG}@exemple.test', 'pct.${TAG}@exemple.test'),
      ('${ORG.beta}', 'Beta ${TAG}', 'beta.${TAG}@exemple.test', 'beta.${TAG}@exemple.test');
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id, assignee_id)
      select c.organization_id, c.id, case c.organization_id when '${ORG.alpha}' then '${PROJECT.alphaSite}'::uuid else '${PROJECT.betaShop}'::uuid end, 'web_form',
             (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id
               where p.organization_id = c.organization_id and p.is_default and s.kind = case when c.name like 'Own %' then 'open' else 'unassigned' end::public.stage_kind order by s.position limit 1),
             case when c.name like 'Own %' then '${USER.alphaSales}'::uuid else null end
        from public.contacts c where c.name like '%${TAG}%';
  `);
});
afterAll(cleanup);

describe("search_leads : la RLS de l'appelant décide", () => {
  it("owner, admin et marketing d'Alpha : tous les leads d'Alpha, aucun de Beta", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing"] as const) {
      const result = await search(persona, ORG.alpha);
      expect(result.status, persona).toBe(200);
      expect(result.rows.map((r) => r.contact_name).sort(), persona).toEqual([`100% ${TAG}`, `Own ${TAG}`, `Queue ${TAG}`]);
      expect(Number(result.rows[0]?.total_count), persona).toBe(3);
    }
  });

  it("commercial : seulement le lead qui lui est assigné ; analyste, Beta et sans adhésion : rien", async () => {
    expect((await search("alphaSales", ORG.alpha)).rows.map((r) => r.contact_name)).toEqual([`Own ${TAG}`]);
    expect((await search("alphaSales", ORG.alpha, { p_unassigned: true })).rows).toEqual([]);
    for (const persona of ["alphaAnalyst", "betaOwner", "nobody"] as const) expect((await search(persona, ORG.alpha)).rows, persona).toEqual([]);
    expect((await search("betaOwner", ORG.beta)).rows.map((r) => r.contact_name)).toEqual([`Beta ${TAG}`]);
  });

  it("anon : refusé", async () => {
    expect(isDenied(await rpc("anon", "search_leads", { p_org: ORG.alpha }))).toBe(true);
  });

  it("filtres et caractères spéciaux : « % » littéral, « _ » littéral, source mal formée refusée", async () => {
    expect((await search("shared", ORG.alpha, { p_unassigned: true })).rows.map((r) => r.contact_name).sort()).toEqual([`100% ${TAG}`, `Queue ${TAG}`]);
    expect((await search("shared", ORG.alpha, { p_query: `100% ${TAG}` })).rows.map((r) => r.contact_name)).toEqual([`100% ${TAG}`]);
    expect((await search("shared", ORG.alpha, { p_query: `%${TAG}`.replace(TAG, "zzz") })).rows).toEqual([]);
    expect((await search("shared", ORG.alpha, { p_query: "_____" })).rows.length).toBe(0);
    expect(message(await rpc("shared", "search_leads", { p_org: ORG.alpha, p_source: "x; drop table leads" }))).toBe("validation_failed");
    expect(message(await rpc("shared", "search_leads", { p_org: ORG.alpha, p_limit: 10001 }))).toBe("validation_failed");
  });
});

describe("log_export : owner et admin seulement", () => {
  it("owner et admin enregistrent ; marketing, commercial, analyste, Beta, sans adhésion et anon refusés", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const result = await rpc(persona, "log_export", { p_org: ORG.alpha, p_kind: "leads", p_count: 3, p_filters: { query: true } });
      expect(result.status, persona).toBe(200);
    }
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(message(await rpc(persona, "log_export", { p_org: ORG.alpha, p_kind: "leads", p_count: 1, p_filters: {} })), persona).toBe("forbidden");
    }
    expect(isDenied(await rpc("anon", "log_export", { p_org: ORG.alpha, p_kind: "leads", p_count: 1, p_filters: {} }))).toBe(true);
  });

  it("l'audit ne garde que le nombre de lignes et les noms de filtres (jamais une valeur) ; valeur de filtre inconnue refusée", async () => {
    expect(message(await rpc("shared", "log_export", { p_org: ORG.alpha, p_kind: "leads", p_count: 1, p_filters: { password: "x" } }))).toBe("validation_failed");
    expect(message(await rpc("shared", "log_export", { p_org: ORG.alpha, p_kind: "contacts", p_count: 1, p_filters: {} }))).toBe("validation_failed");
    expect(message(await rpc("shared", "log_export", { p_org: ORG.alpha, p_kind: "leads", p_count: 10001, p_filters: {} }))).toBe("validation_failed");
    const last = psql(`select after::text from public.audit_logs where action = 'export.created' and organization_id = '${ORG.alpha}' order by created_at desc limit 1`);
    expect(JSON.parse(last)).toEqual({ kind: "leads", rows: 3, filters: ["query"] });
  });
});
