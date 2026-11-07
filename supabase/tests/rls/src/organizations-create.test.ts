import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  apiAsUser,
  cleanupTestUsers,
  createTestUser,
  isDenied,
  ORG,
  rowsOf,
  select,
  USER,
} from "./harness";

/**
 * Création d'organisation par la Data API (J9) — ADR 005 §11 (G-R7), ADR 006, ADR 014.
 * POST /rest/v1/rpc/create_organization est appelé comme le ferait un client, avec un JWT signé pour
 * de VRAIS comptes créés par le test (la FK vers auth.users l'exige : la persona `nobody` du harnais
 * n'existe pas dans auth.users). Tests ré-exécutables : noms et clés uniques par exécution,
 * assertions bornées aux identifiants créés, nettoyage best-effort en fin de fichier.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const key = (suffix: string): string => `rls-${run}-${suffix}`;
const rpcPath = "rpc/create_organization";
const ch = (code: number): string => String.fromCharCode(code);

type Account = { id: string; email: string };
let newcomer: Account; // authentifié, sans aucune adhésion au départ (rôle « nobody »)
let other: Account; // second utilisateur, tente de réutiliser la clé du premier
const createdUsers: string[] = [];

const create = (
  user: Account,
  args: Record<string, unknown>,
  claims: Record<string, unknown> = {},
) => apiAsUser<string>(user.id, "POST", rpcPath, args, claims);

const visibleOrgIds = async (user: Account): Promise<string[]> =>
  rowsOf<{ id: string }>(await apiAsUser(user.id, "GET", "organizations?select=id")).map(
    (o) => o.id,
  );

beforeAll(async () => {
  newcomer = await createTestUser("newcomer");
  other = await createTestUser("other");
  createdUsers.push(newcomer.id, other.id);
});

afterAll(async () => {
  await cleanupTestUsers(createdUsers);
});

describe("accès à la fonction", () => {
  it("anon est refusé", async () => {
    const result = await api("anon", "POST", rpcPath, {
      p_name: `Anon ${run}`,
      p_creation_key: key("anon"),
    });
    expect(isDenied(result)).toBe(true);
    expect(result.code).toBe("42501");
  });

  it("service_role n'a pas accès au wrapper (réservé à authenticated)", async () => {
    const result = await api("service", "POST", rpcPath, {
      p_name: `Service ${run}`,
      p_creation_key: key("service"),
    });
    expect(isDenied(result)).toBe(true);
    expect(
      rowsOf(await select("service", `organizations?select=id&name=eq.${encodeURIComponent(`Service ${run}`)}`)),
    ).toHaveLength(0);
  });

  it("la fonction privée n'est pas exposée par la Data API (schéma private)", async () => {
    const result = await api("anon", "POST", "rpc/private.create_organization", {});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).not.toBe(200);
  });

  it("un utilisateur absent de auth.users (persona nobody du harnais) ne crée rien", async () => {
    const name = `Fantome ${run}`;
    const result = await api("nobody", "POST", rpcPath, { p_name: name, p_creation_key: key("ghost") });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.code).toBe("23503"); // clé étrangère vers auth.users
    expect(
      rowsOf(await select("service", `organizations?select=id&name=eq.${encodeURIComponent(name)}`)),
    ).toHaveLength(0);
    expect(
      rowsOf(await select("service", `organization_members?select=id&user_id=eq.${USER.nobody}`)),
    ).toHaveLength(0);
  });
});

describe("création, visibilité et isolation", () => {
  const name = `Société Équilibre ${run}`;
  let orgId = "";

  it("un utilisateur sans adhésion ne voit aucune organisation", async () => {
    expect(await visibleOrgIds(newcomer)).toEqual([]);
  });

  it("nobody crée une organisation : identifiant renvoyé, owner actif, abonnement d'essai", async () => {
    const result = await create(newcomer, {
      p_name: `  ${name}  `,
      p_locale: "en",
      p_timezone: "Africa/Casablanca",
      p_creation_key: key("main"),
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatch(/^[0-9a-f-]{36}$/);
    orgId = result.body;

    const orgs = rowsOf<Record<string, string>>(
      await apiAsUser(
        newcomer.id,
        "GET",
        "organizations?select=id,name,slug,locale,timezone,status,created_by",
      ),
    );
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      id: orgId,
      name,
      locale: "en",
      timezone: "Africa/Casablanca",
      status: "active",
      created_by: newcomer.id,
    });
    expect(orgs[0]?.slug).toMatch(/^societe-equilibre-[a-z0-9]+-[0-9a-f]{6}$/);

    const members = rowsOf<Record<string, string>>(
      await apiAsUser(newcomer.id, "GET", `organization_members?select=user_id,role,status&organization_id=eq.${orgId}`),
    );
    expect(members).toEqual([{ user_id: newcomer.id, role: "company_owner", status: "active" }]);

    const subscriptions = rowsOf<Record<string, string | null>>(
      await apiAsUser(
        newcomer.id,
        "GET",
        `subscriptions?select=status,period_start,period_end,plans(code)&organization_id=eq.${orgId}`,
      ),
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.status).toBe("trial");
    expect(subscriptions[0]?.period_start).toBeTruthy();
    expect(subscriptions[0]?.period_end).toBeNull();
  });

  it.each(["shared", "alphaAdmin", "betaOwner", "betaAnalyst", "alphaAnalyst"] as const)(
    "%s (Alpha/Beta) ne voit pas la nouvelle organisation ni ses données",
    async (persona) => {
      expect(rowsOf(await select(persona, `organizations?select=id&id=eq.${orgId}`))).toHaveLength(0);
      expect(
        rowsOf(await select(persona, `organization_members?select=id&organization_id=eq.${orgId}`)),
      ).toHaveLength(0);
      expect(
        rowsOf(await select(persona, `subscriptions?select=id&organization_id=eq.${orgId}`)),
      ).toHaveLength(0);
    },
  );

  it("les propriétaires d'Alpha et Beta voient toujours exactement leurs organisations", async () => {
    const shared = rowsOf<{ id: string }>(await select("shared", "organizations?select=id")).map((o) => o.id);
    expect(shared.sort()).toEqual([ORG.alpha, ORG.beta].sort());
    const beta = rowsOf<{ id: string }>(await select("betaOwner", "organizations?select=id")).map((o) => o.id);
    expect(beta).toEqual([ORG.beta]);
  });

  it("un autre utilisateur authentifié ne voit pas l'organisation", async () => {
    expect(await visibleOrgIds(other)).not.toContain(orgId);
  });

  it("le rejeu avec la même clé renvoie le même identifiant sans rien recréer", async () => {
    const replay = await create(newcomer, {
      p_name: name,
      p_locale: "en",
      p_timezone: "Africa/Casablanca",
      p_creation_key: key("main"),
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toBe(orgId);
    expect(await visibleOrgIds(newcomer)).toEqual([orgId]);
    expect(
      rowsOf(await select("service", `organization_members?select=id&organization_id=eq.${orgId}`)),
    ).toHaveLength(1);
    expect(
      rowsOf(await select("service", `subscriptions?select=id&organization_id=eq.${orgId}`)),
    ).toHaveLength(1);
  });

  it("la même clé avec une charge utile différente est refusée (idempotency_conflict)", async () => {
    const result = await create(newcomer, {
      p_name: `${name} bis`,
      p_locale: "en",
      p_timezone: "Africa/Casablanca",
      p_creation_key: key("main"),
    });
    expect(result.status).toBe(400);
    expect(result.code).toBe("P0001");
    expect((result.body as unknown as { message: string }).message).toBe("idempotency_conflict");
    expect(await visibleOrgIds(newcomer)).toEqual([orgId]);
  });

  it("un second utilisateur qui réutilise la clé obtient SA propre organisation, jamais celle d'autrui", async () => {
    const result = await create(other, {
      p_name: name,
      p_locale: "en",
      p_timezone: "Africa/Casablanca",
      p_creation_key: key("main"),
    });
    expect(result.status).toBe(200);
    expect(result.body).not.toBe(orgId);
    expect(await visibleOrgIds(other)).toEqual([result.body]);
    // …et l'organisation du premier reste invisible pour lui (comme l'inverse).
    expect(await visibleOrgIds(other)).not.toContain(orgId);
    expect(await visibleOrgIds(newcomer)).toEqual([orgId]);
  });

  it("sans clé, deux appels créent deux organisations distinctes", async () => {
    const before = (await visibleOrgIds(other)).length;
    const a = await create(other, { p_name: `Sans cle ${run}` });
    const b = await create(other, { p_name: `Sans cle ${run}` });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).not.toBe(b.body);
    expect(await visibleOrgIds(other)).toHaveLength(before + 2);
  });

  it("nom arabe : slug préfixé « org » et locale par défaut « ar »", async () => {
    const result = await create(newcomer, { p_name: "شركة النور", p_creation_key: key("ar") });
    expect(result.status).toBe(200);
    const rows = rowsOf<{ slug: string; locale: string; timezone: string }>(
      await apiAsUser(newcomer.id, "GET", `organizations?select=slug,locale,timezone&id=eq.${result.body}`),
    );
    expect(rows[0]?.slug).toMatch(/^org-[0-9a-f]{6}$/);
    expect(rows[0]).toMatchObject({ locale: "ar", timezone: "UTC" });
  });
});

describe("identité : jamais fournie par le client", () => {
  it("un paramètre p_user_id est inconnu de la fonction (aucun moyen de créer pour autrui)", async () => {
    const name = `Forge ${run}`;
    const before = rowsOf(await select("shared", "organizations?select=id")).length;
    const result = await create(newcomer, {
      p_name: name,
      p_user_id: USER.shared,
      p_creation_key: key("forged-param"),
    });
    expect(result.status).toBe(404);
    expect(result.code).toBe("PGRST202");
    expect(rowsOf(await select("shared", "organizations?select=id"))).toHaveLength(before);
    expect(
      rowsOf(await select("service", `organizations?select=id&name=eq.${encodeURIComponent(name)}`)),
    ).toHaveLength(0);
  });

  it("des métadonnées de JWT mensongères (user_metadata / app_metadata) sont ignorées", async () => {
    const name = `Metadata ${run}`;
    const result = await create(
      newcomer,
      { p_name: name, p_creation_key: key("metadata") },
      {
        user_metadata: { sub: USER.shared, user_id: USER.shared, role: "company_owner" },
        app_metadata: { sub: USER.shared, role: "company_owner" },
      },
    );
    expect(result.status).toBe(200);
    const rows = rowsOf<{ created_by: string }>(
      await select("service", `organizations?select=created_by&id=eq.${result.body}`),
    );
    expect(rows[0]?.created_by).toBe(newcomer.id);
    const members = rowsOf<{ user_id: string }>(
      await select("service", `organization_members?select=user_id&organization_id=eq.${result.body}`),
    );
    expect(members.map((m) => m.user_id)).toEqual([newcomer.id]);
    expect(rowsOf(await select("shared", `organizations?select=id&id=eq.${result.body}`))).toHaveLength(0);
  });
});

describe("validation et atomicité côté API", () => {
  const countOwn = async (): Promise<number> => (await visibleOrgIds(newcomer)).length;

  it.each([
    ["nom blanc", { p_name: "   " }],
    ["nom trop long", { p_name: "a".repeat(121) }],
    ["locale inconnue", { p_name: "Val", p_locale: "fr" }],
    ["fuseau inconnu", { p_name: "Val", p_timezone: "Mars/Phobos" }],
    ["clé trop courte", { p_name: "Val", p_creation_key: "court" }],
    ["nom avec LRM invisible", { p_name: `Acme${ch(0x200e)}Co` }],
    ["nom avec RLO (bidi)", { p_name: `${ch(0x202e)}Acme` }],
    ["nom avec espace de largeur nulle", { p_name: `Ac${ch(0x200b)}me` }],
    ["nom avec BOM", { p_name: `Acme${ch(0xfeff)}` }],
    ["nom avec séparateur de ligne U+2028", { p_name: `Acme${ch(0x2028)}Co` }],
    ["nom avec caractère de contrôle C0", { p_name: `Acme${ch(0x07)}Co` }],
    ["nom avec caractère de contrôle C1", { p_name: `Acme${ch(0x85)}Co` }],
    ["nom sans lettre ni chiffre", { p_name: "!!! - ???" }],
    ["fuseau EST (abréviation)", { p_name: "Val", p_timezone: "EST" }],
    ["fuseau est (minuscules)", { p_name: "Val", p_timezone: "est" }],
    ["fuseau Asia/Nowhere", { p_name: "Val", p_timezone: "Asia/Nowhere" }],
    ["fuseau vide", { p_name: "Val", p_timezone: "" }],
    ["fuseau Europe/ incomplet", { p_name: "Val", p_timezone: "Europe/" }],
    ["fuseau utc avec espace", { p_name: "Val", p_timezone: "utc " }],
  ])("%s : validation_failed (22023), rien n'est créé", async (_label, args) => {
    const before = await countOwn();
    const result = await create(newcomer, args);
    expect(result.status).toBe(400);
    expect(result.code).toBe("22023");
    expect((result.body as unknown as { message: string }).message).toBe("validation_failed");
    expect(await countOwn()).toBe(before);
  });
});

describe("noms et fuseaux acceptés", () => {
  it.each([
    ["Éclair Ñandú", "Europe/Kyiv"],
    ["Привет", "Asia/Kolkata"],
    ["شركة النور", "America/Argentina/Buenos_Aires"],
    ["42", "UTC"],
  ])("%s / %s est accepté", async (name, tz) => {
    const result = await create(newcomer, {
      p_name: `${name}`,
      p_timezone: tz,
      p_creation_key: key(`ok-${tz.length}-${name.length}`),
    });
    expect(result.status).toBe(200);
    const rows = rowsOf<{ name: string; timezone: string }>(
      await select("service", `organizations?select=name,timezone&id=eq.${result.body}`),
    );
    expect(rows[0]).toEqual({ name, timezone: tz });
  });

  it("le nom U+0000 ne peut pas atteindre la fonction et ne crée rien", async () => {
    const before = (await visibleOrgIds(newcomer)).length;
    const result = await create(newcomer, { p_name: `Acme${ch(0)}Co`, p_creation_key: key("nul") });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await visibleOrgIds(newcomer)).length).toBe(before);
  });
});

describe("source de la migration", () => {
  it("n'utilise aucun caractère combinant, invisible ou bidi littéral (échappements uniquement)", () => {
    const sql = readFileSync(
      resolve(__dirname, "../../../migrations/20261106140000_organizations_create.sql"),
      "utf8",
    );
    const forbidden = /[\u0300-\u036f\u200b-\u200f\u2028-\u202e\u2060-\u2069\u061c\ufeff]/u;
    expect(forbidden.test(sql)).toBe(false);
    expect(sql).toContain("[\\u0300-\\u036f]");
  });
});

describe("écritures directes refusées sur les nouvelles colonnes et tables", () => {
  let orgId = "";
  beforeAll(async () => {
    const result = await create(newcomer, { p_name: `Ecritures ${run}`, p_creation_key: key("writes") });
    orgId = result.body;
  });

  it("le owner ne peut modifier ni created_by ni creation_key (GRANT par colonne)", async () => {
    for (const patch of [{ created_by: other.id }, { creation_key: "hijacked-key-1" }, { slug: "mine-now" }]) {
      const result = await apiAsUser(newcomer.id, "PATCH", `organizations?id=eq.${orgId}`, patch);
      expect(isDenied(result)).toBe(true);
    }
    const row = rowsOf<{ created_by: string; creation_key: string }>(
      await select("service", `organizations?select=created_by,creation_key&id=eq.${orgId}`),
    )[0];
    expect(row).toEqual({ created_by: newcomer.id, creation_key: key("writes") });
  });

  it("le owner peut toujours renommer son organisation (GRANT inchangé)", async () => {
    const result = await apiAsUser(newcomer.id, "PATCH", `organizations?id=eq.${orgId}`, {
      name: `Renomme ${run}`,
    });
    expect(result.status).toBe(200);
  });

  it("aucun INSERT direct (organizations, organization_members, subscriptions)", async () => {
    const org = await apiAsUser(newcomer.id, "POST", "organizations", { name: "Direct", slug: `direct-${run}` });
    const member = await apiAsUser(newcomer.id, "POST", "organization_members", {
      organization_id: ORG.alpha,
      user_id: newcomer.id,
      role: "company_owner",
    });
    const subscription = await apiAsUser(newcomer.id, "POST", "subscriptions", { organization_id: orgId });
    for (const result of [org, member, subscription]) expect(isDenied(result)).toBe(true);
    expect(
      rowsOf(await select("service", `organization_members?select=id&organization_id=eq.${ORG.alpha}&user_id=eq.${newcomer.id}`)),
    ).toHaveLength(0);
  });

  it("le créateur, unique owner, ne peut pas se retirer (protect_last_owner)", async () => {
    const result = await apiAsUser(
      newcomer.id,
      "DELETE",
      `organization_members?organization_id=eq.${orgId}&user_id=eq.${newcomer.id}`,
    );
    expect(isDenied(result) || result.status >= 400 || rowsOf(result).length === 0).toBe(true);
    expect(
      rowsOf(await select("service", `organization_members?select=id&organization_id=eq.${orgId}`)),
    ).toHaveLength(1);
  });
});
