import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, rowsOf, select, USER, type Persona } from "./harness";

/**
 * Assignation par la Data API (J22) : règles gérées par owner / admin seulement (fonctions), lues par owner / admin, aucune écriture
 * directe (même service_role) ; `auto_assign_lead` réservée à service_role (ni anon, ni utilisateur connecté), isolation Alpha / Beta,
 * rejeu sans double assignation ; notifications lues par leur seul destinataire. Ré-exécutable : contacts et leads de l'exécution
 * nettoyés, règles du projet de test supprimées.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (n: string) => `rlsasg-${run}-${n}@exemple.test`.toLowerCase();
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

function newLead(n: string): string {
  return psql(`
    with c as (
      insert into public.contacts (organization_id, name, email_raw, email_normalized)
      values ('${ORG.alpha}', 'Test RLS assignation', '${email(n)}', '${email(n)}') returning id
    ), s as (
      select st.id from public.pipeline_stages st join public.pipelines p on p.organization_id = st.organization_id and p.id = st.pipeline_id
       where p.organization_id = '${ORG.alpha}' and p.is_default and st.kind = 'unassigned'
    )
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id)
    select '${ORG.alpha}', c.id, '${PROJECT.alphaSite}', 'web_form', s.id from c, s returning id;
  `).split("\n")[0]!;
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.notifications where payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'rlsasg-${run}-%');
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'rlsasg-${run}-%');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like 'rlsasg-${run}-%');
    delete from public.contacts where email_normalized like 'rlsasg-${run}-%';
    delete from public.assignment_rules where project_id = '${PROJECT.alphaSite}';
  `);

beforeAll(cleanup);
afterAll(cleanup);

let ruleId = "";

describe("règles : rôles, lecture, aucune écriture directe", () => {
  it("owner et admin créent ; marketing, commercial, analyste, Beta et sans adhésion refusés", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      const result = await rpc(persona, "create_assignment_rule", {
        p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_strategy: "fixed", p_members: [USER.alphaSales],
      });
      expect(message(result), persona).toBe("forbidden");
    }
    const created = await rpc("alphaAdmin", "create_assignment_rule", {
      p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_strategy: "fixed", p_members: [USER.alphaSales],
    });
    expect(created.status).toBe(200);
    ruleId = String(created.body);
    expect(ruleId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("un membre non assignable (marketing) et une entreprise forgée sont refusés", async () => {
    const marketing = await rpc("shared", "create_assignment_rule", {
      p_org: ORG.alpha, p_project: PROJECT.alphaApp, p_strategy: "fixed", p_members: [USER.alphaMarketing],
    });
    expect(message(marketing)).toBe("assignee_invalid");
    const forged = await rpc("betaOwner", "create_assignment_rule", {
      p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_strategy: "fixed", p_members: [USER.alphaSales],
    });
    expect(message(forged)).toBe("forbidden");
  });

  it("lecture : owner et admin voient la règle ; commercial, marketing, analyste, Beta et anon non", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const rows = rowsOf<{ id: string }>(await select(persona, `assignment_rules?id=eq.${ruleId}`));
      expect(rows.map((row) => row.id), persona).toEqual([ruleId]);
    }
    for (const persona of ["alphaSales", "alphaMarketing", "alphaAnalyst", "betaOwner"] as const) {
      expect(rowsOf(await select(persona, `assignment_rules?id=eq.${ruleId}`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "assignment_rules"))).toBe(true);
  });

  it("aucune écriture directe, pas même par owner ou service_role", async () => {
    for (const persona of ["shared", "service"] as const) {
      const insert = await api<unknown>(persona, "POST", "assignment_rules", {
        organization_id: ORG.alpha, project_id: null, strategy: "fixed", eligible_member_ids: [USER.alphaSales],
      });
      expect(insert.status, persona).not.toBe(201);
      const update = await api<unknown>(persona, "PATCH", `assignment_rules?id=eq.${ruleId}`, { active: false });
      expect(rowsOf(update), persona).toEqual([]);
    }
  });
});

describe("auto_assign_lead : service_role seulement, isolation, rejeu", () => {
  it("anon et utilisateurs connectés ne peuvent pas l'appeler", async () => {
    const lead = newLead("deny");
    for (const persona of ["anon", "shared", "alphaAdmin", "alphaSales", "betaOwner"] as const) {
      const result = await rpc(persona, "auto_assign_lead", { p_org: ORG.alpha, p_lead: lead });
      expect(result.status === 200, persona).toBe(false);
    }
  });

  it("service_role : assigne au membre de la règle ; le rejeu ne réassigne pas ; une autre entreprise ne touche pas le lead", async () => {
    const lead = newLead("ok");
    const first = await rpc("service", "auto_assign_lead", { p_org: ORG.alpha, p_lead: lead });
    expect(first.body).toEqual({ outcome: "assigned", assignee_id: USER.alphaSales });
    const replay = await rpc("service", "auto_assign_lead", { p_org: ORG.alpha, p_lead: lead });
    expect(replay.body).toMatchObject({ outcome: "skipped" });
    const other = await rpc("service", "auto_assign_lead", { p_org: ORG.beta, p_lead: lead });
    expect(other.body).toEqual({ outcome: "skipped", reason: "not_found" });
    // le commercial désigné voit SON lead, et lui seul (RLS J19)
    expect(rowsOf<{ id: string }>(await select("alphaSales", `leads?id=eq.${lead}`)).map((row) => row.id)).toEqual([lead]);
    expect(rowsOf(await select("betaOwner", `leads?id=eq.${lead}`))).toEqual([]);
  });
});

describe("notifications : lues par leur seul destinataire", () => {
  it("règle désactivée : lead non assigné, alerte aux owner et admin, ni commercial ni Beta ; marquage « lu » par le destinataire seulement", async () => {
    const off = await rpc("alphaAdmin", "update_assignment_rule", {
      p_org: ORG.alpha, p_id: ruleId, p_strategy: "fixed", p_members: [USER.alphaSales], p_active: false,
    });
    expect(off.status).toBe(204);
    const lead = newLead("flag");
    const outcome = await rpc("service", "auto_assign_lead", { p_org: ORG.alpha, p_lead: lead });
    expect(outcome.body).toEqual({ outcome: "unassigned", reason: "no_rule" });
    const path = `notifications?payload->>lead_id=eq.${lead}`;
    const adminRows = rowsOf<{ id: string; recipient_id: string; payload: { lead_id: string; reason: string }; read_at: string | null }>(await select("alphaAdmin", path));
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]).toMatchObject({ recipient_id: USER.alphaAdmin, payload: { lead_id: lead, reason: "no_rule" }, read_at: null });
    expect(rowsOf<{ recipient_id: string }>(await select("shared", path)).map((row) => row.recipient_id)).toEqual([USER.shared]);
    for (const persona of ["alphaSales", "alphaMarketing", "alphaAnalyst", "betaOwner"] as const) {
      expect(rowsOf(await select(persona, path)), persona).toEqual([]);
    }
    const id = adminRows[0]!.id;
    expect(message(await rpc("shared", "mark_notification_read", { p_org: ORG.alpha, p_id: id }))).toBe("not_found");
    expect((await rpc("alphaAdmin", "mark_notification_read", { p_org: ORG.alpha, p_id: id })).status).toBe(204);
    expect(rowsOf<{ read_at: string | null }>(await select("alphaAdmin", path))[0]?.read_at).not.toBeNull();
  });

  it("la file « non assignés » est lue par owner et admin, jamais par le commercial", async () => {
    const lead = newLead("queue");
    for (const persona of ["shared", "alphaAdmin"] as const) {
      expect(rowsOf<{ id: string }>(await select(persona, `leads?id=eq.${lead}`)).map((row) => row.id), persona).toEqual([lead]);
    }
    expect(rowsOf(await select("alphaSales", `leads?id=eq.${lead}`))).toEqual([]);
    expect(rowsOf(await select("betaOwner", `leads?id=eq.${lead}`))).toEqual([]);
  });
});
