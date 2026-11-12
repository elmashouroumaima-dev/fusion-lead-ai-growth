import { afterAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, rowsOf, select, USER, type Persona } from "./harness";

/**
 * Pipelines, leads et deals par la Data API (J19) : étapes visibles par les membres, leads et deals lus par owner / admin /
 * marketing (tous) et par le commercial sur SES leads seulement, analyste sans accès, AUCUNE écriture directe (même service_role),
 * écriture par fonctions, isolation Alpha / Beta, lead vers un projet d'une autre entreprise refusé, étapes configurables,
 * changements simultanés cohérents. Tests ré-exécutables : noms uniques par exécution, nettoyage des lignes créées.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const source = `rlsl${run}`;
const email = (n: string) => `rlsl-${run}-${n}@exemple.test`.toLowerCase();
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

const contactArgs = (org: string, address: string) => ({
  p_org: org, p_name: "Test RLS leads", p_email_raw: address, p_email_normalized: address, p_phone_e164: null, p_language: "fr", p_country: "MA",
  p_external_source: null, p_external_id: null, p_attributes: {},
});
async function newContact(persona: Persona, org: string, address: string): Promise<string> {
  const result = await rpc(persona, "create_contact", contactArgs(org, address));
  expect(result.status, `${persona} crée ${address}`).toBe(200);
  return String(result.body);
}
const leadArgs = (contact: string, project: string, assignee: string | null = null) => ({
  p_org: ORG.alpha, p_contact: contact, p_project: project, p_source: source, p_assignee: assignee, p_score: null, p_score_reason: {}, p_utm: {},
  p_external_source: null, p_external_id: null,
});
async function newLead(persona: Persona, contact: string, assignee: string | null = null): Promise<string> {
  const result = await rpc(persona, "create_lead", leadArgs(contact, PROJECT.alphaSite, assignee));
  expect(result.status, `${persona} crée un lead`).toBe(200);
  return String(result.body);
}
const stagesOf = async (persona: Persona, org: string) =>
  rowsOf<{ id: string; kind: string; position: number; pipeline_id: string }>(await select(persona, `pipeline_stages?select=id,kind,position,pipeline_id&organization_id=eq.${org}&order=position`));

afterAll(() => {
  psql(`
    set session_replication_role = replica;
    delete from public.activities where lead_id in (select id from public.leads where source = '${source}');
    delete from public.deals where lead_id in (select id from public.leads where source = '${source}');
    delete from public.leads where source = '${source}';
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'rlsl-${run}-%');
    delete from public.contacts where email_normalized like 'rlsl-${run}-%';
    delete from public.pipeline_stages where pipeline_id in (select id from public.pipelines where name like 'rlsl-${run}%');
    delete from public.pipelines where name like 'rlsl-${run}%';
  `);
});

describe("étapes par défaut et lecture des pipelines", () => {
  it("chaque entreprise a un pipeline par défaut de 6 étapes (une seule étape système)", async () => {
    for (const [persona, org] of [["alphaAnalyst", ORG.alpha], ["betaOwner", ORG.beta]] as const) {
      const stages = await stagesOf(persona, org);
      expect(stages.map((s) => s.kind), org).toEqual(["unassigned", "open", "open", "open", "won", "lost"]);
      expect(new Set(stages.map((s) => s.pipeline_id)).size).toBe(1);
    }
  });

  it("chacun ne voit que les étapes de son entreprise ; sans adhésion et anonyme : rien / refusé", async () => {
    expect(rowsOf(await select("betaAnalyst", `pipeline_stages?select=id&organization_id=eq.${ORG.alpha}`))).toEqual([]);
    expect(rowsOf(await select("nobody", "pipelines?select=id"))).toEqual([]);
    expect(isDenied(await select("anon", "pipeline_stages?select=id"))).toBe(true);
  });
});

describe("aucune écriture directe, même service_role", () => {
  it("INSERT, UPDATE, DELETE sur les quatre tables : refusés pour tous", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "service"] as const) {
      for (const table of ["pipelines", "pipeline_stages", "leads", "deals"]) {
        expect(isDenied(await api(persona, "POST", table, { organization_id: ORG.alpha })), `${persona} insert ${table}`).toBe(true);
        expect(isDenied(await api(persona, "PATCH", `${table}?organization_id=eq.${ORG.alpha}`, { organization_id: ORG.beta })), `${persona} update ${table}`).toBe(true);
        expect(isDenied(await api(persona, "DELETE", `${table}?organization_id=eq.${ORG.alpha}`)), `${persona} delete ${table}`).toBe(true);
      }
    }
  });
});

describe("lecture des leads : tous pour owner / admin / marketing, SES leads pour le commercial", () => {
  let leadSales = "";
  let leadFree = "";
  it("préparation : un lead assigné au commercial, un non assigné", async () => {
    const contactA = await newContact("alphaAdmin", ORG.alpha, email("lecture-a"));
    const contactB = await newContact("alphaAdmin", ORG.alpha, email("lecture-b"));
    leadSales = await newLead("alphaAdmin", contactA, USER.alphaSales);
    leadFree = await newLead("alphaMarketing", contactB);
  });

  it("owner, admin, marketing d'Alpha : voient les deux ; commercial : le sien ; analyste, Beta, sans adhésion : aucun", async () => {
    const ids = async (persona: Persona) =>
      rowsOf<{ id: string }>(await select(persona, `leads?select=id&source=eq.${source}`)).map((row) => row.id).sort();
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing"] as const) expect(await ids(persona), persona).toEqual([leadSales, leadFree].sort());
    expect(await ids("alphaSales")).toEqual([leadSales]);
    for (const persona of ["alphaAnalyst", "betaOwner", "betaAnalyst", "nobody"] as const) expect(await ids(persona), persona).toEqual([]);
    expect(isDenied(await select("anon", "leads?select=id"))).toBe(true);
  });

  it("le commercial lit le contact de son lead, pas l'autre ; l'étape d'un lead assigné est ouverte, celle d'un lead libre est « non assigné »", async () => {
    const contacts = rowsOf<{ email_normalized: string }>(await select("alphaSales", `contacts?select=email_normalized&email_normalized=like.rlsl-${run}-*`));
    expect(contacts.map((c) => c.email_normalized)).toEqual([email("lecture-a")]);
    const stages = await stagesOf("alphaAdmin", ORG.alpha);
    const stageOf = async (id: string) => rowsOf<{ stage_id: string }>(await select("alphaAdmin", `leads?select=stage_id&id=eq.${id}`))[0]?.stage_id;
    expect(stages.filter((s) => s.kind === "unassigned").map((s) => s.id)).toContain(await stageOf(leadFree));
    expect(stages.filter((s) => s.kind === "open").map((s) => s.id)).toContain(await stageOf(leadSales));
  });
});

describe("isolation entre entreprises et rôles à l'écriture", () => {
  it("un lead ne vise ni un projet ni un contact d'une autre entreprise", async () => {
    const contact = await newContact("alphaAdmin", ORG.alpha, email("iso"));
    expect(message(await rpc("alphaAdmin", "create_lead", leadArgs(contact, PROJECT.betaShop)))).toBe("not_found");
    const betaContact = await newContact("betaOwner", ORG.beta, email("iso-beta"));
    expect(message(await rpc("alphaAdmin", "create_lead", leadArgs(betaContact, PROJECT.alphaSite)))).toBe("not_found");
  });

  it("le marketing ne choisit pas le responsable à la création ; NaN et pipeline étranger refusés", async () => {
    const contact = await newContact("alphaAdmin", ORG.alpha, email("marketing-assign"));
    expect(message(await rpc("alphaMarketing", "create_lead", leadArgs(contact, PROJECT.alphaSite, USER.alphaSales)))).toBe("forbidden");
    const lead = await newLead("alphaAdmin", contact, USER.alphaSales);
    const nan = await rpc("alphaAdmin", "create_deal", { p_org: ORG.alpha, p_lead: lead, p_stage: null, p_value: "NaN", p_currency: "MAD", p_expected_close_at: null });
    expect(message(nan)).toBe("validation_failed");
    const created = await rpc("alphaAdmin", "create_pipeline", { p_org: ORG.alpha, p_name: `rlsl-${run} autre` });
    const otherWon = rowsOf<{ id: string }>(await select("alphaAdmin", `pipeline_stages?select=id&pipeline_id=eq.${String(created.body)}&kind=eq.won`))[0]?.id ?? "";
    expect(message(await rpc("alphaAdmin", "move_lead_stage", { p_org: ORG.alpha, p_id: lead, p_stage: otherWon }))).toBe("validation_failed");
  });

  it("owner de Beta, commercial, analyste, sans adhésion : création refusée chez Alpha", async () => {
    const contact = await newContact("alphaAdmin", ORG.alpha, email("roles"));
    for (const persona of ["betaOwner", "alphaSales", "alphaAnalyst", "nobody"] as const) {
      expect(message(await rpc(persona, "create_lead", leadArgs(contact, PROJECT.alphaSite))), persona).toBe("forbidden");
    }
  });

  it("pipelines : seuls owner et admin écrivent ; marketing, commercial et Beta refusés", async () => {
    const stages = await stagesOf("alphaAdmin", ORG.alpha);
    const pipeline = stages[0]?.pipeline_id ?? "";
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner"] as const) {
      expect(message(await rpc(persona, "create_pipeline", { p_org: ORG.alpha, p_name: `rlsl-${run} refusé` })), persona).toBe("forbidden");
      expect(message(await rpc(persona, "create_stage", { p_org: ORG.alpha, p_pipeline: pipeline, p_name: "X", p_kind: "open", p_position: null })), persona).toBe("forbidden");
    }
    const created = await rpc("alphaAdmin", "create_pipeline", { p_org: ORG.alpha, p_name: `rlsl-${run} ventes` });
    expect(created.status).toBe(200);
    const pipelineId = String(created.body);
    const stage = await rpc("alphaAdmin", "create_stage", { p_org: ORG.alpha, p_pipeline: pipelineId, p_name: "Négociation", p_kind: "open", p_position: null });
    expect(stage.status).toBe(200);
    expect((await rpc("alphaAdmin", "update_stage", { p_org: ORG.alpha, p_id: String(stage.body), p_name: "Négociation finale", p_position: 25 })).status).toBeLessThan(300);
    expect((await rpc("alphaAdmin", "delete_stage", { p_org: ORG.alpha, p_id: String(stage.body) })).status).toBeLessThan(300);
    const system = rowsOf<{ id: string }>(await select("alphaAdmin", `pipeline_stages?select=id&pipeline_id=eq.${pipelineId}&kind=eq.unassigned`))[0]?.id ?? "";
    expect(message(await rpc("alphaAdmin", "delete_stage", { p_org: ORG.alpha, p_id: system }))).toBe("system_stage");
  });
});

describe("deals et changements simultanés", () => {
  it("cycle d'un deal : ouvert, gagné, perdu, rouvert ; 12 déplacements simultanés restent cohérents", async () => {
    const contact = await newContact("alphaAdmin", ORG.alpha, email("deal"));
    const lead = await newLead("alphaAdmin", contact, USER.alphaSales);
    // étapes du pipeline du lead seulement (les autres tests créent d'autres pipelines)
    const leadStage = rowsOf<{ stage_id: string }>(await select("alphaAdmin", `leads?select=stage_id&id=eq.${lead}`))[0]?.stage_id;
    const all = await stagesOf("alphaAdmin", ORG.alpha);
    const pipelineOfLead = all.find((s) => s.id === leadStage)?.pipeline_id;
    const stages = all.filter((s) => s.pipeline_id === pipelineOfLead);
    const won = stages.find((s) => s.kind === "won")?.id ?? "";
    const lost = stages.find((s) => s.kind === "lost")?.id ?? "";
    const open = stages.find((s) => s.kind === "open")?.id ?? "";

    const created = await rpc("alphaSales", "create_deal", { p_org: ORG.alpha, p_lead: lead, p_stage: null, p_value: 1234.5, p_currency: "MAD", p_expected_close_at: null });
    expect(created.status).toBe(200);
    const deal = String(created.body);
    const state = async () => rowsOf<{ stage_id: string; won_at: string | null; lost_at: string | null; value: number }>(await select("alphaSales", `deals?select=stage_id,won_at,lost_at,value&id=eq.${deal}`))[0];
    expect(Number((await state())?.value)).toBe(1234.5);

    const targets = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? won : i % 3 === 1 ? lost : open));
    const results = await Promise.all(targets.map((stage) => rpc("alphaSales", "move_deal_stage", { p_org: ORG.alpha, p_id: deal, p_stage: stage })));
    expect(results.filter((r) => r.status >= 300).map((r) => `${r.status} ${message(r)}`)).toEqual([]);
    const final = await state();
    // quel que soit l'ordre d'arrivée, les dates restent cohérentes avec le genre de l'étape finale
    const kind = stages.find((s) => s.id === final?.stage_id)?.kind;
    expect(kind === "won" ? final?.won_at !== null && final?.lost_at === null : kind === "lost" ? final?.lost_at !== null && final?.won_at === null : final?.won_at === null && final?.lost_at === null).toBe(true);

    // le commercial d'un autre lead, le marketing et l'analyste ne touchent pas à ce deal
    expect(message(await rpc("alphaMarketing", "move_deal_stage", { p_org: ORG.alpha, p_id: deal, p_stage: won }))).toBe("forbidden");
    expect(message(await rpc("alphaAnalyst", "update_deal", { p_org: ORG.alpha, p_id: deal, p_value: 1, p_currency: "MAD", p_expected_close_at: null }))).toBe("forbidden");
    expect(message(await rpc("betaOwner", "move_deal_stage", { p_org: ORG.alpha, p_id: deal, p_stage: won }))).toBe("forbidden");
  });

  it("12 assignations simultanées du même lead : un seul responsable final, étape cohérente", async () => {
    const contact = await newContact("alphaAdmin", ORG.alpha, email("assign"));
    const lead = await newLead("alphaAdmin", contact);
    const assignees = [USER.alphaSales, USER.shared, null];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => rpc("alphaAdmin", "assign_lead", { p_org: ORG.alpha, p_id: lead, p_assignee: assignees[i % 3] ?? null })),
    );
    expect(results.every((r) => r.status < 300)).toBe(true);
    const row = rowsOf<{ assignee_id: string | null; stage_id: string }>(await select("alphaAdmin", `leads?select=assignee_id,stage_id&id=eq.${lead}`))[0];
    const kind = (await stagesOf("alphaAdmin", ORG.alpha)).find((s) => s.id === row?.stage_id)?.kind;
    expect(row?.assignee_id === null ? kind === "unassigned" : kind === "open").toBe(true);
  });

  it("assignation à un marketing, un analyste ou un membre d'une autre entreprise : refusée", async () => {
    const contact = await newContact("alphaAdmin", ORG.alpha, email("assignee-invalid"));
    const lead = await newLead("alphaAdmin", contact);
    for (const user of [USER.alphaMarketing, USER.alphaAnalyst, USER.betaOwner]) {
      expect(message(await rpc("alphaAdmin", "assign_lead", { p_org: ORG.alpha, p_id: lead, p_assignee: user })), user).toBe("assignee_invalid");
    }
  });
});

describe("audit : aucune donnée métier ni personnelle", () => {
  it("les entrées d'audit des leads et deals ne contiennent ni valeur de deal ni e-mail", () => {
    const leaks = psql(`
      select count(*) from public.audit_logs
       where entity_type in ('lead', 'deal') and created_at > now() - interval '10 minutes'
         and (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'rlsl-${run}|exemple\\.test|1234[.]5'
    `);
    expect(leaks).toBe("0");
  });
});
