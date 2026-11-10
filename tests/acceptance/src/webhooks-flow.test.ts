import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ingestWebhook,
  signHmacSha256Hex,
  verifyHmacSha256Hex,
  type WebhookAdapter,
  type WebhookHeaders,
  type WebhookOutcome,
  type WebhookStore,
} from "../../../packages/adapters/src/webhooks";
import { createProcessWebhookHandler } from "../../../apps/worker/src/handlers";
import type { WebhookGateway, WebhookProcessor, WebhookProcessorInput } from "../../../apps/worker/src/webhooks";
import { api, ORG, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL } from "./app-client";

/**
 * Pipeline webhook (J29, spec §8 et §11, menaces C1 à C5) : le VRAI pipeline `ingestWebhook` et le VRAI handler `process_webhook` du worker
 * sur les VRAIES fonctions SQL (service_role). Aucun adaptateur de production n'existe encore (e-mail J32, WhatsApp J34) : un adaptateur
 * de test (HMAC-SHA256 du corps brut, horodatage signé) est injecté ici seulement. Scénarios : événement valide (enregistré pour l'entreprise
 * du COMPTE, job en file), rejeu traité une seule fois, signature invalide ou trop ancienne (rejet tracé sans payload), compte inconnu
 * (ignoré, aucune trace), tenant forgé dans le payload, corps trop gros, traitement par le worker ; et côté HTTP : sans adaptateur, 404.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNT_A = `acc29a${run}`;
const ACCOUNT_B = `acc29b${run}`;
const SECRET_A = `secret-alpha-${run}`;
const SECRET_B = `secret-beta-${run}`;
const NOW = Math.floor(Date.now() / 1000);
const CIPHERTEXT = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
const NONCE = "QUJDREVGR0hJSktM";
const encoder = new TextEncoder();

type Body = { account?: string; event?: string; ts?: number; org?: string; note?: string; pad?: string };

const adapter: WebhookAdapter = {
  provider: "whatsapp",
  maxBytes: 1024,
  parse(raw) {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(raw));
      return typeof value === "object" && value !== null ? value : null;
    } catch {
      return null;
    }
  },
  extractAccount: (payload) => (payload as Body).account ?? null,
  extractEventId: (payload) => (payload as Body).event ?? null,
  extractTimestamp: (payload) => (payload as Body).ts ?? null,
  verify: ({ rawBody, headers, secret }) => verifyHmacSha256Hex({ secret, rawBody, signature: headers["x-signature"], prefix: "sha256=" }),
};

const rpc = <T = unknown>(fn: string, args: Record<string, unknown>) => api<T>("service", "POST", `rpc/${fn}`, args);
const store: WebhookStore = {
  async resolve(provider, account) {
    const result = await rpc<{ organization_id: string; integration_id: string } | null>("webhook_resolve_integration", { p_provider: provider, p_account: account });
    const row = result.body;
    return row ? { organizationId: row.organization_id, integrationId: row.integration_id } : null;
  },
  async record(input) {
    const result = await rpc<{ event_id: string; duplicate: boolean }>("webhook_record", {
      p_org: input.organizationId, p_integration: input.integrationId, p_provider: input.provider, p_event_id: input.externalEventId, p_payload: input.payload,
    });
    if (result.status !== 200) throw new Error(`webhook_record_${result.status}`);
    return { eventId: result.body.event_id, duplicate: result.body.duplicate };
  },
  async recordRejection(input) {
    await rpc("webhook_record_rejection", { p_org: input.organizationId, p_integration: input.integrationId, p_provider: input.provider });
  },
};

/** Passerelle du worker pour l'acceptation : fonctions SQL réelles (service_role). */
const gateway: WebhookGateway = {
  async start(org, event) {
    const result = await rpc<{ status: string; provider?: string; integration_id?: string; payload?: unknown }>("webhook_start", { p_org: org, p_event: event });
    const body = result.body;
    if (body.status !== "running") return { status: body.status as "missing" | "done" };
    return { status: "running", provider: String(body.provider), integrationId: String(body.integration_id), payload: body.payload };
  },
  async finish(org, event, status, failureCode) {
    const result = await rpc("webhook_finish", { p_org: org, p_event: event, p_status: status, p_failure: failureCode });
    if (result.status >= 300) throw new Error("webhook_finish_failed");
  },
};

let integrationA = "";
let integrationB = "";
const secretOf = async (organizationId: string): Promise<string | null> => (organizationId === ORG.alpha ? SECRET_A : organizationId === ORG.beta ? SECRET_B : null);

const send = async (body: Body | string, opts: { secret?: string; headers?: WebhookHeaders; now?: number } = {}): Promise<WebhookOutcome> => {
  const raw = encoder.encode(typeof body === "string" ? body : JSON.stringify(body));
  const headers: WebhookHeaders = opts.headers ?? { "x-signature": `sha256=${signHmacSha256Hex(opts.secret ?? SECRET_A, raw)}` };
  return ingestWebhook({ adapter, rawBody: raw, headers, store, readSecret: secretOf, now: () => opts.now ?? NOW });
};
const events = (where = "true") => Number(psql(`select count(*) from public.webhook_events where integration_id in ('${integrationA}', '${integrationB}') and ${where}`));
const jobsFor = (event: string) => Number(psql(`select count(*) from public.jobs where kind = 'process_webhook' and payload ->> 'event_id' = '${event}'`));

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'process_webhook' and payload ->> 'event_id' in (select id::text from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like 'acc29%${run}'));
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like 'acc29%${run}');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like 'acc29%${run}');
    delete from public.integrations where external_account_id like 'acc29%${run}';
  `);

beforeAll(async () => {
  cleanup();
  const create = async (persona: "shared" | "betaOwner", org: string, account: string) =>
    String((await api<string>(persona, "POST", "rpc/create_provider_integration", {
      p_org: org, p_provider: "whatsapp", p_account: account, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1,
    })).body);
  integrationA = await create("shared", ORG.alpha, ACCOUNT_A);
  integrationB = await create("betaOwner", ORG.beta, ACCOUNT_B);
});
afterAll(cleanup);

describe("événement valide et rejeu", () => {
  let eventId = "";

  it("accepté : enregistré pour l'entreprise du COMPTE (Alpha), payload conservé, un job process_webhook en file", async () => {
    const outcome = await send({ account: ACCOUNT_A, event: `wamid.${run}.1`, ts: NOW, note: "Bonjour" });
    expect(outcome.kind).toBe("accepted");
    eventId = (outcome as { eventId: string }).eventId;
    expect(psql(`select organization_id || ':' || status || ':' || signature_valid::text || ':' || (payload ->> 'note') from public.webhook_events where id = '${eventId}'`)).toBe(`${ORG.alpha}:received:true:Bonjour`);
    expect(jobsFor(eventId)).toBe(1);
    expect(psql(`select organization_id from public.jobs where kind = 'process_webhook' and payload ->> 'event_id' = '${eventId}'`)).toBe(ORG.alpha);
  });

  it("rejeu du même événement : « duplicate », une seule ligne, un seul job ; rejeu 5 fois en parallèle : toujours un seul", async () => {
    expect(await send({ account: ACCOUNT_A, event: `wamid.${run}.1`, ts: NOW })).toEqual({ kind: "duplicate", eventId });
    const parallel = await Promise.all(Array.from({ length: 5 }, () => send({ account: ACCOUNT_A, event: `wamid.${run}.1`, ts: NOW })));
    expect(parallel.every((o) => o.kind === "duplicate")).toBe(true);
    expect(events(`external_event_id = 'wamid.${run}.1'`)).toBe(1);
    expect(jobsFor(eventId)).toBe(1);
  });

  it("8 événements neufs simultanés avec le même identifiant : un seul enregistrement, un seul job", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => send({ account: ACCOUNT_A, event: `wamid.${run}.course`, ts: NOW })));
    expect(results.filter((o) => o.kind === "accepted")).toHaveLength(1);
    expect(results.filter((o) => o.kind === "duplicate")).toHaveLength(7);
    expect(events(`external_event_id = 'wamid.${run}.course'`)).toBe(1);
  });

  it("même identifiant d'événement chez Beta (son compte, son secret) : événement distinct", async () => {
    const outcome = await send({ account: ACCOUNT_B, event: `wamid.${run}.1`, ts: NOW }, { secret: SECRET_B });
    expect(outcome.kind).toBe("accepted");
    expect(events(`external_event_id = 'wamid.${run}.1'`)).toBe(2);
  });
});

describe("refus", () => {
  it("signature invalide (mauvais secret, en-tête absent, corps modifié) : refusée, rejets tracés SANS payload ni identifiant, aucun événement", async () => {
    const before = events("status <> 'rejected'");
    const body: Body = { account: ACCOUNT_A, event: `wamid.${run}.forge`, ts: NOW, note: "contenu-sensible" };
    expect(await send(body, { secret: "pas-le-bon-secret" })).toEqual({ kind: "invalid_signature" });
    expect(await send(body, { headers: {} })).toEqual({ kind: "invalid_signature" });
    const signedBody = encoder.encode(JSON.stringify(body));
    const tampered = await ingestWebhook({
      adapter, rawBody: encoder.encode(JSON.stringify({ ...body, event: "autre" })), headers: { "x-signature": `sha256=${signHmacSha256Hex(SECRET_A, signedBody)}` }, store, readSecret: secretOf, now: () => NOW,
    });
    expect(tampered).toEqual({ kind: "invalid_signature" });
    expect(events("status <> 'rejected'")).toBe(before);
    expect(events(`external_event_id = 'wamid.${run}.forge'`)).toBe(0);
    expect(events(`status = 'rejected' and integration_id = '${integrationA}'`)).toBe(3);
    expect(psql(`select count(*) from public.webhook_events where status = 'rejected' and integration_id = '${integrationA}' and (payload is not null or external_event_id is not null or signature_valid)`)).toBe("0");
    expect(psql(`select count(*) from public.webhook_events where to_jsonb(webhook_events)::text like '%contenu-sensible%' and status = 'rejected'`)).toBe("0");
  });

  it("horodatage trop ancien ou dans le futur : même refus (rejeu d'une capture ancienne)", async () => {
    expect(await send({ account: ACCOUNT_A, event: `wamid.${run}.vieux`, ts: NOW - 301 })).toEqual({ kind: "invalid_signature" });
    expect(await send({ account: ACCOUNT_A, event: `wamid.${run}.futur`, ts: NOW + 301 })).toEqual({ kind: "invalid_signature" });
    expect(events(`external_event_id in ('wamid.${run}.vieux', 'wamid.${run}.futur')`)).toBe(0);
    expect((await send({ account: ACCOUNT_A, event: `wamid.${run}.limite`, ts: NOW - 300 })).kind).toBe("accepted");
  });

  it("compte inconnu : le MÊME refus qu'une signature invalide (aucun oracle d'existence), et AUCUNE ligne (ni événement, ni rejet)", async () => {
    const before = Number(psql(`select count(*) from public.webhook_events`));
    const unknown = await send({ account: `${ACCOUNT_A}-inconnu`, event: "e", ts: NOW });
    const known = await send({ account: ACCOUNT_A, event: "e", ts: NOW }, { secret: "pas-le-bon-secret" });
    expect(unknown).toEqual({ kind: "invalid_signature" });
    expect(known).toEqual(unknown);
    // seul le compte CONNU laisse une trace de rejet (une ligne, sans payload) ; l'inconnu n'écrit rien
    expect(Number(psql(`select count(*) from public.webhook_events`))).toBe(before + 1);
  });

  it("corps trop gros : refusé avant toute écriture ; corps illisible, sans compte ou sans identifiant : requête invalide", async () => {
    const before = events();
    expect(await send({ account: ACCOUNT_A, event: `wamid.${run}.gros`, ts: NOW, pad: "x".repeat(2000) })).toEqual({ kind: "too_large" });
    expect((await send("pas du json")).kind).toBe("bad_request");
    expect((await send({ event: "e", ts: NOW })).kind).toBe("bad_request");
    expect((await send({ account: ACCOUNT_A, ts: NOW })).kind).toBe("bad_request");
    expect(events()).toBe(before);
  });

  it("identifiant d'événement mal formé (signature valide) : refusé par la base (400), rien d'enregistré", async () => {
    await expect(send({ account: ACCOUNT_A, event: "avec des espaces", ts: NOW })).rejects.toThrow("webhook_record_400");
    expect(events(`external_event_id = 'avec des espaces'`)).toBe(0);
  });
});

describe("l'entreprise vient du COMPTE, jamais du payload", () => {
  it("un champ libre qui désigne Beta ne détourne pas l'événement : il reste à Alpha", async () => {
    const outcome = await send({ account: ACCOUNT_A, event: `wamid.${run}.forge-org`, ts: NOW, org: ORG.beta });
    expect(outcome.kind).toBe("accepted");
    expect(psql(`select organization_id from public.webhook_events where external_event_id = 'wamid.${run}.forge-org'`)).toBe(ORG.alpha);
    expect(events(`external_event_id = 'wamid.${run}.forge-org' and integration_id = '${integrationB}'`)).toBe(0);
  });

  it("signé avec le secret d'Alpha mais visant le compte de Beta : vérifié avec le secret de BETA, donc refusé ; la trace est chez Beta, pas d'événement", async () => {
    const before = events(`integration_id = '${integrationB}' and status = 'rejected'`);
    expect(await send({ account: ACCOUNT_B, event: `wamid.${run}.croise`, ts: NOW }, { secret: SECRET_A })).toEqual({ kind: "invalid_signature" });
    expect(events(`integration_id = '${integrationB}' and status = 'rejected'`)).toBe(before + 1);
    expect(events(`external_event_id = 'wamid.${run}.croise'`)).toBe(0);
  });
});

describe("traitement différé par le worker", () => {
  const handlerFor = (processors: Map<string, WebhookProcessor>) => createProcessWebhookHandler(gateway, processors);
  const job = (organizationId: string, eventId: string, attempt = 1) => ({
    ctx: { jobId: randomUUID(), organizationId, idempotencyKey: `process_webhook:${eventId}`, attempt, maxAttempts: 5, signal: new AbortController().signal },
    payload: { event_id: eventId },
  });
  const calls: WebhookProcessorInput[] = [];
  const processor: WebhookProcessor = {
    provider: "whatsapp",
    async process(input) {
      calls.push(input);
      return "processed";
    },
  };

  it("sans processeur (e-mail et WhatsApp arrivent aux J32 et J35) : « failed » avec le code no_processor (re-jouable), payload conservé", async () => {
    const eventId = psql(`select id from public.webhook_events where external_event_id = 'wamid.${run}.limite'`);
    const { ctx, payload } = job(ORG.alpha, eventId);
    await handlerFor(new Map()).run(ctx, payload);
    expect(psql(`select status || ':' || failure_code || ':' || (payload is not null)::text from public.webhook_events where id = '${eventId}'`)).toBe("failed:no_processor:true");
  });

  it("avec un processeur : « processed » avec l'entreprise de la LIGNE du job ; rejeu du job : pas de second traitement", async () => {
    const eventId = psql(`select id from public.webhook_events where external_event_id = 'wamid.${run}.1' and organization_id = '${ORG.alpha}'`);
    const handler = handlerFor(new Map([["whatsapp", processor]]));
    const first = job(ORG.alpha, eventId);
    await handler.run(first.ctx, first.payload);
    const replay = job(ORG.alpha, eventId, 2);
    await handler.run(replay.ctx, replay.payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ organizationId: ORG.alpha, eventId, integrationId: integrationA });
    expect(psql(`select status || ':' || (processed_at is not null)::text from public.webhook_events where id = '${eventId}'`)).toBe("processed:true");
  });

  it("le job de l'entreprise B ne traite pas l'événement d'Alpha (il reste « received »)", async () => {
    const eventId = psql(`select id from public.webhook_events where external_event_id = 'wamid.${run}.forge-org'`);
    const wrong = job(ORG.beta, eventId);
    await handlerFor(new Map([["whatsapp", processor]])).run(wrong.ctx, wrong.payload);
    expect(psql(`select status from public.webhook_events where id = '${eventId}'`)).toBe("received");
    expect(calls).toHaveLength(1);
  });
});

describe("route HTTP /api/webhooks/[provider]", () => {
  it("sans adaptateur enregistré en production (avant J32 et J34), tout fournisseur répond 404, corps lu ou non", async () => {
    for (const provider of ["whatsapp", "email", "salla", "inconnu", "..%2Fetc"]) {
      const response = await fetch(`${BASE_URL}/api/webhooks/${provider}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: ACCOUNT_A, event: "x" }) });
      expect(response.status, provider).toBe(404);
      const body = (await response.json()) as { code?: string };
      expect(body.code, provider).toBe("not_found");
    }
    expect(events(`external_event_id = 'x'`)).toBe(0);
  });

  it("la méthode GET n'est pas acceptée", async () => {
    const response = await fetch(`${BASE_URL}/api/webhooks/whatsapp`);
    expect(response.status).toBe(405);
  });
});
