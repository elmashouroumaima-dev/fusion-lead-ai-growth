import { afterAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, rowsOf, select, USER, type Persona } from "./harness";

/**
 * Activités par la Data API (J20) : lecture comme les leads (owner / admin / marketing partout, commercial sur SES leads,
 * analyste jamais), AUCUNE écriture directe (même service_role), écriture par fonctions réservées à owner / admin et au commercial
 * sur ses leads, journal automatique des changements d'étape et d'assignation, historique immuable, tâches, isolation Alpha / Beta,
 * changements simultanés cohérents. Tests ré-exécutables : noms uniques, nettoyage des lignes créées.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const source = `rlsa${run}`;
const email = (n: string) => `rlsa-${run}-${n}@exemple.test`.toLowerCase();
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

async function newContact(org: string, address: string): Promise<string> {
  const persona: Persona = org === ORG.alpha ? "alphaAdmin" : "betaOwner";
  const result = await rpc(persona, "create_contact", {
    p_org: org, p_name: "Test RLS activités", p_email_raw: address, p_email_normalized: address, p_phone_e164: null, p_language: "fr", p_country: "MA",
    p_external_source: null, p_external_id: null, p_attributes: {},
  });
  expect(result.status, `contact ${address}`).toBe(200);
  return String(result.body);
}
async function newLead(org: string, project: string, contact: string, assignee: string | null): Promise<string> {
  const persona: Persona = org === ORG.alpha ? "alphaAdmin" : "betaOwner";
  const result = await rpc(persona, "create_lead", {
    p_org: org, p_contact: contact, p_project: project, p_source: source, p_assignee: assignee, p_score: null, p_score_reason: {}, p_utm: {},
    p_external_source: null, p_external_id: null,
  });
  expect(result.status, "lead").toBe(200);
  return String(result.body);
}
const activityArgs = (lead: string, type: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  p_org: ORG.alpha, p_lead: lead, p_type: type, p_metadata: metadata, p_due_at: null, p_owner: null, ...extra,
});
const stagesOf = async () =>
  rowsOf<{ id: string; kind: string; position: number; pipeline_id: string }>(await select("alphaAdmin", `pipeline_stages?select=id,kind,position,pipeline_id&organization_id=eq.${ORG.alpha}&order=position`));

afterAll(() => {
  psql(`
    set session_replication_role = replica;
    delete from public.activities where lead_id in (select id from public.leads where source = '${source}');
    delete from public.deals where lead_id in (select id from public.leads where source = '${source}');
    delete from public.leads where source = '${source}';
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'rlsa-${run}-%');
    delete from public.contacts where email_normalized like 'rlsa-${run}-%';
  `);
});

let leadSales = "";
let leadFree = "";
let leadBeta = "";

describe("préparation", () => {
  it("un lead assigné au commercial, un non assigné, un lead chez Beta", async () => {
    leadSales = await newLead(ORG.alpha, PROJECT.alphaSite, await newContact(ORG.alpha, email("a")), USER.alphaSales);
    leadFree = await newLead(ORG.alpha, PROJECT.alphaSite, await newContact(ORG.alpha, email("b")), null);
    leadBeta = await newLead(ORG.beta, PROJECT.betaShop, await newContact(ORG.beta, email("c")), null);
  });
});

describe("aucune écriture directe, même service_role", () => {
  it("INSERT, UPDATE, DELETE sur activities : refusés pour tous", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "service"] as const) {
      expect(isDenied(await api(persona, "POST", "activities", { organization_id: ORG.alpha })), `${persona} insert`).toBe(true);
      expect(isDenied(await api(persona, "PATCH", `activities?organization_id=eq.${ORG.alpha}`, { metadata: {} })), `${persona} update`).toBe(true);
      expect(isDenied(await api(persona, "DELETE", `activities?organization_id=eq.${ORG.alpha}`)), `${persona} delete`).toBe(true);
    }
  });

  it("les fonctions ne sont ni anonymes ni exécutables par service_role", async () => {
    for (const persona of ["anon", "service"] as const) {
      expect((await rpc(persona, "create_activity", activityArgs(leadSales, "note", { text: "x" }))).status, persona).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("création : rôles, contenu, types automatiques", () => {
  it("owner, admin et commercial (sur son lead) créent ; marketing, analyste, Beta, sans adhésion refusés", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales"] as const) {
      const result = await rpc(persona, "create_activity", activityArgs(leadSales, "note", { text: `Note de ${persona}` }));
      expect(result.status, persona).toBe(200);
    }
    for (const persona of ["alphaMarketing", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(message(await rpc(persona, "create_activity", activityArgs(leadSales, "note", { text: "interdit" }))), persona).toBe("forbidden");
    }
  });

  it("le commercial ne touche pas au lead d'un autre ; un lead inconnu est « introuvable » comme un lead étranger", async () => {
    expect(message(await rpc("alphaSales", "create_activity", activityArgs(leadFree, "note", { text: "x" })))).toBe("not_found");
    expect(message(await rpc("alphaSales", "create_activity", activityArgs("00000000-0000-4000-8000-0000000000aa", "note", { text: "x" })))).toBe("not_found");
    expect(message(await rpc("alphaAdmin", "create_activity", activityArgs(leadBeta, "note", { text: "x" })))).toBe("not_found");
  });

  it("stage_change et assignment ne se créent pas à la main ; contenu invalide refusé par la base", async () => {
    for (const type of ["stage_change", "assignment"]) {
      expect(message(await rpc("alphaAdmin", "create_activity", activityArgs(leadSales, type, {}))), type).toBe("validation_failed");
    }
    const invalid = await rpc("alphaAdmin", "create_activity", activityArgs(leadSales, "note", { text: "x", autre: 1 }));
    expect(message(invalid)).toBe("validation_failed");
    const note = await rpc("alphaAdmin", "create_activity", activityArgs(leadSales, "note", { text: "x" }, { p_due_at: "2026-12-10T09:00:00Z" }));
    expect(message(note)).toBe("validation_failed");
  });
});

describe("journal automatique", () => {
  it("assigner et déplacer un lead écrit des entrées lisibles dans la chronologie, avec l'acteur", async () => {
    const result = await rpc("alphaAdmin", "assign_lead", { p_org: ORG.alpha, p_id: leadFree, p_assignee: USER.alphaSales });
    expect(result.status).toBeLessThan(300);
    const stages = await stagesOf();
    const qualified = stages.filter((s) => s.kind === "open")[1]?.id ?? "";
    const moved = await rpc("alphaSales", "move_lead_stage", { p_org: ORG.alpha, p_id: leadFree, p_stage: qualified });
    expect(moved.status).toBeLessThan(300);

    const rows = rowsOf<{ type: string; owner_id: string | null; metadata: Record<string, unknown> }>(
      await select("alphaAdmin", `activities?select=type,owner_id,metadata&lead_id=eq.${leadFree}&order=created_at`),
    );
    const types = rows.map((row) => row.type).sort();
    expect(types).toEqual(["assignment", "stage_change", "stage_change"]);
    const assignment = rows.find((row) => row.type === "assignment");
    expect(assignment?.metadata.to_assignee_id).toBe(USER.alphaSales);
    expect(assignment?.owner_id).toBe(USER.alphaAdmin);
    expect(rows.find((row) => row.type === "stage_change" && row.metadata.to_stage_id === qualified)?.owner_id).toBe(USER.alphaSales);
  });

  it("l'historique ne se modifie ni ne se supprime, même par le propriétaire de la base", () => {
    const id = psql(`select id from public.activities where lead_id = '${leadFree}' and type = 'assignment' limit 1`);
    expect(() => psql(`update public.activities set metadata = '{"from_assignee_id": null, "to_assignee_id": null}' where id = '${id}'`)).toThrow();
    expect(() => psql(`delete from public.activities where id = '${id}'`)).toThrow();
  });
});

describe("lecture : comme les leads", () => {
  const ids = async (persona: Persona, lead: string) =>
    rowsOf<{ id: string }>(await select(persona, `activities?select=id&lead_id=eq.${lead}`)).length;

  it("owner, admin, marketing : tout ; commercial : SES leads ; analyste, Beta, sans adhésion : rien ; anonyme refusé", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing"] as const) {
      expect(await ids(persona, leadSales), persona).toBeGreaterThanOrEqual(3);
      expect(await ids(persona, leadFree), persona).toBeGreaterThanOrEqual(3);
    }
    expect(await ids("alphaSales", leadSales)).toBeGreaterThanOrEqual(3);
    for (const persona of ["alphaAnalyst", "betaOwner", "betaAnalyst", "nobody"] as const) {
      expect(await ids(persona, leadSales), persona).toBe(0);
    }
    expect(isDenied(await select("anon", "activities?select=id"))).toBe(true);
  });

  it("le propriétaire de Beta ne voit que les activités de Beta", async () => {
    const rows = rowsOf<{ organization_id: string }>(await select("betaOwner", `activities?select=organization_id&lead_id=eq.${leadBeta}`));
    expect(rows.every((row) => row.organization_id === ORG.beta)).toBe(true);
    expect(rowsOf(await select("betaOwner", `activities?select=id&organization_id=eq.${ORG.alpha}`))).toEqual([]);
  });
});

describe("tâches et changements simultanés", () => {
  it("cycle d'une tâche, responsable, droits ; 12 bascules simultanées restent cohérentes", async () => {
    const created = await rpc("alphaSales", "create_activity", activityArgs(leadSales, "task", { title: "Relancer" }, { p_due_at: "2026-12-10T09:00:00Z" }));
    expect(created.status).toBe(200);
    const task = String(created.body);
    const stateOf = async () => rowsOf<{ completed_at: string | null; owner_id: string | null }>(await select("alphaSales", `activities?select=completed_at,owner_id&id=eq.${task}`))[0];
    expect((await stateOf())?.owner_id).toBe(USER.alphaSales);

    expect(message(await rpc("alphaSales", "create_activity", activityArgs(leadSales, "task", { title: "Pour un autre" }, { p_owner: USER.shared })))).toBe("forbidden");
    expect((await rpc("alphaAdmin", "update_task", { p_org: ORG.alpha, p_id: task, p_metadata: { title: "Relancer vite" }, p_due_at: "2026-12-11T09:00:00Z", p_owner: USER.shared })).status).toBeLessThan(300);
    expect((await stateOf())?.owner_id).toBe(USER.shared);
    expect(message(await rpc("alphaAdmin", "update_task", { p_org: ORG.alpha, p_id: task, p_metadata: { title: "x" }, p_due_at: null, p_owner: USER.alphaAnalyst }))).toBe("assignee_invalid");

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => rpc("alphaSales", "complete_task", { p_org: ORG.alpha, p_id: task, p_done: i % 2 === 0 })),
    );
    expect(results.filter((r) => r.status >= 300).map((r) => `${r.status} ${message(r)}`)).toEqual([]);
    const final = rowsOf<{ completed_at: string | null }>(await select("alphaAdmin", `activities?select=completed_at&id=eq.${task}`))[0];
    expect(final).toBeDefined();

    expect(message(await rpc("alphaMarketing", "complete_task", { p_org: ORG.alpha, p_id: task, p_done: true }))).toBe("forbidden");
    expect(message(await rpc("betaOwner", "complete_task", { p_org: ORG.alpha, p_id: task, p_done: true }))).toBe("forbidden");
    expect(message(await rpc("alphaAnalyst", "update_task", { p_org: ORG.alpha, p_id: task, p_metadata: { title: "x" }, p_due_at: null, p_owner: null }))).toBe("forbidden");
  });

  it("12 créations simultanées sur un lead : toutes enregistrées, aucune perdue", async () => {
    const before = rowsOf(await select("alphaAdmin", `activities?select=id&lead_id=eq.${leadSales}`)).length;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => rpc("alphaAdmin", "create_activity", activityArgs(leadSales, "note", { text: `Course ${i}` }))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(rowsOf(await select("alphaAdmin", `activities?select=id&lead_id=eq.${leadSales}`)).length).toBe(before + 12);
  });

  it("une note, un appel ou un e-mail ne se traite pas comme une tâche", async () => {
    const note = await rpc("alphaAdmin", "create_activity", activityArgs(leadSales, "note", { text: "Compte rendu" }));
    expect(message(await rpc("alphaAdmin", "complete_task", { p_org: ORG.alpha, p_id: String(note.body), p_done: true }))).toBe("validation_failed");
    expect(message(await rpc("alphaAdmin", "update_task", { p_org: ORG.alpha, p_id: String(note.body), p_metadata: { title: "x" }, p_due_at: null, p_owner: null }))).toBe("validation_failed");
  });
});

describe("audit : jamais le contenu", () => {
  it("les entrées d'audit des activités ne contiennent ni texte ni titre ni e-mail", () => {
    const leaks = psql(`
      select count(*) from public.audit_logs
       where entity_type = 'activity' and created_at > now() - interval '10 minutes'
         and (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'Note de|Relancer|Compte rendu|Course|rlsa-${run}|exemple\\.test'
    `);
    expect(leaks).toBe("0");
  });
});
