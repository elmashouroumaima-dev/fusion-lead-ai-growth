import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, psql, rowsOf, select, USER, type Persona } from "./harness";

/**
 * Conversations et messages par la Data API (J30, spec §7 et §9.3, ADR 014) : un fil par contact et canal, cohérence d'entreprise,
 * déduplication d'un message entrant rejoué (même 8 envois simultanés), idempotence d'un envoi, lecture par rôle (owner et admin tout, le
 * commercial SES conversations et leurs messages, marketing, analyste, autre entreprise et anonyme rien), assignation et état par rôle,
 * aucune écriture directe même pour service_role, fonctions de réception réservées à service_role. Ré-exécutable : données supprimées.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CIPHERTEXT = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
const NONCE = "QUJDREVGR0hJSktM";
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@cv${run}.test'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@cv${run}.test');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like 'rlscv${run}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like 'rlscv${run}%');
    delete from public.integrations where external_account_id like 'rlscv${run}%';
    delete from public.contacts where email_normalized like '%@cv${run}.test';
  `);

let channelA = "";
let channelB = "";
let contactA1 = "";
let contactA2 = "";
let contactB1 = "";
let convA1 = "";
let convA2 = "";
let convB1 = "";

beforeAll(async () => {
  cleanup();
  const integration = async (persona: Persona, org: string, provider: string, account: string): Promise<string> =>
    String((await rpc(persona, "create_provider_integration", { p_org: org, p_provider: provider, p_account: account, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1 })).body);
  const intA = await integration("shared", ORG.alpha, "email", `rlscv${run}a`);
  const intB = await integration("betaOwner", ORG.beta, "whatsapp", `rlscv${run}b`);
  channelA = String((await rpc("shared", "create_channel", { p_org: ORG.alpha, p_integration: intA, p_type: "email", p_sender: `ventes@cv${run}.test`, p_scope: [] })).body);
  channelB = String((await rpc("betaOwner", "create_channel", { p_org: ORG.beta, p_integration: intB, p_type: "whatsapp", p_sender: `+2126${run.replace(/\D/g, "").padEnd(8, "1").slice(0, 8)}`, p_scope: [] })).body);
  psql(`
    insert into public.contacts (organization_id, name, email_raw, email_normalized) values
      ('${ORG.alpha}', 'CV A1 ${run}', 'a1@cv${run}.test', 'a1@cv${run}.test'),
      ('${ORG.alpha}', 'CV A2 ${run}', 'a2@cv${run}.test', 'a2@cv${run}.test'),
      ('${ORG.beta}', 'CV B1 ${run}', 'b1@cv${run}.test', 'b1@cv${run}.test');
  `);
  const contact = (org: string, n: string) => psql(`select id from public.contacts where organization_id = '${org}' and email_normalized = '${n}@cv${run}.test'`);
  contactA1 = contact(ORG.alpha, "a1");
  contactA2 = contact(ORG.alpha, "a2");
  contactB1 = contact(ORG.beta, "b1");
});
afterAll(cleanup);

describe("ouverture d'un fil : service_role seulement, idempotente, cohérente", () => {
  it("le service ouvre le fil (en file de tri) ; un second appel rend le même fil ; 8 appels simultanés : un seul fil", async () => {
    const first = await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contactA1, p_channel: channelA });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: true });
    convA1 = String((first.body as { id: string }).id);
    const parallel = await Promise.all(Array.from({ length: 8 }, () => rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contactA2, p_channel: channelA })));
    const ids = new Set(parallel.map((r) => String((r.body as { id: string }).id)));
    expect(ids.size).toBe(1);
    expect(parallel.filter((r) => (r.body as { created: boolean }).created)).toHaveLength(1);
    convA2 = [...ids][0] ?? "";
    expect(psql(`select state || ':' || coalesce(assignee_id::text, 'null') from public.conversations where id = '${convA1}'`)).toBe("to_triage:null");
    const beta = await rpc("service", "conversation_get_or_create", { p_org: ORG.beta, p_contact: contactB1, p_channel: channelB });
    convB1 = String((beta.body as { id: string }).id);
  });

  it("contact ou canal d'une autre entreprise : introuvable ; owner, admin, commercial, Beta et anonyme : fonction interdite", async () => {
    expect(message(await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contactB1, p_channel: channelA }))).toBe("not_found");
    expect(message(await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contactA1, p_channel: channelB }))).toBe("not_found");
    expect(message(await rpc("service", "conversation_get_or_create", { p_org: ORG.beta, p_contact: contactA1, p_channel: channelB }))).toBe("not_found");
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "nobody", "anon"] as const) {
      const denied = await rpc(persona, "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contactA1, p_channel: channelA });
      expect([401, 403], persona).toContain(denied.status);
    }
  });
});

describe("messages : entrant dédupliqué, sortant idempotent", () => {
  it("8 envois simultanés du MÊME message entrant : un seul message", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: `wamid.${run}.1`, p_body: "Bonjour, je veux un devis", p_idempotency_key: null, p_event_at: null })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => (r.body as { duplicate: boolean }).duplicate === false)).toHaveLength(1);
    expect(new Set(results.map((r) => String((r.body as { message_id: string }).message_id))).size).toBe(1);
    expect(psql(`select count(*) from public.messages where conversation_id = '${convA1}' and provider_message_id = 'wamid.${run}.1'`)).toBe("1");
  });

  it("envoi sortant : 8 mises en file simultanées avec la même clé d'idempotence : un seul message « queued »", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "outbound", p_provider_message_id: null, p_body: "Voici le devis", p_idempotency_key: `envoi-${run}-1`, p_event_at: null })),
    );
    expect(results.filter((r) => (r.body as { duplicate: boolean }).duplicate === false)).toHaveLength(1);
    expect(psql(`select status || ':' || count(*) from public.messages where idempotency_key = 'envoi-${run}-1' group by status`)).toBe("queued:1");
  });

  it("un rejeu qui CONTREDIT le premier message (autre conversation ou autre corps) est un conflit, jamais un duplicate silencieux ; aucun corps dans l'erreur", async () => {
    const reuse = await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA2, p_direction: "outbound", p_provider_message_id: null, p_body: "Voici le devis", p_idempotency_key: `envoi-${run}-1`, p_event_at: null });
    expect(message(reuse)).toBe("idempotency_conflict");
    const other = await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: `wamid.${run}.1`, p_body: "SECRET-CORPS-DIFFERENT", p_idempotency_key: null, p_event_at: null });
    expect(message(other)).toBe("idempotency_conflict");
    expect(JSON.stringify(other.body)).not.toContain("SECRET-CORPS");
    const tooLong = await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: `wamid.${run}.long`, p_body: `SECRET-CORPS-${"x".repeat(100001)}`, p_idempotency_key: null, p_event_at: null });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.body)).not.toContain("SECRET-CORPS");
    expect(psql(`select count(*) from public.messages where provider_message_id = 'wamid.${run}.1' or idempotency_key = 'envoi-${run}-1'`)).toBe("2");
  });

  it("un message entrant d'un autre fil d'une autre entreprise : introuvable ; paramètres invalides refusés ; rien d'enregistré", async () => {
    const before = psql(`select count(*) from public.messages where conversation_id in ('${convA1}', '${convA2}', '${convB1}')`);
    expect(message(await rpc("service", "message_record", { p_org: ORG.beta, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: `wamid.${run}.x`, p_body: "x", p_idempotency_key: null, p_event_at: null }))).toBe("not_found");
    expect((await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: null, p_body: "x", p_idempotency_key: null, p_event_at: null })).status).toBe(400);
    expect((await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "outbound", p_provider_message_id: null, p_body: "x", p_idempotency_key: null, p_event_at: null })).status).toBe(400);
    expect((await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: `wamid.${run}.vide`, p_body: "", p_idempotency_key: null, p_event_at: null })).status).toBe(400);
    expect(psql(`select count(*) from public.messages where conversation_id in ('${convA1}', '${convA2}', '${convB1}')`)).toBe(before);
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "anon"] as const) {
      const denied = await rpc(persona, "message_record", { p_org: ORG.alpha, p_conversation: convA1, p_direction: "inbound", p_provider_message_id: `wamid.${run}.y`, p_body: "x", p_idempotency_key: null, p_event_at: null });
      expect([401, 403], persona).toContain(denied.status);
    }
  });
});

describe("assignation et état par rôle", () => {
  it("marketing, commercial, analyste, Beta et sans adhésion n'assignent pas ; owner et admin assignent à un commercial ; un marketing n'est pas assignable", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(message(await rpc(persona, "assign_conversation", { p_org: ORG.alpha, p_id: convA1, p_assignee: USER.alphaSales })), persona).toBe("forbidden");
    }
    expect(message(await rpc("shared", "assign_conversation", { p_org: ORG.alpha, p_id: convA1, p_assignee: USER.alphaMarketing }))).toBe("assignee_invalid");
    expect(message(await rpc("shared", "assign_conversation", { p_org: ORG.alpha, p_id: convA1, p_assignee: USER.betaOwner }))).toBe("assignee_invalid");
    expect((await rpc("shared", "assign_conversation", { p_org: ORG.alpha, p_id: convA1, p_assignee: USER.alphaSales })).status).toBe(204);
    expect(psql(`select state || ':' || assignee_id from public.conversations where id = '${convA1}'`)).toBe(`open:${USER.alphaSales}`);
  });

  it("changer l'état : le commercial sur SON fil, pas sur celui des autres (introuvable) ; marketing et analyste interdits", async () => {
    expect((await rpc("alphaSales", "set_conversation_state", { p_org: ORG.alpha, p_id: convA1, p_state: "pending" })).status).toBe(204);
    expect(message(await rpc("alphaSales", "set_conversation_state", { p_org: ORG.alpha, p_id: convA2, p_state: "closed" }))).toBe("not_found");
    for (const persona of ["alphaMarketing", "alphaAnalyst", "betaOwner"] as const) {
      expect(message(await rpc(persona, "set_conversation_state", { p_org: ORG.alpha, p_id: convA1, p_state: "closed" })), persona).toBe("forbidden");
    }
    expect((await rpc("alphaAdmin", "set_conversation_state", { p_org: ORG.alpha, p_id: convA2, p_state: "pending" })).status).toBe(400);
    expect((await rpc("alphaAdmin", "set_conversation_state", { p_org: ORG.alpha, p_id: convA2, p_state: "closed" })).status).toBe(204);
    expect((await rpc("alphaAdmin", "set_conversation_state", { p_org: ORG.alpha, p_id: convA2, p_state: "to_triage" })).status).toBe(204);
    expect((await rpc("alphaAdmin", "set_conversation_state", { p_org: ORG.alpha, p_id: convA2, p_state: "open" })).status).toBe(400);
  });
});

describe("lecture par rôle", () => {
  it("owner et admin voient les deux fils d'Alpha ; le commercial seulement le sien (A1) ; marketing, analyste, Beta et anonyme rien", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      expect(rowsOf<{ id: string }>(await select(persona, `conversations?organization_id=eq.${ORG.alpha}&contact_id=in.(${contactA1},${contactA2})&select=id`)).map((r) => r.id).sort(), persona).toEqual([convA1, convA2].sort());
    }
    expect(rowsOf<{ id: string }>(await select("alphaSales", `conversations?contact_id=in.(${contactA1},${contactA2})&select=id`)).map((r) => r.id)).toEqual([convA1]);
    for (const persona of ["alphaMarketing", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(rowsOf(await select(persona, `conversations?contact_id=in.(${contactA1},${contactA2})&select=id`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "conversations?select=id"))).toBe(true);
    expect(rowsOf<{ id: string }>(await select("betaOwner", `conversations?contact_id=eq.${contactB1}&select=id`)).map((r) => r.id)).toEqual([convB1]);
  });

  it("messages : le commercial lit ceux de SON fil seulement ; les autres rôles et l'autre entreprise rien", async () => {
    expect(rowsOf(await select("shared", `messages?conversation_id=eq.${convA1}&select=id,body`))).toHaveLength(2);
    expect(rowsOf(await select("alphaSales", `messages?conversation_id=eq.${convA1}&select=id,body`))).toHaveLength(2);
    expect(rowsOf(await select("alphaSales", `messages?conversation_id=eq.${convA2}&select=id`))).toEqual([]);
    for (const persona of ["alphaMarketing", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(rowsOf(await select(persona, `messages?conversation_id=eq.${convA1}&select=id`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "messages?select=id"))).toBe(true);
  });

  it("aucune écriture directe, même service_role ; la cohérence d'entreprise tient même pour une insertion forgée", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "service"] as const) {
      expect(rowsOf(await api<unknown>(persona, "PATCH", `conversations?id=eq.${convA1}`, { state: "closed" })), persona).toEqual([]);
      expect(rowsOf(await api<unknown>(persona, "PATCH", `messages?conversation_id=eq.${convA1}`, { body: "modifié" })), persona).toEqual([]);
      const insert = await api<unknown>(persona, "POST", "messages", { organization_id: ORG.alpha, conversation_id: convA1, channel_id: channelA, direction: "outbound", body: "x", status: "queued", idempotency_key: `direct-${run}-${persona}` });
      expect(insert.status, persona).toBeGreaterThanOrEqual(400);
    }
    // un PATCH refusé ou sans effet renvoie une liste vide : c'est l'ÉTAT en base qui prouve qu'aucune écriture n'a eu lieu
    expect(psql(`select state from public.conversations where id = '${convA1}'`)).toBe("pending");
    expect(psql(`select count(*) from public.messages where conversation_id = '${convA1}' and body = 'modifié'`)).toBe("0");
    expect(psql(`select count(*) from public.messages where idempotency_key like 'direct-${run}-%'`)).toBe("0");
    const forged = psql(`select count(*) from public.conversations c join public.channels ch on ch.id = c.channel_id and ch.organization_id = c.organization_id where c.id = '${convA1}' and ch.id = '${channelA}'`);
    expect(forged).toBe("1");
  });

  it("l'audit ne contient ni corps de message, ni identifiant fournisseur, ni clé d'envoi", () => {
    const body = psql(`select coalesce(string_agg(to_jsonb(a)::text, ' '), '') from public.audit_logs a where a.organization_id = '${ORG.alpha}' and a.action like 'conversation.%' and a.created_at > now() - interval '10 minutes'`);
    expect(body).toContain("conversation.assigned");
    expect(body).not.toContain("devis");
    expect(body).not.toContain(`wamid.${run}`);
    expect(body).not.toContain(`envoi-${run}`);
  });
});
