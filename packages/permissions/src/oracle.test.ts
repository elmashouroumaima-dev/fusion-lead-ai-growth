import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assignableRoles, can, canManageMember } from "./can";
import { PERMISSION_MATRIX } from "./matrix";
import { ACTIONS, RESOURCES, ROLES, type Action, type PermissionContext, type Resource, type Role } from "./types";

/**
 * ORACLE INDÉPENDANT (J10, agent A4). Le tableau de l'ADR 014 est retranscrit À LA MAIN ci-dessous,
 * sans lire matrix.ts ni l'ADR. Codes de cellule :
 *   Y = ✔   N = ✘   own = `own` (ctx.isOwnRecord)   auth = ✔ ≠auteur (ctx.isAuthor === false)
 *   appr = ✔ si `approved` (ctx.isApproved)   M = ✔ avec garde « jamais un OWN » (ADM, ligne 4)
 * Colonnes : OWN, ADM, MKT, SAL, ANA.
 */
type Cell = "Y" | "N" | "own" | "auth" | "appr" | "M";
const ORACLE_ROLES: readonly Role[] = ["company_owner", "company_admin", "marketing_manager", "sales_agent", "analyst"];

// [ligne ADR, ressources, actions, cellules]
const TABLE: ReadonlyArray<readonly [number, readonly string[], readonly string[], readonly Cell[]]> = [
  [1, ["company"], ["update_settings"], ["Y", "Y", "N", "N", "N"]],
  [2, ["billing"], ["view"], ["Y", "Y", "N", "N", "N"]],
  [3, ["members"], ["list"], ["Y", "Y", "N", "N", "N"]],
  [4, ["members"], ["invite", "change_role", "remove"], ["Y", "M", "N", "N", "N"]],
  [5, ["ownership"], ["transfer"], ["Y", "N", "N", "N", "N"]],
  [6, ["integrations"], ["view_status"], ["Y", "Y", "N", "N", "N"]],
  [7, ["integrations"], ["connect", "replace_secret", "disconnect"], ["Y", "Y", "N", "N", "N"]],
  [8, ["secrets"], ["read_raw"], ["N", "N", "N", "N", "N"]],
  [9, ["sending"], ["emergency_stop"], ["Y", "Y", "Y", "N", "N"]],
  [10, ["projects"], ["read"], ["Y", "Y", "Y", "Y", "Y"]],
  [11, ["projects"], ["create", "update", "archive"], ["Y", "Y", "N", "N", "N"]],
  [12, ["contacts", "leads", "deals"], ["read"], ["Y", "Y", "Y", "own", "N"]],
  [13, ["contacts", "leads"], ["create"], ["Y", "Y", "Y", "Y", "N"]],
  [14, ["leads", "deals"], ["update", "change_stage", "manage_tasks"], ["Y", "Y", "N", "own", "N"]],
  [15, ["unassigned_leads"], ["read"], ["Y", "Y", "Y", "N", "N"]],
  [15, ["unassigned_leads"], ["assign"], ["Y", "Y", "N", "N", "N"]],
  [16, ["assignment_rules", "pipelines", "crm_mappings"], ["manage"], ["Y", "Y", "N", "N", "N"]],
  [17, ["conversations"], ["read"], ["Y", "Y", "N", "own", "N"]],
  [18, ["conversations"], ["reply"], ["Y", "Y", "N", "own", "N"]],
  [19, ["consent"], ["revoke", "mark_do_not_contact"], ["Y", "Y", "Y", "own", "N"]],
  [20, ["campaigns"], ["read"], ["Y", "Y", "Y", "N", "Y"]],
  [21, ["campaigns", "assets", "segments"], ["create", "update", "submit"], ["Y", "Y", "Y", "N", "N"]],
  [22, ["campaigns"], ["approve"], ["auth", "auth", "auth", "N", "N"]],
  [23, ["campaigns"], ["schedule", "pause", "stop"], ["Y", "Y", "appr", "N", "N"]],
  [24, ["ai_agents"], ["request_draft", "request_qualification"], ["Y", "Y", "Y", "own", "N"]],
  [25, ["ai_drafts"], ["use", "send_after_review"], ["Y", "Y", "N", "own", "N"]],
  [26, ["reports"], ["read"], ["Y", "Y", "Y", "N", "Y"]],
  [27, ["audit_log"], ["read"], ["Y", "Y", "N", "N", "N"]],
  [28, ["exports"], ["export"], ["Y", "Y", "N", "N", "N"]],
  [28, ["campaign_results_exports"], ["export"], ["Y", "Y", "Y", "N", "N"]],
  [29, ["alerts", "dead_letter"], ["view"], ["Y", "Y", "N", "N", "N"]],
  [30, ["dead_letter"], ["replay"], ["Y", "Y", "N", "N", "N"]],
  [31, ["organization"], ["delete"], ["Y", "N", "N", "N", "N"]],
  [31, ["records"], ["delete_permanently"], ["Y", "Y", "N", "N", "N"]],
];

const ORACLE = new Map<string, readonly Cell[]>();
for (const [, resources, actions, cells] of TABLE) {
  for (const resource of resources) for (const action of actions) ORACLE.set(`${resource}.${action}`, cells);
}

const TRI = [undefined, true, false] as const;
const ROLE_CTX = [undefined, ...ORACLE_ROLES] as const;

/** Attendu : écrit sans réutiliser can.ts. */
function expected(role: Role, action: string, resource: string, ctx: PermissionContext): boolean {
  const cells = ORACLE.get(`${resource}.${action}`);
  if (!cells) return false;
  const cell = cells[ORACLE_ROLES.indexOf(role)];
  switch (cell) {
    case "Y":
      return true;
    case "N":
      return false;
    case "own":
      return ctx.isOwnRecord === true;
    case "auth":
      return ctx.isAuthor === false;
    case "appr":
      return ctx.isApproved === true;
    case "M": {
      const t = ctx.targetRole;
      const a = ctx.assignedRole;
      if (action === "invite" && a === undefined) return false;
      if (action === "remove" && t === undefined) return false;
      if (action === "change_role" && (t === undefined || a === undefined)) return false;
      return t !== "company_owner" && a !== "company_owner";
    }
    default:
      return false;
  }
}

describe("oracle ADR 014 : couverture du tableau retranscrit", () => {
  it("le tableau retranscrit compte 31 lignes ADR et chaque couple (ressource, action) est unique", () => {
    expect(new Set(TABLE.map((r) => r[0])).size).toBe(31);
    const keys = TABLE.flatMap(([, rs, as]) => rs.flatMap((r) => as.map((a) => `${r}.${a}`)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matrix.ts expose exactement les mêmes couples (ressource, action) que l'oracle", () => {
    const impl = PERMISSION_MATRIX.flatMap((r) => r.resources.flatMap((res) => r.actions.map((a) => `${res}.${a}`)));
    expect([...new Set(impl)].sort()).toEqual([...ORACLE.keys()].sort());
  });

  it("l'ordre des colonnes de l'oracle est celui de l'enum de l'implémentation", () => {
    expect([...ROLES]).toEqual([...ORACLE_ROLES]);
  });
});

describe("oracle ADR 014 : can() sur TOUTES les combinaisons rôle x action x ressource x contexte", () => {
  it("décision identique pour 5 rôles x toutes les actions x toutes les ressources x grille de contextes", () => {
    let checked = 0;
    const mismatches: string[] = [];
    for (const role of ORACLE_ROLES) {
      for (const action of ACTIONS) {
        for (const resource of RESOURCES) {
          for (const isOwnRecord of TRI) {
            for (const isAuthor of TRI) {
              for (const isApproved of TRI) {
                for (const targetRole of ROLE_CTX) {
                  for (const assignedRole of ROLE_CTX) {
                    // Les contextes de rôle ne concernent que « members » : on échantillonne ailleurs.
                    if (resource !== "members" && (targetRole !== undefined || assignedRole !== undefined)) continue;
                    const ctx: PermissionContext = {};
                    if (isOwnRecord !== undefined) ctx.isOwnRecord = isOwnRecord;
                    if (isAuthor !== undefined) ctx.isAuthor = isAuthor;
                    if (isApproved !== undefined) ctx.isApproved = isApproved;
                    if (targetRole !== undefined) ctx.targetRole = targetRole;
                    if (assignedRole !== undefined) ctx.assignedRole = assignedRole;
                    const got = can(role, action, resource, ctx);
                    const want = expected(role, action, resource, ctx);
                    checked++;
                    if (got !== want) mismatches.push(`${role} ${resource}.${action} ${JSON.stringify(ctx)} got=${got}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(20000);
  });

  it("sans contexte (argument omis) : même décision que le contexte vide, fail closed pour own / auteur / approved", () => {
    for (const role of ORACLE_ROLES) {
      for (const [key] of ORACLE) {
        const [resource, action] = key.split(".") as [Resource, Action];
        expect(can(role, action, resource), `${role} ${key}`).toBe(expected(role, action, resource, {}));
      }
    }
    expect(can("sales_agent", "read", "leads")).toBe(false);
    expect(can("company_owner", "approve", "campaigns")).toBe(false);
    expect(can("marketing_manager", "schedule", "campaigns")).toBe(false);
  });

  it("un contexte étranger (own, auteur, approuvé) n'élargit jamais un refus ✘", () => {
    const everything: PermissionContext = { isOwnRecord: true, isAuthor: false, isApproved: true, targetRole: "analyst", assignedRole: "analyst" };
    for (const [key, cells] of ORACLE) {
      const [resource, action] = key.split(".") as [Resource, Action];
      cells.forEach((cell, i) => {
        if (cell === "N") expect(can(ORACLE_ROLES[i] as Role, action, resource, everything), `${key} ${ORACLE_ROLES[i]}`).toBe(false);
      });
    }
  });

  it("exigences testables de la spec §13-2", () => {
    // Analyst n'envoie pas
    expect(can("analyst", "send_after_review", "ai_drafts", { isOwnRecord: true })).toBe(false);
    expect(can("analyst", "reply", "conversations", { isOwnRecord: true })).toBe(false);
    // Sales Agent ne modifie pas les intégrations
    for (const a of ["connect", "replace_secret", "disconnect"] as const) {
      expect(can("sales_agent", a, "integrations", { isOwnRecord: true })).toBe(false);
    }
    // Marketing Manager : pas de planification sans approbation
    expect(can("marketing_manager", "schedule", "campaigns", { isApproved: false })).toBe(false);
    expect(can("marketing_manager", "schedule", "campaigns", { isApproved: true })).toBe(true);
    // Personne ne lit les secrets bruts
    for (const r of ORACLE_ROLES) expect(can(r, "read_raw", "secrets", { isOwnRecord: true, isApproved: true, isAuthor: false })).toBe(false);
  });
});

describe("fail closed : entrées inconnues ou hostiles", () => {
  const bad = ["", " ", "COMPANY_OWNER", "company_owner ", "admin", "platform_admin", "__proto__", "constructor", "toString", "hasOwnProperty"];

  it("rôle inconnu -> false pour toutes les cases", () => {
    for (const role of bad) {
      for (const [key] of ORACLE) {
        const [resource, action] = key.split(".") as [Resource, Action];
        expect(can(role as Role, action, resource, { isOwnRecord: true, isAuthor: false, isApproved: true }), `${role} ${key}`).toBe(false);
      }
    }
  });

  it("action ou ressource inconnue -> false, y compris les noms du prototype d'Object", () => {
    for (const x of bad) {
      expect(can("company_owner", x as Action, "members")).toBe(false);
      expect(can("company_owner", "list", x as Resource)).toBe(false);
      expect(can("company_owner", x as Action, x as Resource)).toBe(false);
    }
    expect(can("company_owner", "list", "billing")).toBe(false); // action existante sur une autre ressource
    expect(can("company_owner", "view", "members")).toBe(false);
  });

  it("types non textuels -> false (jamais d'exception)", () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], ["company_owner"]]) {
      expect(can(v as unknown as Role, "list", "members")).toBe(false);
      expect(can("company_owner", v as unknown as Action, "members")).toBe(false);
      expect(can("company_owner", "list", v as unknown as Resource)).toBe(false);
    }
  });

  it("rôle inconnu dans le contexte membre -> false même pour OWN", () => {
    expect(can("company_owner", "invite", "members", { assignedRole: "god" as Role })).toBe(false);
    expect(can("company_owner", "remove", "members", { targetRole: "root" as Role })).toBe(false);
    expect(can("company_owner", "change_role", "members", { targetRole: "analyst", assignedRole: "__proto__" as Role })).toBe(false);
  });
});

describe("règles de gestion des membres (admin jamais sur / vers owner)", () => {
  const oracleManage = (actor: Role, target: Role, next?: Role): boolean => {
    if (actor === "company_owner") return true;
    if (actor === "company_admin") return target !== "company_owner" && next !== "company_owner";
    return false;
  };

  it("canManageMember : exhaustif 5 x 5 x (retrait + 5 nouveaux rôles)", () => {
    for (const actor of ORACLE_ROLES) {
      for (const target of ORACLE_ROLES) {
        expect(canManageMember(actor, target), `${actor} retire ${target}`).toBe(oracleManage(actor, target));
        for (const next of ORACLE_ROLES) {
          expect(canManageMember(actor, target, next), `${actor} ${target}->${next}`).toBe(oracleManage(actor, target, next));
        }
      }
    }
  });

  it("canManageMember : entrées invalides -> false", () => {
    expect(canManageMember("nope" as Role, "analyst")).toBe(false);
    expect(canManageMember("company_owner", "nope" as Role)).toBe(false);
    expect(canManageMember("company_owner", "analyst", "nope" as Role)).toBe(false);
    expect(canManageMember(undefined as unknown as Role, "analyst")).toBe(false);
  });

  it("assignableRoles : exactement la liste attendue, jamais company_owner pour un admin", () => {
    expect(assignableRoles("company_owner")).toEqual(["company_owner", "company_admin", "marketing_manager", "sales_agent", "analyst"]);
    expect(assignableRoles("company_admin")).toEqual(["company_admin", "marketing_manager", "sales_agent", "analyst"]);
    for (const r of ["marketing_manager", "sales_agent", "analyst"] as const) expect(assignableRoles(r)).toEqual([]);
    expect(assignableRoles("zz" as Role)).toEqual([]);
    expect(assignableRoles("__proto__" as Role)).toEqual([]);
  });

  it("seul l'owner transfère la propriété ou promeut / retire un owner", () => {
    for (const r of ORACLE_ROLES) {
      expect(can(r, "transfer", "ownership"), r).toBe(r === "company_owner");
      expect(can(r, "invite", "members", { assignedRole: "company_owner" }), r).toBe(r === "company_owner");
      expect(can(r, "change_role", "members", { targetRole: "analyst", assignedRole: "company_owner" }), r).toBe(r === "company_owner");
      expect(can(r, "remove", "members", { targetRole: "company_owner" }), r).toBe(r === "company_owner");
    }
  });
});

describe("Role <-> enum SQL app_role (lu dans les migrations, indépendamment de domain)", () => {
  it("les valeurs de l'enum public.app_role sont exactement ROLES", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    const create = /create\s+type\s+public\.app_role\s+as\s+enum\s*\(([^)]*)\)/i.exec(sql);
    expect(create, "enum app_role introuvable").not.toBeNull();
    const created = [...(create?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const added = [...sql.matchAll(/alter\s+type\s+public\.app_role\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([a-z_]+)'/gi)].map((m) => m[1]);
    expect([...created, ...added].sort()).toEqual([...ROLES].sort());
  });
});
