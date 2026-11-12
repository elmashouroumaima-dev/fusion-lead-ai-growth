import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, psql, rowsOf, select, type Persona } from "./harness";

/**
 * Webhooks par la Data API (J29, spec §8 et §11) : les fonctions de réception et de traitement sont réservées à service_role ; un
 * utilisateur connecté (même owner) et l'anonyme n'en exécutent aucune ; la table `webhook_events` ne livre que ses MÉTADONNÉES à
 * owner et admin (jamais le payload, jamais `select *`), rien aux autres rôles ni à l'autre entreprise ; aucune écriture directe,
 * même service_role. Le tenant vient du compte fournisseur de l'intégration. Ré-exécutable : données de l'exécution supprimées.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNT = `rlswh${run}`;
const CIPHERTEXT = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
const NONCE = "QUJDREVGR0hJSktM";
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'process_webhook' and organization_id in (select organization_id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.integrations where external_account_id like '${ACCOUNT}%';
  `);

let integration = "";
let event = "";

beforeAll(async () => {
  cleanup();
  const created = await rpc("shared", "create_provider_integration", {
    p_org: ORG.alpha, p_provider: "whatsapp", p_account: ACCOUNT, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1,
  });
  integration = String(created.body);
});
afterAll(cleanup);

describe("fonctions : service_role seulement", () => {
  it("résolution par le compte fournisseur : Alpha pour son compte, null pour un compte inconnu", async () => {
    const found = await rpc("service", "webhook_resolve_integration", { p_provider: "whatsapp", p_account: ACCOUNT });
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ organization_id: ORG.alpha, integration_id: integration });
    expect((await rpc("service", "webhook_resolve_integration", { p_provider: "whatsapp", p_account: `${ACCOUNT}-inconnu` })).body).toBeNull();
  });

  it("owner, admin, commercial, Beta, anonyme : aucune des cinq fonctions n'est exécutable", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["webhook_resolve_integration", { p_provider: "whatsapp", p_account: ACCOUNT }],
      ["webhook_record", { p_org: ORG.alpha, p_integration: integration, p_provider: "whatsapp", p_event_id: "x", p_payload: {} }],
      ["webhook_record_rejection", { p_org: ORG.alpha, p_integration: integration, p_provider: "whatsapp" }],
      ["webhook_start", { p_org: ORG.alpha, p_event: randomUUID() }],
      ["webhook_finish", { p_org: ORG.alpha, p_event: randomUUID(), p_status: "processed", p_failure: null }],
    ];
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "nobody", "anon"] as const) {
      for (const [fn, args] of calls) {
        const result = await rpc(persona, fn, args);
        expect([401, 403], `${persona} ${fn}`).toContain(result.status);
      }
    }
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}'`)).toBe("0");
  });
});

describe("événements : métadonnées seulement", () => {
  it("le service enregistre un événement (job en file) ; un rejeu ne crée ni ligne ni job", async () => {
    const first = await rpc("service", "webhook_record", { p_org: ORG.alpha, p_integration: integration, p_provider: "whatsapp", p_event_id: `wamid.${run}`, p_payload: { nom: "Nadia Benali" } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ duplicate: false });
    event = String((first.body as { event_id: string }).event_id);
    const replay = await rpc("service", "webhook_record", { p_org: ORG.alpha, p_integration: integration, p_provider: "whatsapp", p_event_id: `wamid.${run}`, p_payload: { nom: "autre" } });
    expect(replay.body).toEqual({ event_id: event, duplicate: true });
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}'`)).toBe("1");
    expect(psql(`select count(*) from public.jobs where kind = 'process_webhook' and payload ->> 'event_id' = '${event}'`)).toBe("1");
  });

  it("owner et admin lisent les métadonnées ; le payload et select * sont refusés ; marketing, commercial, analyste, Beta et anonyme ne voient rien", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const rows = rowsOf<{ id: string; status: string; signature_valid: boolean; provider: string }>(await select(persona, `webhook_events?id=eq.${event}&select=id,status,signature_valid,provider`));
      expect(rows, persona).toEqual([{ id: event, status: "received", signature_valid: true, provider: "whatsapp" }]);
      expect(isDenied(await select(persona, `webhook_events?id=eq.${event}&select=payload`)), `${persona} payload`).toBe(true);
      expect(isDenied(await select(persona, `webhook_events?id=eq.${event}`)), `${persona} select *`).toBe(true);
    }
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(rowsOf(await select(persona, `webhook_events?id=eq.${event}&select=id`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "webhook_events?select=id"))).toBe(true);
  });

  it("aucune écriture directe, même service_role ; le payload reste inaccessible", async () => {
    for (const persona of ["shared", "alphaAdmin", "service"] as const) {
      expect(rowsOf(await api<unknown>(persona, "PATCH", `webhook_events?id=eq.${event}`, { status: "processed" })), persona).toEqual([]);
      const insert = await api<unknown>(persona, "POST", "webhook_events", { organization_id: ORG.alpha, integration_id: integration, provider: "whatsapp", external_event_id: "direct", payload: {}, signature_valid: true });
      expect(insert.status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(psql(`select status from public.webhook_events where id = '${event}'`)).toBe("received");
  });
});

describe("traitement côté worker", () => {
  it("start rend le payload au service avec l'entreprise du job, jamais à une autre entreprise ; finish est définitif", async () => {
    const started = await rpc("service", "webhook_start", { p_org: ORG.alpha, p_event: event });
    expect(started.body).toMatchObject({ status: "running", provider: "whatsapp", integration_id: integration, payload: { nom: "Nadia Benali" } });
    expect((await rpc("service", "webhook_start", { p_org: ORG.beta, p_event: event })).body).toEqual({ status: "missing" });
    expect((await rpc("service", "webhook_finish", { p_org: ORG.alpha, p_event: event, p_status: "processed", p_failure: null })).status).toBe(204);
    expect((await rpc("service", "webhook_start", { p_org: ORG.alpha, p_event: event })).body).toEqual({ status: "done" });
    expect(rowsOf<{ status: string }>(await select("shared", `webhook_events?id=eq.${event}&select=status`))).toEqual([{ status: "processed" }]);
  });
});
