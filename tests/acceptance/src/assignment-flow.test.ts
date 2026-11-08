import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, PROJECT, psql, USER } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL } from "./app-client";

/**
 * Chaîne complète d'assignation (J22, spec §9.1 étapes 3 et 4) : formulaire public (HTTP, clé + origine) -> contact + lead « non
 * assigné » + job `lead.assign` -> assignation par la fonction que le worker appelle (avec l'entreprise de la LIGNE DU JOB) ->
 * lead ouvert chez le commercial désigné ; rejeu sans double assignation ; sans règle : le lead reste dans la file « non assignés »
 * et les owner / admin sont alertés (une alerte chacun). Le handler du worker est testé à part (tests unitaires).
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (n: string) => `asg-${run}-${n}@exemple.test`.toLowerCase();
const ORIGIN = `https://asg-${run}-a.exemple.test`;
const KEY = `flk_${randomBytes(32).toString("hex")}`;
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
let ip = 20;
const nextIp = () => `203.0.113.${(ip += 1)}`;

async function submit(address: string): Promise<number> {
  const response = await fetch(`${BASE_URL}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), "x-form-key": KEY, origin: ORIGIN },
    body: JSON.stringify({ name: "Test acceptation assignation", email: address }),
  });
  return response.status;
}

const leadOf = (address: string) =>
  psql(`select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = '${address}'`);
const jobOf = (lead: string) =>
  psql(`select organization_id from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' = '${lead}'`);
/** Ce que fait le worker pour un job `lead.assign` : l'entreprise vient de la ligne du job, jamais de la charge utile. */
const processJob = async (lead: string) => (await api<Record<string, unknown>>("service", "POST", "rpc/auto_assign_lead", { p_org: jobOf(lead), p_lead: lead })).body;

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.notifications where payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'asg-${run}-%');
    delete from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'asg-${run}-%');
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'asg-${run}-%');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like 'asg-${run}-%');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'asg-${run}-%');
    delete from public.contacts where email_normalized like 'asg-${run}-%';
    delete from public.form_keys where allowed_origins::text like '%asg-${run}-%';
    delete from public.assignment_rules where project_id = '${PROJECT.alphaSite}';
  `);

beforeAll(() => {
  cleanup();
  psql(`
    insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins)
    values ('${ORG.alpha}', '${PROJECT.alphaSite}', '${hash(KEY)}', '${KEY.slice(0, 8)}', array['${ORIGIN}']);
    insert into public.assignment_rules (organization_id, project_id, strategy, eligible_member_ids)
    values ('${ORG.alpha}', '${PROJECT.alphaSite}', 'fixed', array['${USER.alphaSales}']::uuid[]);
  `);
});
afterAll(cleanup);

describe("formulaire public -> job -> assignation", () => {
  it("le lead capturé est « non assigné » avec un job, puis assigné au commercial de la règle ; le rejeu ne change rien", async () => {
    expect(await submit(email("one"))).toBe(202);
    const lead = leadOf(email("one"));
    expect(psql(`select s.kind from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = '${lead}'`)).toBe("unassigned");
    expect(jobOf(lead)).toBe(ORG.alpha);

    expect(await processJob(lead)).toEqual({ outcome: "assigned", assignee_id: USER.alphaSales });
    expect(psql(`select assignee_id from public.leads where id = '${lead}'`)).toBe(USER.alphaSales);
    expect(psql(`select s.kind from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = '${lead}'`)).toBe("open");

    expect(await processJob(lead)).toMatchObject({ outcome: "skipped" });
    expect(psql(`select assignee_id from public.leads where id = '${lead}'`)).toBe(USER.alphaSales);
    expect(psql(`select count(*) from public.activities where lead_id = '${lead}' and type = 'assignment'`)).toBe("1");
  });

  it("une entreprise forgée dans l'appel ne touche pas le lead d'une autre", async () => {
    expect(await submit(email("two"))).toBe(202);
    const lead = leadOf(email("two"));
    const forged = await api<Record<string, unknown>>("service", "POST", "rpc/auto_assign_lead", { p_org: ORG.beta, p_lead: lead });
    expect(forged.body).toEqual({ outcome: "skipped", reason: "not_found" });
    expect(psql(`select assignee_id is null from public.leads where id = '${lead}'`)).toBe("t");
  });

  it("sans règle active : le lead reste « non assigné » et chaque owner / admin reçoit UNE alerte, même si le job est rejoué", async () => {
    psql(`update public.assignment_rules set active = false where project_id = '${PROJECT.alphaSite}'`);
    expect(await submit(email("three"))).toBe(202);
    const lead = leadOf(email("three"));
    expect(await processJob(lead)).toEqual({ outcome: "unassigned", reason: "no_rule" });
    expect(await processJob(lead)).toEqual({ outcome: "unassigned", reason: "no_rule" });
    expect(psql(`select s.kind from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = '${lead}'`)).toBe("unassigned");
    expect(psql(`select count(*) from public.notifications where payload ->> 'lead_id' = '${lead}'`)).toBe("2");
    expect(psql(`select count(*) from public.notifications where payload ->> 'lead_id' = '${lead}' and recipient_id in ('${USER.alphaSales}', '${USER.alphaMarketing}')`)).toBe("0");
  });
});
