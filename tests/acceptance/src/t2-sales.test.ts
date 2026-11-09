import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, PROJECT, psql, USER } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";
import { runImportJob } from "./import-worker";
import { createLeadAssignHandler } from "../../../apps/worker/src/handlers";
import type { LeadAssigner } from "../../../apps/worker/src/assignment";

/**
 * T2 (docs/testing/strategy.md, spec §13-3 et « tests d'acceptation réalistes ») : 100 leads importés avec doublons et téléphones
 * hétérogènes (`tests/fixtures/leads-100.csv`), puis assignation et rapports. Chaîne complète par HTTP (sessions réelles) et par le
 * VRAI handler `import_csv` : aperçu, confirmation, worker, un job `lead.assign` par lead traité par la fonction du worker
 * (round-robin), chiffres AFFICHÉS sur /leads par rôle, rapport CSV, rejeu du fichier, puis le même fichier chez l'autre
 * entreprise : deux entreprises, deux jeux de contacts séparés. Les données portent le domaine `leads100.test` et sont supprimées.
 */
const csvBytes = readFileSync(fileURLToPath(new URL("../../fixtures/leads-100.csv", import.meta.url)));
const DOMAIN = "leads100.test";
const MAPPING = { name: 0, email: 1, phone: 2, language: 3, country: 4 };

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const cookie = (who: string, org: string) => Object.entries({ ...as(who).cookies, fl_active_org: org }).map(([k, v]) => `${k}=${v}`).join("; ");
const page = (who: string, path: string, org: string = ORG.alpha) => getPage(as(who), path, org);
const post = (who: string, path: string, payload: unknown, org: string = ORG.alpha) =>
  postJson(as(who), path, payload, { activeOrg: org, headers: { "idempotency-key": randomUUID() } });

async function upload(who: string, project: string, org: string) {
  const response = await fetch(`${BASE_URL}/api/imports?project_id=${project}`, {
    method: "POST",
    headers: { "content-type": "text/csv; charset=utf-8", cookie: cookie(who, org) },
    body: csvBytes,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const batches: string[] = [];
/** Contacts de la fixture dans UNE entreprise (e-mail du domaine de test, ou téléphone du contact « déjà connu »). */
const KNOWN_PHONE = "+212600000099";
const ofFixture = (org: string, alias = "c") =>
  `${alias}.organization_id = '${org}' and (${alias}.email_normalized like '%@${DOMAIN}' or ${alias}.phone_e164 = '${KNOWN_PHONE}')`;
const contactsIn = (org: string) => Number(psql(`select count(*) from public.contacts c where ${ofFixture(org)}`));
const leadsIn = (org: string) =>
  Number(psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where ${ofFixture(org)}`));
/** Leads que la RECHERCHE par domaine retrouve : 66 sur 67, car le contact « téléphone seul » n'a pas d'e-mail du domaine. */
const SEARCHABLE = 66;
const searchableLeadsIn = (org: string, extra = "") =>
  Number(psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where c.organization_id = '${org}' and c.email_normalized like '%@${DOMAIN}' ${extra}`));
const jobsToAssign = (org: string): string[] =>
  psql(`select l.id from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where ${ofFixture(org)} order by l.created_at, l.id`)
    .split("\n").filter(Boolean);

/** Passerelle de test du handler `lead.assign` : mêmes fonctions SQL que le worker (rôle service_role). */
const assigner: LeadAssigner = {
  async assign(org, lead) {
    const result = await api<Record<string, unknown>>("service", "POST", "rpc/auto_assign_lead", { p_org: org, p_lead: lead });
    if (result.status >= 300) throw new Error("assignment_assign_failed");
    return result.body as never;
  },
  async flagUnassigned(org, lead) {
    await api("service", "POST", "rpc/flag_lead_unassigned", { p_org: org, p_lead: lead });
  },
};
const assignHandler = createLeadAssignHandler(assigner);
/** Responsable de chaque lead donné (une seule requête), dans l'ordre demandé ; chaîne vide = non assigné. */
const assigneesOf = (leads: string[]): string[] => {
  const out = psql(`select id || ':' || coalesce(assignee_id::text, '') from public.leads where id in (${leads.map((l) => `'${l}'`).join(",")})`);
  const rows = new Map(out.split(/\r?\n/).filter(Boolean).map((r) => [r.slice(0, 36), r.slice(37)] as const));
  return leads.map((l) => rows.get(l) ?? "?");
};
/** Entreprise de la LIGNE de chaque job `lead.assign` (une seule requête) : jamais la charge utile. */
const jobOrganizations = (): Map<string, string> => {
  const out = psql(`select (payload ->> 'lead_id') || ':' || organization_id from public.jobs where kind = 'lead.assign'`);
  return new Map(out.split(/\r?\n/).filter(Boolean).map((r) => [r.slice(0, 36), r.slice(37)] as const));
};
/** Ce que fait le worker pour les jobs `lead.assign` : le VRAI handler, un job après l'autre, dans l'ordre. Renvoie le responsable de chaque lead. */
const assignAll = async (leads: string[]): Promise<string[]> => {
  const orgs = jobOrganizations();
  for (const lead of leads) {
    const organizationId = orgs.get(lead);
    if (!organizationId) throw new Error(`job lead.assign absent pour ${lead}`);
    await assignHandler.run({ jobId: randomUUID(), organizationId, idempotencyKey: `lead.assign:${lead}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal }, { lead_id: lead });
  }
  return assigneesOf(leads);
};

const cleanup = () => {
  const ids = batches.map((b) => `'${b}'`).join(",") || "'00000000-0000-4000-8000-000000000000'";
  const leadIds = `select l.id from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where c.email_normalized like '%@${DOMAIN}' or c.phone_e164 = '${KNOWN_PHONE}'`;
  psql(`
    set session_replication_role = replica;
    delete from public.notifications where payload ->> 'lead_id' in (select id::text from (${leadIds}) x);
    delete from public.jobs where (kind = 'import_csv' and payload ->> 'batch_id' in (${ids}))
       or (kind = 'lead.assign' and payload ->> 'lead_id' in (select id::text from (${leadIds}) x));
    delete from public.import_rows where batch_id in (${ids});
    delete from public.import_batches where id in (${ids});
    delete from public.activities where lead_id in (${leadIds});
    delete from public.leads where id in (${leadIds});
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '${KNOWN_PHONE}');
    delete from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '${KNOWN_PHONE}';
    delete from public.assignment_rules where project_id in ('${PROJECT.alphaSite}', '${PROJECT.betaShop}');
  `);
};
/** Fichiers du Storage des lots de ce test (chemin lu en base AVANT la suppression des lots). */
const storagePaths = (): string => {
  const ids = batches.map((b) => `'${b}'`).join(",");
  return ids ? psql(`select file_path from public.import_batches where id in (${ids})`).split("\n").filter(Boolean).map((x) => `'${x}'`).join(",") : "";
};
const purgeStorage = (paths: string) => {
  if (paths) psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'imports' and name in (${paths});`);
};

/** Un import complet d'une entreprise : envoi, aperçu, confirmation par HTTP puis passage du worker. Renvoie l'aperçu et le lot. */
async function importFile(who: string, project: string, org: string) {
  const up = await upload(who, project, org);
  expect(up.status).toBe(201);
  const batch = String(up.json.batch_id);
  batches.push(batch);
  const preview = await post(who, "/api/imports/preview", { batch_id: batch, mapping: MAPPING, default_country: "MA" }, org);
  expect(preview.status).toBe(200);
  const confirm = await post(who, "/api/imports/confirm", { batch_id: batch, mapping: MAPPING, default_country: "MA" }, org);
  expect(confirm.status).toBe(202);
  await runImportJob(batch);
  return { batch, preview: preview.json.preview as Record<string, unknown> };
}

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  // deux contacts DÉJÀ connus chez Alpha (rattachement par e-mail, puis par téléphone seul)
  psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'Déjà client', 'deja.client@${DOMAIN}', 'deja.client@${DOMAIN}')`);
  psql(`insert into public.contacts (organization_id, name, phone_e164) values ('${ORG.alpha}', 'Déjà client tel', '${KNOWN_PHONE}')`);
  // une règle round-robin par entreprise : trois responsables chez Alpha, deux chez Beta
  psql(`
    insert into public.assignment_rules (organization_id, project_id, strategy, eligible_member_ids)
    values ('${ORG.alpha}', '${PROJECT.alphaSite}', 'round_robin', array['${USER.alphaSales}', '${USER.alphaAdmin}', '${USER.shared}']::uuid[]),
           ('${ORG.beta}', '${PROJECT.betaShop}', 'round_robin', array['${USER.betaOwner}', '${USER.shared}']::uuid[]);
  `);
});
afterAll(() => {
  const paths = storagePaths();
  cleanup();
  purgeStorage(paths);
});

describe("T2 chez Alpha : import de 100 lignes, assignation, chiffres affichés", () => {
  let batch = "";

  it("import : 65 créés, 17 rattachés (15 doublons du fichier + 2 déjà connus), 18 refusées ; 67 leads, un job d'assignation chacun", async () => {
    const imported = await importFile("shared", PROJECT.alphaSite, ORG.alpha);
    batch = imported.batch;
    expect(imported.preview).toMatchObject({ rowCount: 100, newContacts: 65, existingContacts: 2, duplicatesInFile: 15, errors: 18 });
    expect(psql(`select status || ':' || created_count || ':' || matched_count || ':' || error_count from public.import_batches where id = '${batch}'`)).toBe("done:65:17:18");
    expect(contactsIn(ORG.alpha)).toBe(67);
    expect(leadsIn(ORG.alpha)).toBe(67);
    expect(jobsToAssign(ORG.alpha)).toHaveLength(67);
    expect(Number(psql(`select count(*) from public.jobs where kind = 'lead.assign' and organization_id = '${ORG.alpha}' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where ${ofFixture(ORG.alpha)})`))).toBe(67);
    // aucun consentement n'est inventé par un import
    expect(psql(`select count(*) from public.consent_events e join public.contacts c on c.id = e.contact_id where ${ofFixture(ORG.alpha)}`)).toBe("0");
  });

  it("avant l'assignation : les 67 leads sont « non assignés » (étape système) et visibles du seul tableau owner / admin / marketing", async () => {
    expect(psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id join public.pipeline_stages s on s.id = l.stage_id where ${ofFixture(ORG.alpha)} and s.kind = 'unassigned' and l.assignee_id is null`)).toBe("67");
    expect(visibleText(await page("shared", `/fr/leads?q=${DOMAIN}&unassigned=1`))).toContain(`Résultats : ${SEARCHABLE}`);
    expect(visibleText(await page("alpha-sales", `/fr/leads?q=${DOMAIN}`))).toContain("Résultats : 0");
  });

  it("assignation par le VRAI handler du worker : 67 leads assignés en rotation round-robin (ordre de la règle), écart maximal 1, tous ouverts", { timeout: 180_000 }, async () => {
    const eligible = [USER.alphaSales, USER.alphaAdmin, USER.shared];
    const sequence: string[] = [];
    sequence.push(...(await assignAll(jobsToAssign(ORG.alpha))));
    expect(sequence.every(Boolean)).toBe(true);
    // la rotation suit l'ordre des membres de la règle, à partir du curseur (0) : 1er membre, 2e, 3e, 1er, ...
    sequence.forEach((assignee, index) => expect(assignee, `lead n° ${index + 1}`).toBe(eligible[index % 3]));
    const perPerson = new Map<string, number>();
    for (const assignee of sequence) perPerson.set(assignee, (perPerson.get(assignee) ?? 0) + 1);
    expect([...perPerson.keys()].sort()).toEqual([...eligible].sort());
    expect(Math.max(...perPerson.values()) - Math.min(...perPerson.values())).toBeLessThanOrEqual(1);
    expect(psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id join public.pipeline_stages s on s.id = l.stage_id where ${ofFixture(ORG.alpha)} and s.kind = 'open'`)).toBe("67");
    expect(psql(`select count(*) from public.activities a join public.leads l on l.id = a.lead_id join public.contacts c on c.id = l.contact_id where ${ofFixture(ORG.alpha)} and a.type = 'assignment'`)).toBe("67");
  });

  it("rejeu des 67 jobs : aucune seconde assignation, aucune activité de plus", async () => {
    const leads = jobsToAssign(ORG.alpha);
    const before = assigneesOf(leads);
    expect(await assignAll(leads)).toEqual(before);
    expect(psql(`select count(*) from public.activities a join public.leads l on l.id = a.lead_id join public.contacts c on c.id = l.contact_id where ${ofFixture(ORG.alpha)} and a.type = 'assignment'`)).toBe("67");
  });

  it("chiffres affichés : owner, admin et marketing voient 66 par la recherche (67 en base) ; le commercial seulement les siens ; plus aucun « non assigné » ; l'analyste est renvoyé", async () => {
    for (const who of ["shared", "alpha-admin", "alpha-marketing"]) expect(visibleText(await page(who, `/fr/leads?q=${DOMAIN}`)), who).toContain(`Résultats : ${SEARCHABLE}`);
    expect(visibleText(await page("shared", `/fr/leads?q=${DOMAIN}&unassigned=1`))).toContain("Résultats : 0");
    const mine = searchableLeadsIn(ORG.alpha, `and l.assignee_id = '${USER.alphaSales}'`);
    expect(mine).toBeGreaterThanOrEqual(21);
    expect(mine).toBeLessThan(SEARCHABLE);
    expect(visibleText(await page("alpha-sales", `/fr/leads?q=${DOMAIN}`))).toContain(`Résultats : ${mine}`);
    const analyst = await page("alpha-analyst", "/fr/leads");
    expect(redirectPath(analyst)).toMatch(/dashboard/);
  });

  it("rapport : 100 lignes, 67 leads créés = le nombre de leads affichés, aucune donnée de contact", async () => {
    const response = await fetch(`${BASE_URL}/api/imports/report?batch_id=${batch}`, { headers: { cookie: cookie("alpha-admin", ORG.alpha) } });
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(101);
    const header = lines[0]!.split(",");
    const rows = lines.slice(1).map((l) => l.split(","));
    expect(rows.filter((r) => r[header.indexOf("lead_created")] === "yes")).toHaveLength(67);
    expect(rows.filter((r) => r[header.indexOf("outcome")] === "error")).toHaveLength(18);
    expect(text).not.toMatch(/@|\+212|\+966/);
  });

  it("rejeu du même fichier : aucun contact, aucun lead, aucun job de plus ; toutes les lignes valides sont rattachées", async () => {
    const before = { contacts: contactsIn(ORG.alpha), leads: leadsIn(ORG.alpha), jobs: Number(psql(`select count(*) from public.jobs where kind = 'lead.assign' and organization_id = '${ORG.alpha}'`)) };
    const again = await importFile("alpha-admin", PROJECT.alphaSite, ORG.alpha);
    expect(again.preview).toMatchObject({ rowCount: 100, newContacts: 0, existingContacts: 67, errors: 18 });
    expect(psql(`select status || ':' || created_count || ':' || error_count from public.import_batches where id = '${again.batch}'`)).toBe("done:0:18");
    expect({ contacts: contactsIn(ORG.alpha), leads: leadsIn(ORG.alpha), jobs: Number(psql(`select count(*) from public.jobs where kind = 'lead.assign' and organization_id = '${ORG.alpha}'`)) }).toEqual(before);
  });
});

describe("T2 chez Beta : le même fichier, une autre entreprise", () => {
  it("avant tout import, Beta ne voit rien des 67 contacts d'Alpha (page, recherche, export)", async () => {
    expect(visibleText(await page("beta-owner", `/fr/leads?q=${DOMAIN}`, ORG.beta))).toContain("Résultats : 0");
    const exported = await fetch(`${BASE_URL}/api/leads/export?q=${DOMAIN}`, { headers: { cookie: cookie("beta-owner", ORG.beta) } });
    expect(exported.status).toBe(200);
    expect((await exported.text()).toLowerCase()).not.toContain(DOMAIN);
  });

  it("import chez Beta : un jeu de contacts SÉPARÉ (65 créés, aucun rattachement à Alpha), Alpha inchangé", async () => {
    const alpha = { contacts: contactsIn(ORG.alpha), leads: leadsIn(ORG.alpha) };
    const imported = await importFile("beta-owner", PROJECT.betaShop, ORG.beta);
    expect(imported.preview).toMatchObject({ rowCount: 100, newContacts: 67, existingContacts: 0, duplicatesInFile: 15, errors: 18 });
    expect(psql(`select status || ':' || created_count || ':' || error_count from public.import_batches where id = '${imported.batch}'`)).toBe("done:67:18");
    expect(contactsIn(ORG.alpha)).toBe(alpha.contacts);
    expect(leadsIn(ORG.alpha)).toBe(alpha.leads);
    expect(contactsIn(ORG.beta)).toBe(67);
    expect(leadsIn(ORG.beta)).toBe(67);
    // aucun doublon à l'intérieur d'une entreprise ; chacune des 66 adresses du fichier existe UNE fois par entreprise (jamais partagée)
    expect(psql(`select count(*) from (select organization_id, email_normalized from public.contacts where email_normalized like '%@${DOMAIN}' group by 1, 2 having count(*) > 1) x`)).toBe("0");
    expect(psql(`select count(*) from (select email_normalized from public.contacts where email_normalized like '%@${DOMAIN}' group by 1 having count(distinct organization_id) = 2) x`)).toBe("66");
  });

  it("assignation chez Beta : seulement des membres de Beta ; les chiffres affichés par entreprise restent séparés", async () => {
    expect((await assignAll(jobsToAssign(ORG.beta))).every(Boolean)).toBe(true);
    expect(psql(`select string_agg(distinct l.assignee_id::text, ',' order by l.assignee_id::text) from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where ${ofFixture(ORG.beta)}`))
      .toBe([USER.betaOwner, USER.shared].sort().join(","));
    expect(searchableLeadsIn(ORG.beta)).toBe(SEARCHABLE);
    expect(visibleText(await page("beta-owner", `/fr/leads?q=${DOMAIN}`, ORG.beta))).toContain(`Résultats : ${SEARCHABLE}`);
    expect(visibleText(await page("shared", `/fr/leads?q=${DOMAIN}`, ORG.alpha))).toContain(`Résultats : ${SEARCHABLE}`);
  });

  it("contexte forgé : le propriétaire de Beta qui désigne Alpha comme entreprise active ne voit jamais le contact propre à Alpha", async () => {
    psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'Alpha seul', 'alpha-seul@${DOMAIN}', 'alpha-seul@${DOMAIN}')`);
    psql(`insert into public.leads (organization_id, contact_id, project_id, source, stage_id)
      select c.organization_id, c.id, '${PROJECT.alphaSite}', 'manual',
             (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id
               where p.organization_id = c.organization_id and p.is_default and s.kind = 'unassigned' order by s.position limit 1)
        from public.contacts c where c.organization_id = '${ORG.alpha}' and c.email_normalized = 'alpha-seul@${DOMAIN}'`);
    expect(contactsIn(ORG.alpha)).toBe(68);
    // contrôle positif : le propriétaire d'Alpha le voit bien
    expect(visibleText(await page("shared", "/fr/leads?q=alpha-seul", ORG.alpha))).toContain("alpha-seul@");
    const forged = await page("beta-owner", "/fr/leads?q=alpha-seul", ORG.alpha);
    expect(visibleText(forged)).not.toContain("alpha-seul@");
    const exported = await fetch(`${BASE_URL}/api/leads/export?q=alpha-seul`, { headers: { cookie: cookie("beta-owner", ORG.alpha) } });
    expect((await exported.text()).toLowerCase()).not.toContain("alpha-seul@");
  });
});
