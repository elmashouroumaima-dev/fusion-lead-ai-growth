import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, PROJECT, psql, rowsOf, USER, type Persona } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, signIn, visibleText, type Session } from "./app-client";
import { assignAll, assigneesOf } from "./assign-worker";

/**
 * Gate G2 (plan J27, spec §12 et §13-4) : « un lead capturé va jusqu'au deal gagné avec un historique d'activités visible ».
 * Parcours complet sur la pile réelle : formulaire public (clé + origine, HTTP sans session) -> contact + lead « non assigné » + job
 * -> VRAI handler `lead.assign` -> le commercial désigné lit SON lead, note un appel, crée le deal (fonction SQL : aucun écran ni
 * route de création de deal n'existe encore, voir C2) -> déplacement par la route `/api/deals/move` (session réelle) jusqu'à
 * « gagné » -> chronologie lue par chaque rôle (tous les rôles autorisés voient la MÊME histoire, l'analyste et l'autre entreprise
 * n'en voient rien) -> audit sans valeur de deal ni adresse. Même parcours chez Beta : aucune fuite dans aucun sens.
 * L'échec de synchro CRM rejoué est prouvé par `crm-sync-flow` (« Réessayer » sans doublon) et relancé avec ce fichier au C2.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = (who: string) => `g2-${run}-${who}@exemple.test`;
const ORIGIN = { alpha: `https://g2-${run}-a.exemple.test`, beta: `https://g2-${run}-b.exemple.test` };
const KEY = { alpha: `flk_${randomBytes(32).toString("hex")}`, beta: `flk_${randomBytes(32).toString("hex")}` };
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
let ip = 40;
const nextIp = () => `203.0.113.${(ip += 1)}`;

async function submit(key: string, origin: string, address: string): Promise<number> {
  const response = await fetch(`${BASE_URL}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), "x-form-key": key, origin },
    body: JSON.stringify({
      name: "Parcours G2",
      email: address,
      default_country: "MA",
      language: "fr",
      utm: { utm_source: "newsletter", utm_campaign: "g2" },
      consent: { channel: "email", text: "J'accepte de recevoir des offres par e-mail.", version: "v1" },
      page_url: "https://exemple.test/g2",
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

const leadOf = (address: string) => psql(`select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = '${address}'`);
const stagesOf = (org: string) =>
  psql(`select s.kind || ':' || s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id where p.organization_id = '${org}' and p.is_default order by s.position`)
    .split(/\r?\n/).filter(Boolean).map((r) => ({ kind: r.slice(0, r.indexOf(":")), id: r.slice(r.indexOf(":") + 1) }));

type Entry = { type: string; metadata: Record<string, unknown> | null };
const timeline = async (who: Persona, lead: string): Promise<Entry[]> =>
  rowsOf<Entry>(await api<Entry[]>(who, "GET", `activities?lead_id=eq.${lead}&select=type,metadata&order=created_at.asc,id.asc`));
const visibleLeads = async (who: Persona, lead: string) => rowsOf(await api(who, "GET", `leads?id=eq.${lead}&select=id`)).length;
const visibleDeals = async (who: Persona, deal: string) => rowsOf(await api(who, "GET", `deals?id=eq.${deal}&select=id`)).length;

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.notifications where payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'g2-${run}-%');
    delete from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'g2-${run}-%');
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'g2-${run}-%');
    delete from public.deals where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'g2-${run}-%');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like 'g2-${run}-%');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'g2-${run}-%');
    delete from public.contacts where email_normalized like 'g2-${run}-%';
    delete from public.form_keys where allowed_origins::text like '%g2-${run}-%';
    delete from public.assignment_rules where eligible_member_ids = array['${USER.alphaSales}']::uuid[] and project_id = '${PROJECT.alphaSite}';
  `);

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};

beforeAll(async () => {
  cleanup();
  for (const name of ["alpha-sales", "alpha-admin", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  psql(`
    insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins)
    values ('${ORG.alpha}', '${PROJECT.alphaSite}', '${hash(KEY.alpha)}', '${KEY.alpha.slice(0, 8)}', array['${ORIGIN.alpha}']),
           ('${ORG.beta}', '${PROJECT.betaShop}', '${hash(KEY.beta)}', '${KEY.beta.slice(0, 8)}', array['${ORIGIN.beta}']);
    insert into public.assignment_rules (organization_id, project_id, strategy, eligible_member_ids)
    values ('${ORG.alpha}', '${PROJECT.alphaSite}', 'fixed', array['${USER.alphaSales}']::uuid[]);
  `);
});
afterAll(cleanup);

describe("G2 chez Alpha : formulaire -> lead -> assignation -> deal gagné, avec historique", () => {
  const address = EMAIL("alpha");
  let lead = "";
  let deal = "";
  const stages = () => stagesOf(ORG.alpha);
  const stage = (kind: string, index = 0) => {
    const found = stages().filter((s) => s.kind === kind)[index];
    if (!found) throw new Error(`étape absente : ${kind}`);
    return found.id;
  };

  it("1. le formulaire public crée contact, lead « non assigné », consentement et job d'assignation", async () => {
    expect(await submit(KEY.alpha, ORIGIN.alpha, address)).toBe(202);
    lead = leadOf(address);
    expect(lead).toMatch(/^[0-9a-f-]{36}$/);
    expect(psql(`select s.kind || '|' || coalesce(l.assignee_id::text, '') || '|' || l.source from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = '${lead}'`)).toBe("unassigned||web_form");
    expect(psql(`select count(*) from public.consent_events e join public.contacts c on c.id = e.contact_id where c.email_normalized = '${address}'`)).toBe("1");
    expect(psql(`select count(*) from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' = '${lead}' and organization_id = '${ORG.alpha}'`)).toBe("1");
    // le lead non assigné n'est visible ni du commercial ni de l'analyste ; l'admin et le marketing le voient
    expect(await visibleLeads("alphaSales", lead)).toBe(0);
    expect(await visibleLeads("alphaAnalyst", lead)).toBe(0);
    expect(await visibleLeads("alphaAdmin", lead)).toBe(1);
    expect(await visibleLeads("alphaMarketing", lead)).toBe(1);
  });

  it("2. le vrai handler lead.assign confie le lead au commercial de la règle ; il devient visible de lui seul parmi les commerciaux", async () => {
    expect(await assignAll([lead])).toEqual([USER.alphaSales]);
    expect(psql(`select s.kind from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = '${lead}'`)).toBe("open");
    expect(await visibleLeads("alphaSales", lead)).toBe(1);
    expect(await visibleLeads("alphaAnalyst", lead)).toBe(0);
    const page = visibleText(await getPage(as("alpha-sales"), `/fr/leads?q=g2-${run}`, ORG.alpha));
    expect(page).toContain(address);
    expect(page).toContain("Résultats : 1");
  });

  it("3. le commercial note un appel puis crée le deal (la base refuse un deal dans l'étape système)", async () => {
    const note = await api("alphaSales", "POST", "rpc/create_activity", {
      p_org: ORG.alpha, p_lead: lead, p_type: "call", p_metadata: { outcome: "answered", text: "Premier appel" }, p_due_at: null, p_owner: null,
    });
    expect(note.status, JSON.stringify(note.body)).toBeLessThan(300);
    const refused = await api("alphaSales", "POST", "rpc/create_deal", {
      p_org: ORG.alpha, p_lead: lead, p_stage: stage("unassigned"), p_value: 1500, p_currency: "MAD", p_expected_close_at: null,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const created = await api<string>("alphaSales", "POST", "rpc/create_deal", {
      p_org: ORG.alpha, p_lead: lead, p_stage: stage("open", 0), p_value: 1500, p_currency: "MAD", p_expected_close_at: null,
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    deal = String(created.body);
    expect(deal).toMatch(/^[0-9a-f-]{36}$/);
    expect(await visibleDeals("alphaSales", deal)).toBe(1);
  });

  it("4. le deal avance par /api/deals/move (session réelle) jusqu'à « gagné » ; won_at est posé ; /deals l'affiche", async () => {
    const open = stages().filter((s) => s.kind === "open");
    const path = [open[1], open[2], stages().find((s) => s.kind === "won")].filter((s): s is { kind: string; id: string } => Boolean(s));
    expect(path.length).toBeGreaterThanOrEqual(2);
    for (const target of path) {
      const moved = await postJson(as("alpha-sales"), "/api/deals/move", { deal_id: deal, stage_id: target.id }, { activeOrg: ORG.alpha, headers: { "idempotency-key": randomUUID() } });
      expect(moved.status, `vers ${target.kind}`).toBe(200);
    }
    expect(psql(`select s.kind || '|' || (d.won_at is not null) || '|' || (d.lost_at is null) from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`)).toBe("won|true|true");
    expect(visibleText(await getPage(as("alpha-sales"), "/fr/deals", ORG.alpha))).toContain("Parcours G2");
  });

  it("5. historique d'activités : assignation, appel, puis un changement d'étape par déplacement, dans l'ordre, avec le deal", async () => {
    const entries = await timeline("alphaSales", lead);
    const moves = stages().filter((s) => s.kind === "open").slice(1).length + 1; // étapes ouvertes suivantes + « gagné »
    // l'assignation fait aussi sortir le LEAD de l'étape « non assigné » : une entrée d'étape SANS deal, puis l'appel, puis les déplacements du DEAL
    // les deux premières entrées naissent dans la MÊME transaction (même horodatage) : leur ordre relatif n'est pas défini
    expect(entries.slice(0, 2).map((e) => e.type).sort()).toEqual(["assignment", "stage_change"]);
    expect(entries.slice(2).map((e) => e.type)).toEqual(["call", ...Array<string>(moves).fill("stage_change")]);
    const [first, second] = entries.slice(0, 2);
    const assignment = first?.type === "assignment" ? first : second;
    const leadStage = first?.type === "stage_change" ? first : second;
    expect(assignment?.metadata).toMatchObject({ to_assignee_id: USER.alphaSales });
    expect(leadStage?.metadata).toMatchObject({ from_stage_id: stage("unassigned") });
    expect(leadStage?.metadata).not.toHaveProperty("deal_id");
    const dealMoves = entries.slice(3);
    for (const entry of dealMoves) expect(entry.metadata).toMatchObject({ deal_id: deal });
    expect(dealMoves[dealMoves.length - 1]?.metadata).toMatchObject({ to_stage_id: stage("won") });
  });

  it("6. les rôles autorisés lisent la MÊME histoire ; l'analyste et l'autre entreprise n'en voient rien", async () => {
    const reference = (await timeline("alphaSales", lead)).map((e) => e.type);
    for (const who of ["shared", "alphaAdmin", "alphaMarketing"] as const) expect((await timeline(who, lead)).map((e) => e.type), who).toEqual(reference);
    for (const who of ["alphaAnalyst", "betaOwner", "betaAnalyst", "nobody", "anon"] as const) {
      expect(await timeline(who, lead), who).toEqual([]);
      expect(await visibleLeads(who, lead), who).toBe(0);
      expect(await visibleDeals(who, deal), who).toBe(0);
    }
    const betaPage = visibleText(await getPage(as("beta-owner"), `/fr/leads?q=g2-${run}`, ORG.beta));
    expect(betaPage).not.toContain(address);
  });

  it("7. audit : deal.created et deal.won présents, sans adresse, sans valeur du deal", async () => {
    const rows = psql(`select a.action from public.audit_logs a where a.organization_id = '${ORG.alpha}' and to_jsonb(a)::text like '%${deal}%' order by a.created_at`).split(/\r?\n/).filter(Boolean);
    expect(rows).toEqual(expect.arrayContaining(["deal.created", "deal.won"]));
    const body = psql(`select string_agg(to_jsonb(a)::text, ' ') from public.audit_logs a where a.organization_id = '${ORG.alpha}' and (to_jsonb(a)::text like '%${deal}%' or to_jsonb(a)::text like '%${lead}%')`);
    expect(body).not.toContain(address);
    expect(body).not.toContain("1500");
    expect(body).not.toContain("Parcours G2");
  });

  it("8. rejeu : le job d'assignation rejoué ne change ni le responsable ni l'histoire", async () => {
    const before = (await timeline("alphaSales", lead)).length;
    expect(await assignAll([lead])).toEqual([USER.alphaSales]);
    expect((await timeline("alphaSales", lead)).length).toBe(before);
    expect(assigneesOf([lead])).toEqual([USER.alphaSales]);
  });
});

describe("G2 chez Beta : même parcours, aucune fuite dans aucun sens", () => {
  it("le lead de Beta reste chez Beta : sans règle il attend en « non assigné », et aucun rôle d'Alpha ne le voit", async () => {
    const address = EMAIL("beta");
    expect(await submit(KEY.beta, ORIGIN.beta, address)).toBe(202);
    const lead = leadOf(address);
    expect(psql(`select organization_id from public.leads where id = '${lead}'`)).toBe(ORG.beta);
    expect(psql(`select s.kind from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = '${lead}'`)).toBe("unassigned");
    for (const who of ["shared", "alphaAdmin", "alphaMarketing", "alphaSales", "alphaAnalyst"] as const) {
      // `shared` est owner d'Alpha et commercial de Beta : un lead non assigné de Beta lui reste invisible comme commercial
      expect(await visibleLeads(who, lead), who).toBe(0);
    }
    expect(await visibleLeads("betaOwner", lead)).toBe(1);
    expect(visibleText(await getPage(as("alpha-admin"), `/fr/leads?q=g2-${run}-beta`, ORG.alpha))).not.toContain(address);
  });
});
