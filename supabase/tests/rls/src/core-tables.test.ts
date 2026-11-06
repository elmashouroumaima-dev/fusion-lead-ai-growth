import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  isDenied,
  ORG,
  restoreFixtures,
  rowsOf,
  select,
  snapshotFixtures,
  USER,
  type Persona,
  type Snapshot,
} from "./harness";

/**
 * Matrice RLS du noyau tenant (J7) — spec §2, §7.2, §11, §13-1 et §13-2 ; ADR 005, ADR 014.
 * Fixture : Alpha (owner = shared, admin, marketing, sales, analyst) et Beta (owner, shared =
 * sales_agent, analyst). Les « refus » sont attendus à DEUX niveaux : privilège manquant (403)
 * ou politique qui masque la ligne (0 ligne touchée).
 */

const orgSlug = (id: string): string => (id === ORG.alpha ? "alpha" : "beta");
const userKey = (id: string): string =>
  Object.entries(USER).find(([, value]) => value === id)?.[0] ?? id;

let snapshot: Snapshot;

beforeAll(async () => {
  snapshot = await snapshotFixtures();
  // La fixture doit être celle du seed (2 entreprises, 8 adhésions).
  expect(snapshot.organizations.map((o) => o.slug)).toEqual(["alpha", "beta"]);
  expect(snapshot.members).toHaveLength(8);
  // Crée aussi les compteurs de fixture (rlstest_a pour Alpha, rlstest_b pour Beta).
  await restoreFixtures(snapshot);
});

afterEach(async () => {
  await restoreFixtures(snapshot);
});

afterAll(async () => {
  // Laisse la base dans l'état exact du seed (sans les compteurs de fixture).
  await api("service", "DELETE", "usage_counters?metric=like.rlstest_*");
});

const personas = [
  "shared",
  "alphaAdmin",
  "alphaMarketing",
  "alphaSales",
  "alphaAnalyst",
  "betaOwner",
  "betaAnalyst",
  "nobody",
] as const satisfies readonly Persona[];

// ---------------------------------------------------------------------------
// LECTURE (select) — spec §13-1 : A ne voit rien de B
// ---------------------------------------------------------------------------
describe("select : ce que chaque utilisateur voit", () => {
  const visibleOrganizations: Record<(typeof personas)[number], string[]> = {
    shared: ["alpha", "beta"],
    alphaAdmin: ["alpha"],
    alphaMarketing: ["alpha"],
    alphaSales: ["alpha"],
    alphaAnalyst: ["alpha"],
    betaOwner: ["beta"],
    betaAnalyst: ["beta"],
    nobody: [],
  };
  it.each(personas)("organizations — %s", async (persona) => {
    const slugs = rowsOf<{ slug: string }>(
      await select(persona, "organizations?select=slug&order=slug"),
    ).map((r) => r.slug);
    expect(slugs).toEqual(visibleOrganizations[persona]);
  });

  // Un membre voit sa propre ligne ; owner et admin voient toutes les adhésions de leur entreprise.
  const visibleMembers: Record<(typeof personas)[number], string[]> = {
    shared: [
      "alpha:shared",
      "alpha:alphaAdmin",
      "alpha:alphaMarketing",
      "alpha:alphaSales",
      "alpha:alphaAnalyst",
      "beta:shared",
    ],
    alphaAdmin: [
      "alpha:shared",
      "alpha:alphaAdmin",
      "alpha:alphaMarketing",
      "alpha:alphaSales",
      "alpha:alphaAnalyst",
    ],
    alphaMarketing: ["alpha:alphaMarketing"],
    alphaSales: ["alpha:alphaSales"],
    alphaAnalyst: ["alpha:alphaAnalyst"],
    betaOwner: ["beta:betaOwner", "beta:shared", "beta:betaAnalyst"],
    betaAnalyst: ["beta:betaAnalyst"],
    nobody: [],
  };
  it.each(personas)("organization_members — %s", async (persona) => {
    const rows = rowsOf<{ organization_id: string; user_id: string }>(
      await select(persona, "organization_members?select=organization_id,user_id"),
    );
    const seen = rows.map((r) => `${orgSlug(r.organization_id)}:${userKey(r.user_id)}`).sort();
    expect(seen).toEqual([...visibleMembers[persona]].sort());
  });

  // Seuls owner et admin lisent l'abonnement et les compteurs de leur entreprise (ADR 014).
  const visibleBilling: Record<(typeof personas)[number], string[]> = {
    shared: ["alpha"],
    alphaAdmin: ["alpha"],
    alphaMarketing: [],
    alphaSales: [],
    alphaAnalyst: [],
    betaOwner: ["beta"],
    betaAnalyst: [],
    nobody: [],
  };
  it.each(personas)("subscriptions — %s", async (persona) => {
    const slugs = rowsOf<{ organization_id: string }>(
      await select(persona, "subscriptions?select=organization_id"),
    ).map((r) => orgSlug(r.organization_id));
    expect(slugs).toEqual(visibleBilling[persona]);
  });
  it.each(personas)("usage_counters — %s", async (persona) => {
    const slugs = rowsOf<{ organization_id: string }>(
      await select(persona, "usage_counters?select=organization_id&metric=like.rlstest_*"),
    ).map((r) => orgSlug(r.organization_id));
    expect(slugs).toEqual(visibleBilling[persona]);
  });

  it.each(personas)("plans (catalogue global) — %s", async (persona) => {
    const codes = rowsOf<{ code: string }>(await select(persona, "plans?select=code")).map(
      (r) => r.code,
    );
    // Tout utilisateur authentifié lit le catalogue ; aucune ligne tenant n'y figure.
    expect(codes).toEqual(["trial"]);
  });

  it("anon : refus sur toutes les tables du noyau", async () => {
    for (const table of [
      "organizations",
      "organization_members",
      "subscriptions",
      "usage_counters",
      "plans",
    ]) {
      const result = await select("anon", `${table}?select=*`);
      expect(isDenied(result), `${table} doit être refusée à anon (statut ${result.status})`).toBe(
        true,
      );
    }
  });

  it("un identifiant de l'autre entreprise placé dans le filtre ne révèle rien", async () => {
    expect(
      rowsOf(await select("alphaAnalyst", `organizations?select=id&id=eq.${ORG.beta}`)),
    ).toEqual([]);
    expect(
      rowsOf(
        await select("alphaAdmin", `organization_members?select=id&organization_id=eq.${ORG.beta}`),
      ),
    ).toEqual([]);
    expect(
      rowsOf(await select("betaOwner", `subscriptions?select=id&organization_id=eq.${ORG.alpha}`)),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ÉCRITURE sur organizations
// ---------------------------------------------------------------------------
describe("organizations : écriture", () => {
  const rename = (persona: Persona, org: string) =>
    api<{ name: string }[]>(persona, "PATCH", `organizations?id=eq.${org}`, {
      name: "Renommée par test",
    });

  it.each([
    ["shared", ORG.alpha],
    ["alphaAdmin", ORG.alpha],
  ] as const)("%s peut renommer %s", async (persona, org) => {
    const result = await rename(persona, org);
    expect(rowsOf(result)).toHaveLength(1);
  });

  it.each([
    ["alphaMarketing", ORG.alpha],
    ["alphaSales", ORG.alpha],
    ["alphaAnalyst", ORG.alpha],
    ["shared", ORG.beta], // sales_agent chez Beta
    ["betaOwner", ORG.alpha], // autre entreprise
    ["betaAnalyst", ORG.beta],
    ["nobody", ORG.alpha],
  ] as const)("%s ne peut pas modifier %s (0 ligne touchée)", async (persona, org) => {
    const result = await rename(persona, org);
    expect(isDenied(result) || rowsOf(result).length === 0).toBe(true);
    const name = rowsOf<{ name: string }>(
      await select("service", `organizations?select=name&id=eq.${org}`),
    )[0]?.name;
    expect(name).not.toBe("Renommée par test");
  });

  it.each(["slug", "status", "id", "created_at"])(
    "la colonne %s n'est modifiable par aucun utilisateur (GRANT par colonne)",
    async (column) => {
      const value =
        column === "status"
          ? "closed"
          : column === "id"
            ? ORG.beta
            : column === "created_at"
              ? "2020-01-01T00:00:00Z"
              : "pirate";
      const result = await api("shared", "PATCH", `organizations?id=eq.${ORG.alpha}`, {
        [column]: value,
      });
      expect(isDenied(result)).toBe(true);
    },
  );

  it("insert et delete d'organisations sont refusés (création par fonction serveur uniquement)", async () => {
    const insert = await api("shared", "POST", "organizations", { name: "Pirate", slug: "pirate" });
    expect(isDenied(insert)).toBe(true);
    const del = await api("shared", "DELETE", `organizations?id=eq.${ORG.alpha}`);
    expect(isDenied(del)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ÉCRITURE sur organization_members — spec §13-2, ADR 014
// ---------------------------------------------------------------------------
describe("organization_members : update", () => {
  const patch = (persona: Persona, org: string, user: string, data: Record<string, unknown>) =>
    api<{ role: string; status: string }[]>(
      persona,
      "PATCH",
      `organization_members?organization_id=eq.${org}&user_id=eq.${user}`,
      data,
    );

  it("owner : change le rôle d'un membre de son entreprise", async () => {
    const result = await patch("shared", ORG.alpha, USER.alphaSales, { role: "marketing_manager" });
    expect(rowsOf<{ role: string }>(result)[0]?.role).toBe("marketing_manager");
  });

  it("admin : change le rôle et suspend un membre non-owner", async () => {
    expect(
      rowsOf(await patch("alphaAdmin", ORG.alpha, USER.alphaSales, { role: "analyst" })),
    ).toHaveLength(1);
    expect(
      rowsOf(await patch("alphaAdmin", ORG.alpha, USER.alphaSales, { status: "suspended" })),
    ).toHaveLength(1);
  });

  it("admin : ne peut pas attribuer le rôle company_owner (WITH CHECK)", async () => {
    const result = await patch("alphaAdmin", ORG.alpha, USER.alphaSales, { role: "company_owner" });
    expect(isDenied(result)).toBe(true);
    expect(
      rowsOf<{ role: string }>(
        await select(
          "service",
          `organization_members?select=role&organization_id=eq.${ORG.alpha}&user_id=eq.${USER.alphaSales}`,
        ),
      )[0]?.role,
    ).toBe("sales_agent");
  });

  it("admin : ne peut pas toucher une ligne owner (USING)", async () => {
    const result = await patch("alphaAdmin", ORG.alpha, USER.shared, { role: "analyst" });
    expect(isDenied(result) || rowsOf(result).length === 0).toBe(true);
    expect(
      rowsOf<{ role: string }>(
        await select(
          "service",
          `organization_members?select=role&organization_id=eq.${ORG.alpha}&user_id=eq.${USER.shared}`,
        ),
      )[0]?.role,
    ).toBe("company_owner");
  });

  it.each(["alphaMarketing", "alphaSales", "alphaAnalyst"] as const)(
    "%s ne peut modifier aucune adhésion, pas même la sienne",
    async (persona) => {
      for (const target of [USER[persona], USER.alphaSales, USER.shared]) {
        const result = await patch(persona, ORG.alpha, target, { role: "company_owner" });
        expect(
          isDenied(result) || rowsOf(result).length === 0,
          `${persona} → ${userKey(target)}`,
        ).toBe(true);
      }
      const roles = rowsOf<{ user_id: string; role: string }>(
        await select(
          "service",
          `organization_members?select=user_id,role&organization_id=eq.${ORG.alpha}`,
        ),
      );
      expect(
        roles.filter((r) => r.role === "company_owner").map((r) => userKey(r.user_id)),
      ).toEqual(["shared"]);
    },
  );

  it("aucun utilisateur ne modifie une adhésion d'une autre entreprise", async () => {
    const cases: [Persona, string, string][] = [
      ["alphaAdmin", ORG.beta, USER.betaAnalyst],
      ["betaOwner", ORG.alpha, USER.alphaAnalyst],
      ["shared", ORG.beta, USER.betaOwner], // shared est seulement sales_agent chez Beta
      ["nobody", ORG.alpha, USER.alphaAnalyst],
    ];
    for (const [persona, org, user] of cases) {
      const result = await patch(persona, org, user, { role: "company_admin" });
      expect(
        isDenied(result) || rowsOf(result).length === 0,
        `${persona} → ${orgSlug(org)}:${userKey(user)}`,
      ).toBe(true);
    }
    expect(
      rowsOf<{ role: string }>(
        await select(
          "service",
          `organization_members?select=role&organization_id=eq.${ORG.beta}&user_id=eq.${USER.betaOwner}`,
        ),
      )[0]?.role,
    ).toBe("company_owner");
  });

  it("owner : ne peut ni déplacer une adhésion vers une autre entreprise ni changer l'utilisateur (GRANT par colonne)", async () => {
    const move = await patch("shared", ORG.alpha, USER.alphaAnalyst, { organization_id: ORG.beta });
    expect(isDenied(move)).toBe(true);
    const swap = await patch("shared", ORG.alpha, USER.alphaAnalyst, { user_id: USER.nobody });
    expect(isDenied(swap)).toBe(true);
  });
});

describe("organization_members : delete", () => {
  const remove = (persona: Persona, org: string, user: string) =>
    api(persona, "DELETE", `organization_members?organization_id=eq.${org}&user_id=eq.${user}`);

  it("owner retire un membre ; admin retire un non-owner", async () => {
    expect(rowsOf(await remove("shared", ORG.alpha, USER.alphaAnalyst))).toHaveLength(1);
    expect(rowsOf(await remove("alphaAdmin", ORG.alpha, USER.alphaSales))).toHaveLength(1);
  });

  it("admin ne retire pas un owner ; les autres rôles ne retirent personne ; rien entre entreprises", async () => {
    const cases: [Persona, string, string][] = [
      ["alphaAdmin", ORG.alpha, USER.shared],
      ["alphaMarketing", ORG.alpha, USER.alphaSales],
      ["alphaSales", ORG.alpha, USER.alphaSales],
      ["alphaAnalyst", ORG.alpha, USER.alphaAnalyst],
      ["alphaAdmin", ORG.beta, USER.betaAnalyst],
      ["betaOwner", ORG.alpha, USER.alphaAnalyst],
      ["shared", ORG.beta, USER.betaAnalyst],
    ];
    for (const [persona, org, user] of cases) {
      const result = await remove(persona, org, user);
      expect(
        isDenied(result) || rowsOf(result).length === 0,
        `${persona} → ${orgSlug(org)}:${userKey(user)}`,
      ).toBe(true);
    }
    const count = rowsOf(await select("service", "organization_members?select=id"));
    expect(count).toHaveLength(8);
  });
});

describe("organization_members : insert", () => {
  it.each(["shared", "alphaAdmin", "betaOwner", "alphaAnalyst", "nobody"] as const)(
    "%s ne peut pas créer d'adhésion via la Data API (création par fonction serveur)",
    async (persona) => {
      const result = await api(persona, "POST", "organization_members", {
        organization_id: ORG.alpha,
        user_id: USER.nobody,
        role: "analyst",
      });
      expect(isDenied(result)).toBe(true);
      expect(rowsOf(await select("service", "organization_members?select=id"))).toHaveLength(8);
    },
  );
});

// ---------------------------------------------------------------------------
// Protection du dernier owner (ADR 007) — s'applique aussi à service_role
// ---------------------------------------------------------------------------
describe("dernier owner actif", () => {
  it("ne peut être ni rétrogradé, ni suspendu, ni retiré", async () => {
    const demote = await api(
      "shared",
      "PATCH",
      `organization_members?organization_id=eq.${ORG.alpha}&user_id=eq.${USER.shared}`,
      { role: "company_admin" },
    );
    expect(demote.status).toBeGreaterThanOrEqual(400);
    const suspend = await api(
      "shared",
      "PATCH",
      `organization_members?organization_id=eq.${ORG.alpha}&user_id=eq.${USER.shared}`,
      { status: "suspended" },
    );
    expect(suspend.status).toBeGreaterThanOrEqual(400);
    const remove = await api(
      "shared",
      "DELETE",
      `organization_members?organization_id=eq.${ORG.alpha}&user_id=eq.${USER.shared}`,
    );
    expect(remove.status).toBeGreaterThanOrEqual(400);
    const viaService = await api(
      "service",
      "PATCH",
      `organization_members?organization_id=eq.${ORG.beta}&user_id=eq.${USER.betaOwner}`,
      { role: "analyst" },
    );
    expect(viaService.status).toBeGreaterThanOrEqual(400);
    const owners = rowsOf<{ user_id: string }>(
      await select(
        "service",
        "organization_members?select=user_id&role=eq.company_owner&status=eq.active",
      ),
    );
    expect(owners.map((o) => userKey(o.user_id)).sort()).toEqual(["betaOwner", "shared"]);
  });

  it("peut être transféré une fois un second owner actif existe", async () => {
    const promote = await api(
      "shared",
      "PATCH",
      `organization_members?organization_id=eq.${ORG.alpha}&user_id=eq.${USER.alphaAdmin}`,
      { role: "company_owner" },
    );
    expect(rowsOf(promote)).toHaveLength(1);
    const demote = await api(
      "shared",
      "PATCH",
      `organization_members?organization_id=eq.${ORG.alpha}&user_id=eq.${USER.shared}`,
      { role: "company_admin" },
    );
    expect(rowsOf(demote)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// subscriptions, usage_counters, plans : lecture seule pour tous les utilisateurs
// ---------------------------------------------------------------------------
describe("tables en lecture seule côté client", () => {
  const writers = ["shared", "alphaAdmin", "betaOwner"] as const;
  const targets = [
    [
      "subscriptions",
      `organization_id=eq.${ORG.alpha}`,
      { status: "active" },
      { organization_id: ORG.alpha, plan_id: "00000000-0000-4000-8000-000000000000" },
    ],
    [
      "usage_counters",
      "metric=like.rlstest_*",
      { value: 999 },
      { organization_id: ORG.alpha, metric: "rlstest_x", period_start: "2026-11-01" },
    ],
    ["plans", "code=eq.trial", { name: "Pirate" }, { code: "pirate", name: "Pirate" }],
  ] as const;

  for (const [table, filter, update, insert] of targets) {
    it.each(writers)(
      `${table} : %s ne peut ni insérer, ni modifier, ni supprimer`,
      async (persona) => {
        expect(isDenied(await api(persona, "POST", table, insert))).toBe(true);
        expect(isDenied(await api(persona, "PATCH", `${table}?${filter}`, update))).toBe(true);
        expect(isDenied(await api(persona, "DELETE", `${table}?${filter}`))).toBe(true);
      },
    );
  }

  it("les valeurs n'ont pas bougé", async () => {
    const sub = rowsOf<{ status: string }>(
      await select("service", `subscriptions?select=status&organization_id=eq.${ORG.alpha}`),
    );
    expect(sub[0]?.status).toBe("trial");
    const usage = rowsOf<{ value: number }>(
      await select("service", `usage_counters?select=value&metric=eq.rlstest_a`),
    );
    expect(usage[0]?.value).toBe(1);
  });
});
