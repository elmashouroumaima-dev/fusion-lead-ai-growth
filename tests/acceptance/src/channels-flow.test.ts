import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { postJson, type Session, signIn } from "./app-client";

/**
 * Écran de canaux par HTTP, avec de vraies sessions : ajout d'un canal e-mail (`POST /api/channels`), pause (`POST /api/channels/update`).
 * Refus d'abord (rôles, clé d'idempotence, organization_id du client, autre entreprise), puis le cas nominal. Aucun appel vers Postmark :
 * un canal naît `pending` tant que la validation du fournisseur n'a pas eu lieu (l'activation est couverte par le test pgTAP 320).
 * Sans clé maître (SECRETS_MASTER_KEY), l'intégration ne peut pas être créée : seuls les refus sont vérifiés.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNT = `postmark-ch${run}.test`;
const SENDER = `ventes-${run}@ch${run}.test`;
const KEY_PREFIX = `acc-ch${run}`;
const MASTER = Boolean(process.env.SECRETS_MASTER_KEY);

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(who ? as(who) : null, path, payload, {
    activeOrg: opts.org ?? ORG.alpha,
    headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` },
  });

const cleanup = () => {
  psql(`
    set session_replication_role = replica;
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id = '${ACCOUNT}');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id = '${ACCOUNT}');
    delete from public.integrations where external_account_id = '${ACCOUNT}';
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-sales", "alpha-marketing", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
});
afterAll(cleanup);

describe("refus", () => {
  const body = { integration_id: randomUUID(), type: "email", sender_identity: SENDER };
  it("commercial, marketing, analyste : 403 ; anonyme : 401 ; sans clé d'idempotence, organization_id, expéditeur invalide ou champ inconnu : 400", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) {
      expect((await post(who, "/api/channels", body)).status, who).toBe(403);
      expect((await post(who, "/api/channels/update", { channel_id: randomUUID(), send_paused: true })).status, who).toBe(403);
    }
    expect((await post(null, "/api/channels", body)).status).toBe(401);
    expect((await post(null, "/api/channels/update", { channel_id: randomUUID(), send_paused: true })).status).toBe(401);
    expect((await post("shared", "/api/channels", body, { key: null })).status).toBe(400);
    expect((await post("shared", "/api/channels", { ...body, organization_id: ORG.beta })).status).toBe(400);
    expect((await post("shared", "/api/channels", { ...body, sender_identity: "pas-une-adresse" })).status).toBe(400);
    expect((await post("shared", "/api/channels", { ...body, type: "whatsapp" })).status).toBe(400);
    expect((await post("shared", "/api/channels", { ...body, extra: 1 })).status).toBe(400);
    expect((await post("shared", "/api/channels/update", { channel_id: randomUUID() })).status).toBe(400);
    expect((await post("shared", "/api/channels/update", { channel_id: randomUUID(), send_paused: true }, { key: null })).status).toBe(400);
  });

  it("une intégration ou un canal inexistant : 404", async () => {
    expect((await post("shared", "/api/channels", body)).status).toBe(404);
    expect((await post("shared", "/api/channels/update", { channel_id: randomUUID(), send_paused: true })).status).toBe(404);
  });
});

describe.skipIf(!MASTER)("cas nominal et isolation", () => {
  let integrationId = "";
  let channelId = "";

  it("owner : intégration e-mail puis canal : 201, le canal est « pending » (jamais actif sans validation du fournisseur)", async () => {
    const created = await post("shared", "/api/integrations", { provider: "email", external_account_id: ACCOUNT, scopes: [], secret: `pm-jeton-${run}-0123456789` });
    expect(created.status).toBe(201);
    integrationId = (created.json.integration as { id: string }).id;
    const channel = await post("shared", "/api/channels", { integration_id: integrationId, type: "email", sender_identity: SENDER });
    expect(channel.status).toBe(201);
    channelId = (channel.json.channel as { id: string }).id;
    expect(psql(`select status from public.channels where id = '${channelId}'`).trim()).toBe("pending");
  });

  it("même adresse : 409 ; un canal « whatsapp » sur une intégration e-mail : refusé", async () => {
    expect((await post("shared", "/api/channels", { integration_id: integrationId, type: "email", sender_identity: SENDER })).status).toBe(409);
    expect((await post("shared", "/api/channels", { integration_id: integrationId, type: "whatsapp", sender_identity: "+212600000001" })).status).toBeGreaterThanOrEqual(400);
  });

  it("isolation : Beta ne voit, n'ajoute ni ne met en pause rien chez Alpha (404)", async () => {
    expect((await post("beta-owner", "/api/channels", { integration_id: integrationId, type: "email", sender_identity: `autre-${run}@ch${run}.test` }, { org: ORG.beta })).status).toBe(404);
    expect((await post("beta-owner", "/api/channels/update", { channel_id: channelId, send_paused: true }, { org: ORG.beta })).status).toBe(404);
  });

  it("admin : pause puis reprise : 200 ; la pause ne change pas le statut « pending » ; rejouable avec la même clé", async () => {
    const key = `${KEY_PREFIX}-pause-${randomUUID()}`;
    const first = await post("alpha-admin", "/api/channels/update", { channel_id: channelId, send_paused: true }, { key });
    expect(first.status).toBe(200);
    expect(psql(`select send_paused::text || ':' || status from public.channels where id = '${channelId}'`).trim()).toBe("true:pending");
    expect((await post("alpha-admin", "/api/channels/update", { channel_id: channelId, send_paused: true }, { key })).status).toBe(200);
    expect((await post("alpha-admin", "/api/channels/update", { channel_id: channelId, send_paused: false })).status).toBe(200);
    expect(psql(`select send_paused::text from public.channels where id = '${channelId}'`).trim()).toBe("false");
  });

  it("audit : channel.created et channel.updated sans adresse ni jeton", async () => {
    const rows = psql(`select count(*) from public.audit_logs where action in ('channel.created','channel.updated') and (coalesce(before::text,'') || coalesce(after::text,'')) like '%${run}%'`).trim();
    expect(rows).toBe("0");
  });
});
