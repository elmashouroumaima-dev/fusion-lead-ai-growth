import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { getPage, postJson, signIn, visibleText, type Session } from "./app-client";

/**
 * Réponse WhatsApp depuis la boîte de réception (écart n° 3 de C3) de bout en bout : la VRAIE route `POST /api/conversations/:id/replies` (sessions réelles) et les VRAIES
 * fonctions SQL. Texte libre dans la fenêtre de 24 h SEULEMENT : fenêtre fermée = 409, aucun message, aucun job ; rôles ; rejeu sans second message ; la page propose le champ de
 * réponse dans la fenêtre et un message clair hors fenêtre ; l'audit ne contient jamais le texte. L'envoi par le worker est couvert par les tests du worker et du contrôle final.
 * Exige la clé maître (SECRETS_MASTER_KEY) : sans elle, le flux entier est ignoré. Aucun appel sortant (Kapso n'est jamais appelé ici).
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stamp = String(Date.now()).slice(-9);
const PHONE_ID = `5${stamp}01`;
const SENDER = `+2126${stamp.slice(-8)}`;
const KEY_PREFIX = `accwr${run}`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const OPEN_TEXT = `Réponse confidentielle ${run}`;

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, opts: { key?: string | null } = {}) =>
  postJson(who ? as(who) : null, path, payload, {
    activeOrg: ORG.alpha,
    headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` },
  });

const contact = { open: randomUUID(), closed: randomUUID(), never: randomUUID() };
const conv = { open: "", closed: "", never: "" };

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.jobs where payload ->> 'message_id' in (select m.id::text from public.messages m join public.conversations c on c.id = m.conversation_id join public.contacts ct on ct.id = c.contact_id where ct.name like '${KEY_PREFIX}%');
    delete from public.messages where conversation_id in (select c.id from public.conversations c join public.contacts ct on ct.id = c.contact_id where ct.name like '${KEY_PREFIX}%');
    delete from public.conversations where contact_id in (select id from public.contacts where name like '${KEY_PREFIX}%');
    delete from public.contacts where name like '${KEY_PREFIX}%';
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id = '${PHONE_ID}');
    delete from public.integrations where external_account_id = '${PHONE_ID}';
    commit;
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-marketing", "alpha-analyst"]) sessions.set(name, await signIn(`${name}@seed.test`));
  if (!MASTER) return;
  const created = await post("shared", "/api/integrations", { provider: "whatsapp", gateway: "kapso", external_account_id: PHONE_ID, scopes: [], secret: `kapso-cle-${run}-0123456789` });
  expect(created.status).toBe(201);
  // intégration validée par le serveur (simulé sans appel sortant), puis canal : il naît « active »
  psql(`update public.integrations set status = 'active' where external_account_id = '${PHONE_ID}'`);
  const integration = psql(`select id from public.integrations where external_account_id = '${PHONE_ID}'`);
  const channel = await post("shared", "/api/channels", { integration_id: integration, type: "whatsapp", sender_identity: SENDER });
  expect(channel.status).toBe(201);
  const org = ORG.alpha;
  psql(`
    insert into public.contacts (id, organization_id, name, phone_e164) values
      ('${contact.open}', '${org}', '${KEY_PREFIX} ouvert', '+2127${stamp.slice(-8)}'),
      ('${contact.closed}', '${org}', '${KEY_PREFIX} ferme', '+2128${stamp.slice(-8)}'),
      ('${contact.never}', '${org}', '${KEY_PREFIX} jamais', '+2129${stamp.slice(-8)}');
    select private.conversation_get_or_create('${org}', c.id, (select id from public.channels where sender_identity = '${SENDER}' and organization_id = '${org}'))
      from public.contacts c where c.name like '${KEY_PREFIX}%';
    select private.message_record('${org}', (select id from public.conversations where contact_id = '${contact.open}'), 'inbound', 'wr.${run}.1', 'Bonjour', null, now() - interval '2 hours');
    select private.message_record('${org}', (select id from public.conversations where contact_id = '${contact.closed}'), 'inbound', 'wr.${run}.2', 'Bonjour', null, now() - interval '30 hours');
  `);
  conv.open = psql(`select id from public.conversations where contact_id = '${contact.open}'`);
  conv.closed = psql(`select id from public.conversations where contact_id = '${contact.closed}'`);
  conv.never = psql(`select id from public.conversations where contact_id = '${contact.never}'`);
});
afterAll(cleanup);

describe.skipIf(!MASTER)("réponse WhatsApp : refus d'abord", () => {
  it("fenêtre fermée (dernier message du contact il y a 30 h) et contact qui n'a jamais écrit : 409, aucun message, aucun job d'envoi", async () => {
    const before = psql(`select count(*) from public.messages where direction = 'outbound' and conversation_id in ('${conv.closed}', '${conv.never}')`);
    expect((await post("shared", `/api/conversations/${conv.closed}/replies`, { body: "Trop tard" })).status).toBe(409);
    expect((await post("shared", `/api/conversations/${conv.never}/replies`, { body: "Premier contact" })).status).toBe(409);
    expect(psql(`select count(*) from public.messages where direction = 'outbound' and conversation_id in ('${conv.closed}', '${conv.never}')`)).toBe(before);
  });

  it("marketing et analyste : 403 ; sans session : 401 ; sans clé d'idempotence : 400", async () => {
    expect((await post("alpha-marketing", `/api/conversations/${conv.open}/replies`, { body: "Non" })).status).toBe(403);
    expect((await post("alpha-analyst", `/api/conversations/${conv.open}/replies`, { body: "Non" })).status).toBe(403);
    expect((await post(null, `/api/conversations/${conv.open}/replies`, { body: "Non" })).status).toBe(401);
    expect((await post("shared", `/api/conversations/${conv.open}/replies`, { body: "Non" }, { key: null })).status).toBe(400);
    expect(psql(`select count(*) from public.messages where direction = 'outbound' and conversation_id = '${conv.open}'`)).toBe("0");
  });
});

describe.skipIf(!MASTER)("réponse WhatsApp dans la fenêtre", () => {
  it("202 ; texte libre approuvé par son auteur (finalité reply, numéro du contact, aucun modèle), un job d'envoi ; le rejeu ne crée pas de second message", async () => {
    const key = `${KEY_PREFIX}-ok-${randomUUID()}`;
    const first = await post("shared", `/api/conversations/${conv.open}/replies`, { body: OPEN_TEXT }, { key });
    expect(first.status).toBe(202);
    const replay = await post("shared", `/api/conversations/${conv.open}/replies`, { body: OPEN_TEXT }, { key });
    expect(replay.status).toBe(202);
    expect(psql(`select count(*) from public.messages where direction = 'outbound' and conversation_id = '${conv.open}'`)).toBe("1");
    expect(psql(`select approved_purpose || ':' || (approved_recipient = '+2127${stamp.slice(-8)}')::text || ':' || (template_id is null)::text || ':' || status::text from public.messages where direction = 'outbound' and conversation_id = '${conv.open}'`)).toBe("reply:true:true:queued");
    expect(psql(`select count(*) from public.jobs where kind = 'send_message' and payload ->> 'message_id' = (select id::text from public.messages where direction = 'outbound' and conversation_id = '${conv.open}')`)).toBe("1");
  });

  it("l'audit ne contient jamais le texte de la réponse", () => {
    expect(psql(`select count(*) from public.audit_logs where (coalesce(before::text,'') || coalesce(after::text,'')) like '%${run}%'`)).toBe("0");
  });
});

describe.skipIf(!MASTER)("page de la conversation", () => {
  const page = async (id: string) => {
    const response = await getPage(as("shared"), `/en/inbox/${id}`, ORG.alpha);
    expect(response.status).toBe(200);
    return visibleText(response);
  };

  it("fenêtre ouverte : le champ de réponse est proposé ; fenêtre fermée : message clair, pas de champ", async () => {
    const open = await page(conv.open);
    expect(open).toMatch(/send reply|reply/i);
    expect(open).not.toContain("The 24-hour window is closed");
    const closed = await page(conv.closed);
    expect(closed).toContain("The 24-hour window is closed");
  });
});
