import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, PROJECT, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL } from "./app-client";

/**
 * POST /api/leads (J21) par HTTP, SANS session : clé de formulaire et origine. Scénario d'acceptation §13-3 : deux soumissions
 * identiques donnent UN contact ; source, UTM, `landing_page_id`, texte et version du consentement stockés ; l'entreprise est
 * déduite de la clé, jamais du corps. Les clés de test sont insérées par SQL local (empreinte calculée ici) ; nettoyage complet.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (n: string) => `acc-${run}-${n}@exemple.test`.toLowerCase();
const ORIGIN_A = `https://acc-${run}-a.exemple.test`;
const ORIGIN_B = `https://acc-${run}-b.exemple.test`;
const newKey = () => `flk_${randomBytes(32).toString("hex")}`;
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

const keys = { alpha: newKey(), beta: newKey(), revoked: newKey(), archived: newKey() };
let ip = 10;
/** Une adresse source distincte par appel (le proxy d'hébergement la fournit ; ici, l'en-tête du test) : aucun seau partagé. */
const nextIp = () => `198.51.100.${(ip += 1)}`;

type Result = { status: number; json: Record<string, unknown>; headers: Headers };
async function submit(
  key: string | null,
  origin: string | null,
  body: unknown,
  opts: { ip?: string; raw?: string; contentType?: string } = {},
): Promise<Result> {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json", "x-forwarded-for": opts.ip ?? nextIp() };
  if (key !== null) headers["x-form-key"] = key;
  if (origin !== null) headers.origin = origin;
  const response = await fetch(`${BASE_URL}/api/leads`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: response.headers };
}

const count = (sql: string) => Number(psql(sql));
const contactsOf = (address: string) => count(`select count(*) from public.contacts where email_normalized = '${address}'`);
const leadsOf = (address: string) => count(`select count(*) from public.leads where contact_id in (select id from public.contacts where email_normalized = '${address}')`);

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'acc-${run}-%');
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'acc-${run}-%');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like 'acc-${run}-%');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'acc-${run}-%');
    delete from public.contacts where email_normalized like 'acc-${run}-%';
    delete from public.form_keys where allowed_origins::text like '%acc-${run}-%';
    update public.projects set status = 'active' where id = '${PROJECT.alphaApp}';
  `);

beforeAll(() => {
  cleanup();
  const insert = (org: string, project: string, key: string, origin: string, active: boolean) =>
    `insert into public.form_keys (organization_id, project_id, key_hash, key_prefix, allowed_origins, active) values ('${org}', '${project}', '${hash(key)}', '${key.slice(0, 8)}', array['${origin}'], ${active});`;
  psql(
    [
      insert(ORG.alpha, PROJECT.alphaSite, keys.alpha, ORIGIN_A, true),
      insert(ORG.beta, PROJECT.betaShop, keys.beta, ORIGIN_B, true),
      insert(ORG.alpha, PROJECT.alphaSite, keys.revoked, ORIGIN_A.replace("-a.", "-r."), false),
      insert(ORG.alpha, PROJECT.alphaApp, keys.archived, ORIGIN_A.replace("-a.", "-z."), true),
    ].join("\n"),
  );
  psql(`update public.projects set status = 'archived' where id = '${PROJECT.alphaApp}'`);
});
afterAll(cleanup);

const form = (address: string, extra: Record<string, unknown> = {}) => ({
  name: "Nadia Benali",
  email: address,
  default_country: "MA",
  language: "fr",
  utm: { utm_source: "newsletter", utm_campaign: "ete", landing_page_id: "lp-ete" },
  consent: { channel: "email", text: "J'accepte de recevoir des offres par e-mail.", version: "v2" },
  page_url: "https://exemple.test/inscription",
  ...extra,
});

describe("préflight CORS", () => {
  it("origine d'une clé active : 204 avec CORS sans identifiants ; origine inconnue : 403 sans CORS", async () => {
    const ok = await fetch(`${BASE_URL}/api/leads`, { method: "OPTIONS", headers: { origin: ORIGIN_A } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN_A);
    expect(ok.headers.get("access-control-allow-headers")).toContain("x-form-key");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const denied = await fetch(`${BASE_URL}/api/leads`, { method: "OPTIONS", headers: { origin: "https://pirate.example.test" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /api/leads : scénario §13-3", () => {
  it("une soumission : 202 sans identifiant ; contact, lead, consentement (texte, version, page, IP) et job créés dans l'entreprise de la clé", async () => {
    const address = email("une");
    const res = await submit(keys.alpha, ORIGIN_A, form(address, { phone: "06 12 34 56 78" }), { ip: "198.51.100.200" });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: "received" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN_A);
    expect(contactsOf(address)).toBe(1);
    expect(psql(`select organization_id from public.contacts where email_normalized = '${address}'`)).toBe(ORG.alpha);
    expect(psql(`select phone_e164 from public.contacts where email_normalized = '${address}'`)).toBe("+212612345678");
    const lead = psql(`select l.source || '|' || l.project_id || '|' || (l.utm ->> 'landing_page_id') || '|' || (l.utm ->> 'utm_source') from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = '${address}'`);
    expect(lead).toBe(`web_form|${PROJECT.alphaSite}|lp-ete|newsletter`);
    const proof = psql(`select (e.proof ->> 'consent_version') || '|' || (e.proof ->> 'consent_text') || '|' || (e.proof ->> 'url') || '|' || (e.proof ->> 'ip') from public.consent_events e join public.contacts c on c.id = e.contact_id where c.email_normalized = '${address}'`);
    expect(proof).toBe("v2|J'accepte de recevoir des offres par e-mail.|https://exemple.test/inscription|198.51.100.200");
    expect(count(`select count(*) from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = '${address}')`)).toBe(1);
  });

  it("DEUX soumissions identiques : la même réponse, UN contact, UN lead, UN consentement, UN job", async () => {
    const address = email("deux");
    const first = await submit(keys.alpha, ORIGIN_A, form(address));
    const second = await submit(keys.alpha, ORIGIN_A, form(address));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.json).toEqual(first.json);
    expect(contactsOf(address)).toBe(1);
    expect(leadsOf(address)).toBe(1);
    expect(count(`select count(*) from public.consent_events e join public.contacts c on c.id = e.contact_id where c.email_normalized = '${address}'`)).toBe(1);
    expect(count(`select count(*) from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = '${address}')`)).toBe(1);
  });

  it("8 soumissions simultanées identiques : un seul contact et un seul lead", async () => {
    const address = email("course");
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(keys.alpha, ORIGIN_A, form(address))));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(202));
    expect(contactsOf(address)).toBe(1);
    expect(leadsOf(address)).toBe(1);
  });

  it("même e-mail chez l'autre entreprise : un contact par entreprise", async () => {
    const address = email("deux-orgs");
    expect((await submit(keys.alpha, ORIGIN_A, form(address))).status).toBe(202);
    expect((await submit(keys.beta, ORIGIN_B, form(address))).status).toBe(202);
    expect(contactsOf(address)).toBe(2);
  });
});

describe("POST /api/leads : refus (aucune écriture)", () => {
  const code = (res: Result) => res.json.code;

  it("origine absente ou inconnue : 403 forbidden, jamais de CORS ; origine d'une AUTRE clé : 403 aussi (rien n'est écrit)", async () => {
    const address = email("origine");
    for (const origin of [null, "https://pirate.example.test"]) {
      const res = await submit(keys.alpha, origin, form(address));
      expect(res.status, String(origin)).toBe(403);
      expect(code(res)).toBe("forbidden");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const crossed = await submit(keys.alpha, ORIGIN_B, form(address));
    expect(crossed.status).toBe(403);
    expect(code(crossed)).toBe("forbidden");
    expect(crossed.headers.get("access-control-allow-origin")).toBeNull();
    expect(contactsOf(address)).toBe(0);
  });

  it("clé absente, mal formée, inconnue, révoquée ou d'un projet archivé : le même 403", async () => {
    const address = email("cle");
    const attempts: [string | null, string][] = [
      [null, ORIGIN_A],
      ["flk_trop-court", ORIGIN_A],
      [newKey(), ORIGIN_A],
      [keys.revoked, ORIGIN_A.replace("-a.", "-r.")],
      [keys.archived, ORIGIN_A.replace("-a.", "-z.")],
    ];
    for (const [key, origin] of attempts) {
      const res = await submit(key, origin, form(address));
      expect(res.status, String(key)).toBe(403);
      expect(code(res)).toBe("forbidden");
    }
    expect(contactsOf(address)).toBe(0);
  });

  it("entreprise ou projet nommés dans le corps, champ inconnu, e-mail invalide, JSON invalide, mauvais type : 400", async () => {
    const address = email("corps");
    const bodies = [
      form(address, { organization_id: ORG.beta }),
      form(address, { project_id: PROJECT.betaShop }),
      form(address, { role: "owner" }),
      form("pas-un-email"),
      { name: "Sans identifiant" },
    ];
    for (const body of bodies) {
      const res = await submit(keys.alpha, ORIGIN_A, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(code(res)).toBe("validation_failed");
    }
    expect((await submit(keys.alpha, ORIGIN_A, null, { raw: "pas du json" })).status).toBe(400);
    expect((await submit(keys.alpha, ORIGIN_A, form(address), { contentType: "text/plain" })).status).toBe(400);
    expect(contactsOf(address)).toBe(0);
  });

  it("corps de plus de 16 Kio : 413", async () => {
    const res = await submit(keys.alpha, ORIGIN_A, form(email("gros"), { name: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(code(res)).toBe("payload_too_large");
  });

  it("champ piège rempli : 202 identique, RIEN n'est écrit", async () => {
    const address = email("piege");
    const res = await submit(keys.alpha, ORIGIN_A, form(address, { website: "http://spam.example.test" }));
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: "received" });
    expect(contactsOf(address)).toBe(0);
  });

  it("limitation de débit par adresse : 429 avec Retry-After après la rafale", async () => {
    const source = "198.51.100.250";
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 24; i++) {
      const res = await submit(keys.alpha, ORIGIN_A, form(email(`debit-${i}`)), { ip: source });
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after");
    }
    expect(statuses.slice(0, 20).every((status) => status === 202)).toBe(true);
    expect(statuses.slice(20)).toContain(429);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/leads : aucune donnée personnelle dans l'audit", () => {
  it("l'audit ne contient ni e-mail, ni nom, ni téléphone, ni texte de consentement, ni clé", () => {
    const leaks = psql(`
      select count(*) from public.audit_logs
       where created_at > now() - interval '15 minutes' and entity_type in ('contact', 'lead', 'consent_event')
         and (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'acc-${run}|exemple\\.test|Nadia|\\+2126|J''accepte|198\\.51\\.100'
    `);
    expect(leaks).toBe("0");
  });
});
