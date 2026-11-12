import { afterAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, psql, rowsOf, select, type Persona } from "./harness";

/**
 * Contacts et consentement par la Data API (J18) : lecture réservée à owner / admin / marketing de CHAQUE entreprise (jamais le
 * commercial ni l'analyste), AUCUNE écriture directe (même service_role), écriture par fonctions, unicité sous VRAIE concurrence,
 * même e-mail dans deux entreprises = deux contacts, historique de consentement append-only. Tests ré-exécutables : e-mails
 * uniques par exécution, nettoyage des lignes créées (réplication désactivée pour passer outre le journal append-only).
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (n: string) => `rlsc-${run}-${n}@exemple.test`.toLowerCase();
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

const contactArgs = (org: string, address: string, extra: Record<string, unknown> = {}) => ({
  p_org: org, p_name: "Test RLS", p_email_raw: address, p_email_normalized: address, p_phone_e164: null, p_language: "fr", p_country: "MA",
  p_external_source: null, p_external_id: null, p_attributes: {}, ...extra,
});

async function create(persona: Persona, org: string, address: string): Promise<string> {
  const result = await rpc(persona, "create_contact", contactArgs(org, address));
  expect(result.status, `${persona} crée ${address}`).toBe(200);
  return String(result.body);
}

afterAll(() => {
  psql(`
    set session_replication_role = replica;
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like 'rlsc-${run}-%');
    delete from public.contacts where email_normalized like 'rlsc-${run}-%';
  `);
});

describe("lecture : owner, admin et marketing seulement, chacun dans SON entreprise", () => {
  const alphaContact = email("lecture-alpha");
  const betaContact = email("lecture-beta");

  it("préparation : un contact chez Alpha, un chez Beta, même identité visible par chaque propriétaire", async () => {
    await create("alphaAdmin", ORG.alpha, alphaContact);
    await create("betaOwner", ORG.beta, betaContact);
  });

  it("owner, admin, marketing d'Alpha : voient Alpha, jamais Beta", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing"] as const) {
      const rows = rowsOf<{ email_normalized: string; organization_id: string }>(
        await select(persona, `contacts?select=email_normalized,organization_id&email_normalized=like.rlsc-${run}-lecture*`),
      );
      expect(rows.map((r) => r.email_normalized), persona).toEqual([alphaContact]);
      expect(new Set(rows.map((r) => r.organization_id)), persona).toEqual(new Set([ORG.alpha]));
    }
  });

  it("propriétaire de Beta : voit Beta seulement, l'organisation d'Alpha dans le filtre ne révèle rien", async () => {
    const rows = rowsOf<{ email_normalized: string }>(await select("betaOwner", `contacts?select=email_normalized&email_normalized=like.rlsc-${run}-lecture*`));
    expect(rows.map((r) => r.email_normalized)).toEqual([betaContact]);
    expect(rowsOf(await select("betaOwner", `contacts?select=id&organization_id=eq.${ORG.alpha}`))).toEqual([]);
  });

  it("commercial et analyste d'Alpha, commercial de Beta (le compte partagé), analyste de Beta, sans adhésion : rien", async () => {
    for (const persona of ["alphaSales", "alphaAnalyst", "betaAnalyst", "nobody"] as const) {
      expect(rowsOf(await select(persona, `contacts?select=id&email_normalized=like.rlsc-${run}-*`)), persona).toEqual([]);
    }
    // « shared » est owner d'Alpha et commercial de Beta : il lit Alpha mais pas les contacts de Beta
    const shared = rowsOf<{ email_normalized: string }>(await select("shared", `contacts?select=email_normalized&email_normalized=like.rlsc-${run}-lecture*`));
    expect(shared.map((r) => r.email_normalized)).toEqual([alphaContact]);
  });

  it("anonyme : refusé", async () => {
    expect(isDenied(await select("anon", "contacts?select=id"))).toBe(true);
    expect(isDenied(await select("anon", "consent_events?select=id"))).toBe(true);
  });
});

describe("aucune écriture directe, même service_role", () => {
  const body = { organization_id: ORG.alpha, phone_e164: "+212600099999" };

  it("INSERT, UPDATE, DELETE sur contacts et consent_events : refusés pour tous", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing", "service"] as const) {
      expect(isDenied(await api(persona, "POST", "contacts", body)), `${persona} insert`).toBe(true);
      expect(isDenied(await api(persona, "PATCH", `contacts?organization_id=eq.${ORG.alpha}`, { name: "piraté" })), `${persona} update`).toBe(true);
      expect(isDenied(await api(persona, "DELETE", `contacts?organization_id=eq.${ORG.alpha}`)), `${persona} delete`).toBe(true);
      expect(isDenied(await api(persona, "DELETE", `consent_events?organization_id=eq.${ORG.alpha}`)), `${persona} delete consent`).toBe(true);
    }
  });

  it("les fonctions ne sont ni anonymes ni exécutables par service_role", async () => {
    for (const persona of ["anon", "service"] as const) {
      const result = await rpc(persona, "create_contact", contactArgs(ORG.alpha, email("interdit")));
      expect(result.status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(rowsOf(await select("alphaAdmin", `contacts?select=id&email_normalized=eq.${email("interdit")}`))).toEqual([]);
  });
});

describe("écriture par fonctions : rôles et isolation", () => {
  it("owner, admin, marketing : créent ; commercial, analyste : refusés", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing"] as const) await create(persona, ORG.alpha, email(`role-${persona}`));
    for (const persona of ["alphaSales", "alphaAnalyst", "betaAnalyst", "nobody"] as const) {
      const result = await rpc(persona, "create_contact", contactArgs(ORG.alpha, email(`refuse-${persona}`)));
      expect(message(result), persona).toBe("forbidden");
    }
  });

  it("owner de Beta : ne crée, ne modifie, ne consent et ne révoque rien chez Alpha", async () => {
    const id = await create("alphaAdmin", ORG.alpha, email("cible-alpha"));
    expect(message(await rpc("betaOwner", "create_contact", contactArgs(ORG.alpha, email("piratage"))))).toBe("forbidden");
    expect(message(await rpc("betaOwner", "update_contact", { ...contactArgs(ORG.alpha, email("piratage")), p_id: id }))).toBe("forbidden");
    expect(message(await rpc("betaOwner", "record_consent", { p_org: ORG.alpha, p_contact: id, p_channel: "email", p_purpose: "marketing", p_source: "manual", p_proof: {} }))).toBe("forbidden");
    expect(message(await rpc("betaOwner", "revoke_consent", { p_org: ORG.alpha, p_contact: id, p_channel: "email", p_purpose: null, p_do_not_contact: true }))).toBe("forbidden");
  });

  it("le contact d'Alpha est introuvable quand l'appelant désigne SA propre entreprise", async () => {
    const id = await create("alphaAdmin", ORG.alpha, email("autre-org"));
    const update = await rpc("betaOwner", "update_contact", { ...contactArgs(ORG.beta, email("autre-org-b")), p_id: id });
    expect(message(update)).toBe("not_found");
    const consent = await rpc("betaOwner", "record_consent", { p_org: ORG.beta, p_contact: id, p_channel: "email", p_purpose: "marketing", p_source: "manual", p_proof: {} });
    expect(message(consent)).toBe("not_found");
  });

  it("valeurs invalides refusées par la base (e-mail incohérent, téléphone non E.164, finalité mal formée)", async () => {
    expect(message(await rpc("alphaAdmin", "create_contact", contactArgs(ORG.alpha, email("x"), { p_email_normalized: email("autre") })))).toContain("contacts_email_valid");
    expect(message(await rpc("alphaAdmin", "create_contact", { ...contactArgs(ORG.alpha, email("tel")), p_phone_e164: "0612345678" }))).toContain("contacts_phone_valid");
    const id = await create("alphaAdmin", ORG.alpha, email("finalite"));
    const bad = await rpc("alphaAdmin", "record_consent", { p_org: ORG.alpha, p_contact: id, p_channel: "email", p_purpose: "Marketing", p_source: "manual", p_proof: {} });
    expect(message(bad)).toContain("consent_events_purpose_valid");
  });
});

describe("unicité et déduplication", () => {
  it("même e-mail, deux entreprises : deux contacts ; même e-mail, même entreprise : refusé", async () => {
    const shared = email("deux-orgs");
    await create("alphaAdmin", ORG.alpha, shared);
    await create("betaOwner", ORG.beta, shared);
    const again = await rpc("alphaAdmin", "create_contact", contactArgs(ORG.alpha, shared));
    expect(again.code).toBe("23505");
    const count = psql(`select count(*) from public.contacts where email_normalized = '${shared}'`);
    expect(count).toBe("2");
  });

  it("12 créations simultanées du même e-mail : un seul contact, les autres refusées proprement", async () => {
    const same = email("course");
    const results = await Promise.all(Array.from({ length: 12 }, () => rpc("alphaAdmin", "create_contact", contactArgs(ORG.alpha, same))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.code === "23505")).toHaveLength(11);
    expect(psql(`select count(*) from public.contacts where email_normalized = '${same}'`)).toBe("1");
  });
});

describe("consentement : dérivé, idempotent, immédiat, append-only", () => {
  it("cycle complet : unknown -> granted -> revoked + ne-plus-contacter ; retrait réservé à owner / admin", async () => {
    const address = email("cycle");
    const id = await create("alphaMarketing", ORG.alpha, address);
    const status = async () =>
      rowsOf<{ consent_status: string; do_not_contact: boolean }>(await select("alphaAdmin", `contacts?select=consent_status,do_not_contact&id=eq.${id}`))[0];
    expect(await status()).toEqual({ consent_status: "unknown", do_not_contact: false });

    const grant = { p_org: ORG.alpha, p_contact: id, p_channel: "email", p_purpose: "marketing", p_source: "web_form", p_proof: { consent_version: "v2", url: "https://exemple.ma/inscription" } };
    const first = await rpc("alphaMarketing", "record_consent", grant);
    expect(first.status).toBe(200);
    const second = await rpc("alphaMarketing", "record_consent", grant);
    expect(second.body).toBe(first.body);
    expect(await status()).toEqual({ consent_status: "granted", do_not_contact: false });

    const revoked = await rpc("alphaMarketing", "revoke_consent", { p_org: ORG.alpha, p_contact: id, p_channel: "email", p_purpose: null, p_do_not_contact: true });
    expect(revoked.body).toBe(1);
    expect(await status()).toEqual({ consent_status: "revoked", do_not_contact: true });

    const events = rowsOf<{ revoked_at: string | null }>(await select("alphaAdmin", `consent_events?select=revoked_at&contact_id=eq.${id}`));
    expect(events).toHaveLength(1);
    expect(events[0]?.revoked_at).not.toBeNull();

    const denied = await rpc("alphaMarketing", "set_do_not_contact", { p_org: ORG.alpha, p_contact: id, p_value: false });
    expect(message(denied)).toBe("forbidden");
    expect((await rpc("alphaAdmin", "set_do_not_contact", { p_org: ORG.alpha, p_contact: id, p_value: false })).status).toBeLessThan(300);
    expect((await status())?.do_not_contact).toBe(false);
  });

  it("l'historique ne se modifie pas, même par le propriétaire de la base", () => {
    const id = psql(`select id from public.contacts where email_normalized like 'rlsc-${run}-cycle%' limit 1`);
    expect(() => psql(`update public.consent_events set purpose = 'autre' where contact_id = '${id}'`)).toThrow();
    expect(() => psql(`delete from public.consent_events where contact_id = '${id}'`)).toThrow();
  });
});

describe("audit : aucune donnée personnelle", () => {
  it("les entrées d'audit des contacts et consentements ne contiennent ni e-mail ni preuve", () => {
    const leaks = psql(`
      select count(*) from public.audit_logs
       where entity_type in ('contact', 'consent_event')
         and created_at > now() - interval '10 minutes'
         and (coalesce(before::text, '') || coalesce(after::text, '')) ~* 'rlsc-${run}|exemple\\.(test|ma)|consent_version'
    `);
    expect(leaks).toBe("0");
  });
});
