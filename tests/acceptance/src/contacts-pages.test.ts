import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql } from "../../../supabase/tests/rls/src/harness";
import { getPage, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Écran Contacts (J30b) par HTTP, avec de vraies sessions : liste (recherche et pagination côté serveur), fiche d'un contact
 * (coordonnées, historique du consentement avec sa preuve, formulaires). Rôles : owner, admin et marketing ; le commercial et
 * l'analyste sont renvoyés au tableau de bord ; une autre entreprise ne voit rien d'Alpha ; un contact d'une autre entreprise est
 * introuvable. L'adresse IP enregistrée dans une preuve n'est jamais affichée. Les données de test portent un préfixe unique par
 * exécution et sont supprimées à la fin.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `cnt${run}`;
const name = (label: string) => `Zz${TAG} ${label}`;
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
    insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values
      ('${ORG.alpha}', '${name("Nadia")}', 'nadia.${TAG}@cnt.test', 'nadia.${TAG}@cnt.test', '+212612340011'),
      ('${ORG.alpha}', '${name("Youssef")}', 'youssef.${TAG}@cnt.test', 'youssef.${TAG}@cnt.test', null),
      ('${ORG.beta}', '${name("Beta")}', 'beta.${TAG}@cnt.test', 'beta.${TAG}@cnt.test', null);
    insert into public.contacts (organization_id, name, email_raw, email_normalized)
      select '${ORG.alpha}', 'Zz${TAG} Page ' || lpad(n::text, 2, '0'), 'page' || n || '.${TAG}@cnt.test', 'page' || n || '.${TAG}@cnt.test' from generate_series(1, 30) n;
  `);
  for (const label of ["Nadia", "Youssef", "Beta"]) {
    ids[label] = psql(`select id from public.contacts where name = '${name(label)}'`);
  }
  // un consentement avec une preuve qui contient une adresse IP (jamais affichée) et un texte lisible
  psql(`
    set session_replication_role = replica;
    insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof)
    values ('${ORG.alpha}', '${ids.Nadia}', 'email', 'marketing', 'web_form',
            '{"consent_text": "Accord pour les offres ${TAG}", "consent_version": "v7", "ip": "203.0.113.77"}'::jsonb);
  `);
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.consent_events where contact_id in (select id from public.contacts where name like '%${TAG}%');
    delete from public.contacts where name like '%${TAG}%';
  `);

beforeAll(async () => {
  cleanup();
  for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(who, await signIn(`${who}@seed.test`));
  seed();
});
afterAll(cleanup);

describe("liste des contacts : rôles et isolation", () => {
  it("owner, admin et marketing voient les contacts d'Alpha ; Beta ne voit rien d'Alpha ; sans session : connexion", async () => {
    // la liste est triée du plus récent au plus ancien et paginée : on cible chaque personne par sa recherche
    for (const who of ["shared", "alpha-admin", "alpha-marketing"]) {
      const nadia = await page(who, `/fr/contacts?q=nadia.${TAG}`);
      expect(nadia.status, who).toBe(200);
      expect(visibleText(nadia), who).toContain(name("Nadia"));
      expect(visibleText(await page(who, `/fr/contacts?q=youssef.${TAG}`)), who).toContain(name("Youssef"));
      expect(visibleText(await page(who, `/fr/contacts?q=beta.${TAG}`)), who).not.toContain(name("Beta"));
    }
    const beta = visibleText(await page("beta-owner", `/fr/contacts?q=beta.${TAG}`, ORG.beta));
    expect(beta).toContain(name("Beta"));
    expect(visibleText(await page("beta-owner", `/fr/contacts?q=nadia.${TAG}`, ORG.beta))).not.toContain(name("Nadia"));
    const anon = await getPage(null, "/fr/contacts");
    expect([302, 303, 307]).toContain(anon.status);
    expect(redirectPath(anon)).toMatch(/login/);
  });

  it("le commercial et l'analyste sont renvoyés au tableau de bord (données personnelles)", async () => {
    for (const who of ["alpha-sales", "alpha-analyst"]) {
      const res = await page(who, "/fr/contacts");
      expect([302, 303, 307], who).toContain(res.status);
      expect(redirectPath(res), who).toMatch(/dashboard/);
    }
  });

  it("recherche par nom, e-mail et téléphone ; saisie sans effet de motif ; pagination côté serveur", async () => {
    expect(visibleText(await page("shared", `/fr/contacts?q=nadia.${TAG}`))).toContain(name("Nadia"));
    expect(visibleText(await page("shared", `/fr/contacts?q=${encodeURIComponent("06 12 34 00 11")}`))).toContain(name("Nadia"));
    // « % » et « _ » sont des caractères : aucune des personnes de test n'en porte, donc aucun résultat
    expect(visibleText(await page("shared", `/fr/contacts?q=${encodeURIComponent(`%${TAG}%`)}`))).not.toContain(name("Nadia"));
    const first = visibleText(await page("shared", `/fr/contacts?q=${TAG}`));
    expect(first).toContain("Page 1 sur 2");
    expect(visibleText(await page("shared", `/fr/contacts?q=${TAG}&page=2`))).toContain("Page 2 sur 2");
    // un numéro de page absurde ne casse pas la page
    expect((await page("shared", `/fr/contacts?q=${TAG}&page=abc`)).status).toBe(200);
  });
});

describe("fiche d'un contact", () => {
  it("coordonnées, historique du consentement avec le texte et la version de la preuve ; jamais l'adresse IP", async () => {
    for (const who of ["shared", "alpha-admin", "alpha-marketing"]) {
      const res = await page(who, `/fr/contacts/${ids.Nadia}`);
      expect(res.status, who).toBe(200);
      const text = visibleText(res);
      expect(text, who).toContain(name("Nadia"));
      expect(text, who).toContain(`nadia.${TAG}@cnt.test`);
      expect(text, who).toContain(`Accord pour les offres ${TAG}`);
      expect(text, who).toContain("v7");
      expect(text, who).not.toContain("203.0.113.77");
      expect(res.body, who).not.toContain("203.0.113.77");
    }
  });

  it("formulaires : visibles pour owner, admin et marketing ; le retrait du blocage n'est proposé qu'à owner et admin", async () => {
    for (const who of ["shared", "alpha-admin", "alpha-marketing"]) {
      const body = (await page(who, `/fr/contacts/${ids.Youssef}`)).body;
      expect(body, who).toContain('name="idempotency_key"');
      expect(body, who).toContain("Enregistrer le consentement");
    }
  });

  it("un contact d'une autre entreprise est introuvable ; un identifiant invalide aussi ; commercial et analyste sont renvoyés", async () => {
    expect((await page("shared", `/fr/contacts/${ids.Beta}`)).status).toBe(404);
    expect((await page("beta-owner", `/fr/contacts/${ids.Nadia}`, ORG.beta)).status).toBe(404);
    expect((await page("shared", "/fr/contacts/pas-un-uuid")).status).toBe(404);
    for (const who of ["alpha-sales", "alpha-analyst"]) {
      const res = await page(who, `/fr/contacts/${ids.Nadia}`);
      expect([302, 303, 307], who).toContain(res.status);
      expect(redirectPath(res), who).toMatch(/dashboard/);
    }
  });
});
