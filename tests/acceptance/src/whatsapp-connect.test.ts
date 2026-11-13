import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, postJson, signIn, type Session } from "./app-client";

/**
 * Connexion WhatsApp (J34, spec §9.3 et §11) de bout en bout : la VRAIE route `/api/webhooks/whatsapp` (signature `X-Hub-Signature-256` avec le secret
 * de l'app enregistré par l'API de l'application), les VRAIES fonctions SQL. Scénarios : le secret de l'app (rôles, jamais renvoyé), événement signé
 * accepté puis rejeu sans second effet, signature fausse ou absente, numéro inconnu (même 401 qu'une signature fausse), requête qui mélange deux
 * numéros, corps illisible ; la route de vérification de connexion (rôles, autre entreprise, autre fournisseur : aucun appel à Meta ici).
 * Exige la clé maître (SECRETS_MASTER_KEY, la même que celle de l'application) : sans elle, le flux entier est ignoré.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stamp = String(Date.now()).slice(-9);
const PHONE = `7${stamp}01`;
const OTHER_PHONE = `7${stamp}02`;
const KEY_PREFIX = `acc34${run}`;
const APP_SECRET = `app-secret-${run}-0123456789abcdef0123`;
const TOKEN = `EAAG-jeton-${run}-0123456789`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const IP = "203.0.113.34";

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, org: string = ORG.alpha) =>
  postJson(who ? as(who) : null, path, payload, { activeOrg: org, headers: { "idempotency-key": `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` } });

const body = (phone: string, id: string) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: phone }, messages: [{ from: "212600000000", id, timestamp: "1700000000", text: { body: `SECRET-${run}` }, type: "text" }] } }] }],
});
const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const hook = (raw: string, signature: string | null) =>
  fetch(`${BASE_URL}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": IP, ...(signature ? { "x-hub-signature-256": signature } : {}) },
    body: raw,
  });

let integration = "";
let emailIntegration = "";
// événements ACCEPTÉS (les refus de signature sont tracés à part, sans contenu : statut « rejected », payload vide)
const events = () => Number(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and status <> 'rejected'`));
const rejections = () => Number(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and status = 'rejected'`));

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like '7${stamp}%' or external_account_id like 'acc34${run}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like '7${stamp}%' or external_account_id like 'acc34${run}%')
      or id in (select webhook_secret_ref from public.integrations where external_account_id like '7${stamp}%' or external_account_id like 'acc34${run}%');
    delete from public.integrations where external_account_id like '7${stamp}%' or external_account_id like 'acc34${run}%';
    commit;
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  if (!MASTER) return;
  const created = await post("shared", "/api/integrations", { provider: "whatsapp", external_account_id: PHONE, scopes: [], secret: TOKEN });
  expect(created.status).toBe(201);
  integration = psql(`select id from public.integrations where external_account_id = '${PHONE}'`);
  const email = await post("shared", "/api/integrations", { provider: "email", external_account_id: `acc34${run}`, scopes: [], secret: `jeton-envoi-${run}-0123456789` });
  expect(email.status).toBe(201);
  emailIntegration = psql(`select id from public.integrations where external_account_id = 'acc34${run}'`);
});
afterAll(cleanup);

describe.skipIf(!MASTER)("secret de l'app WhatsApp", () => {
  it("commercial : 403 ; anonyme : 401 ; trop court : 400 ; l'owner l'enregistre : 200, jamais renvoyé", async () => {
    expect((await post("alpha-sales", "/api/integrations/webhook-secret", { integration_id: integration, secret: APP_SECRET })).status).toBe(403);
    expect((await post(null, "/api/integrations/webhook-secret", { integration_id: integration, secret: APP_SECRET })).status).toBe(401);
    expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: "court" })).status).toBe(400);
    const ok = await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: APP_SECRET });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.json)).not.toContain(APP_SECRET);
    expect(psql(`select has_webhook_secret from public.integrations where id = '${integration}'`)).toBe("t");
  });
});

describe.skipIf(!MASTER)("webhook WhatsApp signé", () => {
  it("événement signé : 200 accepté, enregistré pour la bonne intégration ; rejeu du même corps : 200 doublon, un seul événement", async () => {
    const raw = JSON.stringify(body(PHONE, `wamid.${run}A`));
    const first = await hook(raw, sign(raw));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(events()).toBe(1);
    const again = await hook(raw, sign(raw));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(events()).toBe(1);
    expect(psql(`select organization_id from public.webhook_events where integration_id = '${integration}' limit 1`)).toBe(ORG.alpha);
  });

  it("signature fausse, secret d'une autre app, signature absente, préfixe manquant : 401, rien n'est enregistré", async () => {
    const before = events();
    const raw = JSON.stringify(body(PHONE, `wamid.${run}B`));
    for (const signature of [sign(raw, "un-autre-secret-0123456789abcdef0123456789"), `sha256=${"0".repeat(64)}`, null, createHmac("sha256", APP_SECRET).update(raw).digest("hex")]) {
      expect((await hook(raw, signature)).status).toBe(401);
    }
    // corps modifié après la signature
    expect((await hook(raw.replace("wamid", "wamix"), sign(raw))).status).toBe(401);
    expect(events()).toBe(before);
    // chaque refus est tracé SANS contenu (ni corps, ni identifiant d'événement)
    expect(rejections()).toBe(5);
    expect(Number(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and status = 'rejected' and (payload is not null or external_event_id is not null)`))).toBe(0);
  });

  it("numéro inconnu : le MÊME 401 qu'une signature fausse (pas d'oracle sur les comptes)", async () => {
    const raw = JSON.stringify(body(OTHER_PHONE, `wamid.${run}C`));
    const unknown = await hook(raw, sign(raw));
    expect(unknown.status).toBe(401);
    const wrong = await hook(JSON.stringify(body(PHONE, `wamid.${run}D`)), `sha256=${"1".repeat(64)}`);
    expect(wrong.status).toBe(401);
    const a = (await unknown.json()) as { code: string; message: string };
    const b = (await wrong.json()) as { code: string; message: string };
    expect({ code: a.code, message: a.message }).toEqual({ code: b.code, message: b.message });
  });

  it("deux numéros dans une même requête, corps illisible ou objet inattendu : 400 (signés ou non), rien n'est enregistré", async () => {
    const before = events();
    const mixed = JSON.stringify({ object: "whatsapp_business_account", entry: [body(PHONE, "wamid.x").entry[0], body(OTHER_PHONE, "wamid.y").entry[0]] });
    expect((await hook(mixed, sign(mixed))).status).toBe(400);
    expect((await hook("pas du json", sign("pas du json"))).status).toBe(400);
    const other = JSON.stringify({ object: "page", entry: [] });
    expect((await hook(other, sign(other))).status).toBe(400);
    expect(events()).toBe(before);
  });

  it("le contenu du message n'apparaît dans aucun journal d'audit ni dans la réponse", async () => {
    expect(Number(psql(`select count(*) from public.audit_logs where (before::text || after::text) like '%SECRET-${run}%'`))).toBe(0);
  });
});

describe.skipIf(!MASTER)("vérification de la connexion (sans appel à Meta)", () => {
  it("commercial, marketing, analyste : 403 ; anonyme : 401 ; sans clé d'idempotence ou organization_id : 400", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) expect((await post(who, "/api/integrations/validate", { integration_id: integration })).status, who).toBe(403);
    expect((await post(null, "/api/integrations/validate", { integration_id: integration })).status).toBe(401);
    expect((await post("shared", "/api/integrations/validate", { integration_id: integration, organization_id: ORG.beta })).status).toBe(400);
    expect((await postJson(as("shared"), "/api/integrations/validate", { integration_id: integration }, { activeOrg: ORG.alpha })).status).toBe(400);
  });

  it("l'owner d'une autre entreprise ne peut pas viser cette intégration : 404, aucun appel à Meta", async () => {
    expect((await post("beta-owner", "/api/integrations/validate", { integration_id: integration }, ORG.beta)).status).toBe(404);
    expect(psql(`select status from public.integrations where id = '${integration}'`)).toBe("pending");
  });

  it("intégration e-mail : 400 (seul WhatsApp est vérifiable), statut inchangé ; un utilisateur ne peut pas se déclarer « actif » par la fonction SQL", async () => {
    expect((await post("shared", "/api/integrations/validate", { integration_id: emailIntegration })).status).toBe(400);
    expect(psql(`select status from public.integrations where id = '${emailIntegration}'`)).toBe("pending");
    const denied = await api("alphaAdmin", "POST", "rpc/integration_set_validation", { p_org: ORG.alpha, p_integration: integration, p_ok: true, p_code: null, p_actor: ORG.alpha });
    expect([401, 403]).toContain(denied.status);
    expect(psql(`select status from public.integrations where id = '${integration}'`)).toBe("pending");
  });
});
