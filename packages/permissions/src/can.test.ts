import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROLES } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import { assignableRoles, can, canManageMember } from "./can";
import { PERMISSION_MATRIX } from "./matrix";
import { ACTIONS, RESOURCES, ROLES, type Action, type PermissionContext, type Resource, type Role } from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// ---------------------------------------------------------------------------
// Source de vérité externe : le tableau de l'ADR 014 et les migrations SQL.
// ---------------------------------------------------------------------------
const adr = readFileSync(path.join(ROOT, "docs/adr/014-rbac-matrix.md"), "utf8");

function adrRows(): { label: string; cells: string[] }[] {
  const start = adr.indexOf("| Ressource / action");
  const end = adr.indexOf("\n## ", start);
  const lines = adr
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2); // en-tête + séparateur
  return lines.map((line) => {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const label = /\*\*(.+?)\*\*/.exec(cells[0] ?? "")?.[1] ?? "";
    return { label, cells: cells.slice(1, 6) };
  });
}

describe("matrice : fidélité à l'ADR 014", () => {
  const rows = adrRows();

  it("couvre CHAQUE ligne du tableau de l'ADR, dans l'ordre, sans trou", () => {
    expect(rows.length).toBe(31);
    const covered = [...new Set(PERMISSION_MATRIX.map((r) => r.adrRow))].sort((a, b) => a - b);
    expect(covered).toEqual(rows.map((_r, i) => i + 1));
  });

  it("le libellé de ressource de chaque règle figure dans la ligne correspondante de l'ADR", () => {
    for (const r of PERMISSION_MATRIX) {
      const label = rows[r.adrRow - 1]?.label ?? "";
      expect(label, `ligne ${r.adrRow}`).toContain(r.adrLabel.split(" /")[0]?.split(",")[0] ?? "?");
    }
  });

  it("chaque case ✘ de l'ADR est un refus pour toutes les règles de la ligne ; chaque case ✔/own autorise au moins une règle", () => {
    rows.forEach((row, i) => {
      const rules = PERMISSION_MATRIX.filter((r) => r.adrRow === i + 1);
      expect(rules.length, `ligne ${i + 1}`).toBeGreaterThan(0);
      row.cells.forEach((cell, c) => {
        const role = ROLES[c];
        if (!role) throw new Error("colonne inattendue");
        const denied = cell.startsWith("✘");
        const grants = rules.map((r) => r.grants[role]);
        if (denied) expect(grants.every((x) => x === "deny"), `ligne ${i + 1} ${role}`).toBe(true);
        else expect(grants.some((x) => x !== "deny"), `ligne ${i + 1} ${role}`).toBe(true);
        if (cell === "`own`") expect(grants, `ligne ${i + 1} ${role}`).toContain("own");
        if (cell.includes("≠auteur")) expect(grants, `ligne ${i + 1} ${role}`).toContain("not_author");
      });
    });
  });

  it("une même paire ressource/action n'apparaît qu'une fois", () => {
    const seen = new Set<string>();
    for (const r of PERMISSION_MATRIX) {
      for (const res of r.resources) {
        for (const act of r.actions) {
          const key = `${res}.${act}`;
          expect(seen.has(key), key).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it("tous les identifiants de ressource et d'action de la matrice sont déclarés", () => {
    for (const r of PERMISSION_MATRIX) {
      for (const res of r.resources) expect(RESOURCES).toContain(res);
      for (const act of r.actions) expect(ACTIONS).toContain(act);
    }
    const used = new Set(PERMISSION_MATRIX.flatMap((r) => r.resources));
    expect(RESOURCES.filter((x) => !used.has(x))).toEqual([]);
  });
});

describe("Role : égal à l'enum app_role des migrations", () => {
  it("ROLES (et APP_ROLES du domaine) == valeurs de public.app_role dans supabase/migrations", () => {
    const dir = path.join(ROOT, "supabase/migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    const created = /create type public\.app_role as enum \(([^)]*)\)/i.exec(sql);
    expect(created, "enum app_role introuvable").not.toBeNull();
    const values = [...(created?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    for (const m of sql.matchAll(/alter type public\.app_role add value (?:if not exists )?'([a-z_]+)'/gi)) {
      values.push(m[1] as string);
    }
    expect([...ROLES].sort()).toEqual([...values].sort());
    expect([...APP_ROLES].sort()).toEqual([...ROLES].sort());
  });
});

// ---------------------------------------------------------------------------
// Attendus indépendants de l'implémentation, écrits à la main depuis l'ADR (contexte favorable).
// Format : "ressource.action" -> rôles autorisés SANS contexte particulier.
// ---------------------------------------------------------------------------
const OWN = "company_owner";
const ADM = "company_admin";
const MKT = "marketing_manager";
const SAL = "sales_agent";
const ANA = "analyst";
const ALL: Role[] = [OWN, ADM, MKT, SAL, ANA];

const UNCONDITIONAL: Record<string, Role[]> = {
  "company.update_settings": [OWN, ADM],
  "billing.view": [OWN, ADM],
  "members.list": [OWN, ADM],
  "integrations.view_status": [OWN, ADM],
  "integrations.connect": [OWN, ADM],
  "integrations.replace_secret": [OWN, ADM],
  "integrations.disconnect": [OWN, ADM],
  "secrets.read_raw": [],
  "sending.emergency_stop": [OWN, ADM, MKT],
  "projects.read": ALL,
  "projects.create": [OWN, ADM],
  "projects.update": [OWN, ADM],
  "projects.archive": [OWN, ADM],
  "contacts.read": [OWN, ADM, MKT],
  "leads.read": [OWN, ADM, MKT],
  "deals.read": [OWN, ADM, MKT],
  "contacts.create": [OWN, ADM, MKT, SAL],
  "leads.create": [OWN, ADM, MKT, SAL],
  "leads.update": [OWN, ADM],
  "leads.change_stage": [OWN, ADM],
  "leads.manage_tasks": [OWN, ADM],
  "deals.update": [OWN, ADM],
  "deals.change_stage": [OWN, ADM],
  "deals.manage_tasks": [OWN, ADM],
  "unassigned_leads.read": [OWN, ADM, MKT],
  "unassigned_leads.assign": [OWN, ADM],
  "assignment_rules.manage": [OWN, ADM],
  "pipelines.manage": [OWN, ADM],
  "crm_mappings.manage": [OWN, ADM],
  "conversations.read": [OWN, ADM],
  "conversations.reply": [OWN, ADM],
  "consent.revoke": [OWN, ADM, MKT],
  "consent.mark_do_not_contact": [OWN, ADM, MKT],
  "campaigns.read": [OWN, ADM, MKT, ANA],
  "campaigns.create": [OWN, ADM, MKT],
  "campaigns.update": [OWN, ADM, MKT],
  "campaigns.submit": [OWN, ADM, MKT],
  "assets.create": [OWN, ADM, MKT],
  "assets.update": [OWN, ADM, MKT],
  "assets.submit": [OWN, ADM, MKT],
  "segments.create": [OWN, ADM, MKT],
  "segments.update": [OWN, ADM, MKT],
  "segments.submit": [OWN, ADM, MKT],
  "campaigns.approve": [],
  "campaigns.schedule": [OWN, ADM],
  "campaigns.pause": [OWN, ADM],
  "campaigns.stop": [OWN, ADM],
  "ai_agents.request_draft": [OWN, ADM, MKT],
  "ai_agents.request_qualification": [OWN, ADM, MKT],
  "ai_drafts.use": [OWN, ADM],
  "ai_drafts.send_after_review": [OWN, ADM],
  "reports.read": [OWN, ADM, MKT, ANA],
  "audit_log.read": [OWN, ADM],
  "exports.export": [OWN, ADM],
  "campaign_results_exports.export": [OWN, ADM, MKT],
  "alerts.view": [OWN, ADM],
  "dead_letter.view": [OWN, ADM],
  "dead_letter.replay": [OWN, ADM],
  "organization.delete": [OWN],
  "records.delete_permanently": [OWN, ADM],
  "ownership.transfer": [OWN],
};

// Actions membres (invite / change_role / remove) : dépendent du contexte, testées dans leur propre bloc.
const MEMBER_ACTIONS = ["invite", "change_role", "remove"] as const;

describe("can() : tableau rôle × action × ressource (sans contexte)", () => {
  const cases = Object.entries(UNCONDITIONAL).flatMap(([key, allowed]) =>
    ALL.map((role) => [key, role, allowed.includes(role)] as const),
  );

  it("couvre toutes les paires de la matrice hors membres (invite/changement/retrait) et hors attendus manuels", () => {
    const declared = new Set(
      PERMISSION_MATRIX.flatMap((r) => r.resources.flatMap((res) => r.actions.map((a) => `${res}.${a}`))),
    );
    for (const m of MEMBER_ACTIONS) declared.delete(`members.${m}`);
    const manual = new Set(Object.keys(UNCONDITIONAL));
    expect([...declared].filter((k) => !manual.has(k))).toEqual([]);
    expect([...manual].filter((k) => !declared.has(k))).toEqual([]);
  });

  it.each(cases)("%s / %s -> %s", (key, role, expected) => {
    const [resource, action] = key.split(".") as [Resource, Action];
    expect(can(role, action, resource)).toBe(expected);
  });
});

describe("can() : cellules `own`", () => {
  const OWN_CELLS: [Resource, Action][] = [
    ["contacts", "read"],
    ["leads", "read"],
    ["deals", "read"],
    ["leads", "update"],
    ["leads", "change_stage"],
    ["leads", "manage_tasks"],
    ["deals", "update"],
    ["deals", "change_stage"],
    ["deals", "manage_tasks"],
    ["conversations", "read"],
    ["conversations", "reply"],
    ["consent", "revoke"],
    ["consent", "mark_do_not_contact"],
    ["ai_agents", "request_draft"],
    ["ai_agents", "request_qualification"],
    ["ai_drafts", "use"],
    ["ai_drafts", "send_after_review"],
  ];

  it.each(OWN_CELLS)("sales_agent %s.%s : refusé sans isOwnRecord, accepté avec", (resource, action) => {
    expect(can(SAL, action, resource)).toBe(false);
    expect(can(SAL, action, resource, {})).toBe(false);
    expect(can(SAL, action, resource, { isOwnRecord: false })).toBe(false);
    expect(can(SAL, action, resource, { isOwnRecord: true })).toBe(true);
  });

  it.each(OWN_CELLS)("isOwnRecord ne donne rien à analyst / marketing sur %s.%s quand la cellule est ✘", (resource, action) => {
    expect(can(ANA, action, resource, { isOwnRecord: true })).toBe(false);
  });

  it("marketing_manager ne lit/écrit pas les conversations ni les leads même 'own'", () => {
    expect(can(MKT, "read", "conversations", { isOwnRecord: true })).toBe(false);
    expect(can(MKT, "update", "leads", { isOwnRecord: true })).toBe(false);
  });
});

describe("can() : approbation (≠ auteur) et planification (si approved)", () => {
  it.each([OWN, ADM, MKT] as const)("%s approuve seulement si isAuthor === false", (role) => {
    expect(can(role, "approve", "campaigns")).toBe(false);
    expect(can(role, "approve", "campaigns", {})).toBe(false);
    expect(can(role, "approve", "campaigns", { isAuthor: true })).toBe(false);
    expect(can(role, "approve", "campaigns", { isAuthor: false })).toBe(true);
  });

  it.each([SAL, ANA] as const)("%s n'approuve jamais", (role) => {
    expect(can(role, "approve", "campaigns", { isAuthor: false })).toBe(false);
  });

  it.each(["schedule", "pause", "stop"] as const)("marketing_manager %s seulement si approved", (action) => {
    expect(can(MKT, action, "campaigns")).toBe(false);
    expect(can(MKT, action, "campaigns", { isApproved: false })).toBe(false);
    expect(can(MKT, action, "campaigns", { isApproved: true })).toBe(true);
    expect(can(SAL, action, "campaigns", { isApproved: true })).toBe(false);
    expect(can(ANA, action, "campaigns", { isApproved: true })).toBe(false);
  });
});

describe("contraintes testables de la spec §13-2", () => {
  it("Analyst n'envoie pas (réponse, brouillon IA, arrêt/planification de campagne)", () => {
    expect(can(ANA, "reply", "conversations", { isOwnRecord: true })).toBe(false);
    expect(can(ANA, "send_after_review", "ai_drafts", { isOwnRecord: true })).toBe(false);
    expect(can(ANA, "schedule", "campaigns", { isApproved: true })).toBe(false);
  });
  it("Sales Agent ne modifie pas les intégrations", () => {
    for (const a of ["connect", "replace_secret", "disconnect", "view_status"] as const) {
      expect(can(SAL, a, "integrations")).toBe(false);
    }
  });
  it("Marketing Manager n'envoie qu'après approbation", () => {
    expect(can(MKT, "schedule", "campaigns", { isApproved: false })).toBe(false);
    expect(can(MKT, "schedule", "campaigns", { isApproved: true })).toBe(true);
  });
  it("seul le Company Owner transfère la propriété ; Company Admin ne le peut pas", () => {
    expect(can(OWN, "transfer", "ownership")).toBe(true);
    for (const r of [ADM, MKT, SAL, ANA] as const) expect(can(r, "transfer", "ownership")).toBe(false);
  });
  it("personne ne lit un secret brut", () => {
    for (const r of ALL) expect(can(r, "read_raw", "secrets", { isOwnRecord: true, isAuthor: false })).toBe(false);
  });
});

describe("membres : règles Owner / Admin", () => {
  it("company_owner gère tous les rôles, sans contexte ou avec", () => {
    for (const a of MEMBER_ACTIONS) expect(can(OWN, a, "members")).toBe(true);
    for (const target of ROLES) {
      for (const assigned of ROLES) {
        expect(can(OWN, "change_role", "members", { targetRole: target, assignedRole: assigned })).toBe(true);
        expect(can(OWN, "invite", "members", { assignedRole: assigned })).toBe(true);
      }
      expect(can(OWN, "remove", "members", { targetRole: target })).toBe(true);
    }
  });

  it("company_admin : jamais un Owner, ne peut pas attribuer Owner", () => {
    expect(can(ADM, "invite", "members", { assignedRole: OWN })).toBe(false);
    expect(can(ADM, "remove", "members", { targetRole: OWN })).toBe(false);
    expect(can(ADM, "change_role", "members", { targetRole: OWN, assignedRole: ADM })).toBe(false);
    expect(can(ADM, "change_role", "members", { targetRole: MKT, assignedRole: OWN })).toBe(false);
    expect(can(ADM, "change_role", "members", { targetRole: MKT, assignedRole: ANA })).toBe(true);
    expect(can(ADM, "invite", "members", { assignedRole: SAL })).toBe(true);
    expect(can(ADM, "remove", "members", { targetRole: ADM })).toBe(true);
  });

  it("company_admin sans contexte : fail closed pour invite / change_role / remove", () => {
    expect(can(ADM, "invite", "members")).toBe(false);
    expect(can(ADM, "remove", "members")).toBe(false);
    expect(can(ADM, "change_role", "members")).toBe(false);
    expect(can(ADM, "change_role", "members", { targetRole: MKT })).toBe(false);
    expect(can(ADM, "change_role", "members", { assignedRole: MKT })).toBe(false);
  });

  it("autres rôles : jamais, quel que soit le contexte", () => {
    for (const r of [MKT, SAL, ANA] as const) {
      for (const a of MEMBER_ACTIONS) {
        expect(can(r, a, "members", { targetRole: ANA, assignedRole: ANA, isOwnRecord: true })).toBe(false);
      }
    }
  });

  it("un rôle inconnu dans le contexte ferme l'accès, même pour Owner", () => {
    const bad = { assignedRole: "root" } as unknown as PermissionContext;
    expect(can(OWN, "invite", "members", bad)).toBe(false);
    expect(can(ADM, "invite", "members", bad)).toBe(false);
  });

  it.each(ROLES)("canManageMember(company_admin, %s) : refusé uniquement pour Owner", (target) => {
    expect(canManageMember(ADM, target)).toBe(target !== OWN);
    for (const next of ROLES) expect(canManageMember(ADM, target, next)).toBe(target !== OWN && next !== OWN);
  });

  it("canManageMember : owner partout, les autres rôles jamais", () => {
    for (const t of ROLES) {
      expect(canManageMember(OWN, t)).toBe(true);
      for (const n of ROLES) expect(canManageMember(OWN, t, n)).toBe(true);
      for (const r of [MKT, SAL, ANA] as const) {
        expect(canManageMember(r, t)).toBe(false);
        expect(canManageMember(r, t, ANA)).toBe(false);
      }
    }
  });

  it("assignableRoles", () => {
    expect(assignableRoles(OWN)).toEqual([...ROLES]);
    expect(assignableRoles(ADM)).toEqual([ADM, MKT, SAL, ANA]);
    expect(assignableRoles(ADM)).not.toContain(OWN);
    expect(assignableRoles(MKT)).toEqual([]);
    expect(assignableRoles(SAL)).toEqual([]);
    expect(assignableRoles(ANA)).toEqual([]);
  });
});

describe("fail closed : entrées inconnues", () => {
  it("rôle inconnu ou polluant -> false", () => {
    for (const bad of ["", "root", "COMPANY_OWNER", "platform_admin", "__proto__", "constructor", "toString"]) {
      expect(can(bad as Role, "list", "members")).toBe(false);
      expect(canManageMember(bad as Role, ANA)).toBe(false);
      expect(assignableRoles(bad as Role)).toEqual([]);
    }
    expect(can(undefined as unknown as Role, "list", "members")).toBe(false);
    expect(can(null as unknown as Role, "list", "members")).toBe(false);
  });

  it("action ou ressource inconnue -> false pour tous les rôles", () => {
    for (const r of ALL) {
      expect(can(r, "nope" as Action, "members")).toBe(false);
      expect(can(r, "list", "nope" as Resource)).toBe(false);
      expect(can(r, "__proto__" as Action, "__proto__" as Resource)).toBe(false);
      expect(can(r, "list", "billing")).toBe(false);
    }
  });

  it("une paire valide mais absente de la matrice est refusée (ex. members.view)", () => {
    for (const r of ALL) expect(can(r, "view", "members")).toBe(false);
  });

  it("canManageMember : rôle cible ou nouveau rôle inconnu -> false", () => {
    expect(canManageMember(OWN, "root" as Role)).toBe(false);
    expect(canManageMember(OWN, ANA, "root" as Role)).toBe(false);
  });
});

describe("matrice : immuable", () => {
  it("les règles et leurs cellules sont gelées", () => {
    expect(Object.isFrozen(PERMISSION_MATRIX)).toBe(true);
    const first = PERMISSION_MATRIX[0];
    expect(first && Object.isFrozen(first)).toBe(true);
    expect(first && Object.isFrozen(first.grants)).toBe(true);
  });
});
