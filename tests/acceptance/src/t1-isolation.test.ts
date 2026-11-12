import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, psql, restoreFixtures, rowsOf, select, snapshotFixtures, USER, type Persona, type Snapshot } from "../../../supabase/tests/rls/src/harness";
import { getPage, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * T1 (docs/testing/strategy.md §5, spec §13-1) : deux entreprises (Alpha, Beta), un utilisateur à deux rôles
 * (`shared` : owner d'Alpha, sales agent de Beta). Aucune fuite sur : RLS / API (Data API réelle), worker
 * (file de jobs) et pages de l'application (HTTP). Les tables tenant sont DÉCOUVERTES dans le catalogue :
 * une table ajoutée plus tard (projets, contacts...) est couverte sans modifier ce fichier.
 */

const A = ORG.alpha;
const B = ORG.beta;
const SINGLE: { persona: Persona; own: string; other: string }[] = [
  { persona: "alphaAdmin", own: A, other: B },
  { persona: "alphaMarketing", own: A, other: B },
  { persona: "alphaSales", own: A, other: B },
  { persona: "alphaAnalyst", own: A, other: B },
  { persona: "betaOwner", own: B, other: A },
  { persona: "betaAnalyst", own: B, other: A },
];
const allowed = (persona: Persona): string[] => {
  if (persona === "shared") return [A, B];
  const single = SINGLE.find((s) => s.persona === persona);
  return single ? [single.own] : [];
};

// --- Tables tenant : colonne organization_id dans le schéma public (+ organizations elle-même, par id) ---
const tenantTables: string[] = psql(
  "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' order by 1",
)
  .split("\n")
  .filter(Boolean);
const idColumn = (table: string): string => (table === "organizations" ? "id" : "organization_id");
const tables = ["organizations", ...tenantTables];

describe("T1 · RLS et API : ce que chaque utilisateur peut lire", () => {
  it("la découverte trouve les tables du noyau (garde contre un test vide)", () => {
    for (const t of ["organization_members", "subscriptions", "usage_counters", "invitations", "audit_logs", "jobs", "projects", "products"]) {
      expect(tenantTables).toContain(t);
    }
  });

  const personas: Persona[] = ["shared", ...SINGLE.map((s) => s.persona)];
  for (const persona of personas) {
    it(`${persona} : sur toute table tenant, aucune ligne hors de ses entreprises`, async () => {
      for (const table of tables) {
        const result = await select<Record<string, unknown>>(persona, `${table}?select=*&limit=1000`);
        for (const row of rowsOf<Record<string, unknown>>(result)) {
          expect(allowed(persona), `${persona} lit une ligne étrangère dans ${table}`).toContain(String(row[idColumn(table)]));
        }
      }
    });
  }

  it("garde anti-test creux : un admin d'Alpha voit réellement les adhésions d'Alpha", async () => {
    const rows = rowsOf<{ organization_id: string }>(await select("alphaAdmin", "organization_members?select=organization_id"));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.organization_id))).toEqual(new Set([A]));
  });

  it("un utilisateur à deux rôles voit ses deux entreprises, et personne d'autre", async () => {
    const orgs = rowsOf<{ id: string }>(await select("shared", "organizations?select=id"));
    expect(new Set(orgs.map((o) => o.id))).toEqual(new Set([A, B]));
  });

  for (const { persona, own, other } of SINGLE) {
    it(`${persona} : changer l'identifiant d'entreprise dans le filtre ne révèle rien`, async () => {
      for (const table of tables) {
        const filter = `${idColumn(table)}=eq.${other}`;
        expect(rowsOf(await select(persona, `${table}?select=*&${filter}`)), `${table} via ${filter}`).toEqual([]);
      }
      // Garde : le même filtre sur sa propre entreprise reste lisible (le test n'est pas vacueux).
      expect(rowsOf(await select(persona, `organizations?select=id&id=eq.${own}`))).toHaveLength(1);
    });
  }

  it("anonyme et compte sans adhésion : rien sur aucune table tenant", async () => {
    for (const table of tables) {
      const anon = await select("anon", `${table}?select=*&limit=5`);
      expect(isDenied(anon) || rowsOf(anon).length === 0, `anon sur ${table}`).toBe(true);
      expect(rowsOf(await select("nobody", `${table}?select=*&limit=5`)), `nobody sur ${table}`).toEqual([]);
    }
  });
});

describe("T1 · RLS et API : écritures vers l'autre entreprise", () => {
  let snapshot: Snapshot;
  beforeAll(async () => {
    snapshot = await snapshotFixtures();
  });
  afterAll(async () => {
    await restoreFixtures(snapshot);
  });

  it("l'admin d'Alpha ne modifie, ne déplace ni ne supprime rien chez Beta", async () => {
    expect(rowsOf(await api("alphaAdmin", "PATCH", `organizations?id=eq.${B}`, { name: "piraté" }))).toEqual([]);
    expect(rowsOf(await api("alphaAdmin", "DELETE", `organization_members?organization_id=eq.${B}`))).toEqual([]);
    const insert = await api("alphaAdmin", "POST", "organization_members", { organization_id: B, user_id: USER.alphaAdmin, role: "analyst" });
    expect(insert.status).toBeGreaterThanOrEqual(400);
    const ownRow = rowsOf<{ id: string }>(await select("alphaAdmin", `organization_members?select=id&user_id=eq.${USER.alphaSales}`))[0];
    expect(ownRow).toBeDefined();
    const moved = await api("alphaAdmin", "PATCH", `organization_members?id=eq.${ownRow?.id ?? ""}`, { organization_id: B });
    expect(moved.status).toBeGreaterThanOrEqual(400);
    const after = rowsOf<{ name: string }>(await select("service", `organizations?select=name&id=eq.${B}`));
    expect(after[0]?.name).toBe("Beta");
  });

  it("le propriétaire de Beta ne modifie rien chez Alpha", async () => {
    expect(rowsOf(await api("betaOwner", "PATCH", `organizations?id=eq.${A}`, { name: "piraté" }))).toEqual([]);
    expect(rowsOf(await api("betaOwner", "DELETE", `organization_members?organization_id=eq.${A}`))).toEqual([]);
    expect(rowsOf<{ name: string }>(await select("service", `organizations?select=name&id=eq.${A}`))[0]?.name).toBe("Alpha");
  });

  it("l'utilisateur à deux rôles : écrit chez Alpha (owner), pas chez Beta (sales agent)", async () => {
    expect(rowsOf(await api("shared", "PATCH", `organizations?id=eq.${B}`, { name: "piraté" }))).toEqual([]);
    const own = await api("shared", "PATCH", `organizations?id=eq.${A}`, { timezone: "Africa/Casablanca" });
    expect(own.status).toBeLessThan(300);
    expect(rowsOf(own)).toHaveLength(1);
    const insert = await api("shared", "POST", "organization_members", { organization_id: B, user_id: USER.nobody, role: "analyst" });
    expect(insert.status).toBeGreaterThanOrEqual(400);
  });
});

describe("T1 · worker : la file de jobs ne mélange pas les entreprises", () => {
  const prefix = `t1-${Date.now().toString(36)}`;
  const svc = <T = unknown>(fn: string, args: Record<string, unknown>) => api<T>("service", "POST", `rpc/${fn}`, args);
  afterAll(() => {
    psql(`delete from public.jobs where idempotency_key like '${prefix}%'`);
  });

  it("chaque job réclamé garde son entreprise ; aucun utilisateur ne lit ni ne réclame la file", async () => {
    psql("delete from public.jobs where status in ('queued', 'running')");
    const ids = new Map<string, string>();
    for (const [name, org] of [["a", A], ["b", B]] as const) {
      for (let i = 0; i < 3; i++) {
        const created = await svc<string>("enqueue_job", { p_org: org, p_kind: "noop", p_payload: {}, p_idempotency_key: `${prefix}-${name}${i}` });
        expect(created.status).toBe(200);
        ids.set(String(created.body), org);
      }
    }
    for (const persona of ["shared", "alphaAdmin", "betaOwner", "alphaAnalyst"] as const) {
      // Owner / admin lisent les jobs de LEUR entreprise (jobs.test.ts) ; jamais ceux de l'autre.
      const direct = await select<{ organization_id: string }>(persona, "jobs?select=organization_id");
      for (const row of rowsOf<{ organization_id: string }>(direct)) {
        expect(allowed(persona), `${persona} lit un job étranger`).toContain(row.organization_id);
      }
      const stolen = await api(persona, "POST", "rpc/claim_jobs", { p_worker: "intrus", p_limit: 10, p_lease_seconds: 60 });
      expect(stolen.status).toBeGreaterThanOrEqual(400);
    }
    const claimed = rowsOf<{ id: string; organization_id: string }>(await svc("claim_jobs", { p_worker: `${prefix}-w`, p_limit: 10, p_lease_seconds: 60 }));
    expect(claimed).toHaveLength(6);
    for (const job of claimed) expect(job.organization_id, `job ${job.id}`).toBe(ids.get(job.id));
  });
});

describe("T1 · application : pages protégées par HTTP", () => {
  const sessions = new Map<string, Session>();
  beforeAll(async () => {
    for (const name of ["alpha-admin", "alpha-analyst", "alpha-sales", "beta-owner", "shared"]) {
      sessions.set(name, await signIn(`${name}@seed.test`));
    }
  });
  const as = (name: string): Session => {
    const session = sessions.get(name);
    if (!session) throw new Error(`session absente : ${name}`);
    return session;
  };

  it("sans session : redirection vers la connexion, aucune donnée", async () => {
    for (const p of ["/fr/members", "/fr/dashboard", "/fr/admin/organizations", "/fr/settings/smtp"]) {
      const page = await getPage(null, p);
      expect(page.status).toBe(307);
      expect(redirectPath(page)).toBe("/fr/login");
    }
  });

  it("l'admin d'Alpha voit la page Membres d'Alpha, sans trace de Beta", async () => {
    const page = await getPage(as("alpha-admin"), "/fr/members");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(B);
    expect(visibleText(page)).toContain("Alpha"); // garde anti-test creux : la page affiche bien son entreprise
    expect(visibleText(page)).not.toContain("Beta");
  });

  it("le propriétaire de Beta ne voit rien d'Alpha ; son indice vers Alpha est refusé", async () => {
    const own = await getPage(as("beta-owner"), "/fr/members");
    expect(own.status).toBe(200);
    expect(own.body).not.toContain(A);
    expect(visibleText(own)).not.toContain("Alpha");
    const forged = await getPage(as("beta-owner"), "/fr/members", A);
    expect(forged.status).toBe(307);
    expect(redirectPath(forged)).toBe("/fr/select-organization");
    expect(forged.body).not.toContain(A);
  });

  it("l'admin d'Alpha avec un indice vers Beta : refusé", async () => {
    const page = await getPage(as("alpha-admin"), "/fr/members", B);
    expect(page.status).toBe(307);
    expect(redirectPath(page)).toBe("/fr/select-organization");
    expect(page.body).not.toContain(B);
  });

  it("rôles (spec §13-2) : analyste et sales agent n'accèdent pas à Membres ; personne d'Alpha n'entre dans l'administration de la plateforme", async () => {
    for (const name of ["alpha-analyst", "alpha-sales"]) {
      const members = await getPage(as(name), "/fr/members");
      expect(members.status, name).toBe(307);
      expect(redirectPath(members), name).toBe("/fr/dashboard");
    }
    for (const name of ["alpha-analyst", "alpha-sales", "beta-owner"]) {
      const admin = await getPage(as(name), "/fr/admin/organizations");
      expect(admin.status, name).toBe(307);
      expect(visibleText(admin), name).not.toContain("Alpha");
      const smtp = await getPage(as(name), "/fr/settings/smtp");
      expect(smtp.status, name).toBe(307);
    }
  });
});
