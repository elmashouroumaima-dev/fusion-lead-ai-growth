import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCrmSyncHandler } from "../../../apps/worker/src/handlers";
import type { CrmFound, CrmSyncGateway, CrmSyncStart } from "../../../apps/worker/src/crm-sync";
import { api, downloadAsService, ORG, PROJECT, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Synchro CRM (J25) par HTTP avec de vraies sessions, puis par le VRAI handler `crm_sync` du worker (passerelle de test : mêmes fonctions
 * SQL, fichier lu dans le Storage réel) : intégration + mapping (owner / admin), fichier CSV envoyé par l'assistant d'import, demande de
 * synchro (202, jamais dans la requête), création / rattachement / mise à jour, conflit résolu par la source de vérité et consigné dans
 * l'audit SANS valeur, contact « ne plus contacter » intact, aucun consentement, rejeu sans doublon, échec visible puis « Réessayer ».
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `crmsync${run}`;
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const cookie = (who: string, org: string) => Object.entries({ ...as(who).cookies, fl_active_org: org }).map(([k, v]) => `${k}=${v}`).join("; ");
const post = (who: string, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(as(who), path, payload, { activeOrg: opts.org ?? ORG.alpha, headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? randomUUID() } });
const getJson = async (who: string, path: string, org: string = ORG.alpha) => {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { cookie: cookie(who, org) } });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const uploadCsv = async (text: string) => {
  const res = await fetch(`${BASE_URL}/api/imports?project_id=${PROJECT.alphaSite}`, {
    method: "POST", headers: { "content-type": "text/csv", cookie: cookie("shared", ORG.alpha) }, body: text,
  });
  const json = (await res.json()) as { batch_id: string };
  return { status: res.status, batchId: json.batch_id };
};

const MAPPINGS = [
  { entity: "contact", internal_field: "external_id", external_field: "ID", source_of_truth: "external", direction: "pull" },
  { entity: "contact", internal_field: "external_updated_at", external_field: "Modifié le", source_of_truth: "external", direction: "pull" },
  { entity: "contact", internal_field: "email", external_field: "E-mail", source_of_truth: "internal", direction: "pull" },
  { entity: "contact", internal_field: "name", external_field: "Nom", source_of_truth: "internal", direction: "both" },
  { entity: "contact", internal_field: "country", external_field: "Pays", source_of_truth: "external", direction: "both" },
];

/** Passerelle du worker pour l'acceptation : fonctions SQL réelles (service_role) et fichier lu dans le Storage réel. */
const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const result = await api<T>("service", "POST", `rpc/${fn}`, args);
  if (result.status >= 300) throw new Error(`${fn}_${result.status}`);
  return result.body;
};
const gateway: CrmSyncGateway = {
  async start(org, integration, batch) {
    const body = await rpc<Record<string, unknown>>("crm_sync_start", { p_org: org, p_integration: integration, p_batch: batch });
    if (body.status !== "running") return { status: body.status } as CrmSyncStart;
    return { status: "running", path: body.path as string, provider: body.provider as string, source: body.source as string, lastSyncAt: body.last_sync_at ? new Date(body.last_sync_at as string) : null, lastSyncFinishedAt: body.last_sync_finished_at ? new Date(body.last_sync_finished_at as string) : null, startedAt: new Date(body.started_at as string), mappings: body.mappings };
  },
  readFile: (path) => downloadAsService("imports", path),
  async find(org, provider, externalId, email, phone) {
    const body = await rpc<Record<string, unknown> | null>("crm_sync_find", { p_org: org, p_provider: provider, p_external_id: externalId, p_email_normalized: email, p_phone_e164: phone });
    if (body === null) return null;
    if (body.status === "identity_taken") return { status: "identity_taken" } as CrmFound;
    return { status: "found", linked: body.linked as boolean, id: body.id as string, name: body.name as string | null, language: body.language as string | null, country: body.country as string | null, updatedAt: new Date(body.updated_at as string), doNotContact: body.do_not_contact as boolean };
  },
  create: (org, provider, input) =>
    rpc("crm_sync_create", { p_org: org, p_provider: provider, p_external_id: input.externalId, p_name: input.name, p_email_raw: input.emailRaw, p_email_normalized: input.emailNormalized, p_phone_e164: input.phoneE164, p_language: input.language, p_country: input.country }),
  update: (org, contact, provider, externalId, fields) => rpc("crm_sync_update", { p_org: org, p_contact: contact, p_provider: provider, p_external_id: externalId, p_fields: fields }),
  async auditConflict(org, integration, contact, conflicts) {
    await rpc("crm_sync_audit_conflict", { p_org: org, p_integration: integration, p_contact: contact, p_conflicts: conflicts });
  },
  async finish(org, integration, batch, startedAt, counts) {
    await rpc("crm_sync_finish", { p_org: org, p_integration: integration, p_batch: batch, p_started_at: startedAt.toISOString(), p_counts: counts });
  },
  async fail(org, integration, code) {
    await rpc("crm_sync_fail", { p_org: org, p_integration: integration, p_code: code });
  },
};
async function runJob(integration: string, batch: string): Promise<void> {
  await createCrmSyncHandler(gateway).run(
    { jobId: randomUUID(), organizationId: ORG.alpha, idempotencyKey: `crm_sync:${integration}:${batch}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal },
    { integration_id: integration, batch_id: batch },
  );
}

const batches: string[] = [];
let integration = "";
const email = (n: string) => `${n}.${TAG}@crmsync.test`;

const cleanup = () => {
  const ids = batches.map((b) => `'${b}'`).join(",") || "'00000000-0000-4000-8000-000000000000'";
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'crm_sync' and payload ->> 'batch_id' in (${ids});
    delete from public.crm_field_mappings where integration_id in (select id from public.integrations where external_account_id like '${TAG}%');
    delete from public.integrations where external_account_id like '${TAG}%';
    delete from public.import_rows where batch_id in (${ids});
    delete from public.import_batches where id in (${ids});
    delete from public.contacts where email_normalized like '%@crmsync.test';
  `);
  const paths = batches.map((b) => `'${ORG.alpha}/${b}.csv'`).join(",");
  if (paths) psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'imports' and name in (${paths});`);
};

beforeAll(async () => {
  cleanup();
  for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "beta-owner"]) sessions.set(who, await signIn(`${who}@seed.test`));
  // contact existant, rattachable par e-mail (même nom que dans le fichier : valeur modifiée des DEUX côtés -> conflit)
  psql(`
    insert into public.contacts (organization_id, name, email_raw, email_normalized, country) values
      ('${ORG.alpha}', 'Nadia Interne', '${email("nadia")}', '${email("nadia")}', 'MA'),
      ('${ORG.alpha}', 'Désinscrit', '${email("stop")}', '${email("stop")}', 'MA');
    update public.contacts set do_not_contact = true where email_normalized = '${email("stop")}';
  `);
});
afterAll(cleanup);

describe("intégration et mapping : rôles", () => {
  it("owner crée l'intégration ; commercial, marketing refusés ; clé d'idempotence obligatoire ; Beta ne voit pas celle d'Alpha", async () => {
    expect((await post("alpha-sales", "/api/crm/integrations", { provider: "csv", external_account_id: `${TAG}-x` })).status).toBe(403);
    expect((await post("alpha-marketing", "/api/crm/integrations", { provider: "csv", external_account_id: `${TAG}-x` })).status).toBe(403);
    expect((await post("shared", "/api/crm/integrations", { provider: "csv", external_account_id: `${TAG}-x` }, { key: null })).status).toBe(400);
    expect((await post("shared", "/api/crm/integrations", { provider: "salla", external_account_id: `${TAG}-x` })).status).toBe(400);
    expect((await post("shared", "/api/crm/integrations", { provider: "csv", external_account_id: `${TAG}-x`, organization_id: ORG.beta })).status).toBe(400);
    const created = await post("shared", "/api/crm/integrations", { provider: "csv", external_account_id: TAG });
    expect(created.status).toBe(201);
    integration = (created.json.integration as { id: string }).id;
    expect((await post("shared", "/api/crm/integrations", { provider: "csv", external_account_id: TAG })).status).toBe(409);
    const beta = await getJson("beta-owner", "/api/crm/integrations", ORG.beta);
    expect(JSON.stringify(beta.json)).not.toContain(TAG);
  });

  it("mapping : champs hors liste blanche et mapping sans identifiant refusés ; owner l'enregistre ; commercial refusé ; lecture owner / admin seulement", async () => {
    expect((await post("shared", "/api/crm/mappings", { integration_id: integration, mappings: [MAPPINGS[0], { ...MAPPINGS[3], internal_field: "do_not_contact" }] })).status).toBe(400);
    expect((await post("shared", "/api/crm/mappings", { integration_id: integration, mappings: MAPPINGS.slice(2) })).status).toBe(400);
    expect((await post("alpha-sales", "/api/crm/mappings", { integration_id: integration, mappings: MAPPINGS })).status).toBe(403);
    expect((await post("beta-owner", "/api/crm/mappings", { integration_id: integration, mappings: MAPPINGS }, { org: ORG.beta })).status).toBe(404);
    expect((await post("alpha-admin", "/api/crm/mappings", { integration_id: integration, mappings: MAPPINGS })).status).toBe(200);
    const list = await getJson("alpha-admin", "/api/crm/integrations");
    expect(list.status).toBe(200);
    const views = list.json.integrations as Array<{ integration: { id: string }; mappings: unknown[]; sync: { status: string } }>;
    const mine = views.find((v) => v.integration.id === integration);
    expect(mine?.mappings).toHaveLength(5);
    expect(mine?.sync.status).toBe("never");
    expect((await getJson("alpha-sales", "/api/crm/integrations")).status).toBe(403);
    expect((await getJson("alpha-marketing", "/api/crm/integrations")).status).toBe(403);
  });
});

describe("synchro : fichier, demande, worker", () => {
  const FILE = () =>
    [
      "ID,Nom,E-mail,Pays,Modifié le",
      `n1,Nadia Externe,${email("nadia")},SA,2099-01-01T00:00:00Z`,
      `n2,Sarah,${email("sarah")},MA,2099-01-01T00:00:00Z`,
      `n3,Piraté,${email("stop")},SA,2099-01-01T00:00:00Z`,
      "n4,Sans identité,,MA,2099-01-01T00:00:00Z",
    ].join("\r\n") + "\r\n";
  let batch = "";
  let job = "";

  it("demande refusée sans mapping ni fichier ; 202 avec un lot envoyé ; une seule synchro à la fois ; rôles", async () => {
    const up = await uploadCsv(FILE());
    expect(up.status).toBe(201);
    batch = up.batchId;
    batches.push(batch);
    expect((await post("shared", "/api/crm/sync", { integration_id: integration, batch_id: randomUUID() })).status).toBe(404);
    expect((await post("alpha-sales", "/api/crm/sync", { integration_id: integration, batch_id: batch })).status).toBe(403);
    expect((await post("shared", "/api/crm/sync", { integration_id: integration, batch_id: batch }, { key: null })).status).toBe(400);
    const first = await post("shared", "/api/crm/sync", { integration_id: integration, batch_id: batch });
    expect(first.status).toBe(202);
    job = String(first.json.job_id);
    expect((await post("alpha-admin", "/api/crm/sync", { integration_id: integration, batch_id: batch })).status).toBe(409);
    expect(psql(`select payload::text from public.jobs where id = '${job}'`)).toBe(JSON.stringify({ batch_id: batch, integration_id: integration }).replace(/","/g, '", "').replace(/":"/g, '": "'));
    expect(psql(`select count(*) from public.contacts where email_normalized = '${email("sarah")}'`)).toBe("0");
    const status = await getJson("shared", "/api/crm/integrations");
    expect((status.json.integrations as Array<{ sync: { status: string } }>)[0]?.sync.status).toBe("queued");
  });

  it("worker : Sarah créée, Nadia rattachée (conflit : nom interne gardé, pays externe appliqué), contact « ne plus contacter » intact, ligne sans identité refusée", async () => {
    await runJob(integration, batch);
    expect(psql(`select name || ':' || country || ':' || external_id from public.contacts where email_normalized = '${email("nadia")}'`)).toBe("Nadia Interne:SA:n1");
    // l'identifiant externe est PROPRE à l'intégration ; le fichier est CONSOMMÉ (plus importable ni synchronisable, hors plafond des lots en cours)
    expect(psql(`select external_source from public.contacts where email_normalized = '${email("nadia")}'`)).toBe(`csv:${integration}`);
    expect(psql(`select status from public.import_batches where id = '${batch}'`)).toBe("synced");
    expect(psql(`select name || ':' || external_id from public.contacts where email_normalized = '${email("sarah")}'`)).toBe("Sarah:n2");
    expect(psql(`select name || ':' || coalesce(external_id, 'aucun') from public.contacts where email_normalized = '${email("stop")}'`)).toBe("Désinscrit:aucun");
    expect(psql(`select count(*) from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@crmsync.test')`)).toBe("0");
    const audit = psql(`select after::text from public.audit_logs where action = 'crm_sync.conflict' and organization_id = '${ORG.alpha}' order by created_at desc limit 1`);
    const parsed = JSON.parse(audit) as { integration_id: string; conflicts: Array<{ field: string; winner: string }> };
    expect(parsed.integration_id).toBe(integration);
    expect(parsed.conflicts).toHaveLength(2);
    expect(parsed.conflicts).toEqual(expect.arrayContaining([{ field: "name", winner: "internal" }, { field: "country", winner: "external" }]));
    expect(audit).not.toContain("Nadia");
    expect(audit).not.toContain("@");
    const done = JSON.parse(psql(`select after::text from public.audit_logs where action = 'crm_sync.completed' and organization_id = '${ORG.alpha}' order by created_at desc limit 1`));
    expect(done).toEqual({ created: 1, updated: 0, linked: 1, unchanged: 0, skipped: 1, rejected: 1, conflicts: 2 });
    expect(psql(`select last_sync_at is not null and last_error is null from public.integrations where id = '${integration}'`)).toBe("t");
  });

  it("rejeu du même fichier : aucun contact de plus, aucun changement de valeur", async () => {
    await runJob(integration, batch);
    expect(psql(`select count(*) from public.contacts where email_normalized like '%@crmsync.test'`)).toBe("3");
    expect(psql(`select name from public.contacts where email_normalized = '${email("nadia")}'`)).toBe("Nadia Interne");
  });
});

describe("échec visible et « Réessayer »", () => {
  it("fichier introuvable : échec enregistré (code), statut « failed » visible, page et API ; Réessayer rejoue le même job sans doublon", async () => {
    const up = await uploadCsv(`ID,Nom,E-mail\r\nn9,Nouveau,${email("nouveau")}\r\n`);
    batches.push(up.batchId);
    // le fichier disparaît du Storage : la synchro échoue de façon définitive
    psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'imports' and name = '${ORG.alpha}/${up.batchId}.csv';`);
    // une synchro précédente est terminée : le job du premier lot est « succeeded »
    psql(`update public.jobs set status = 'succeeded' where kind = 'crm_sync' and payload ->> 'integration_id' = '${integration}'`);
    const requested = await post("shared", "/api/crm/sync", { integration_id: integration, batch_id: up.batchId });
    expect(requested.status).toBe(202);
    await expect(runJob(integration, up.batchId)).rejects.toThrow();
    psql(`update public.jobs set status = 'dead_letter', last_error = 'file_missing' where id = '${String(requested.json.job_id)}'`);
    const failed = (await getJson("alpha-admin", "/api/crm/integrations")).json.integrations as Array<{ sync: { status: string; lastError: string | null } }>;
    expect(failed[0]?.sync).toMatchObject({ status: "failed", lastError: "file_missing" });
    const page = await getPage(as("shared"), "/fr/crm", ORG.alpha);
    expect(page.status).toBe(200);
    expect(visibleText(page)).toContain("En échec");
    expect(visibleText(page)).toContain("Réessayer");
    expect(visibleText(page)).not.toContain("@");

    expect((await post("alpha-sales", "/api/crm/sync/retry", { integration_id: integration })).status).toBe(403);
    expect((await post("beta-owner", "/api/crm/sync/retry", { integration_id: integration }, { org: ORG.beta })).status).toBe(404);
    const retry = await post("alpha-admin", "/api/crm/sync/retry", { integration_id: integration });
    expect(retry.status).toBe(202);
    expect(retry.json.retried).toBe(true);
    expect(psql(`select count(*) from public.jobs where kind = 'crm_sync' and payload ->> 'batch_id' = '${up.batchId}'`)).toBe("1");
    expect((await getJson("alpha-admin", "/api/crm/integrations")).json.integrations as Array<{ sync: { status: string } }>).toMatchObject([{ sync: { status: "queued" } }]);
    // rien d'autre à rejouer
    expect((await post("alpha-admin", "/api/crm/sync/retry", { integration_id: integration })).json.retried).toBe(false);
  });

  it("page /crm : renvoie commercial et marketing au tableau de bord ; sans session, à la connexion ; Beta n'y voit rien d'Alpha", async () => {
    for (const who of ["alpha-sales", "alpha-marketing"]) expect(redirectPath(await getPage(as(who), "/fr/crm", ORG.alpha)), who).toMatch(/dashboard/);
    expect(redirectPath(await getPage(null, "/fr/crm"))).toMatch(/login/);
    expect(visibleText(await getPage(as("beta-owner"), "/fr/crm", ORG.beta))).not.toContain(TAG);
    const ar = await getPage(as("shared"), "/ar/crm", ORG.alpha);
    expect(ar.body).toContain('dir="rtl"');
  });
});
