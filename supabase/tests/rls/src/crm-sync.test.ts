import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, psql, rowsOf, select, type Persona } from "./harness";

/**
 * Synchro CRM par la Data API (J25) : intégrations et mappings gérés par fonctions réservées à owner et admin (jamais d'écriture
 * directe, même service_role), lecture owner et admin seulement, fonctions du worker réservées à service_role (ni anon, ni utilisateur
 * connecté), isolation Alpha / Beta, aucune modification d'un contact « ne plus contacter ». Ré-exécutable : données de l'exécution
 * supprimées.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNT = `rlscrm${run}`;
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";
const SOURCE = "csv:7f000000-0000-4000-8000-000000000001";
const MAPPINGS = [
  { internal_field: "external_id", external_field: "ID", source_of_truth: "external", direction: "pull" },
  { internal_field: "name", external_field: "Nom", source_of_truth: "internal", direction: "both" },
];

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.crm_field_mappings where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.integrations where external_account_id like '${ACCOUNT}%';
    delete from public.contacts where email_normalized like '%@${ACCOUNT}.test';
  `);

let integration = "";
let contact = "";

beforeAll(() => {
  cleanup();
  psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized, do_not_contact) values ('${ORG.alpha}', 'Stop ${ACCOUNT}', 'stop@${ACCOUNT}.test', 'stop@${ACCOUNT}.test', true)`);
  contact = psql(`select id from public.contacts where email_normalized = 'stop@${ACCOUNT}.test'`);
});
afterAll(cleanup);

describe("intégrations et mappings : rôles, lecture, aucune écriture directe", () => {
  it("owner et admin créent et enregistrent ; marketing, commercial, analyste, Beta, sans adhésion et anon refusés", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(message(await rpc(persona, "create_integration", { p_org: ORG.alpha, p_provider: "csv", p_account: `${ACCOUNT}-no` })), persona).toBe("forbidden");
    }
    expect(isDenied(await rpc("anon", "create_integration", { p_org: ORG.alpha, p_provider: "csv", p_account: `${ACCOUNT}-no` }))).toBe(true);
    const created = await rpc("alphaAdmin", "create_integration", { p_org: ORG.alpha, p_provider: "csv", p_account: ACCOUNT });
    expect(created.status).toBe(200);
    integration = String(created.body);
    expect((await rpc("shared", "save_crm_mappings", { p_org: ORG.alpha, p_integration: integration, p_mappings: MAPPINGS })).status).toBe(204);
    for (const persona of ["alphaMarketing", "alphaSales", "betaOwner"] as const) {
      expect(message(await rpc(persona, "save_crm_mappings", { p_org: ORG.alpha, p_integration: integration, p_mappings: MAPPINGS })), persona).toBe("forbidden");
    }
    // Beta qui se déclare dans SA propre entreprise : l'intégration d'Alpha est introuvable
    expect(message(await rpc("betaOwner", "save_crm_mappings", { p_org: ORG.beta, p_integration: integration, p_mappings: MAPPINGS }))).toBe("not_found");
  });

  it("lecture : owner et admin ; commercial, marketing, analyste, Beta et anon non", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      expect(rowsOf<{ id: string }>(await select(persona, `integrations?id=eq.${integration}`)).map((r) => r.id), persona).toEqual([integration]);
      expect(rowsOf(await select(persona, `crm_field_mappings?integration_id=eq.${integration}`)), persona).toHaveLength(2);
    }
    for (const persona of ["alphaSales", "alphaMarketing", "alphaAnalyst", "betaOwner"] as const) {
      expect(rowsOf(await select(persona, `integrations?id=eq.${integration}`)), persona).toEqual([]);
      expect(rowsOf(await select(persona, `crm_field_mappings?integration_id=eq.${integration}`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "integrations"))).toBe(true);
  });

  it("aucune écriture directe, pas même par owner ou service_role", async () => {
    for (const persona of ["shared", "service"] as const) {
      const insert = await api<unknown>(persona, "POST", "integrations", { organization_id: ORG.alpha, provider: "csv", external_account_id: `${ACCOUNT}-direct` });
      expect(insert.status, persona).not.toBe(201);
      expect(rowsOf(await api<unknown>(persona, "PATCH", `integrations?id=eq.${integration}`, { status: "disabled" })), persona).toEqual([]);
      const mapping = await api<unknown>(persona, "POST", "crm_field_mappings", { organization_id: ORG.alpha, integration_id: integration, internal_field: "name", external_field: "X", source_of_truth: "internal", direction: "both" });
      expect(mapping.status, persona).not.toBe(201);
    }
  });
});

describe("fonctions du worker : service_role seulement, entreprise du job, identité intacte", () => {
  it("anon et utilisateurs connectés ne peuvent pas les appeler", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["crm_sync_start", { p_org: ORG.alpha, p_integration: integration, p_batch: integration }],
      ["crm_sync_find", { p_org: ORG.alpha, p_provider: SOURCE, p_external_id: "x", p_email_normalized: null, p_phone_e164: null }],
      ["crm_sync_create", { p_org: ORG.alpha, p_provider: SOURCE, p_external_id: "x", p_name: "N", p_email_raw: `n@${ACCOUNT}.test`, p_email_normalized: `n@${ACCOUNT}.test`, p_phone_e164: null, p_language: null, p_country: null }],
      ["crm_sync_update", { p_org: ORG.alpha, p_contact: contact, p_provider: SOURCE, p_external_id: "x", p_fields: { name: "Piraté" } }],
      ["crm_sync_finish", { p_org: ORG.alpha, p_integration: integration, p_batch: integration, p_started_at: new Date().toISOString(), p_counts: { created: 1 } }],
      ["crm_sync_fail", { p_org: ORG.alpha, p_integration: integration, p_code: "failed" }],
    ];
    for (const [fn, args] of calls) {
      for (const persona of ["anon", "shared", "alphaAdmin", "betaOwner"] as const) {
        const result = await rpc(persona, fn, args);
        expect(result.status === 200 || result.status === 204, `${fn} / ${persona}`).toBe(false);
      }
    }
    expect(psql(`select count(*) from public.contacts where email_normalized = 'n@${ACCOUNT}.test'`)).toBe("0");
  });

  it("service_role : crée un contact, ne modifie jamais un contact « ne plus contacter », ne touche pas une autre entreprise", async () => {
    const created = await rpc("service", "crm_sync_create", {
      p_org: ORG.alpha, p_provider: SOURCE, p_external_id: `ext-${run}`, p_name: "Créé", p_email_raw: `new@${ACCOUNT}.test`, p_email_normalized: `new@${ACCOUNT}.test`,
      p_phone_e164: null, p_language: "fr", p_country: "MA",
    });
    expect(created.body).toMatchObject({ status: "created" });
    expect((await rpc("service", "crm_sync_create", { p_org: ORG.alpha, p_provider: SOURCE, p_external_id: `ext-${run}`, p_name: "Doublon", p_email_raw: `x@${ACCOUNT}.test`, p_email_normalized: `x@${ACCOUNT}.test`, p_phone_e164: null, p_language: null, p_country: null })).body).toEqual({ status: "exists" });
    expect((await rpc("service", "crm_sync_update", { p_org: ORG.alpha, p_contact: contact, p_provider: SOURCE, p_external_id: "z", p_fields: { name: "Piraté" } })).body).toEqual({ status: "do_not_contact" });
    expect((await rpc("service", "crm_sync_update", { p_org: ORG.beta, p_contact: contact, p_provider: SOURCE, p_external_id: "z", p_fields: { name: "Autre" } })).body).toEqual({ status: "not_found" });
    expect(message(await rpc("service", "crm_sync_update", { p_org: ORG.alpha, p_contact: contact, p_provider: SOURCE, p_external_id: "z", p_fields: { email_normalized: "a@b.c" } }))).toBe("validation_failed");
    expect(psql(`select name from public.contacts where id = '${contact}'`)).toBe(`Stop ${ACCOUNT}`);
    expect(psql(`select count(*) from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${ACCOUNT}.test')`)).toBe("0");
    expect((await rpc("service", "crm_sync_find", { p_org: ORG.beta, p_provider: SOURCE, p_external_id: `ext-${run}`, p_email_normalized: null, p_phone_e164: null })).body).toBeNull();
  });
});
