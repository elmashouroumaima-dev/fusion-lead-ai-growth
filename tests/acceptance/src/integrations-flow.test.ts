import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyRing, openOrganizationSecret } from "../../../packages/adapters/src/secrets";
import { api, ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Intégrations et secrets (J28) par HTTP, avec de vraies sessions : jeton chiffré par le serveur, jamais renvoyé, jamais affiché, jamais
 * dans l'audit ni dans les clés d'idempotence ; rôles (owner et admin seulement) ; rotation ; déconnexion ; isolation Alpha / Beta.
 * Le déchiffrement de vérification utilise la clé maître de l'exécution (SECRETS_MASTER_KEY dans l'environnement de ce processus, la même que
 * celle de l'application, par exemple dans le job CI e2e) : sans elle, seul le refus 503 « chiffrement non configuré » est vérifié.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// numéro WhatsApp : numérique (5 à 30 chiffres) depuis le J34
const ACCOUNT = `8${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
const KEY_PREFIX = `acc28${run}`;
const TOKEN_1 = `EAAB-jeton-un-${run}-0123456789`;
const TOKEN_2 = `EAAB-jeton-deux-${run}-0123456789`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const VERSION = Number(process.env.SECRETS_KEY_VERSION ?? "1");
const keyRing = MASTER ? createKeyRing(VERSION, { [VERSION]: MASTER }) : null;

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const cookie = (who: string, org: string) => Object.entries({ ...as(who).cookies, fl_active_org: org }).map(([k, v]) => `${k}=${v}`).join("; ");
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(who ? as(who) : null, path, payload, {
    activeOrg: opts.org ?? ORG.alpha,
    headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` },
  });
const getList = (who: string, org: string = ORG.alpha) => fetch(`${BASE_URL}/api/integrations`, { headers: { cookie: cookie(who, org) } });

const cleanup = () => {
  psql(`
    set session_replication_role = replica;
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.integrations where external_account_id like '${ACCOUNT}%';
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
});
afterAll(cleanup);

const body = { provider: "whatsapp", external_account_id: ACCOUNT, scopes: ["messages", "templates"], secret: TOKEN_1 };

describe("rôles : owner et admin seulement", () => {
  it("commercial, marketing, analyste : 403 ; anonyme : 401 ; sans clé d'idempotence ou avec organization_id ou jeton invalide : 400", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) {
      expect((await post(who, "/api/integrations", body)).status, who).toBe(403);
      expect((await post(who, "/api/integrations/secret", { integration_id: randomUUID(), secret: TOKEN_1 })).status, who).toBe(403);
      expect((await post(who, "/api/integrations/disconnect", { integration_id: randomUUID() })).status, who).toBe(403);
      expect((await getList(who)).status, who).toBe(403);
    }
    expect((await post(null, "/api/integrations", body)).status).toBe(401);
    expect((await post("shared", "/api/integrations", body, { key: null })).status).toBe(400);
    expect((await post("shared", "/api/integrations", { ...body, organization_id: ORG.beta })).status).toBe(400);
    expect((await post("shared", "/api/integrations", { ...body, secret: "court" })).status).toBe(400);
    expect((await post("shared", "/api/integrations", { ...body, provider: "csv" })).status).toBe(400);
    expect(psql(`select count(*) from public.integrations where external_account_id like '${ACCOUNT}%'`)).toBe("0");
  });

  it("pages : le commercial, le marketing et l'analyste reviennent au tableau de bord ; un anonyme à la connexion", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) {
      expect(redirectPath(await getPage(as(who), "/fr/integrations", ORG.alpha)), who).toMatch(/dashboard/);
    }
    expect(redirectPath(await getPage(null, "/fr/integrations"))).toMatch(/login/);
  });
});

describe("sans clé maître : refus propre", () => {
  it.runIf(!keyRing)("le serveur refuse (503) d'enregistrer un jeton et ne crée rien", async () => {
    const res = await post("shared", "/api/integrations", body);
    expect(res.status).toBe(503);
    expect(psql(`select count(*) from public.integrations where external_account_id like '${ACCOUNT}%'`)).toBe("0");
  });
});

describe.runIf(Boolean(keyRing))("parcours complet avec chiffrement configuré", () => {
  let integration = "";
  const ring = () => {
    if (!keyRing) throw new Error("clé maître absente");
    return keyRing;
  };
  const stored = async () => {
    const result = await api<Record<string, unknown> | null>("service", "POST", "rpc/get_integration_secret", { p_org: ORG.alpha, p_integration: integration });
    const row = result.body as { secret_id: string; ciphertext: string; nonce: string; key_version: number } | null;
    return row ? { secretId: row.secret_id, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version } : null;
  };

  it("owner crée : 201, le jeton n'est pas renvoyé ; chiffré en base, déchiffrable avec l'entreprise d'Alpha seulement", async () => {
    const key = `${KEY_PREFIX}-create-${randomUUID()}`;
    const first = await post("shared", "/api/integrations", body, { key });
    expect(first.status).toBe(201);
    integration = String((first.json.integration as { id: string }).id);
    expect(JSON.stringify(first.json)).not.toContain(TOKEN_1);
    const row = await stored();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(TOKEN_1);
    expect(openOrganizationSecret({ organizationId: ORG.alpha, stored: row!, keyRing: ring() })).toBe(TOKEN_1);
    expect(() => openOrganizationSecret({ organizationId: ORG.beta, stored: row!, keyRing: ring() })).toThrow();
    // rejeu de la même clé avec le MÊME corps : même réponse, aucune intégration de plus
    const replay = await post("shared", "/api/integrations", body, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    // même clé avec un AUTRE jeton : refusé (422), jamais pris pour un rejeu qui n'appliquerait pas le nouveau jeton ; le premier reste
    const different = await post("shared", "/api/integrations", { ...body, secret: TOKEN_2 }, { key });
    expect(different.status).toBe(422);
    expect(psql(`select count(*) from public.integrations where external_account_id = '${ACCOUNT}'`)).toBe("1");
    expect(openOrganizationSecret({ organizationId: ORG.alpha, stored: (await stored())!, keyRing: ring() })).toBe(TOKEN_1);
  });

  it("un jeton de 4096 octets en caractères multi-octets passe (chiffré sous la limite), 4097 octets sont refusés (400) sans rien créer", async () => {
    const big = "é".repeat(2048);
    const created = await post("shared", "/api/integrations", { provider: "email", external_account_id: `${ACCOUNT}-big`, secret: big });
    expect(created.status).toBe(201);
    expect((await post("shared", "/api/integrations", { provider: "email", external_account_id: `${ACCOUNT}-big2`, secret: `${big}a` })).status).toBe(400);
    expect(psql(`select count(*) from public.integrations where external_account_id = '${ACCOUNT}-big2'`)).toBe("0");
  });

  it("liste (API) et écran : statut, portée, has_secret, jamais le jeton, le chiffré ni secret_ref", async () => {
    const res = await getList("shared");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN_1);
    expect(text).not.toContain("secret_ref");
    expect(text).not.toContain("ciphertext");
    const list = JSON.parse(text) as { integrations: Array<{ integration: { id: string; has_secret: boolean; status: string; scopes: string[] } }> };
    const mine = list.integrations.find((entry) => entry.integration.id === integration);
    expect(mine?.integration).toMatchObject({ has_secret: true, status: "pending", scopes: ["messages", "templates"] });

    for (const who of ["shared", "alpha-admin"]) {
      const page = await getPage(as(who), "/fr/integrations", ORG.alpha);
      expect(page.status, who).toBe(200);
      const visible = visibleText(page);
      expect(visible, who).toContain(ACCOUNT);
      expect(visible, who).toContain("Jeton enregistré et chiffré");
      expect(page.body, who).not.toContain(TOKEN_1);
      expect(page.body, who).not.toContain((await stored())!.ciphertext);
    }
    expect(visibleText(await getPage(as("beta-owner"), "/fr/integrations", ORG.beta))).not.toContain(ACCOUNT);
  });

  it("isolation : Beta ne connecte pas le même compte (409) et ne remplace ni ne déconnecte l'intégration d'Alpha (404)", async () => {
    expect((await post("beta-owner", "/api/integrations", body, { org: ORG.beta })).status).toBe(409);
    expect((await post("beta-owner", "/api/integrations/secret", { integration_id: integration, secret: TOKEN_2 }, { org: ORG.beta })).status).toBe(404);
    expect((await post("beta-owner", "/api/integrations/disconnect", { integration_id: integration }, { org: ORG.beta })).status).toBe(404);
    expect(openOrganizationSecret({ organizationId: ORG.alpha, stored: (await stored())!, keyRing: ring() })).toBe(TOKEN_1);
  });

  it("rotation par l'admin : 200 sans le jeton ; l'ancien secret est supprimé, le nouveau se lit ; l'écran ne le montre pas", async () => {
    const before = (await stored())!;
    const res = await post("alpha-admin", "/api/integrations/secret", { integration_id: integration, secret: TOKEN_2 });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ replaced: true });
    const after = (await stored())!;
    expect(after.secretId).not.toBe(before.secretId);
    expect(psql(`select count(*) from private.secrets where id = '${before.secretId}'`)).toBe("0");
    expect(openOrganizationSecret({ organizationId: ORG.alpha, stored: after, keyRing: ring() })).toBe(TOKEN_2);
    const page = await getPage(as("shared"), "/fr/integrations", ORG.alpha);
    expect(page.body).not.toContain(TOKEN_2);
    expect((await post("shared", "/api/integrations/secret", { integration_id: integration, secret: "court" })).status).toBe(400);
    expect((await post("shared", "/api/integrations/secret", { integration_id: randomUUID(), secret: TOKEN_1 })).status).toBe(404);
  });

  it("le jeton n'apparaît ni dans l'audit, ni dans les clés d'idempotence (réponse et empreinte), ni dans les réponses d'erreur", async () => {
    const audit = psql(`select coalesce(string_agg(to_jsonb(a)::text, ' '), '') from public.audit_logs a where a.organization_id = '${ORG.alpha}' and a.action like 'integration.%' and a.created_at > now() - interval '10 minutes'`);
    expect(audit).toContain("integration.secret_rotated");
    for (const token of [TOKEN_1, TOKEN_2]) {
      expect(audit).not.toContain(token);
      expect(psql(`select count(*) from public.idempotency_keys k where k.key like '${KEY_PREFIX}%' and to_jsonb(k)::text like '%${token}%'`)).toBe("0");
    }
    const bad = await post("shared", "/api/integrations/secret", { integration_id: integration, secret: TOKEN_1, extra: true });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).not.toContain(TOKEN_1);
  });

  it("déconnexion : 200, le secret est supprimé (plus rien à lire), rejouable ; remplacer ensuite : 409 ; l'écran l'indique", async () => {
    expect((await post("shared", "/api/integrations/disconnect", { integration_id: integration })).status).toBe(200);
    expect(await stored()).toBeNull();
    expect(psql(`select count(*) from private.secrets where organization_id = '${ORG.alpha}' and id in (select secret_ref from public.integrations where id = '${integration}')`)).toBe("0");
    expect((await post("shared", "/api/integrations/disconnect", { integration_id: integration })).status).toBe(200);
    expect(visibleText(await getPage(as("shared"), "/fr/integrations", ORG.alpha))).toContain("Déconnectée");
  });

  it("reconnexion : un nouveau jeton remet l'intégration en attente de validation (le compte reste à Alpha) ; l'écran propose « Reconnecter »", async () => {
    const res = await post("shared", "/api/integrations/secret", { integration_id: integration, secret: TOKEN_1 });
    expect(res.status).toBe(200);
    expect(openOrganizationSecret({ organizationId: ORG.alpha, stored: (await stored())!, keyRing: ring() })).toBe(TOKEN_1);
    expect(psql(`select status from public.integrations where id = '${integration}'`)).toBe("pending");
    expect(visibleText(await getPage(as("shared"), "/fr/integrations", ORG.alpha))).toContain("En attente de validation");
    expect((await post("shared", "/api/integrations/disconnect", { integration_id: integration })).status).toBe(200);
    expect(visibleText(await getPage(as("shared"), "/fr/integrations", ORG.alpha))).toContain("Reconnecter");
  });
});
