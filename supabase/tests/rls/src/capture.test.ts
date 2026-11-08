import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, rowsOf, select, type Persona } from "./harness";

/**
 * Capture publique par la Data API (J21) : clés de formulaire lues par owner / admin SANS empreinte, aucune écriture directe,
 * gestion par fonctions réservées à owner / admin, `capture_lead` appelable par service_role SEULEMENT (ni anon, ni utilisateur
 * connecté), déduplication sous VRAIE concurrence (12 soumissions identiques = un contact, un lead, un consentement, un job),
 * isolation Alpha / Beta. Tests ré-exécutables : origines et e-mails uniques par exécution, nettoyage des lignes créées.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const origin = (n: string) => `https://cap-${run}-${n}.exemple.test`;
const email = (n: string) => `rlscap-${run}-${n}@exemple.test`.toLowerCase();
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

const capture = (key: string, from: string, fields: Record<string, unknown>) =>
  rpc("service", "capture_lead", {
    p_key_hash: hash(key), p_origin: from, p_name: "Test RLS capture", p_email_raw: null, p_email_normalized: null, p_phone_e164: null, p_language: "fr",
    p_country: "MA", p_utm: {}, p_consent: null, ...fields,
  });
const withEmail = (address: string) => ({ p_email_raw: address, p_email_normalized: address });

async function newKey(persona: Persona, org: string, project: string, origins: string[]): Promise<{ id: string; key: string }> {
  const result = await rpc(persona, "create_form_key", { p_org: org, p_project: project, p_origins: origins });
  expect(result.status, `${persona} crée une clé`).toBe(200);
  const body = result.body as { id: string; key: string };
  return { id: body.id, key: body.key };
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'rlscap-${run}-%');
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'rlscap-${run}-%');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like 'rlscap-${run}-%');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'rlscap-${run}-%');
    delete from public.contacts where email_normalized like 'rlscap-${run}-%';
    delete from public.form_keys where allowed_origins::text like '%cap-${run}-%';
  `);

beforeAll(cleanup);
afterAll(cleanup);

let alpha = { id: "", key: "" };
let beta = { id: "", key: "" };

describe("gestion des clés : rôles et lecture sans empreinte", () => {
  it("owner et admin créent ; marketing, commercial, analyste, Beta et sans adhésion refusés", async () => {
    alpha = await newKey("alphaAdmin", ORG.alpha, PROJECT.alphaSite, [origin("a")]);
    beta = await newKey("betaOwner", ORG.beta, PROJECT.betaShop, [origin("b")]);
    expect((await newKey("shared", ORG.alpha, PROJECT.alphaSite, [origin("owner")])).key).toMatch(/^flk_[0-9a-f]{64}$/);
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      const result = await rpc(persona, "create_form_key", { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_origins: [origin("x")] });
      expect(message(result), persona).toBe("forbidden");
    }
  });

  it("projet d'une autre entreprise : introuvable ; origines invalides : validation_failed", async () => {
    expect(message(await rpc("alphaAdmin", "create_form_key", { p_org: ORG.alpha, p_project: PROJECT.betaShop, p_origins: [origin("y")] }))).toBe("not_found");
    for (const bad of [["http://exemple.test"], ["https://*.exemple.test"], ["https://127.0.0.1"], []]) {
      expect(message(await rpc("alphaAdmin", "create_form_key", { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_origins: bad })), JSON.stringify(bad)).toBe("validation_failed");
    }
  });

  it("owner et admin lisent les clés SANS empreinte ; les autres rôles et l'autre entreprise : rien", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const rows = rowsOf<{ id: string; key_prefix: string }>(await select(persona, `form_keys?select=id,key_prefix&allowed_origins=cs.{${origin("a")}}`));
      expect(rows.map((row) => row.id), persona).toEqual([alpha.id]);
      expect(rows[0]?.key_prefix).toBe(alpha.key.slice(0, 8));
      const withHash = await select(persona, "form_keys?select=key_hash");
      expect(isDenied(withHash) || withHash.code === "42501", `${persona} key_hash`).toBe(true);
    }
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(rowsOf(await select(persona, `form_keys?select=id&allowed_origins=cs.{${origin("a")}}`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "form_keys?select=id"))).toBe(true);
  });

  it("aucune écriture directe, même service_role", async () => {
    for (const persona of ["shared", "alphaAdmin", "service"] as const) {
      expect(isDenied(await api(persona, "POST", "form_keys", { organization_id: ORG.alpha })), `${persona} insert`).toBe(true);
      expect(isDenied(await api(persona, "PATCH", `form_keys?organization_id=eq.${ORG.alpha}`, { active: false })), `${persona} update`).toBe(true);
      expect(isDenied(await api(persona, "DELETE", `form_keys?organization_id=eq.${ORG.alpha}`)), `${persona} delete`).toBe(true);
    }
  });

  it("révoquer, réactiver, changer les origines : owner / admin seulement", async () => {
    const extra = await newKey("alphaAdmin", ORG.alpha, PROJECT.alphaSite, [origin("rev")]);
    for (const persona of ["alphaMarketing", "alphaSales", "betaOwner"] as const) {
      expect(message(await rpc(persona, "set_form_key_active", { p_org: ORG.alpha, p_id: extra.id, p_active: false })), persona).toBe("forbidden");
    }
    expect((await rpc("alphaAdmin", "set_form_key_active", { p_org: ORG.alpha, p_id: extra.id, p_active: false })).status).toBeLessThan(300);
    expect((await capture(extra.key, origin("rev"), withEmail(email("revoquee")))).status).toBeGreaterThanOrEqual(400);
    expect((await rpc("alphaAdmin", "set_form_key_active", { p_org: ORG.alpha, p_id: extra.id, p_active: true })).status).toBeLessThan(300);
    expect((await rpc("alphaAdmin", "set_form_key_origins", { p_org: ORG.alpha, p_id: extra.id, p_origins: [origin("rev"), origin("rev2")] })).status).toBeLessThan(300);
    expect(message(await rpc("alphaAdmin", "set_form_key_origins", { p_org: ORG.alpha, p_id: extra.id, p_origins: ["*"] }))).toBe("validation_failed");
  });
});

describe("capture_lead : qui peut l'appeler", () => {
  it("service_role seulement : anon, utilisateurs connectés refusés ; l'empreinte de la clé n'est pas la clé", async () => {
    const args = { p_key_hash: hash(alpha.key), p_origin: origin("a"), p_name: "X", p_email_raw: email("interdit"), p_email_normalized: email("interdit"), p_phone_e164: null, p_language: null, p_country: null, p_utm: {}, p_consent: null };
    for (const persona of ["anon", "shared", "alphaAdmin", "alphaSales", "nobody"] as const) {
      expect((await rpc(persona, "capture_lead", args)).status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(rowsOf(await select("alphaAdmin", `contacts?select=id&email_normalized=eq.${email("interdit")}`))).toEqual([]);
    expect(isDenied(await rpc("anon", "form_origin_allowed", { p_origin: origin("a") })) || (await rpc("anon", "form_origin_allowed", { p_origin: origin("a") })).status >= 400).toBe(true);
  });

  it("clé inconnue, origine refusée ou absente : le même refus", async () => {
    const a = await capture(`flk_${"0".repeat(64)}`, origin("a"), withEmail(email("inconnue")));
    const b = await capture(alpha.key, "https://pirate.exemple.test", withEmail(email("pirate")));
    const c = await capture(alpha.key, "", withEmail(email("sans-origine")));
    for (const result of [a, b, c]) expect(message(result)).toBe("form_key_invalid");
    expect(rowsOf(await select("alphaAdmin", `contacts?select=id&email_normalized=like.rlscap-${run}-*`))).toEqual([]);
  });
});

describe("capture_lead : déduplication, consentement, job", () => {
  it("une soumission : contact + lead + consentement + job, dans l'entreprise DE LA CLÉ", async () => {
    const result = await capture(alpha.key, origin("a"), {
      ...withEmail(email("une")),
      p_utm: { utm_source: "newsletter", landing_page_id: "lp-1" },
      p_consent: { channel: "email", purpose: "marketing", proof: { consent_text: "J'accepte.", consent_version: "v2", url: "https://exemple.test/inscription", ip: "203.0.113.7" } },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ contact_created: true, lead_created: true, consent_recorded: true });
    const contact = rowsOf<{ id: string; organization_id: string; consent_status: string }>(await select("alphaAdmin", `contacts?select=id,organization_id,consent_status&email_normalized=eq.${email("une")}`))[0];
    expect(contact?.organization_id).toBe(ORG.alpha);
    expect(contact?.consent_status).toBe("granted");
    const lead = rowsOf<{ source: string; project_id: string; utm: Record<string, string> }>(await select("alphaAdmin", `leads?select=source,project_id,utm&contact_id=eq.${contact?.id}`))[0];
    expect(lead).toMatchObject({ source: "web_form", project_id: PROJECT.alphaSite });
    expect(lead?.utm.landing_page_id).toBe("lp-1");
    const proof = rowsOf<{ proof: Record<string, string> }>(await select("alphaAdmin", `consent_events?select=proof&contact_id=eq.${contact?.id}`))[0]?.proof;
    expect(proof).toMatchObject({ consent_version: "v2", ip: "203.0.113.7" });
    expect(psql(`select count(*) from public.jobs where kind = 'lead.assign' and organization_id = '${ORG.alpha}' and payload ->> 'lead_id' in (select id::text from public.leads where contact_id = '${contact?.id}')`)).toBe("1");
  });

  it("12 soumissions IDENTIQUES simultanées : un contact, un lead, un consentement, un job", async () => {
    const fields = { ...withEmail(email("course")), p_consent: { channel: "email", purpose: "marketing", proof: { consent_version: "v1" } } };
    const results = await Promise.all(Array.from({ length: 12 }, () => capture(alpha.key, origin("a"), fields)));
    expect(results.filter((r) => r.status >= 300).map((r) => message(r))).toEqual([]);
    expect(results.filter((r) => (r.body as { contact_created: boolean }).contact_created)).toHaveLength(1);
    expect(results.filter((r) => (r.body as { lead_created: boolean }).lead_created)).toHaveLength(1);
    expect(psql(`select count(*) from public.contacts where email_normalized = '${email("course")}'`)).toBe("1");
    expect(psql(`select count(*) from public.leads where contact_id in (select id from public.contacts where email_normalized = '${email("course")}')`)).toBe("1");
    expect(psql(`select count(*) from public.consent_events where contact_id in (select id from public.contacts where email_normalized = '${email("course")}')`)).toBe("1");
    expect(psql(`select count(*) from public.jobs where kind = 'lead.assign' and payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized = '${email("course")}')`)).toBe("1");
  });

  it("même e-mail dans deux entreprises : deux contacts ; chaque clé reste dans son entreprise", async () => {
    const shared = email("deux-orgs");
    expect((await capture(alpha.key, origin("a"), withEmail(shared))).status).toBe(200);
    expect((await capture(beta.key, origin("b"), withEmail(shared))).status).toBe(200);
    expect(psql(`select count(*) from public.contacts where email_normalized = '${shared}'`)).toBe("2");
    expect(psql(`select string_agg(organization_id::text, ',' order by organization_id) from public.contacts where email_normalized = '${shared}'`)).toBe(`${ORG.alpha},${ORG.beta}`);
    expect(message(await capture(beta.key, origin("a"), withEmail(email("croise"))))).toBe("form_key_invalid");
  });

  it("un contact qui a révoqué ou demandé « ne plus contacter » n'est jamais réactivé par la voie publique", async () => {
    const address = email("revoque");
    const proof = { consent_version: "v1" };
    expect((await capture(alpha.key, origin("a"), { ...withEmail(address), p_consent: { channel: "email", purpose: "marketing", proof } })).status).toBe(200);
    const contact = rowsOf<{ id: string }>(await select("alphaAdmin", `contacts?select=id&email_normalized=eq.${address}`))[0]?.id ?? "";
    expect((await rpc("alphaAdmin", "revoke_consent", { p_org: ORG.alpha, p_contact: contact, p_channel: "email", p_purpose: null, p_do_not_contact: false })).body).toBe(1);
    const again = await capture(alpha.key, origin("a"), { ...withEmail(address), p_consent: { channel: "email", purpose: "marketing", proof: { consent_version: "forge" } } });
    expect((again.body as { consent_recorded: boolean }).consent_recorded).toBe(false);
    expect(rowsOf<{ consent_status: string }>(await select("alphaAdmin", `contacts?select=consent_status&id=eq.${contact}`))[0]?.consent_status).toBe("revoked");
    expect((await rpc("alphaAdmin", "set_do_not_contact", { p_org: ORG.alpha, p_contact: contact, p_value: true })).status).toBeLessThan(300);
    const leadsBefore = psql(`select count(*) from public.leads where contact_id = '${contact}'`);
    const dnc = await capture(alpha.key, origin("a"), { ...withEmail(address), p_consent: { channel: "email", purpose: "marketing", proof } });
    expect(dnc.body).toEqual({ contact_created: false, lead_created: false, consent_recorded: false });
    expect(psql(`select count(*) from public.leads where contact_id = '${contact}'`)).toBe(leadsBefore);
  });

  it("finalité hors « marketing » / « newsletter » : refusée", async () => {
    const result = await capture(alpha.key, origin("a"), { ...withEmail(email("finalite")), p_consent: { channel: "email", purpose: "transactional", proof: {} } });
    expect(message(result)).toBe("validation_failed");
    expect(psql(`select count(*) from public.contacts where email_normalized = '${email("finalite")}'`)).toBe("0");
  });

  it("e-mail invalide, UTM inconnu, consentement incohérent : refusés sans rien écrire", async () => {
    for (const fields of [
      { p_email_raw: "A@x.com", p_email_normalized: "incoherent@x.com" },
      { ...withEmail(email("utm")), p_utm: { cookie: "x" } },
      { ...withEmail(email("canal")), p_consent: { channel: "sms" } },
      {},
    ]) {
      expect((await capture(alpha.key, origin("a"), fields)).status, JSON.stringify(fields)).toBeGreaterThanOrEqual(400);
    }
    expect(psql(`select count(*) from public.contacts where email_normalized in ('${email("utm")}', '${email("canal")}')`)).toBe("0");
  });
});

describe("audit : aucune donnée personnelle ni clé", () => {
  it("les entrées d'audit ne contiennent ni e-mail, ni preuve, ni clé", () => {
    const leaks = psql(`
      select count(*) from public.audit_logs
       where created_at > now() - interval '10 minutes' and entity_type in ('contact', 'lead', 'consent_event', 'form_key')
         and (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'rlscap-${run}|exemple\\.test|203\\.0\\.113|J''accepte|${alpha.key.slice(4, 24)}'
    `);
    expect(leaks).toBe("0");
  });
});

