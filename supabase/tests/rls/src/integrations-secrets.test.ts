import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, rowsOf, select, type Persona } from "./harness";

/**
 * Intégrations à secret et canaux par la Data API (J28, spec §2 et §11, ADR 004) : AUCUN jeton n'est lisible (ni `secret_ref`, ni
 * `private.secrets`, ni la fonction de lecture du chiffré pour un utilisateur connecté ou anonyme), l'écriture passe par des fonctions
 * réservées à owner et admin, la lecture du chiffré par service_role seulement, un compte fournisseur est unique à l'échelle de la
 * plateforme, isolation Alpha / Beta, rotation et déconnexion. Les chiffrés ci-dessous sont des octets factices au bon format (la base ne
 * déchiffre jamais). Ré-exécutable : données de l'exécution supprimées.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNT = `rlsint${run}`;
const CIPHERTEXT = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
const NONCE = "QUJDREVGR0hJSktM";
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

const create = (persona: Persona, account: string, secretId: string, org: string = ORG.alpha, provider = "whatsapp") =>
  rpc(persona, "create_provider_integration", {
    p_org: org, p_provider: provider, p_account: account, p_scopes: ["messages"], p_secret_id: secretId, p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1,
  });
const replace = (persona: Persona, integration: string, secretId: string, org: string = ORG.alpha) =>
  rpc(persona, "set_integration_secret", { p_org: org, p_integration: integration, p_secret_id: secretId, p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 2 });

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.integrations where external_account_id like '${ACCOUNT}%';
  `);

let integration = "";
let secret1 = "";
let secret2 = "";

beforeAll(() => {
  cleanup();
  secret1 = randomUUID();
  secret2 = randomUUID();
});
afterAll(cleanup);

describe("création : owner et admin seulement", () => {
  it("marketing, commercial, analyste, Beta, sans adhésion et anon refusés ; owner crée ; le secret n'est pas renvoyé", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(message(await create(persona, `${ACCOUNT}-no`, randomUUID())), persona).toBe("forbidden");
    }
    expect(isDenied(await create("anon", `${ACCOUNT}-no`, randomUUID()))).toBe(true);
    const created = await create("shared", ACCOUNT, secret1);
    expect(created.status).toBe(200);
    integration = String(created.body);
    expect(integration).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(created.body)).not.toContain(CIPHERTEXT);
    expect(psql(`select count(*) from private.secrets where id = '${secret1}' and organization_id = '${ORG.alpha}'`)).toBe("1");
  });

  it("compte déjà connecté chez Alpha : refusé chez Beta (unicité globale), et deux fois chez Alpha", async () => {
    const other = await create("betaOwner", ACCOUNT, randomUUID(), ORG.beta);
    expect(other.status).toBe(409);
    expect((await create("shared", ACCOUNT, randomUUID())).status).toBe(409);
    expect(psql(`select count(*) from public.integrations where external_account_id = '${ACCOUNT}'`)).toBe("1");
  });

  it("valeurs invalides refusées : fournisseur csv, compte mal formé, chiffré mal formé", async () => {
    expect((await create("shared", `${ACCOUNT}-csv`, randomUUID(), ORG.alpha, "csv")).status).toBe(400);
    expect((await create("shared", "a b", randomUUID())).status).toBe(400);
    const bad = await rpc("shared", "create_provider_integration", {
      p_org: ORG.alpha, p_provider: "email", p_account: `${ACCOUNT}-bad`, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: "pas du base64 !!!!!!!!!!!!!!!!", p_nonce: NONCE, p_key_version: 1,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});

describe("lecture : jamais de secret", () => {
  it("owner et admin lisent statut, portée et has_secret ; les autres rôles, Beta et anon ne voient rien", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const rows = rowsOf<{ id: string; has_secret: boolean; scopes: string[]; status: string }>(await select(persona, `integrations?id=eq.${integration}&select=id,has_secret,scopes,status`));
      expect(rows, persona).toEqual([{ id: integration, has_secret: true, scopes: ["messages"], status: "pending" }]);
    }
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      expect(rowsOf(await select(persona, `integrations?id=eq.${integration}&select=id`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "integrations?select=id"))).toBe(true);
  });

  it("secret_ref et select * sont refusés à tous, owner compris ; private.secrets est introuvable", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      expect(isDenied(await select(persona, `integrations?id=eq.${integration}&select=secret_ref`)), `${persona} secret_ref`).toBe(true);
      expect(isDenied(await select(persona, `integrations?id=eq.${integration}`)), `${persona} select *`).toBe(true);
    }
    for (const persona of ["shared", "alphaAdmin", "service"] as const) {
      const direct = await select(persona, "secrets?select=ciphertext");
      expect(direct.status, persona).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(direct.body)).not.toContain(CIPHERTEXT);
    }
  });

  it("aucune écriture directe, même service_role", async () => {
    for (const persona of ["shared", "alphaAdmin", "service"] as const) {
      expect(rowsOf(await api<unknown>(persona, "PATCH", `integrations?id=eq.${integration}`, { status: "active" })), persona).toEqual([]);
      const insert = await api<unknown>(persona, "POST", "integrations", { organization_id: ORG.alpha, provider: "email", external_account_id: `${ACCOUNT}-direct` });
      expect(insert.status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(psql(`select status from public.integrations where id = '${integration}'`)).toBe("pending");
  });
});

describe("lecture du chiffré : service_role seulement", () => {
  it("la fonction répond au service avec le chiffré de l'entreprise de la ligne ; owner, admin et anon sont refusés", async () => {
    const result = await rpc("service", "get_integration_secret", { p_org: ORG.alpha, p_integration: integration });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ secret_id: secret1, ciphertext: CIPHERTEXT, nonce: NONCE, key_version: 1 });
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "anon"] as const) {
      const denied = await rpc(persona, "get_integration_secret", { p_org: ORG.alpha, p_integration: integration });
      expect([401, 403], persona).toContain(denied.status);
      expect(denied.body, persona).toMatchObject({ code: expect.stringMatching(/^(42501|PGRST)/) });
      expect(JSON.stringify(denied.body), persona).not.toContain(CIPHERTEXT);
    }
  });

  it("une autre entreprise (job de Beta) ne lit pas le secret d'Alpha : null", async () => {
    const result = await rpc("service", "get_integration_secret", { p_org: ORG.beta, p_integration: integration });
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });
});

describe("rotation et déconnexion", () => {
  it("remplacer le jeton : l'ancien secret est supprimé, le nouveau est lu ; marketing, commercial, Beta refusés", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner"] as const) {
      expect(message(await replace(persona, integration, randomUUID())), persona).toBe("forbidden");
    }
    expect((await replace("alphaAdmin", integration, secret2)).status).toBe(204);
    expect(psql(`select count(*) from private.secrets where id = '${secret1}'`)).toBe("0");
    const result = await rpc("service", "get_integration_secret", { p_org: ORG.alpha, p_integration: integration });
    expect(result.body).toMatchObject({ secret_id: secret2, key_version: 2 });
    expect(psql(`select count(*) from private.secrets where organization_id = '${ORG.alpha}' and id in ('${secret1}', '${secret2}')`)).toBe("1");
  });

  it("canaux : owner et admin créent et lisent ; un projet d'Alpha seulement ; commercial, marketing, Beta refusés", async () => {
    const args = { p_org: ORG.alpha, p_integration: integration, p_type: "whatsapp", p_sender: `+2126${run.replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`, p_scope: [PROJECT.alphaSite] };
    for (const persona of ["alphaMarketing", "alphaSales", "betaOwner"] as const) {
      expect(message(await rpc(persona, "create_channel", args)), persona).toBe("forbidden");
    }
    const created = await rpc("alphaAdmin", "create_channel", args);
    expect(created.status).toBe(200);
    expect(rowsOf(await select("shared", `channels?integration_id=eq.${integration}&select=id,status,send_paused`))).toHaveLength(1);
    for (const persona of ["alphaSales", "alphaMarketing", "betaOwner"] as const) {
      expect(rowsOf(await select(persona, `channels?integration_id=eq.${integration}&select=id`)), persona).toEqual([]);
    }
    const foreign = await rpc("shared", "create_channel", { ...args, p_sender: `${args.p_sender}9`, p_scope: [PROJECT.betaShop] });
    expect(foreign.status).toBe(400);
  });

  it("déconnecter : le secret est supprimé, plus rien ne se lit, les canaux sont en pause ; rejouable ; Beta refusé", async () => {
    expect(message(await rpc("betaOwner", "disconnect_integration", { p_org: ORG.alpha, p_integration: integration }))).toBe("forbidden");
    expect((await rpc("shared", "disconnect_integration", { p_org: ORG.alpha, p_integration: integration })).status).toBe(204);
    expect((await rpc("shared", "disconnect_integration", { p_org: ORG.alpha, p_integration: integration })).status).toBe(204);
    expect(psql(`select count(*) from private.secrets where id in ('${secret1}', '${secret2}')`)).toBe("0");
    expect((await rpc("service", "get_integration_secret", { p_org: ORG.alpha, p_integration: integration })).body).toBeNull();
    expect(rowsOf<{ status: string; send_paused: boolean }>(await select("shared", `channels?integration_id=eq.${integration}&select=status,send_paused`))).toEqual([{ status: "disconnected", send_paused: true }]);
    expect(rowsOf<{ status: string; has_secret: boolean }>(await select("shared", `integrations?id=eq.${integration}&select=status,has_secret`))).toEqual([{ status: "disconnected", has_secret: false }]);
    // reconnexion : un nouveau jeton remet l'intégration en attente de validation, ses canaux restent en pause ; on la déconnecte de nouveau
    expect((await replace("shared", integration, randomUUID())).status).toBe(204);
    expect(rowsOf<{ status: string; has_secret: boolean }>(await select("shared", `integrations?id=eq.${integration}&select=status,has_secret`))).toEqual([{ status: "pending", has_secret: true }]);
    expect(rowsOf<{ status: string; send_paused: boolean }>(await select("shared", `channels?integration_id=eq.${integration}&select=status,send_paused`))).toEqual([{ status: "pending", send_paused: true }]);
    expect((await rpc("shared", "disconnect_integration", { p_org: ORG.alpha, p_integration: integration })).status).toBe(204);
    expect((await rpc("service", "get_integration_secret", { p_org: ORG.alpha, p_integration: integration })).body).toBeNull();
  });
});

describe("audit : aucun secret", () => {
  it("les entrées d'audit des intégrations et des canaux ne contiennent ni chiffré, ni nonce, ni numéro", () => {
    const body = psql(`select coalesce(string_agg(to_jsonb(a)::text, ' '), '') from public.audit_logs a where a.organization_id = '${ORG.alpha}'
      and (a.action like 'integration.%' or a.action like 'channel.%') and a.created_at > now() - interval '10 minutes'`);
    expect(body).toContain("integration.secret_rotated");
    expect(body).not.toContain(CIPHERTEXT);
    expect(body).not.toContain(NONCE);
    expect(body).not.toMatch(/\+2126\d{6}/);
  });
});
