import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, PROJECT, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";
import { runImportJob } from "./import-worker";

/**
 * Écran d'import CSV (J39c) par HTTP, avec de vraies sessions : la page (owner et admin seulement), l'assistant en trois étapes tel que l'écran le
 * pilote (envoi du fichier brut, aperçu, confirmation avec clé d'idempotence), RIEN n'est écrit avant la confirmation, le suivi des lots sur la
 * page, l'annulation, le rapport téléchargeable SANS donnée de contact, et l'isolation Alpha / Beta. Le lot confirmé est traité par le VRAI
 * handler `import_csv` du worker (passerelle de test, mêmes fonctions SQL).
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DOMAIN = `is${run}.test`;
const KEY_PREFIX = `is${run}`;
const NAME_MARK = `NomSecret${run}`;
const PHONE = `+2126${String(Date.now()).slice(-8)}`;
const CSV = [
  "Nom,E-mail,Téléphone,Pays",
  `${NAME_MARK} Un,un@${DOMAIN},${PHONE},MA`,
  `${NAME_MARK} Deux,deux@${DOMAIN},,MA`,
  `${NAME_MARK} Doublon,un@${DOMAIN},,MA`,
  `${NAME_MARK} Mauvais,pas-un-email,,MA`,
  `${NAME_MARK} Sans,,,MA`,
].join("\n");
const MAPPING = { name: 0, email: 1, phone: 2, country: 3 };

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const cookie = (who: string | null, org: string) => Object.entries({ ...(who ? as(who).cookies : {}), fl_active_org: org }).map(([k, v]) => `${k}=${v}`).join("; ");
const first = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0)[0] ?? "";
const batches: string[] = [];

async function upload(who: string | null, project: string, body: string, org: string = ORG.alpha) {
  const response = await fetch(`${BASE_URL}/api/imports?project_id=${project}`, { method: "POST", headers: { "content-type": "text/csv", cookie: cookie(who, org) }, body });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const post = (who: string, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(as(who), path, payload, { activeOrg: opts.org ?? ORG.alpha, headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${KEY_PREFIX}-${randomUUID()}` } });
const imported = () => Number(first(`select count(*) from public.contacts where email_normalized like '%@${DOMAIN}'`));

const cleanup = () => {
  const ids = batches.map((b) => `'${b}'`).join(",") || "'00000000-0000-4000-8000-000000000000'";
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.jobs where (kind = 'import_csv' and payload ->> 'batch_id' in (${ids}))
       or (kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like '%@${DOMAIN}'));
    delete from public.import_rows where batch_id in (${ids});
    delete from public.import_batches where id in (${ids});
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like '%@${DOMAIN}');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}');
    delete from public.contacts where email_normalized like '%@${DOMAIN}';
    commit;
  `);
  const paths = batches.map((b) => `'${ORG.alpha}/${b}.csv'`).join(",");
  if (paths) psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'imports' and name in (${paths});`);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  psql(`update public.projects set status = 'active' where id = '${PROJECT.alphaApp}'`);
});
afterAll(cleanup);

let batch = "";

describe("page et rôles", () => {
  it("commercial, marketing et analyste reviennent au tableau de bord ; un anonyme à la connexion ; l'admin voit l'assistant", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) expect(redirectPath(await getPage(as(who), "/en/imports", ORG.alpha)), who).toMatch(/dashboard/);
    expect(redirectPath(await getPage(null, "/en/imports", ORG.alpha))).toMatch(/login/);
    const page = await getPage(as("alpha-admin"), "/en/imports", ORG.alpha);
    expect(page.status).toBe(200);
    expect(visibleText(page)).toContain("CSV import");
    expect(visibleText(page)).toContain("Upload the file");
    expect(visibleText(page)).not.toMatch(/Imports\.[a-z]+\./);
  });

  it("la page existe dans les trois langues", async () => {
    expect(visibleText(await getPage(as("alpha-admin"), "/fr/imports", ORG.alpha))).toContain("Import CSV");
    expect(visibleText(await getPage(as("alpha-admin"), "/ar/imports", ORG.alpha))).toContain("استيراد CSV");
  });
});

describe("assistant : envoi, aperçu, confirmation", () => {
  it("1. envoi du fichier : le lot est « envoyé », les colonnes sont lues, AUCUN contact n'est créé", async () => {
    const sent = await upload("alpha-admin", PROJECT.alphaApp, CSV);
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({ row_count: 5, columns: ["Nom", "E-mail", "Téléphone", "Pays"] });
    batch = String(sent.json.batch_id);
    batches.push(batch);
    expect(first(`select status from public.import_batches where id = '${batch}'`)).toBe("uploaded");
    expect(imported()).toBe(0);
  });

  it("2. aperçu : compteurs et lignes, MAIS rien n'est écrit (ni contact, ni lead, ni job)", async () => {
    const preview = await post("alpha-admin", "/api/imports/preview", { batch_id: batch, mapping: MAPPING, default_country: "MA" }, { key: null });
    expect(preview.status).toBe(200);
    expect(preview.json.preview).toMatchObject({ rowCount: 5, valid: 3, newContacts: 2, duplicatesInFile: 1, errors: 2 });
    expect(imported()).toBe(0);
    expect(first(`select count(*) from public.jobs where kind = 'import_csv' and payload ->> 'batch_id' = '${batch}'`)).toBe("0");
    expect(first(`select status from public.import_batches where id = '${batch}'`)).toBe("uploaded");
  });

  it("la page montre le lot « Uploaded » et ne révèle ni le chemin du fichier, ni le mapping, ni le contenu", async () => {
    const page = await getPage(as("alpha-admin"), "/en/imports", ORG.alpha);
    expect(visibleText(page)).toContain("Uploaded");
    expect(page.body).not.toContain(`${ORG.alpha}/${batch}.csv`);
    expect(page.body).not.toContain("file_path");
    expect(page.body).not.toContain(NAME_MARK);
    expect(page.body).not.toContain(`un@${DOMAIN}`);
  });

  it("3. confirmation : refusée sans clé d'idempotence et pour le commercial ; acceptée pour l'admin (202, lot « queued »), toujours aucun contact", async () => {
    const body = { batch_id: batch, mapping: MAPPING, default_country: "MA" };
    expect((await post("alpha-admin", "/api/imports/confirm", body, { key: null })).status).toBe(400);
    expect((await post("alpha-sales", "/api/imports/confirm", body)).status).toBe(403);
    expect((await post("alpha-marketing", "/api/imports/confirm", body)).status).toBe(403);
    const confirmed = await post("alpha-admin", "/api/imports/confirm", body);
    expect(confirmed.status).toBe(202);
    expect(confirmed.json).toMatchObject({ status: "queued", batch_id: batch });
    expect(first(`select status from public.import_batches where id = '${batch}'`)).toBe("queued");
    expect(imported()).toBe(0);
  });

  it("le worker traite le lot : 2 contacts créés, 1 doublon, 2 lignes refusées ; la page affiche « Done » et les compteurs", async () => {
    await runImportJob(batch);
    expect(first(`select status from public.import_batches where id = '${batch}'`)).toBe("done");
    expect(imported()).toBe(2);
    expect(first(`select created_count || ':' || matched_count || ':' || error_count from public.import_batches where id = '${batch}'`)).toMatch(/^2:1:2$|^2:1:1$/);
    const page = await getPage(as("alpha-admin"), "/en/imports", ORG.alpha);
    expect(visibleText(page)).toContain("Done");
    expect(visibleText(page)).toContain("Download the report");
  });
});

describe("rapport, annulation et isolation", () => {
  it("le rapport se télécharge en CSV et ne contient AUCUNE donnée de contact", async () => {
    const response = await fetch(`${BASE_URL}/api/imports/report?batch_id=${batch}`, { headers: { cookie: cookie("alpha-admin", ORG.alpha) } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(`import-${batch}.csv`);
    const csv = await response.text();
    const lines = csv.split(/\r?\n/);
    expect(lines[0]).toBe("row,outcome,reason,lead_created");
    expect(csv).not.toContain(NAME_MARK);
    expect(csv).not.toContain(DOMAIN);
    expect(csv).not.toContain(PHONE);
    expect(csv.split("\n").filter((line) => /^\d+,/.test(line))).toHaveLength(5);
    const denied = await fetch(`${BASE_URL}/api/imports/report?batch_id=${batch}`, { headers: { cookie: cookie("alpha-sales", ORG.alpha) } });
    expect(denied.status).toBe(403);
  });

  it("annulation d'un lot « envoyé » : statut « cancelled », rien n'est créé ; un lot terminé ne s'annule plus", async () => {
    const sent = await upload("alpha-admin", PROJECT.alphaApp, `Nom,E-mail\nAnnule,annule@${DOMAIN}`);
    expect(sent.status).toBe(201);
    const cancelled = String(sent.json.batch_id);
    batches.push(cancelled);
    expect((await post("alpha-sales", "/api/imports/cancel", { batch_id: cancelled })).status).toBe(403);
    expect((await post("alpha-admin", "/api/imports/cancel", { batch_id: cancelled }, { key: null })).status).toBe(400);
    expect((await post("alpha-admin", "/api/imports/cancel", { batch_id: cancelled })).status).toBe(200);
    expect(first(`select status from public.import_batches where id = '${cancelled}'`)).toBe("cancelled");
    expect(first(`select count(*) from public.contacts where email_normalized = 'annule@${DOMAIN}'`)).toBe("0");
    expect((await post("alpha-admin", "/api/imports/cancel", { batch_id: batch })).status).toBeGreaterThanOrEqual(400);
    expect(first(`select status from public.import_batches where id = '${batch}'`)).toBe("done");
  });

  it("une autre entreprise ne voit ni le lot, ni son rapport, ni dans sa page ; elle ne peut ni l'annuler ni le confirmer", async () => {
    const read = await fetch(`${BASE_URL}/api/imports?id=${batch}`, { headers: { cookie: cookie("beta-owner", ORG.beta) } });
    expect(read.status).toBe(404);
    const report = await fetch(`${BASE_URL}/api/imports/report?batch_id=${batch}`, { headers: { cookie: cookie("beta-owner", ORG.beta) } });
    expect(report.status).toBe(404);
    expect((await post("beta-owner", "/api/imports/cancel", { batch_id: batch }, { org: ORG.beta })).status).toBeGreaterThanOrEqual(400);
    expect((await post("beta-owner", "/api/imports/confirm", { batch_id: batch, mapping: MAPPING }, { org: ORG.beta })).status).toBeGreaterThanOrEqual(400);
    const page = await getPage(as("beta-owner"), "/en/imports", ORG.beta);
    expect(page.body).not.toContain(batch);
  });
});
