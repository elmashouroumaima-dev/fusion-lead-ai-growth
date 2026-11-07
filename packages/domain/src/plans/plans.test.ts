import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEAR_LIMIT_PERCENT,
  PLAN_CATALOG,
  PLAN_CODES,
  PLAN_METRICS,
  assertWithinLimit,
  effectiveLimit,
  planLimitsSchema,
  setSubscriptionSchema,
  usageRowSchema,
} from "../index";

const ROOT = path.resolve(__dirname, "../../../..");
const migration = readFileSync(path.join(ROOT, "supabase/migrations/20261116100000_plans_quotas.sql"), "utf8");

describe("parité avec la migration SQL", () => {
  it("les limites de chaque plan du catalogue sont celles de la migration", () => {
    for (const code of PLAN_CODES) {
      const re = new RegExp(`\\('${code}'[^\\n]*?'(\\{[^']+\\})'::jsonb|code = '${code}'`);
      const insert = migration.match(new RegExp(`\\('${code}', '[A-Za-z]+', '(\\{[^']+\\})'::jsonb\\)`));
      const update = migration.match(new RegExp(`set limits = '(\\{[^']+\\})'::jsonb\\s*where code = '${code}'`));
      const json = insert?.[1] ?? update?.[1];
      expect(json, `${code} ${re.source.length}`).toBeDefined();
      expect(JSON.parse(json as string)).toEqual(PLAN_CATALOG[code]);
    }
  });

  it("les métriques et le seuil d'alerte sont ceux de la migration", () => {
    for (const metric of PLAN_METRICS) expect(migration).toContain(`'${metric}'`);
    expect(migration).toContain("* 100) >= (v_limit * 80)");
    expect(NEAR_LIMIT_PERCENT).toBe(80);
  });
});

describe("planLimitsSchema", () => {
  it("accepte des clés connues, entiers ≥ 0 ; sous-ensembles autorisés", () => {
    expect(planLimitsSchema.safeParse({}).success).toBe(true);
    expect(planLimitsSchema.safeParse({ users: 0, ai_runs: 12 }).success).toBe(true);
  });
  it("refuse clé inconnue, négatif, décimal, texte, trop grand", () => {
    for (const bad of [{ nope: 1 }, { users: -1 }, { users: 1.5 }, { users: "5" }, { users: 1e13 }, { users: null }]) {
      expect(planLimitsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("effectiveLimit", () => {
  it("la surcharge l'emporte ; clé absente partout = aucune limite ; 0 est une vraie limite", () => {
    expect(effectiveLimit({ users: 3 }, { users: 10 }, "users")).toBe(10);
    expect(effectiveLimit({ users: 3 }, {}, "users")).toBe(3);
    expect(effectiveLimit({}, {}, "users")).toBeNull();
    expect(effectiveLimit({ users: 3 }, { users: 0 }, "users")).toBe(0);
  });
});

describe("assertWithinLimit", () => {
  it("autorise jusqu'à la limite exacte, refuse au-delà sans changer l'usage", () => {
    expect(assertWithinLimit({ used: 199, limit: 200 })).toMatchObject({ allowed: true, used: 200, remaining: 0, nearLimit: true });
    expect(assertWithinLimit({ used: 200, limit: 200 })).toMatchObject({ allowed: false, used: 200, remaining: 0 });
    expect(assertWithinLimit({ used: 190, limit: 200, amount: 11 }).allowed).toBe(false);
  });
  it("alerte à 80 %, pas avant", () => {
    expect(assertWithinLimit({ used: 78, limit: 100 }).nearLimit).toBe(false);
    expect(assertWithinLimit({ used: 79, limit: 100 }).nearLimit).toBe(true);
  });
  it("sans limite : toujours autorisé, jamais d'alerte ; limite 0 : tout est refusé", () => {
    expect(assertWithinLimit({ used: 10 ** 9, limit: null })).toMatchObject({ allowed: true, remaining: null, nearLimit: false });
    expect(assertWithinLimit({ used: 0, limit: 0 }).allowed).toBe(false);
  });
  it("refuse des entrées incohérentes", () => {
    expect(() => assertWithinLimit({ used: -1, limit: 5 })).toThrow();
    expect(() => assertWithinLimit({ used: 1, limit: 5, amount: 0 })).toThrow();
    expect(() => assertWithinLimit({ used: 1.5, limit: 5 })).toThrow();
  });
});

describe("usageRowSchema", () => {
  it("valide une ligne de get_org_usage", () => {
    expect(usageRowSchema.safeParse({ metric: "users", used: 3, limit: 3, near_limit: true }).success).toBe(true);
    expect(usageRowSchema.safeParse({ metric: "users", used: 3, limit: null, near_limit: false }).success).toBe(true);
    expect(usageRowSchema.safeParse({ metric: "autre", used: 3, limit: 3, near_limit: true }).success).toBe(false);
  });
});

describe("setSubscriptionSchema", () => {
  const base = {
    target_organization_id: "11111111-1111-4111-8111-111111111111",
    plan_code: "starter",
    status: "active",
    limits_override: '{"users": 8}',
    reason: "Passage en Starter",
  };
  it("accepte une demande valide (surcharge JSON, date facultative)", () => {
    const r = setSubscriptionSchema.safeParse({ ...base, period_end: "2027-01-31" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limits_override).toEqual({ users: 8 });
    expect(setSubscriptionSchema.safeParse({ ...base, limits_override: "", period_end: "" }).success).toBe(true);
  });
  it("refuse plan inconnu, statut inconnu, surcharge invalide, raison courte, organisation non uuid, champ en trop", () => {
    for (const bad of [
      { plan_code: "gold" }, { status: "free" }, { limits_override: "{" }, { limits_override: '{"users": -2}' },
      { reason: "ok" }, { reason: "x".repeat(201) }, { target_organization_id: "x" }, { organization_id: "11111111-1111-4111-8111-111111111111" },
      { period_end: "31/01/2027" },
    ]) {
      expect(setSubscriptionSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
