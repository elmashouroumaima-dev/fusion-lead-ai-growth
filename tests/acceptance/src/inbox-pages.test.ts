import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql, USER } from "../../../supabase/tests/rls/src/harness";
import { getPage, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Boîte de réception (J37) par HTTP, avec de vraies sessions : liste unifiée (e-mail ET WhatsApp dans la même liste), aperçu tronqué du
 * dernier message (jamais le corps entier), filtres (canal, responsable), recherche, fil en lecture, commandes par rôle. Rôles : owner et
 * admin lisent toutes les conversations d'Alpha, le commercial les SIENNES (une autre est introuvable), marketing et analyste sont renvoyés
 * au tableau de bord ; une autre entreprise ne voit RIEN d'Alpha dans la liste ni dans le fil. Les données de test portent un préfixe
 * unique par exécution et sont supprimées à la fin.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `ibx${run}`;
const name = (label: string) => `Zz${TAG} ${label}`;
const FIN = `FIN-DU-CORPS-${TAG}`;
const LONG_BODY = `Bonjour, voici ma demande ${"détaillée ".repeat(30)}${FIN}`;
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const page = (who: string, path: string, org: string = ORG.alpha) => getPage(as(who), path, org);
const ids: Record<string, string> = {};

function seed() {
  psql(`
    insert into public.integrations (organization_id, provider, status, external_account_id) values
      ('${ORG.alpha}', 'email', 'active', '${TAG}-mail'),
      ('${ORG.alpha}', 'whatsapp', 'active', '${TAG}-wa'),
      ('${ORG.beta}', 'whatsapp', 'active', '${TAG}-wb');
    insert into public.channels (organization_id, type, integration_id, sender_identity, status)
      select i.organization_id, i.provider::public.channel_type, i.id, case i.provider when 'email' then 'ventes@${TAG}.test' else '+2126000' || (case when i.organization_id = '${ORG.alpha}' then '5' else '6' end) || '${Date.now().toString().slice(-5)}' end, 'active'
        from public.integrations i where i.external_account_id like '${TAG}-%';
    insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values
      ('${ORG.alpha}', '${name("Nadia")}', 'nadia.${TAG}@ibx.test', 'nadia.${TAG}@ibx.test', null),
      ('${ORG.alpha}', '${name("Youssef")}', null, null, '+2126123${Date.now().toString().slice(-5)}'),
      ('${ORG.beta}', '${name("Beta")}', 'beta.${TAG}@ibx.test', 'beta.${TAG}@ibx.test', null);
  `);
  const channel = (account: string) => psql(`select ch.id from public.channels ch join public.integrations i on i.id = ch.integration_id where i.external_account_id = '${TAG}-${account}'`);
  const contact = (label: string) => psql(`select id from public.contacts where name = '${name(label)}'`);
  const open = (org: string, label: string, account: string) =>
    psql(`select (private.conversation_get_or_create('${org}', '${contact(label)}', '${channel(account)}') ->> 'id')`);
  ids.Nadia = open(ORG.alpha, "Nadia", "mail");
  ids.Youssef = open(ORG.alpha, "Youssef", "wa");
  ids.Beta = open(ORG.beta, "Beta", "wb");
  psql(`
    select private.message_record('${ORG.alpha}', '${ids.Nadia}', 'inbound', 'ibx.${run}.1', '${LONG_BODY}', null, '2026-11-10 10:00:00+00');
    select private.message_record('${ORG.alpha}', '${ids.Youssef}', 'inbound', 'ibx.${run}.2', 'Salut, vous livrez à Casablanca ?', null, '2026-11-10 11:00:00+00');
    select private.message_record('${ORG.beta}', '${ids.Beta}', 'inbound', 'ibx.${run}.3', 'Hello Beta', null, '2026-11-10 12:00:00+00');
    update public.conversations set assignee_id = '${USER.alphaSales}', state = 'open' where id = '${ids.Youssef}';
  `);
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where name like '%${TAG}%'));
    delete from public.conversations where contact_id in (select id from public.contacts where name like '%${TAG}%');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like '${TAG}-%');
    delete from public.integrations where external_account_id like '${TAG}-%';
    delete from public.contacts where name like '%${TAG}%';
  `);

beforeAll(async () => {
  cleanup();
  for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(who, await signIn(`${who}@seed.test`));
  seed();
});
afterAll(cleanup);

describe("liste : e-mail et WhatsApp dans une même liste, rôles et isolation", () => {
  it("owner et admin voient les deux conversations d'Alpha (e-mail ET WhatsApp) avec le canal ; jamais celle de Beta ; sans session : connexion", async () => {
    for (const who of ["shared", "alpha-admin"]) {
      const res = await page(who, `/fr/inbox?q=${TAG}`);
      expect(res.status, who).toBe(200);
      const text = visibleText(res);
      expect(text, who).toContain(name("Nadia"));
      expect(text, who).toContain(name("Youssef"));
      expect(text, who).toContain("E-mail");
      expect(text, who).toContain("WhatsApp");
      expect(text, who).not.toContain(name("Beta"));
    }
    const beta = visibleText(await page("beta-owner", `/fr/inbox?q=${TAG}`, ORG.beta));
    expect(beta).toContain(name("Beta"));
    expect(beta).not.toContain(name("Nadia"));
    expect(beta).not.toContain(name("Youssef"));
    const anon = await getPage(null, "/fr/inbox");
    expect([302, 303, 307]).toContain(anon.status);
    expect(redirectPath(anon)).toMatch(/login/);
  });

  it("la liste n'affiche qu'un APERÇU : le début du message, jamais la fin d'un long corps", async () => {
    const res = await page("shared", `/fr/inbox?q=${TAG}`);
    expect(visibleText(res)).toContain("Bonjour, voici ma demande");
    expect(visibleText(res)).not.toContain(FIN);
    expect(res.body).not.toContain(FIN);
    expect(visibleText(res)).toContain("Salut, vous livrez à Casablanca ?");
  });

  it("le commercial ne voit que SA conversation ; marketing et analyste sont renvoyés au tableau de bord", async () => {
    const text = visibleText(await page("alpha-sales", `/fr/inbox?q=${TAG}`));
    expect(text).toContain(name("Youssef"));
    expect(text).not.toContain(name("Nadia"));
    for (const who of ["alpha-marketing", "alpha-analyst"]) {
      const res = await page(who, "/fr/inbox");
      expect([302, 303, 307], who).toContain(res.status);
      expect(redirectPath(res), who).toMatch(/dashboard/);
    }
  });

  it("filtres : canal et responsable ; recherche par nom ; valeurs inconnues ignorées", async () => {
    const whatsapp = visibleText(await page("shared", `/fr/inbox?q=${TAG}&channel=whatsapp`));
    expect(whatsapp).toContain(name("Youssef"));
    expect(whatsapp).not.toContain(name("Nadia"));
    const unassigned = visibleText(await page("shared", `/fr/inbox?q=${TAG}&assignee=none`));
    expect(unassigned).toContain(name("Nadia"));
    expect(unassigned).not.toContain(name("Youssef"));
    expect(visibleText(await page("shared", `/fr/inbox?q=nadia.${TAG}`))).toContain(name("Nadia"));
    expect((await page("shared", `/fr/inbox?q=${TAG}&state=bidon&channel=sms&assignee=x&page=abc`)).status).toBe(200);
  });
});

describe("fil d'une conversation", () => {
  it("le corps COMPLET n'est lisible que dans le fil, par owner, admin et le commercial de SA conversation", async () => {
    for (const who of ["shared", "alpha-admin"]) {
      const res = await page(who, `/fr/inbox/${ids.Nadia}`);
      expect(res.status, who).toBe(200);
      expect(visibleText(res), who).toContain(FIN);
    }
    const mine = await page("alpha-sales", `/fr/inbox/${ids.Youssef}`);
    expect(mine.status).toBe(200);
    expect(visibleText(mine)).toContain("Salut, vous livrez à Casablanca ?");
  });

  it("le commercial ne lit PAS le fil d'un autre ; une autre entreprise, un identifiant invalide : 404 ; marketing et analyste : renvoyés", async () => {
    expect((await page("alpha-sales", `/fr/inbox/${ids.Nadia}`)).status).toBe(404);
    expect((await page("beta-owner", `/fr/inbox/${ids.Nadia}`, ORG.beta)).status).toBe(404);
    expect((await page("shared", `/fr/inbox/${ids.Beta}`)).status).toBe(404);
    expect((await page("shared", "/fr/inbox/pas-un-uuid")).status).toBe(404);
    for (const who of ["alpha-marketing", "alpha-analyst"]) {
      const res = await page(who, `/fr/inbox/${ids.Nadia}`);
      expect([302, 303, 307], who).toContain(res.status);
      expect(redirectPath(res), who).toMatch(/dashboard/);
    }
  });

  it("commandes : owner et admin assignent et changent l'état ; le commercial seulement l'état de SA conversation ; réponse WhatsApp non disponible", async () => {
    for (const who of ["shared", "alpha-admin"]) {
      const text = visibleText(await page(who, `/fr/inbox/${ids.Nadia}`));
      expect(text, who).toContain("Assigner");
      expect(text, who).toContain("Changer l’état");
    }
    const sales = visibleText(await page("alpha-sales", `/fr/inbox/${ids.Youssef}`));
    expect(sales).toContain("Changer l’état");
    expect(sales).not.toContain("Assigner");
    // J38 : le composeur existe ; la conversation WhatsApp annonce que la réponse WhatsApp n’est pas encore disponible
    expect(sales).toContain("La réponse par WhatsApp n’est pas encore disponible");
  });
});
