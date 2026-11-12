import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, PROJECT, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, postJson, signIn, type Session } from "./app-client";
import { runImportJob } from "./import-worker";

/**
 * Import CSV (J23, scénario 2 de la spec §13) par HTTP, avec de vraies sessions, puis par le VRAI handler `import_csv` du worker
 * (passerelle de test : mêmes fonctions SQL, fichier lu dans le Storage avec le rôle service_role) sur `tests/fixtures/leads-100.csv` :
 * rien n'est écrit avant la confirmation ; 65 contacts créés, 17 rattachés (15 doublons dans le fichier + 2 déjà connus), 18 lignes
 * refusées ; un job d'assignation par lead ; AUCUN consentement ; rapport sans donnée de contact ; isolation Alpha / Beta.
 */
const FIXTURE = fileURLToPath(new URL("../../fixtures/leads-100.csv", import.meta.url));
const csvBytes = readFileSync(FIXTURE);
const DOMAIN = "leads100.test";

const sessions = new Map<string, Session>();
const as = (name: string): Session => {
  const session = sessions.get(name);
  if (!session) throw new Error(`session absente : ${name}`);
  return session;
};
const cookie = (name: string | null, org: string) => {
  const jar = { ...(name ? as(name).cookies : {}), fl_active_org: org };
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
};

async function upload(who: string | null, project: string, body: NonNullable<RequestInit["body"]>, contentType = "text/csv; charset=utf-8", org: string = ORG.alpha) {
  const response = await fetch(`${BASE_URL}/api/imports?project_id=${project}`, {
    method: "POST",
    headers: { "content-type": contentType, cookie: cookie(who, org) },
    body,
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const jsonPost = (who: string, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(as(who), path, payload, { activeOrg: opts.org ?? ORG.alpha, headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? randomUUID() } });

const mapping = { name: 0, email: 1, phone: 2, language: 3, country: 4 };

const runJob = runImportJob;

const batches: string[] = [];
const contactsOfFixture = () => Number(psql(`select count(*) from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '+212600000099'`));

const cleanup = () => {
  const ids = batches.map((b) => `'${b}'`).join(",") || "'00000000-0000-4000-8000-000000000000'";
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where (kind = 'import_csv' and payload ->> 'batch_id' in (${ids}))
       or (kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like '%@${DOMAIN}' or c.phone_e164 = '+212600000099'));
    delete from public.import_rows where batch_id in (${ids});
    delete from public.import_batches where id in (${ids});
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like '%@${DOMAIN}' or c.phone_e164 = '+212600000099');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '+212600000099');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '+212600000099');
    delete from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '+212600000099';
  `);
  const paths = batches.map((b) => `'${ORG.alpha}/${b}.csv'`).join(",");
  if (paths) psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'imports' and name in (${paths});`);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  // deux contacts DÉJÀ connus : la ligne 94 du fichier se rattache au premier par e-mail, la ligne 95 au second par téléphone seul
  psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'Déjà client', 'deja.client@${DOMAIN}', 'deja.client@${DOMAIN}')`);
  psql(`insert into public.contacts (organization_id, name, phone_e164) values ('${ORG.alpha}', 'Déjà client tel', '+212600000099')`);
});
afterAll(cleanup);

describe("étape 1 : envoi", () => {
  it("sans session 401 ; commercial et marketing 403 ; type de contenu, encodage, fichier vide et projet d'une autre entreprise refusés", async () => {
    expect((await upload(null, PROJECT.alphaSite, csvBytes)).status).toBe(401);
    expect((await upload("alpha-sales", PROJECT.alphaSite, csvBytes)).status).toBe(403);
    expect((await upload("alpha-marketing", PROJECT.alphaSite, csvBytes)).status).toBe(403);
    expect((await upload("shared", PROJECT.alphaSite, csvBytes, "application/json")).status).toBe(400);
    expect((await upload("shared", PROJECT.alphaSite, new Uint8Array([0x6e, 0x0a, 0xff, 0xfe, 0x0a]))).status).toBe(400);
    expect((await upload("shared", PROJECT.alphaSite, new Uint8Array(0))).status).toBe(400);
    expect((await upload("shared", PROJECT.betaShop, csvBytes)).status).toBe(404);
    expect((await upload("shared", "pas-un-uuid", csvBytes)).status).toBe(400);
    expect(contactsOfFixture()).toBe(2);
  });

  it("plus de 10 Mo : 413", async () => {
    expect((await upload("shared", PROJECT.alphaSite, new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
  });
});

describe("leads-100.csv : envoi, aperçu, confirmation, worker, rapport", () => {
  let batch = "";

  it("envoi : lot créé, 100 lignes, en-tête renvoyé ; rien n'est écrit dans les contacts", async () => {
    const res = await upload("shared", PROJECT.alphaSite, csvBytes);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ row_count: 100, columns: ["Nom", "Email", "Téléphone", "Langue", "Pays"] });
    batch = String(res.json.batch_id);
    batches.push(batch);
    expect(psql(`select status from public.import_batches where id = '${batch}'`)).toBe("uploaded");
    expect(contactsOfFixture()).toBe(2);
  });

  it("aperçu : 20 lignes, rapport de déduplication (65 nouveaux, 2 connus, 15 doublons, 18 erreurs) ; RIEN n'est écrit", async () => {
    const res = await jsonPost("alpha-admin", "/api/imports/preview", { batch_id: batch, mapping, default_country: "MA" });
    expect(res.status).toBe(200);
    const preview = res.json.preview as { rowCount: number; newContacts: number; existingContacts: number; duplicatesInFile: number; errors: number; errorsByReason: Record<string, number>; rows: unknown[] };
    expect(preview).toMatchObject({ rowCount: 100, newContacts: 65, existingContacts: 2, duplicatesInFile: 15, errors: 18 });
    expect(preview.errorsByReason).toEqual({ no_identifier: 5, invalid_email: 5, invalid_phone: 5, invalid_language: 3 });
    expect(preview.rows).toHaveLength(20);
    expect(contactsOfFixture()).toBe(2);
    expect(psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like '%@${DOMAIN}'`)).toBe("0");
    expect(psql(`select count(*) from public.jobs where kind = 'import_csv' and payload ->> 'batch_id' = '${batch}'`)).toBe("0");
  });

  it("mapping invalide : 400 ; entreprise dans le corps : 400 ; owner d'une AUTRE entreprise : 404 (lot invisible)", async () => {
    expect((await jsonPost("shared", "/api/imports/preview", { batch_id: batch, mapping: { name: 0 } })).status).toBe(400);
    expect((await jsonPost("shared", "/api/imports/preview", { batch_id: batch, mapping, organization_id: ORG.beta })).status).toBe(400);
    expect((await jsonPost("beta-owner", "/api/imports/preview", { batch_id: batch, mapping }, { org: ORG.beta })).status).toBe(404);
    expect((await jsonPost("beta-owner", "/api/imports/confirm", { batch_id: batch, mapping }, { org: ORG.beta })).status).toBe(404);
    expect((await jsonPost("alpha-sales", "/api/imports/preview", { batch_id: batch, mapping })).status).toBe(403);
  });

  it("confirmation : clé d'idempotence obligatoire ; 202 ; rejeu avec la même clé identique ; nouvelle clé : 409 ; un job `import_csv`", async () => {
    expect((await jsonPost("shared", "/api/imports/confirm", { batch_id: batch, mapping, default_country: "MA" }, { key: null })).status).toBe(400);
    const key = randomUUID();
    const first = await jsonPost("shared", "/api/imports/confirm", { batch_id: batch, mapping, default_country: "MA" }, { key });
    expect(first.status).toBe(202);
    const replay = await jsonPost("shared", "/api/imports/confirm", { batch_id: batch, mapping, default_country: "MA" }, { key });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect((await jsonPost("shared", "/api/imports/confirm", { batch_id: batch, mapping, default_country: "MA" })).status).toBe(409);
    expect(psql(`select count(*) from public.jobs where kind = 'import_csv' and payload ->> 'batch_id' = '${batch}'`)).toBe("1");
    expect(contactsOfFixture()).toBe(2);
    expect((await jsonPost("shared", "/api/imports/preview", { batch_id: batch, mapping })).status).toBe(409);
  });

  it("worker : 65 contacts créés, 17 rattachés, 18 refusées ; un job d'assignation par lead ; aucun consentement", async () => {
    await runJob(batch);
    expect(psql(`select status || ':' || created_count || ':' || matched_count || ':' || skipped_count || ':' || error_count from public.import_batches where id = '${batch}'`)).toBe("done:65:17:0:18");
    expect(contactsOfFixture()).toBe(67);
    const leads = psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id where (c.email_normalized like '%@${DOMAIN}' or c.phone_e164 = '+212600000099') and l.source = 'csv_import'`);
    expect(leads).toBe("67");
    expect(psql(`select count(*) from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like '%@${DOMAIN}' or c.phone_e164 = '+212600000099')`)).toBe("67");
    expect(psql(`select count(*) from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}' or phone_e164 = '+212600000099')`)).toBe("0");
    expect(psql(`select count(distinct phone_e164) from public.contacts where email_normalized like '%@${DOMAIN}' and phone_e164 is not null`)).toBe("60");
  });

  it("téléphones hétérogènes normalisés ; contacts en base : un seul par adresse, casse ignorée", async () => {
    expect(psql(`select count(*) from public.contacts where email_normalized = 'contact001@${DOMAIN}'`)).toBe("1");
    expect(psql(`select phone_e164 from public.contacts where email_normalized = 'contact001@${DOMAIN}'`)).toBe("+212601000137");
    expect(psql(`select count(*) from public.contacts where phone_e164 like '+966%' and email_normalized like '%@${DOMAIN}'`)).not.toBe("0");
  });

  it("rejeu du job : aucun contact, lead ni job de plus", async () => {
    await runJob(batch);
    expect(contactsOfFixture()).toBe(67);
    expect(psql(`select count(*) from public.leads l join public.contacts c on c.id = l.contact_id where (c.email_normalized like '%@${DOMAIN}' or c.phone_e164 = '+212600000099') and l.source = 'csv_import'`)).toBe("67");
    expect(psql(`select status from public.import_batches where id = '${batch}'`)).toBe("done");
  });

  it("rapport téléchargeable : CSV de 100 lignes sans aucune donnée de contact ; admin oui, marketing et commercial 403, Beta 404", async () => {
    const download = async (who: string, org: string = ORG.alpha) =>
      fetch(`${BASE_URL}/api/imports/report?batch_id=${batch}`, { headers: { cookie: cookie(who, org) } });
    const ok = await download("alpha-admin");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/csv");
    const text = await ok.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("row,outcome,reason,lead_created");
    expect(lines).toHaveLength(101);
    expect(text).not.toMatch(/@|\+212|\+966|Nadia|Contact/);
    expect(lines).toContain("2,created,,yes");
    expect(lines.filter((l) => l.includes(",error,invalid_email,")).length).toBe(5);
    expect(lines.filter((l) => l.includes(",matched,duplicate_in_file,")).length).toBe(15);
    expect((await download("alpha-marketing")).status).toBe(403);
    expect((await download("alpha-sales")).status).toBe(403);
    expect((await download("beta-owner", ORG.beta)).status).toBe(404);
  });

  it("lot : état et liste lisibles par owner / admin, jamais le chemin du fichier", async () => {
    const res = await fetch(`${BASE_URL}/api/imports?id=${batch}`, { headers: { cookie: cookie("alpha-admin", ORG.alpha) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: Record<string, unknown> };
    expect(body.batch).toMatchObject({ id: batch, status: "done", created_count: 65, matched_count: 17, error_count: 18 });
    expect(JSON.stringify(body)).not.toContain(".csv");
    const other = await fetch(`${BASE_URL}/api/imports?id=${batch}`, { headers: { cookie: cookie("beta-owner", ORG.beta) } });
    expect(other.status).toBe(404);
  });
});

describe("annulation", () => {
  it("un lot envoyé puis annulé n'écrit jamais rien ; le worker l'ignore", async () => {
    const res = await upload("alpha-admin", PROJECT.alphaSite, new TextEncoder().encode("email\nannule@leads100.test\n"));
    expect(res.status).toBe(201);
    const batch = String(res.json.batch_id);
    batches.push(batch);
    expect((await jsonPost("alpha-admin", "/api/imports/cancel", { batch_id: batch })).status).toBe(200);
    expect((await jsonPost("alpha-admin", "/api/imports/confirm", { batch_id: batch, mapping: { email: 0 } })).status).toBe(409);
    expect(psql(`select count(*) from public.contacts where email_normalized = 'annule@${DOMAIN}'`)).toBe("0");
  });
});
