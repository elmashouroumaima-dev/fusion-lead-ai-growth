import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, PROJECT, psql, USER } from "../../../supabase/tests/rls/src/harness";
import { getPage, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Fiche lead (J30c) par HTTP, avec de vraies sessions : résumé, contact, prochaine action, chronologie (entrées saisies et entrées
 * AUTOMATIQUES d'étape et d'assignation, dans l'ordre), formulaires. Rôles : owner, admin et marketing lisent tous les leads, le
 * commercial les siens (le lead d'un autre est introuvable), l'analyste est renvoyé au tableau de bord ; seuls owner, admin et le
 * commercial sur son lead voient le formulaire d'ajout. Les données de test portent un préfixe unique par exécution et sont
 * supprimées à la fin.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `lead${run}`;
const name = (label: string) => `Zz${TAG} ${label}`;
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const page = (who: string, path: string, org: string = ORG.alpha) => getPage(as(who), path, org);
const ids: Record<string, string> = {};

const NOTE = `Note de suivi ${TAG}`;
const CALL = `Compte rendu d appel ${TAG}`;
const TASK = `Envoyer le devis ${TAG}`;

function seed() {
  psql(`
    insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values
      ('${ORG.alpha}', '${name("Mine")}', 'mine.${TAG}@lead.test', 'mine.${TAG}@lead.test', '+212612340021'),
      ('${ORG.alpha}', '${name("Other")}', 'other.${TAG}@lead.test', 'other.${TAG}@lead.test', null),
      ('${ORG.beta}', '${name("Beta")}', 'beta.${TAG}@lead.test', 'beta.${TAG}@lead.test', null);
  `);
  const lead = (org: string, label: string, assignee: string | null) => `
    insert into public.leads (organization_id, contact_id, project_id, source, stage_id, assignee_id)
    select c.organization_id, c.id, '${org === ORG.alpha ? PROJECT.alphaSite : PROJECT.betaShop}', 'manual',
           (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id
             where p.organization_id = c.organization_id and p.is_default and s.kind = '${assignee ? "open" : "unassigned"}' order by s.position limit 1),
           ${assignee ? `'${assignee}'` : "null"}
      from public.contacts c where c.organization_id = '${org}' and c.name = '${name(label)}';`;
  psql(`
    ${lead(ORG.alpha, "Mine", USER.alphaSales)}
    ${lead(ORG.alpha, "Other", USER.shared)}
    ${lead(ORG.beta, "Beta", null)}
  `);
  for (const label of ["Mine", "Other", "Beta"]) {
    ids[label] = psql(`select l.id from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where c.name = '${name(label)}'`);
  }
  // Entrées saisies, datées dans le passé (la plus ancienne d'abord) : note, appel, tâche ouverte
  psql(`
    set session_replication_role = replica;
    insert into public.activities (organization_id, lead_id, contact_id, type, owner_id, due_at, metadata, created_at, updated_at)
    select l.organization_id, l.id, l.contact_id, v.type::public.activity_type, '${USER.alphaSales}', v.due::timestamptz, v.meta::jsonb, now() - v.age::interval, now() - v.age::interval
      from public.leads l,
           (values ('note', null, '{"text": "${NOTE}"}', '3 hours'),
                   ('call', null, '{"outcome": "answered", "duration_minutes": 7, "text": "${CALL}"}', '2 hours'),
                   ('task', '2027-01-15T12:00:00Z', '{"title": "${TASK}"}', '1 hour')) as v(type, due, meta, age)
     where l.id = '${ids.Mine}';
  `);
  // Entrées AUTOMATIQUES (récentes) : changement d'étape puis changement de responsable, écrites par la base
  psql(`
    update public.leads set stage_id = (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id and p.organization_id = s.organization_id
                                         where p.organization_id = '${ORG.alpha}' and p.is_default and s.kind = 'open' order by s.position desc limit 1)
     where id = '${ids.Mine}';
    update public.leads set assignee_id = '${USER.shared}' where id = '${ids.Mine}';
    update public.leads set assignee_id = '${USER.alphaSales}' where id = '${ids.Mine}';
  `);
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.name like '%${TAG}%');
    delete from public.leads where contact_id in (select id from public.contacts where name like '%${TAG}%');
    delete from public.contacts where name like '%${TAG}%';
  `);

beforeAll(async () => {
  cleanup();
  for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(who, await signIn(`${who}@seed.test`));
  seed();
});
afterAll(cleanup);

describe("fiche lead : rôles et isolation", () => {
  it("owner, admin et marketing lisent la fiche ; le commercial lit la sienne ; sans session : connexion", async () => {
    for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales"]) {
      const res = await page(who, `/fr/leads/${ids.Mine}`);
      expect(res.status, who).toBe(200);
      const text = visibleText(res);
      expect(text, who).toContain(name("Mine"));
      expect(text, who).toContain(`mine.${TAG}@lead.test`);
    }
    const anon = await getPage(null, `/fr/leads/${ids.Mine}`);
    expect([302, 303, 307]).toContain(anon.status);
    expect(redirectPath(anon)).toMatch(/login/);
  });

  it("le commercial ne voit PAS la fiche du lead d'un autre ; l'analyste est renvoyé ; une autre entreprise et un identifiant invalide : 404", async () => {
    expect((await page("alpha-sales", `/fr/leads/${ids.Other}`)).status).toBe(404);
    expect((await page("shared", `/fr/leads/${ids.Other}`)).status).toBe(200);
    const analyst = await page("alpha-analyst", `/fr/leads/${ids.Mine}`);
    expect([302, 303, 307]).toContain(analyst.status);
    expect(redirectPath(analyst)).toMatch(/dashboard/);
    expect((await page("shared", `/fr/leads/${ids.Beta}`)).status).toBe(404);
    expect((await page("beta-owner", `/fr/leads/${ids.Mine}`, ORG.beta)).status).toBe(404);
    expect((await page("shared", "/fr/leads/pas-un-uuid")).status).toBe(404);
  });

  it("formulaire d'ajout : owner, admin et commercial (sur son lead) ; jamais le marketing", async () => {
    // le texte VISIBLE (les messages traduits voyagent aussi dans la charge de la page, pour tout rôle)
    for (const who of ["shared", "alpha-admin", "alpha-sales"]) {
      const res = await page(who, `/fr/leads/${ids.Mine}`);
      expect(visibleText(res), who).toContain("Ajouter à la chronologie");
      expect(res.body, who).toContain('name="idempotency_key"');
    }
    const marketing = await page("alpha-marketing", `/fr/leads/${ids.Mine}`);
    expect(visibleText(marketing)).not.toContain("Ajouter à la chronologie");
    expect(visibleText(marketing)).not.toContain("Marquer comme faite");
    expect(visibleText(marketing)).toContain("Votre rôle peut lire ce lead mais pas le modifier.");
    expect(marketing.body).not.toContain('name="idempotency_key"');
  });
});

describe("chronologie", () => {
  it("notes, appels et tâches sont lisibles, et la prochaine action est la tâche ouverte", async () => {
    const text = visibleText(await page("shared", `/fr/leads/${ids.Mine}`));
    expect(text).toContain(NOTE);
    expect(text).toContain(CALL);
    expect(text).toContain(TASK);
    expect(text).toContain("Prochaine action");
    expect(text).toContain("Répondu");
  });

  it("les entrées automatiques (étape, responsable) figurent et l'ordre est le plus récent d'abord", async () => {
    const text = visibleText(await page("shared", `/fr/leads/${ids.Mine}`));
    const at = (needle: string) => text.indexOf(needle, text.indexOf("Chronologie"));
    expect(text).toContain("Changement d’étape");
    expect(text).toContain("Changement de responsable");
    // récent -> ancien : (responsable, étape) puis tâche, appel, note
    const order = [at("Changement de responsable"), at(TASK), at(CALL), at(NOTE)];
    for (const position of order) expect(position).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(at("Changement d’étape")).toBeGreaterThan(-1);
    expect(at("Changement d’étape")).toBeLessThan(at(TASK));
  });

  it("le lien de la liste des leads mène à la fiche", async () => {
    const list = (await page("shared", `/fr/leads?q=${TAG}`)).body;
    expect(list).toContain(`/leads/${ids.Mine}`);
  });
});
