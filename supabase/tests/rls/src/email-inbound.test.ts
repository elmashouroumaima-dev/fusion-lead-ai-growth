import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, psql, select, type Persona } from "./harness";

/**
 * E-mail entrant et statuts par la Data API (J32, spec §9.2) : le secret de webhook (owner et admin, jamais lisible, seul l'indicateur l'est),
 * les fonctions du worker réservées à service_role (statuts, entrant, lecture du chiffré), `inbound_unmatched` lisible par owner et admin
 * seulement et sans écriture directe, cloisonnement entre entreprises. Ré-exécutable : données supprimées.
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
    delete from public.inbound_unmatched where integration_id in (select id from public.integrations where external_account_id like 'rlsei${run}%');
    delete from public.suppressions where value_normalized like '%@ei${run}.test';
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ei${run}.test'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ei${run}.test');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like 'rlsei${run}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like 'rlsei${run}%')
      or id in (select webhook_secret_ref from public.integrations where external_account_id like 'rlsei${run}%');
    delete from public.integrations where external_account_id like 'rlsei${run}%';
    delete from public.contacts where email_normalized like '%@ei${run}.test';
  `);

let integrationA = "";
let integrationB = "";
let channelA = "";

beforeAll(async () => {
  cleanup();
  const create = async (persona: Persona, org: string, account: string): Promise<string> =>
    String((await rpc(persona, "create_provider_integration", { p_org: org, p_provider: "email", p_account: account, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1 })).body);
  integrationA = await create("shared", ORG.alpha, `rlsei${run}a`);
  integrationB = await create("betaOwner", ORG.beta, `rlsei${run}b`);
  psql(`
    update public.integrations set status = 'active' where id in ('${integrationA}', '${integrationB}');
    insert into public.channels (organization_id, type, integration_id, sender_identity, status) values ('${ORG.alpha}', 'email', '${integrationA}', 'ventes@ei${run}.test', 'active');
    insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'EI K ${run}', 'k@ei${run}.test', 'k@ei${run}.test');
  `);
  channelA = psql(`select id from public.channels where integration_id = '${integrationA}'`);
});
afterAll(cleanup);

describe("secret de webhook : owner et admin, illisible", () => {
  const set = (persona: Persona, org: string, integration: string) =>
    rpc(persona, "set_integration_webhook_secret", { p_org: org, p_integration: integration, p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1 });

  it("commercial, marketing, analyste, Beta, sans adhésion et anonyme : refusés, rien n'est enregistré", async () => {
    for (const persona of ["alphaSales", "alphaMarketing", "alphaAnalyst", "betaOwner", "nobody", "anon"] as const) {
      expect([401, 403], persona).toContain((await set(persona, ORG.alpha, integrationA)).status);
    }
    expect(psql(`select has_webhook_secret from public.integrations where id = '${integrationA}'`)).toBe("f");
  });

  it("Beta ne peut pas viser l'intégration d'Alpha en se déclarant dans la sienne : introuvable", async () => {
    expect(message(await set("betaOwner", ORG.beta, integrationA))).toBe("not_found");
    expect(psql(`select has_webhook_secret from public.integrations where id = '${integrationA}'`)).toBe("f");
  });

  it("owner puis admin (rotation) : un seul secret de webhook reste, distinct du jeton d'envoi", async () => {
    expect((await set("shared", ORG.alpha, integrationA)).status).toBe(204);
    expect((await set("alphaAdmin", ORG.alpha, integrationA)).status).toBe(204);
    expect(psql(`select count(*) from private.secrets where purpose = 'integration_webhook' and id = (select webhook_secret_ref from public.integrations where id = '${integrationA}')`)).toBe("1");
    expect(psql(`select count(*) from private.secrets where purpose = 'integration_webhook' and organization_id = '${ORG.alpha}' and id in (select webhook_secret_ref from public.integrations where external_account_id = 'rlsei${run}a')`)).toBe("1");
    expect(psql(`select webhook_secret_ref <> secret_ref from public.integrations where id = '${integrationA}'`)).toBe("t");
  });

  it("l'API ne renvoie que l'indicateur : webhook_secret_ref est refusé même à l'owner, select * aussi", async () => {
    const flag = await select<{ has_webhook_secret: boolean }>("shared", `integrations?id=eq.${integrationA}&select=has_webhook_secret`);
    expect(flag.body).toEqual([{ has_webhook_secret: true }]);
    expect((await select("shared", `integrations?id=eq.${integrationA}&select=webhook_secret_ref`)).status).toBeGreaterThanOrEqual(400);
    expect((await select("shared", `integrations?id=eq.${integrationA}&select=*`)).status).toBeGreaterThanOrEqual(400);
  });

  it("lecture du chiffré : service_role seulement", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "nobody", "anon"] as const) {
      expect([401, 403], persona).toContain((await rpc(persona, "get_integration_webhook_secret", { p_org: ORG.alpha, p_integration: integrationA })).status);
    }
    const sealed = await rpc("service", "get_integration_webhook_secret", { p_org: ORG.alpha, p_integration: integrationA });
    expect(sealed.status).toBe(200);
    expect(sealed.body).toMatchObject({ ciphertext: expect.any(String), nonce: expect.any(String) });
    expect((await rpc("service", "get_integration_webhook_secret", { p_org: ORG.beta, p_integration: integrationA })).body).toBeNull();
  });
});

describe("fonctions du worker : service_role seulement", () => {
  const status = { p_org: ORG.alpha, p_integration: "", p_event: "delivered", p_hard: false, p_provider_message_id: "pm-x", p_ref: null, p_event_at: null };
  const inbound = (integration: string, from: string, id: string) => ({
    p_org: ORG.alpha, p_integration: integration, p_provider_message_id: id, p_recipients: [`ventes@ei${run}.test`], p_from: from, p_subject: "Re", p_body: `SECRET-RLS-${run}`,
    p_received_at: null, p_verified: true, p_spam: false,
  });

  it("owner, admin, commercial, Beta, sans adhésion et anonyme ne peuvent ni appliquer un statut ni enregistrer un entrant", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "nobody", "anon"] as const) {
      expect([401, 403], persona).toContain((await rpc(persona, "email_status_apply", { ...status, p_integration: integrationA })).status);
      expect([401, 403], persona).toContain((await rpc(persona, "email_inbound_apply", inbound(integrationA, `k@ei${run}.test`, `in-${run}-0`))).status);
    }
    expect(psql(`select count(*) from public.messages where provider_message_id = 'in-${run}-0'`)).toBe("0");
  });

  it("le service : intégration d'une AUTRE entreprise = introuvable ; expéditeur connu = rattaché ; inconnu = file des cas ambigus, aucun contact créé", async () => {
    expect(message(await rpc("service", "email_status_apply", { ...status, p_integration: integrationB }))).toBe("not_found");
    expect(message(await rpc("service", "email_inbound_apply", inbound(integrationB, `k@ei${run}.test`, `in-${run}-b`)))).toBe("not_found");
    const contactsBefore = psql(`select count(*) from public.contacts where organization_id = '${ORG.alpha}'`);
    const known = await rpc("service", "email_inbound_apply", inbound(integrationA, `k@ei${run}.test`, `in-${run}-1`));
    expect(known.body).toEqual({ outcome: "recorded" });
    expect((await rpc("service", "email_inbound_apply", inbound(integrationA, `k@ei${run}.test`, `in-${run}-1`))).body).toEqual({ outcome: "duplicate" });
    const unknown = await rpc("service", "email_inbound_apply", inbound(integrationA, `inconnu@ei${run}.test`, `in-${run}-2`));
    expect(unknown.body).toEqual({ outcome: "unmatched", reason: "unknown_sender" });
    expect(psql(`select count(*) from public.messages m join public.conversations c on c.id = m.conversation_id where m.provider_message_id = 'in-${run}-1' and c.channel_id = '${channelA}'`)).toBe("1");
    expect(psql(`select count(*) from public.contacts where organization_id = '${ORG.alpha}'`)).toBe(contactsBefore);
  });
});

describe("inbound_unmatched : owner et admin, aucune écriture", () => {
  const read = async (persona: Persona) => (await select<unknown[]>(persona, `inbound_unmatched?integration_id=eq.${integrationA}&select=id,reason,status`)).body;

  it("owner et admin lisent la file de leur entreprise ; marketing, commercial, analyste, Beta et sans adhésion : rien ; anonyme : refusé", async () => {
    expect((await read("shared")).length).toBe(1);
    expect((await read("alphaAdmin")).length).toBe(1);
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) expect((await read(persona)).length, persona).toBe(0);
    expect([401, 403]).toContain((await select("anon", "inbound_unmatched?select=id")).status);
  });

  it("aucune écriture directe, même owner ou service_role", async () => {
    for (const persona of ["shared", "alphaAdmin", "service"] as const) {
      const denied = await api<unknown>(persona, "POST", "inbound_unmatched", { organization_id: ORG.alpha, integration_id: integrationA, provider_message_id: `w-${run}`, from_normalized: "a@b.test", body: "x", reason: "spam" });
      expect([401, 403], persona).toContain(denied.status);
      expect([401, 403], persona).toContain((await api<unknown>(persona, "DELETE", `inbound_unmatched?integration_id=eq.${integrationA}`)).status);
    }
    expect(psql(`select count(*) from public.inbound_unmatched where integration_id = '${integrationA}'`)).toBe("1");
  });
});
