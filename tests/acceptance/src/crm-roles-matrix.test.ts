import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ORG } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, getPage, postJson, redirectPath, signIn, type Session } from "./app-client";

/**
 * Matrice des rôles sur la surface HTTP du CRM (spec §13-2, ADR 014 lignes 6, 7, 12 à 15), avec de vraies sessions : chaque point
 * d'accès reçoit une requête BIEN FORMÉE (identifiants aléatoires, donc aucune écriture possible) de chacun des cinq rôles d'Alpha
 * et d'un visiteur anonyme. Un rôle non autorisé reçoit exactement 403 ; un rôle autorisé reçoit EXACTEMENT le statut attendu de la
 * route (200 pour une lecture, 404 « introuvable » pour un identifiant ou un projet inconnu), donc ni un refus
 * de rôle ni une erreur qui masquerait une route cassée ; un anonyme reçoit 401. Pages : rôle non autorisé = retour au tableau de bord.
 *
 * Couvert ici : export, déplacement de deal, intégrations, mapping, synchro, « Réessayer », import (envoi, état, aperçu, confirmation,
 * annulation, rapport), capture publique, pages Leads / Deals / CRM. Hors de cette matrice, faute de route HTTP : activités,
 * notifications, règles d'assignation et clés de formulaire (fonctions SQL : tests RLS `activities`, `assignment`, `capture`).
 * Les cas avec données réelles (propriété du lead, export filtré, déplacement effectif) sont dans `crm-pages`, `crm-sync-flow`,
 * `import-flow` et `t2-sales`.
 */
type Who = "owner" | "admin" | "marketing" | "sales" | "analyst";
const LOGINS: Record<Who, string> = { owner: "shared", admin: "alpha-admin", marketing: "alpha-marketing", sales: "alpha-sales", analyst: "alpha-analyst" };
const ALL: Who[] = ["owner", "admin", "marketing", "sales", "analyst"];

const sessions = new Map<Who, Session>();
beforeAll(async () => {
  for (const who of ALL) sessions.set(who, await signIn(`${LOGINS[who]}@seed.test`));
});
const session = (who: Who): Session => {
  const s = sessions.get(who);
  if (!s) throw new Error(`session absente : ${who}`);
  return s;
};

const uuid = () => randomUUID();
const cookieOf = (who: Who | null) => {
  const jar = { ...(who ? session(who).cookies : {}), fl_active_org: ORG.alpha };
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
};
const post = (path: string, payload: () => unknown) => async (who: Who | null) =>
  (await postJson(who ? session(who) : null, path, payload(), { activeOrg: ORG.alpha, headers: { "idempotency-key": uuid() } })).status;
const get = (path: () => string) => async (who: Who | null) => {
  const response = await fetch(`${BASE_URL}${path()}`, { redirect: "manual", headers: { cookie: cookieOf(who) } });
  await response.arrayBuffer();
  return response.status;
};
/** Envoi d'un CSV valide vers un projet INCONNU : le rôle est contrôlé d'abord, et aucun lot ni fichier n'est jamais créé. */
const upload = async (who: Who | null) => {
  const response = await fetch(`${BASE_URL}/api/imports?project_id=${uuid()}`, {
    method: "POST",
    headers: { "content-type": "text/csv; charset=utf-8", cookie: cookieOf(who) },
    body: ["email", "matrice@exemple.test", ""].join("\n"),
  });
  await response.arrayBuffer();
  return response.status;
};

const MAPPINGS = [
  { entity: "contact", internal_field: "external_id", external_field: "ID", source_of_truth: "external", direction: "pull" },
  { entity: "contact", internal_field: "email", external_field: "E-mail", source_of_truth: "internal", direction: "pull" },
];

type ApiCase = { name: string; allowed: Who[]; expected: number; call: (who: Who | null) => Promise<number> };
const OWNER_ADMIN: Who[] = ["owner", "admin"];
const API: ApiCase[] = [
  { name: "GET /api/leads/export", allowed: OWNER_ADMIN, expected: 200, call: get(() => "/api/leads/export") },
  { name: "POST /api/deals/move", allowed: ["owner", "admin", "sales"], expected: 404, call: post("/api/deals/move", () => ({ deal_id: uuid(), stage_id: uuid() })) },
  { name: "GET /api/crm/integrations", allowed: OWNER_ADMIN, expected: 200, call: get(() => "/api/crm/integrations") },
  { name: "POST /api/crm/mappings", allowed: OWNER_ADMIN, expected: 404, call: post("/api/crm/mappings", () => ({ integration_id: uuid(), mappings: MAPPINGS })) },
  { name: "POST /api/crm/sync", allowed: OWNER_ADMIN, expected: 404, call: post("/api/crm/sync", () => ({ integration_id: uuid(), batch_id: uuid() })) },
  { name: "POST /api/crm/sync/retry", allowed: OWNER_ADMIN, expected: 404, call: post("/api/crm/sync/retry", () => ({ integration_id: uuid() })) },
  { name: "POST /api/imports (envoi)", allowed: OWNER_ADMIN, expected: 404, call: upload },
  { name: "GET /api/imports (liste)", allowed: OWNER_ADMIN, expected: 200, call: get(() => "/api/imports") },
  { name: "GET /api/imports?id= (état d'un lot)", allowed: OWNER_ADMIN, expected: 404, call: get(() => `/api/imports?id=${uuid()}`) },
  { name: "POST /api/imports/preview", allowed: OWNER_ADMIN, expected: 404, call: post("/api/imports/preview", () => ({ batch_id: uuid(), mapping: { email: 1 } })) },
  { name: "POST /api/imports/confirm", allowed: OWNER_ADMIN, expected: 404, call: post("/api/imports/confirm", () => ({ batch_id: uuid(), mapping: { email: 1 } })) },
  { name: "POST /api/imports/cancel", allowed: OWNER_ADMIN, expected: 404, call: post("/api/imports/cancel", () => ({ batch_id: uuid() })) },
  { name: "GET /api/imports/report", allowed: OWNER_ADMIN, expected: 404, call: get(() => `/api/imports/report?batch_id=${uuid()}`) },
];

describe("API CRM : rôle non autorisé = 403, rôle autorisé = le statut exact de la route, anonyme = 401", () => {
  for (const c of API) {
    it(`${c.name} (${c.allowed.join(", ")})`, async () => {
      for (const who of ALL) {
        const status = await c.call(who);
        if (c.allowed.includes(who)) expect(status, `${who} (autorisé)`).toBe(c.expected);
        else expect(status, `${who} (refusé)`).toBe(403);
      }
      expect(await c.call(null)).toBe(401);
    });
  }
});

describe("capture publique POST /api/leads : une session ne donne AUCUN droit (seule la clé de formulaire compte)", () => {
  it("sans clé de formulaire : le même refus pour tous les rôles, avec ou sans session, et rien n'est écrit", async () => {
    const results = new Set<number>();
    for (const who of [...ALL, null]) {
      const response = await fetch(`${BASE_URL}/api/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieOf(who), origin: "https://pirate.example.test", "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({ name: "Test matrice", email: `matrice-${uuid()}@exemple.test` }),
      });
      await response.arrayBuffer();
      results.add(response.status);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect([...results]).toEqual([403]);
  });
});

type PageCase = { path: string; allowed: Who[]; redirectedTo: RegExp };
const PAGES: PageCase[] = [
  { path: "/fr/leads", allowed: ["owner", "admin", "marketing", "sales"], redirectedTo: /dashboard/ },
  { path: "/fr/deals", allowed: ["owner", "admin", "marketing", "sales"], redirectedTo: /dashboard/ },
  { path: "/fr/crm", allowed: OWNER_ADMIN, redirectedTo: /dashboard/ },
];

describe("pages CRM : les rôles autorisés les ouvrent, les autres reviennent au tableau de bord, un anonyme à la connexion", () => {
  for (const c of PAGES) {
    it(c.path, async () => {
      for (const who of ALL) {
        const page = await getPage(session(who), c.path, ORG.alpha);
        if (c.allowed.includes(who)) expect(page.status, `${who} (autorisé)`).toBe(200);
        else {
          expect([302, 303, 307], `${who} (refusé)`).toContain(page.status);
          expect(redirectPath(page), `${who} (refusé)`).toMatch(c.redirectedTo);
        }
      }
      const anonymous = await getPage(null, c.path);
      expect([302, 303, 307]).toContain(anonymous.status);
      expect(redirectPath(anonymous)).toMatch(/login/);
    });
  }
});
