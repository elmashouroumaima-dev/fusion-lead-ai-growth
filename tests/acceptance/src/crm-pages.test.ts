import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, PROJECT, psql, USER } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * UI CRM (J24) par HTTP, avec de vraies sessions : liste des leads (filtres, recherche, pagination serveur), tableau des deals,
 * export CSV audité, déplacement d'un deal. Rôles : owner / admin / marketing voient tous les leads, le commercial les siens,
 * l'analyste est renvoyé au tableau de bord ; export : owner et admin seulement ; recherche et export n'exposent RIEN d'une autre
 * entreprise. Les données de test portent un préfixe unique par exécution et sont supprimées à la fin.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `crm${run}`;
// un nom qui COMMENCE par « = » (injection de formule) ne reçoit pas le préfixe de test
const name = (n: string) => (n.startsWith("=") ? `${n} ${TAG}` : `Zz${TAG} ${n}`);
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const cookie = (who: string, org: string) => Object.entries({ ...as(who).cookies, fl_active_org: org }).map(([k, v]) => `${k}=${v}`).join("; ");
const page = (who: string, path: string, org: string = ORG.alpha) => getPage(as(who), path, org);
const get = (who: string | null, path: string, org: string = ORG.alpha) =>
  fetch(`${BASE_URL}${path}`, { redirect: "manual", headers: who ? { cookie: cookie(who, org) } : {} });
const move = (who: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(as(who), "/api/deals/move", payload, { activeOrg: opts.org ?? ORG.alpha, headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? randomUUID() } });

const ids: Record<string, string> = {};

function seed() {
  const contact = (org: string, label: string, email: string, phone: string | null) =>
    `insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values ('${org}', '${name(label)}', '${email}', '${email}', ${phone ? `'${phone}'` : "null"});`;
  psql(`
    ${contact(ORG.alpha, "Nadia", `nadia.${TAG}@crm.test`, "+212612340001")}
    ${contact(ORG.alpha, "Youssef", `youssef.${TAG}@crm.test`, "+966501230002")}
    ${contact(ORG.alpha, "=cmd|calc", `inj.${TAG}@crm.test`, null)}
    ${contact(ORG.alpha, "Sarah", `sarah.${TAG}@crm.test`, null)}
    ${contact(ORG.beta, "Beta", `beta.${TAG}@crm.test`, null)}
  `);
  // 30 leads supplémentaires pour la pagination (25 par page)
  psql(`
    insert into public.contacts (organization_id, name, email_raw, email_normalized)
      select '${ORG.alpha}', 'Zz${TAG} Page ' || lpad(n::text, 2, '0'), 'page' || n || '.${TAG}@crm.test', 'page' || n || '.${TAG}@crm.test' from generate_series(1, 30) n;
  `);
  const lead = (org: string, label: string, assignee: string | null, source: string) => `
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id, assignee_id)
    select c.organization_id, c.id, '${org === ORG.alpha ? PROJECT.alphaSite : PROJECT.betaShop}', '${source}',
           (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id
             where p.organization_id = c.organization_id and p.is_default and s.kind = '${assignee ? "open" : "unassigned"}' order by s.position limit 1),
           ${assignee ? `'${assignee}'` : "null"}
      from public.contacts c where c.organization_id = '${org}' and c.name = '${name(label)}';`;
  psql(`
    ${lead(ORG.alpha, "Nadia", USER.alphaSales, "web_form")}
    ${lead(ORG.alpha, "Youssef", null, "csv_import")}
    ${lead(ORG.alpha, "=cmd|calc", USER.shared, "manual")}
    ${lead(ORG.alpha, "Sarah", USER.alphaSales, "web_form")}
    ${lead(ORG.beta, "Beta", null, "web_form")}
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id)
      select c.organization_id, c.id, '${PROJECT.alphaSite}', 'csv_import',
             (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id where p.organization_id = c.organization_id and p.is_default and s.kind = 'unassigned' limit 1)
        from public.contacts c where c.organization_id = '${ORG.alpha}' and c.name like 'Zz${TAG} Page %';
  `);
  const deal = (label: string, value: number) => `
    insert into public.deals (organization_id, lead_id, stage_id, value, currency)
    select l.organization_id, l.id, l.stage_id, ${value}, 'MAD' from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id
     where c.name = '${name(label)}' and c.organization_id = '${ORG.alpha}';`;
  psql(`${deal("Nadia", 1500)} ${deal("=cmd|calc", 800)} ${deal("Sarah", 99)}`);
  for (const label of ["Nadia", "=cmd|calc", "Sarah"]) {
    ids[label] = psql(`select d.id from public.deals d join public.leads l on l.id = d.lead_id join public.contacts c on c.id = l.contact_id where c.name = '${name(label)}'`);
  }
  ids.closed = psql(`select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id where p.organization_id = '${ORG.alpha}' and p.is_default and s.kind = 'won' limit 1`);
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.deals where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.name like '%${TAG}%');
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.name like '%${TAG}%');
    delete from public.leads where contact_id in (select id from public.contacts where name like '%${TAG}%');
    delete from public.contacts where name like '%${TAG}%';
  `);

beforeAll(async () => {
  cleanup();
  for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(who, await signIn(`${who}@seed.test`));
  seed();
});
afterAll(cleanup);

describe("liste des leads : rôles et isolation", () => {
  it("owner, admin et marketing voient les leads d'Alpha ; Beta ne voit rien d'Alpha ; sans session : redirection vers la connexion", async () => {
    for (const who of ["shared", "alpha-admin", "alpha-marketing"]) {
      const res = await page(who, `/fr/leads?q=${TAG}&sort=created_asc`);
      expect(res.status, who).toBe(200);
      const text = visibleText(res);
      expect(text, who).toContain(name("Nadia"));
      expect(text, who).toContain(name("Youssef"));
      expect(text, who).not.toContain(name("Beta"));
    }
    const beta = visibleText(await page("beta-owner", `/fr/leads?q=${TAG}&sort=created_asc`, ORG.beta));
    expect(beta).toContain(name("Beta"));
    expect(beta).not.toContain(name("Nadia"));
    const anon = await getPage(null, "/fr/leads");
    expect([302, 303, 307]).toContain(anon.status);
    expect(redirectPath(anon)).toMatch(/login/);
  });

  it("le commercial ne voit que SES leads (aucun lead non assigné, aucune recherche qui élargit)", async () => {
    const res = await page("alpha-sales", `/fr/leads?q=${TAG}&sort=created_asc`);
    expect(res.status).toBe(200);
    const text = visibleText(res);
    expect(text).toContain(name("Nadia"));
    expect(text).toContain(name("Sarah"));
    expect(text).not.toContain(name("Youssef"));
    expect(text).not.toContain(name("=cmd|calc"));
    expect(visibleText(await page("alpha-sales", `/fr/leads?q=Youssef&unassigned=1`))).not.toContain(name("Youssef"));
  });

  it("l'analyste est renvoyé au tableau de bord (PII)", async () => {
    const res = await page("alpha-analyst", "/fr/leads");
    expect([302, 303, 307]).toContain(res.status);
    expect(redirectPath(res)).toMatch(/dashboard/);
  });

  it("bouton d'export : owner et admin seulement", async () => {
    for (const who of ["shared", "alpha-admin"]) expect((await page(who, "/fr/leads")).body, who).toContain("/api/leads/export");
    for (const who of ["alpha-marketing", "alpha-sales"]) expect((await page(who, "/fr/leads")).body, who).not.toContain("/api/leads/export");
  });
});

describe("recherche, filtres et pagination côté serveur", () => {
  it("recherche par nom, e-mail et téléphone (national et international)", async () => {
    expect(visibleText(await page("shared", `/fr/leads?q=nadia.${TAG}`))).toContain(name("Nadia"));
    expect(visibleText(await page("shared", `/fr/leads?q=${encodeURIComponent("06 12 34 00")}`))).toContain(name("Nadia"));
    expect(visibleText(await page("shared", `/fr/leads?q=${encodeURIComponent("+966 50 123")}`))).toContain(name("Youssef"));
  });

  it("caractères spéciaux : « % » n'est pas un joker, la valeur est échappée (pas d'erreur, pas d'élargissement)", async () => {
    for (const q of ["%", "_", "\\", "'; drop table leads;--", "%25%25"]) {
      const res = await page("shared", `/fr/leads?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect(visibleText(res), q).not.toContain(name("Sarah"));
    }
  });

  it("filtres : source, « non assignés », projet d'une autre entreprise, paramètres invalides ignorés", async () => {
    const csv = visibleText(await page("shared", `/fr/leads?q=${TAG}&sort=created_asc&source=csv_import`));
    expect(csv).toContain(name("Youssef"));
    expect(csv).not.toContain(name("Nadia"));
    expect(visibleText(await page("shared", `/fr/leads?q=${TAG}&sort=created_asc&unassigned=1`))).toContain(name("Youssef"));
    const otherProject = await page("shared", `/fr/leads?q=${TAG}&project=${PROJECT.betaShop}`);
    expect(otherProject.status).toBe(200);
    expect(visibleText(otherProject)).not.toContain(name("Nadia"));
    expect((await page("shared", "/fr/leads?sort=password&page=abc&project=pas-un-uuid&source=Web%20Form")).status).toBe(200);
  });

  it("pagination serveur : 25 leads par page, la page 2 contient la suite, une page trop loin est vide sans erreur", async () => {
    const first = visibleText(await page("shared", `/fr/leads?q=${TAG}%20Page&sort=name_asc`));
    expect(first).toContain(name("Page 01"));
    expect(first).toContain(name("Page 25"));
    expect(first).not.toContain(name("Page 26"));
    const second = visibleText(await page("shared", `/fr/leads?q=${TAG}%20Page&sort=name_asc&page=2`));
    expect(second).toContain(name("Page 26"));
    expect(second).toContain(name("Page 30"));
    expect(second).not.toContain(name("Page 01"));
    const far = await page("shared", `/fr/leads?q=${TAG}%20Page&page=4000`);
    expect(far.status).toBe(200);
    // le total est conservé : la navigation (retour à la page précédente) reste affichée
    expect(visibleText(far)).toContain("Résultats : 30");
    expect(far.body).toContain("Page précédente");
  });
});

describe("langues et direction", () => {
  it("fr, en et ar : titres traduits ; l'arabe est en RTL ; les coordonnées restent en LTR", async () => {
    const fr = await page("shared", `/fr/leads?q=${TAG}&sort=created_asc`);
    const en = await page("shared", `/en/leads?q=${TAG}&sort=created_asc`);
    const ar = await page("shared", `/ar/leads?q=${TAG}&sort=created_asc`);
    expect(fr.body).toContain('dir="ltr"');
    expect(visibleText(fr)).toContain("Recherche");
    expect(visibleText(en)).toContain("Search");
    expect(ar.body).toContain('dir="rtl"');
    expect(visibleText(ar)).toContain("بحث");
    expect(ar.body).toMatch(/<bdi dir="ltr">[^<]*@/);
  });
});

describe("export CSV audité", () => {
  it("owner : fichier avec BOM, en-tête, leads d'Alpha SEULEMENT, formule neutralisée, filtres respectés ; l'audit n'a que des noms de filtres", async () => {
    const res = await get("shared", `/api/leads/export?q=${TAG}&source=web_form`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("lead_id,created_at,name,email,phone,source,stage,assignee_id,project_id")).toBe(true);
    expect(text).toContain(name("Nadia"));
    expect(text).toContain(name("Sarah"));
    expect(text).not.toContain(name("Youssef"));
    expect(text).not.toContain(name("Beta"));
    const all = await (await get("alpha-admin", `/api/leads/export?q=${TAG}`)).text();
    expect(all).toContain(`'=cmd|calc ${TAG}`);
    expect(all).not.toMatch(/,=cmd\|calc/);
    const audit = psql(`select after::text from public.audit_logs where action = 'export.created' and organization_id = '${ORG.alpha}' order by created_at desc limit 1`);
    expect(JSON.parse(audit)).toMatchObject({ kind: "leads", filters: ["query"] });
    expect(audit).not.toContain(TAG);
    expect(audit).not.toContain("@");
  });

  it("marketing, commercial et analyste : 403 ; sans session : 401 ; aucun audit pour un refus", async () => {
    const before = psql(`select count(*) from public.audit_logs where action = 'export.created'`);
    for (const who of ["alpha-marketing", "alpha-sales", "alpha-analyst"]) expect((await get(who, "/api/leads/export")).status, who).toBe(403);
    expect((await get(null, "/api/leads/export")).status).toBe(401);
    expect(psql(`select count(*) from public.audit_logs where action = 'export.created'`)).toBe(before);
  });

  it("paramètre de filtre invalide : 400 (pas d'export « tout ») ; navigation inter-sites : 400 ; aucun audit pour ces refus", async () => {
    const before = psql(`select count(*) from public.audit_logs where action = 'export.created'`);
    for (const query of ["project=pas-un-uuid", "source=Web%20Form", "sort=password", "unassigned=oui"]) {
      expect((await get("shared", `/api/leads/export?${query}`)).status, query).toBe(400);
    }
    const cross = await fetch(`${BASE_URL}/api/leads/export`, { redirect: "manual", headers: { cookie: cookie("shared", ORG.alpha), "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(400);
    const same = await fetch(`${BASE_URL}/api/leads/export?q=${TAG}`, { redirect: "manual", headers: { cookie: cookie("shared", ORG.alpha), "sec-fetch-site": "same-origin" } });
    expect(same.status).toBe(200);
    expect(psql(`select count(*) from public.audit_logs where action = 'export.created'`)).toBe(String(Number(before) + 1));
  });

  it("owner de Beta : son propre export, sans rien d'Alpha", async () => {
    const text = await (await get("beta-owner", `/api/leads/export?q=${TAG}`, ORG.beta)).text();
    expect(text).toContain(name("Beta"));
    expect(text).not.toContain(name("Nadia"));
    expect(text).not.toContain("Zz" + TAG + " Page");
  });
});

describe("tableau des deals et déplacement", () => {
  it("owner : voit les deals d'Alpha et un menu de déplacement ; le commercial seulement les siens ; marketing en lecture seule", async () => {
    const owner = visibleText(await page("shared", "/fr/deals"));
    expect(owner).toContain(name("Nadia"));
    expect(owner).toContain(name("=cmd|calc"));
    expect((await page("shared", "/fr/deals")).body).toContain('aria-label="Déplacer le deal de');
    const sales = visibleText(await page("alpha-sales", "/fr/deals"));
    expect(sales).toContain(name("Nadia"));
    expect(sales).not.toContain(name("=cmd|calc"));
    const marketing = await page("alpha-marketing", "/fr/deals");
    expect(visibleText(marketing)).toContain(name("Nadia"));
    expect(marketing.body).not.toContain('aria-label="Déplacer le deal de');
    expect(visibleText(await page("beta-owner", "/fr/deals", ORG.beta))).not.toContain(name("Nadia"));
    expect(redirectPath(await page("alpha-analyst", "/fr/deals"))).toMatch(/dashboard/);
  });

  it("déplacer : owner 200 ; commercial sur SON deal 200 et sur celui d'un autre 404 ; marketing et analyste 403 ; Beta 404", async () => {
    expect((await move("shared", { deal_id: ids["=cmd|calc"], stage_id: ids.closed })).status).toBe(200);
    expect(psql(`select stage_id from public.deals where id = '${ids["=cmd|calc"]}'`)).toBe(ids.closed);
    expect((await move("alpha-sales", { deal_id: ids.Nadia, stage_id: ids.closed })).status).toBe(200);
    expect((await move("alpha-sales", { deal_id: ids.Sarah, stage_id: ids.closed })).status).toBe(200);
    // le lead de « =cmd|calc » appartient à l'owner : le commercial n'y a pas accès (introuvable)
    expect((await move("alpha-sales", { deal_id: ids["=cmd|calc"], stage_id: ids.closed })).status).toBe(404);
    for (const who of ["alpha-marketing", "alpha-analyst"]) expect((await move(who, { deal_id: ids.Nadia, stage_id: ids.closed })).status, who).toBe(403);
    expect((await move("beta-owner", { deal_id: ids.Nadia, stage_id: ids.closed }, { org: ORG.beta })).status).toBe(404);
  });

  it("clé d'idempotence obligatoire, corps strict, entreprise du corps comparée au contexte", async () => {
    expect((await move("shared", { deal_id: ids.Nadia, stage_id: ids.closed }, { key: null })).status).toBe(400);
    expect((await move("shared", { deal_id: "pas-un-uuid", stage_id: ids.closed })).status).toBe(400);
    expect((await move("shared", { deal_id: ids.Nadia, stage_id: ids.closed, organization_id: ORG.beta })).status).toBe(403);
    const key = randomUUID();
    const first = await move("shared", { deal_id: ids.Nadia, stage_id: ids.closed }, { key });
    const replay = await move("shared", { deal_id: ids.Nadia, stage_id: ids.closed }, { key });
    expect(first.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
  });
});
