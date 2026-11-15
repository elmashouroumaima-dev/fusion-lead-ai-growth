import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Écrans de configuration (J39b) par HTTP, avec de vraies sessions : clés de formulaire (clé en clair une seule fois, jamais relisible,
 * révocation), règles d'assignation, notifications (lecture par le seul destinataire). Owner et admin seulement ; isolation Alpha / Beta.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const KEY_PREFIX = `acc39b${run}`;
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(who ? as(who) : null, path, payload, {
    activeOrg: opts.org ?? ORG.alpha,
    headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` },
  });
const first = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0)[0] ?? "";
const memberId = (email: string, org: string) =>
  first(`select m.user_id from public.organization_members m join auth.users u on u.id = m.user_id where u.email = '${email}' and m.organization_id = '${org}'`);

let project = "";
let adminId = "";
let salesId = "";
const ORIGIN = `https://formulaire-${run}.example.com`;
const createdKeys: string[] = [];
const createdRules: string[] = [];

const cleanup = () => {
  if (createdRules.length) psql(`delete from public.assignment_rules where id in (${createdRules.map((i) => `'${i}'`).join(",")})`);
  if (createdKeys.length) psql(`delete from public.form_keys where id in (${createdKeys.map((i) => `'${i}'`).join(",")})`);
  psql(`delete from public.notifications where dedupe_key like '${KEY_PREFIX}%'`);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  project = first(`select id from public.projects where organization_id = '${ORG.alpha}' and status = 'active' order by created_at limit 1`);
  adminId = memberId("alpha-admin@seed.test", ORG.alpha);
  salesId = memberId("alpha-sales@seed.test", ORG.alpha);
  expect(project).not.toBe("");
  expect(adminId).not.toBe("");
});
afterAll(cleanup);

describe("clés de formulaire", () => {
  it("marketing, commercial, analyste : 403 ; anonyme : 401 ; sans clé d'idempotence, organization_id étranger ou origine http : refusés", async () => {
    const body = { project_id: project, allowed_origins: [ORIGIN] };
    for (const who of ["alpha-marketing", "alpha-sales", "alpha-analyst"]) expect((await post(who, "/api/forms/keys", body)).status, who).toBe(403);
    expect((await post(null, "/api/forms/keys", body)).status).toBe(401);
    expect((await post("shared", "/api/forms/keys", body, { key: null })).status).toBe(400);
    expect((await post("shared", "/api/forms/keys", { ...body, organization_id: ORG.beta })).status).toBe(403);
    expect((await post("shared", "/api/forms/keys", { project_id: project, allowed_origins: ["http://pas-https.example.com"] })).status).toBe(400);
  });

  it("l'admin crée une clé : en clair une seule fois ; la base ne garde que l'empreinte ; la liste n'expose que le préfixe", async () => {
    const key = `${KEY_PREFIX}-create-${randomUUID()}`;
    const created = await post("alpha-admin", "/api/forms/keys", { project_id: project, allowed_origins: [ORIGIN] }, { key });
    expect(created.status).toBe(201);
    const { id, key: clear, key_prefix } = created.json as { id: string; key: string; key_prefix: string };
    createdKeys.push(id);
    expect(clear).toMatch(/^flk_[0-9a-f]{64}$/);
    expect(clear.startsWith(key_prefix)).toBe(true);
    // jamais en clair en base ni dans l'idempotence
    expect(first(`select count(*) from public.form_keys where id = '${id}' and key_hash = '${clear}'`)).toBe("0");
    expect(first(`select count(*) from public.form_keys where id = '${id}' and key_hash is not null and active`)).toBe("1");
    expect(first(`select count(*) from public.idempotency_keys where response::text like '%${clear}%'`)).toBe("0");
    // rejeu avec la même clé d'idempotence : 409 sans corps de l'effet initial
    const replay = await post("alpha-admin", "/api/forms/keys", { project_id: project, allowed_origins: [ORIGIN] }, { key });
    expect(replay.status).toBe(409);
    expect(JSON.stringify(replay.json)).not.toContain(clear);
    // la page du projet n'affiche jamais la clé complète
    const page = await getPage(as("alpha-admin"), `/en/projects/${project}`, ORG.alpha);
    expect(page.body).not.toContain(clear);
    expect(first(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and (before::text like '%${clear}%' or after::text like '%${clear}%')`)).toBe("0");
  });

  it("révoquer, réactiver et changer les origines ; la clé d'une autre entreprise reste intouchable", async () => {
    const created = await post("shared", "/api/forms/keys", { project_id: project, allowed_origins: [ORIGIN] });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    createdKeys.push(id);
    expect((await post("alpha-sales", "/api/forms/keys/active", { key_id: id, active: false })).status).toBe(403);
    expect((await post("alpha-admin", "/api/forms/keys/active", { key_id: id, active: false })).status).toBe(200);
    expect(first(`select active from public.form_keys where id = '${id}'`)).toBe("f");
    expect((await post("alpha-admin", "/api/forms/keys/active", { key_id: id, active: true })).status).toBe(200);
    expect((await post("alpha-admin", "/api/forms/keys/origins", { key_id: id, allowed_origins: [`https://autre-${run}.example.com`] })).status).toBe(200);
    expect(first(`select allowed_origins[1] from public.form_keys where id = '${id}'`)).toBe(`https://autre-${run}.example.com`);
    expect((await post("beta-owner", "/api/forms/keys/active", { key_id: id, active: false }, { org: ORG.beta })).status).toBe(404);
    expect(first(`select active from public.form_keys where id = '${id}'`)).toBe("t");
  });
});

describe("règles d'assignation", () => {
  it("commercial, marketing, analyste : 403 ; fixed avec deux membres ou membre d'une autre entreprise : refusés", async () => {
    const body = { project_id: project, strategy: "round_robin", eligible_member_ids: [adminId] };
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) expect((await post(who, "/api/assignment/rules", body)).status, who).toBe(403);
    expect((await post(null, "/api/assignment/rules", body)).status).toBe(401);
    expect((await post("shared", "/api/assignment/rules", { ...body, strategy: "fixed", eligible_member_ids: [adminId, salesId] })).status).toBe(400);
    const betaMember = memberId("beta-owner@seed.test", ORG.beta);
    expect((await post("shared", "/api/assignment/rules", { ...body, eligible_member_ids: [betaMember] })).status).toBeGreaterThanOrEqual(400);
  });

  it("l'admin crée, modifie, désactive et supprime une règle de projet", async () => {
    const created = await post("alpha-admin", "/api/assignment/rules", { project_id: project, strategy: "round_robin", eligible_member_ids: [adminId, salesId] });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    createdRules.push(id);
    expect((await post("alpha-admin", "/api/assignment/rules/update", { rule_id: id, strategy: "fixed", eligible_member_ids: [salesId], active: true })).status).toBe(200);
    expect(first(`select strategy || ':' || cardinality(eligible_member_ids)::text from public.assignment_rules where id = '${id}'`)).toBe("fixed:1");
    expect((await post("alpha-admin", "/api/assignment/rules/update", { rule_id: id, strategy: "fixed", eligible_member_ids: [salesId], active: false })).status).toBe(200);
    expect(first(`select active from public.assignment_rules where id = '${id}'`)).toBe("f");
    expect((await post("beta-owner", "/api/assignment/rules/delete", { rule_id: id }, { org: ORG.beta })).status).toBeGreaterThanOrEqual(400);
    expect(first(`select count(*) from public.assignment_rules where id = '${id}'`)).toBe("1");
    expect((await post("alpha-admin", "/api/assignment/rules/delete", { rule_id: id })).status).toBe(200);
    expect(first(`select count(*) from public.assignment_rules where id = '${id}'`)).toBe("0");
  });

  it("pages : commercial, marketing et analyste reviennent au tableau de bord ; l'admin voit la page", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) expect(redirectPath(await getPage(as(who), "/en/assignment", ORG.alpha)), who).toMatch(/dashboard/);
    const page = await getPage(as("alpha-admin"), "/en/assignment", ORG.alpha);
    expect(page.status).toBe(200);
    expect(visibleText(page)).toContain("Assignment rules");
  });
});

describe("notifications", () => {
  it("chaque destinataire voit et marque SES notifications ; send.failed s'affiche sans erreur", async () => {
    const mine = first(`insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key) values ('${ORG.alpha}', '${adminId}', 'send.failed', '{"job_id":"${randomUUID()}","job_kind":"send_message"}', '${KEY_PREFIX}-mine') returning id`);
    const other = first(`insert into public.notifications (organization_id, recipient_id, kind, payload, dedupe_key) values ('${ORG.alpha}', '${salesId}', 'send.failed', '{"job_id":"${randomUUID()}","job_kind":"send_message"}', '${KEY_PREFIX}-other') returning id`);
    const page = await getPage(as("alpha-admin"), "/en/notifications", ORG.alpha);
    expect(page.status).toBe(200);
    expect(visibleText(page)).toContain("send_message");
    // libellés traduits (une clé de traduction mal formée s'afficherait en clair : « Notifications.kind… »)
    expect(visibleText(page)).toContain("Failed send");
    expect(visibleText(page)).not.toMatch(/Notifications\.[a-z]+\./);
    // le commercial ne peut pas marquer la notification d'un autre
    expect((await post("alpha-sales", "/api/notifications/read", { notification_id: mine })).status).toBeGreaterThanOrEqual(400);
    expect(first(`select read_at is null from public.notifications where id = '${mine}'`)).toBe("t");
    expect((await post("alpha-admin", "/api/notifications/read", { notification_id: mine })).status).toBe(200);
    expect(first(`select read_at is not null from public.notifications where id = '${mine}'`)).toBe("t");
    expect(first(`select read_at is null from public.notifications where id = '${other}'`)).toBe("t");
    expect((await post("alpha-admin", "/api/notifications/read", { notification_id: mine, organization_id: ORG.beta })).status).toBe(400);
  });
});
