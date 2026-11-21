import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, postJson, signIn, type Session } from "./app-client";

/**
 * Passerelle WhatsApp Kapso (ADR 017) de bout en bout : la VRAIE route `/api/webhooks/kapso` (signature `X-Webhook-Signature` : HMAC-SHA256 hexadécimal sans préfixe
 * avec la `secret_key` enregistrée par l'API de l'application), les VRAIES fonctions SQL. Refus d'abord : signature fausse, absente ou au format de Meta, numéro inconnu
 * (même 401), intégration d'une autre passerelle, rôle sans droit, Kapso pour un e-mail ; puis événement signé accepté, rejeu sans second effet, aucun contenu brut conservé.
 * Aucun appel sortant vers Kapso (la vérification de connexion n'est pas lancée ici). Exige la clé maître (SECRETS_MASTER_KEY) : sans elle, le flux entier est ignoré.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stamp = String(Date.now()).slice(-9);
const PHONE = `6${stamp}01`;
const META_PHONE = `6${stamp}02`;
const KEY_PREFIX = `acckp${run}`;
const SECRET = `kapso-secret-${run}-0123456789abcdef0123456789`;
const API_KEY = `kapso-cle-${run}-0123456789`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const IP = "203.0.113.77";

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, org: string = ORG.alpha) =>
  postJson(who ? as(who) : null, path, payload, { activeOrg: org, headers: { "idempotency-key": `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` } });

const message = (phone: string, id: string, text = "Bonjour, ceci est un texte confidentiel") =>
  JSON.stringify({
    phone_number_id: phone,
    is_new_conversation: false,
    conversation: { id: "conv_1", contact_name: "Nom Prive", phone_number: "212600000001" },
    message: { id, timestamp: "1730092800", type: "text", from: "212600000001", text: { body: text }, kapso: { direction: "inbound", status: "received", media_url: "https://exemple.test/x.jpg" } },
  });
const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");
const hook = (path: string, raw: string, headers: Record<string, string>) =>
  fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP, ...headers }, body: raw });
const kapsoHook = (raw: string, signature: string | null) => hook("/api/webhooks/kapso", raw, signature ? { "x-webhook-signature": signature } : {});

let integration = "";
let metaIntegration = "";
const events = (id: string) => Number(psql(`select count(*) from public.webhook_events where integration_id = '${id}' and status <> 'rejected'`));
const rejections = (id: string) => Number(psql(`select count(*) from public.webhook_events where integration_id = '${id}' and status = 'rejected'`));

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like '6${stamp}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like '6${stamp}%')
      or id in (select webhook_secret_ref from public.integrations where external_account_id like '6${stamp}%');
    delete from public.integrations where external_account_id like '6${stamp}%';
    commit;
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-sales"]) sessions.set(name, await signIn(`${name}@seed.test`));
});
afterAll(cleanup);

describe("création : rôles et passerelle", () => {
  it("un commercial ne crée rien (403) ; une passerelle inconnue ou Kapso pour un e-mail : 400", async () => {
    expect((await post("alpha-sales", "/api/integrations", { provider: "whatsapp", gateway: "kapso", external_account_id: PHONE, scopes: [], secret: API_KEY })).status).toBe(403);
    expect((await post("shared", "/api/integrations", { provider: "whatsapp", gateway: "autre", external_account_id: PHONE, scopes: [], secret: API_KEY })).status).toBe(400);
    expect((await post("shared", "/api/integrations", { provider: "email", gateway: "kapso", external_account_id: `acckp${run}`, scopes: [], secret: API_KEY })).status).toBe(400);
    expect(psql(`select count(*) from public.integrations where external_account_id like '6${stamp}%'`)).toBe("0");
  });
});

describe.skipIf(!MASTER)("webhook Kapso", () => {
  beforeAll(async () => {
    // sans « gateway » : Kapso par défaut pour une intégration WhatsApp
    const created = await post("shared", "/api/integrations", { provider: "whatsapp", external_account_id: PHONE, scopes: [], secret: API_KEY });
    expect(created.status).toBe(201);
    integration = psql(`select id from public.integrations where external_account_id = '${PHONE}'`);
    expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET })).status).toBe(200);
    const meta = await post("shared", "/api/integrations", { provider: "whatsapp", gateway: "meta", external_account_id: META_PHONE, scopes: [], secret: API_KEY });
    expect(meta.status).toBe(201);
    metaIntegration = psql(`select id from public.integrations where external_account_id = '${META_PHONE}'`);
    expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: metaIntegration, secret: SECRET })).status).toBe(200);
  });

  it("passerelle par défaut : Kapso ; la liste la renvoie ; la clé d'API n'est jamais renvoyée", async () => {
    expect(psql(`select gateway from public.integrations where id = '${integration}'`)).toBe("kapso");
    expect(psql(`select gateway from public.integrations where id = '${metaIntegration}'`)).toBe("meta");
    const cookie = Object.entries({ ...as("shared").cookies, fl_active_org: ORG.alpha }).map(([k, v]) => `${k}=${v}`).join("; ");
    const list = await fetch(`${BASE_URL}/api/integrations`, { headers: { cookie } });
    const text = await list.text();
    expect(text).toContain('"gateway":"kapso"');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
  });

  it("signature fausse, absente, au format de Meta, secret d'une autre intégration : 401, rien d'enregistré, rejet tracé sans contenu", async () => {
    const raw = message(PHONE, `wamid.${run}.A`);
    const before = rejections(integration);
    expect((await kapsoHook(raw, "0".repeat(64))).status).toBe(401);
    expect((await kapsoHook(raw, null)).status).toBe(401);
    expect((await kapsoHook(raw, `sha256=${sign(raw)}`)).status).toBe(401);
    expect((await kapsoHook(raw, sign(raw, "autre-secret-0123456789abcdef0123456789"))).status).toBe(401);
    expect(events(integration)).toBe(0);
    expect(rejections(integration)).toBeGreaterThan(before);
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and status = 'rejected' and payload::text <> '{}' and payload::text <> 'null'`)).toBe("0");
  });

  it("numéro inconnu et numéro d'une intégration Meta : le MÊME 401 qu'une signature fausse (pas d'oracle)", async () => {
    const unknown = message(`6${stamp}99`, `wamid.${run}.B`);
    const toMeta = message(META_PHONE, `wamid.${run}.C`);
    const a = await kapsoHook(unknown, sign(unknown));
    const b = await kapsoHook(toMeta, sign(toMeta));
    const c = await kapsoHook(message(PHONE, `wamid.${run}.D`), "0".repeat(64));
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
    // même réponse hors identifiant de requête (propre à chaque appel)
    const shape = async (r: Response) => {
      const body = (await r.json()) as Record<string, unknown>;
      delete body.request_id;
      return body;
    };
    expect(await shape(a)).toEqual(await shape(c));
    expect(events(metaIntegration)).toBe(0);
  });

  it("une intégration Kapso n'accepte pas la route de Meta, même avec une signature valide au format de Meta", async () => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, messages: [] } }] }] });
    const response = await hook("/api/webhooks/whatsapp", raw, { "x-hub-signature-256": `sha256=${sign(raw)}` });
    expect(response.status).toBe(401);
    expect(events(integration)).toBe(0);
  });

  it("événement signé : 200 accepté ; rejeu du même corps : 200 doublon, un seul événement ; aucun contenu brut conservé", async () => {
    const raw = message(PHONE, `wamid.${run}.OK`);
    const first = await kapsoHook(raw, sign(raw));
    expect(first.status).toBe(200);
    // l'en-tête d'idempotence n'est pas signé : le changer ne contourne pas la déduplication
    const replay = await hook("/api/webhooks/kapso", raw, { "x-webhook-signature": sign(raw), "x-idempotency-key": randomUUID() });
    expect(replay.status).toBe(200);
    expect(events(integration)).toBe(1);
    expect(psql(`select provider from public.webhook_events where integration_id = '${integration}' and status <> 'rejected'`)).toBe("whatsapp");
    const stored = psql(`select payload::text from public.webhook_events where integration_id = '${integration}' and status <> 'rejected'`);
    for (const leak of ["Nom Prive", "exemple.test", "conv_1"]) expect(stored, leak).not.toContain(leak);
    expect(stored).toContain("+212600000001");
    // l'audit ne contient ni le numéro ni le texte
    expect(psql(`select count(*) from public.audit_logs where (coalesce(before::text,'') || coalesce(after::text,'')) like '%texte confidentiel%'`)).toBe("0");
  });

  it("préférence marketing (STOP annoncé par WhatsApp) : signée, acceptée, conservée sous forme réduite ; sans numéro de contact, acceptée et ignorée", async () => {
    const stop = JSON.stringify({
      phone_number_id: PHONE,
      contact: { phone_number: "212600000077" },
      marketing_preference: { status: "stopped", detail: "texte libre du contact", occurred_at: "2026-11-21T10:00:00Z", sequence: 3 },
    });
    expect((await kapsoHook(stop, sign(stop))).status).toBe(200);
    const stored = psql(`select payload::text from public.webhook_events where integration_id = '${integration}' and status <> 'rejected' and payload::text like '%marketing_preference%'`);
    expect(stored).toContain("+212600000077");
    expect(stored).toContain('"stopped"');
    expect(stored).not.toContain("texte libre");
    const noPhone = JSON.stringify({ phone_number_id: PHONE, marketing_preference: { status: "stopped", sequence: 4 } });
    expect((await kapsoHook(noPhone, sign(noPhone))).status).toBe(200);
  });

  it("corps illisible ou lot mêlant deux numéros : 400, rien d'enregistré", async () => {
    const before = events(integration);
    expect((await kapsoHook("pas du json", sign("pas du json"))).status).toBe(400);
    const mixed = JSON.stringify({ batch: true, data: [JSON.parse(message(PHONE, `wamid.${run}.M1`)), JSON.parse(message(META_PHONE, `wamid.${run}.M2`))] });
    expect((await kapsoHook(mixed, sign(mixed))).status).toBe(400);
    expect(events(integration)).toBe(before);
  });

  it("la route de poignée de main de Meta n'existe pas pour Kapso (GET : 404)", async () => {
    const response = await fetch(`${BASE_URL}/api/webhooks/kapso?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`, { headers: { "x-forwarded-for": IP } });
    expect(response.status).toBe(404);
  });
});
