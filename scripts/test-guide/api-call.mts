/**
 * Outil des tests fonctionnels (docs/testing/phase2-3-functional-tests.md) : appelle l'API de l'application EN TANT QU'un compte du jeu de test,
 * comme le ferait l'interface (même session, même entreprise active, `Idempotency-Key` ajouté aux requêtes qui modifient).
 *
 *   pnpm test:call <compte> <METHODE> <chemin> [corps-json] [--org alpha|beta] [--file fichier.csv]
 *
 *   pnpm test:call shared GET /api/integrations
 *   pnpm test:call shared POST /api/integrations '{"provider":"email","external_account_id":"demo-mail","scopes":[],"secret":"jeton-de-test-0123456789"}'
 *   pnpm test:call shared POST "/api/imports?project_id=<id>" --file tests/fixtures/leads-100.csv
 *
 * <compte> = la partie avant « @seed.test » (shared, alpha-admin, alpha-marketing, alpha-sales, alpha-analyst, beta-owner...).
 * Comptes et mot de passe de test : supabase/seed.sql. Données de test uniquement. L'application doit tourner (E2E_BASE_URL, défaut http://localhost:3000).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { BASE_URL, signIn } from "../../tests/acceptance/src/app-client";

const ORGS: Record<string, string> = { alpha: "a0000000-0000-4000-8000-0000000000a1", beta: "b0000000-0000-4000-8000-0000000000b1" };

const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const org = ORGS[take("--org") ?? "alpha"];
const file = take("--file");
const [account, method, pathname, json] = args;
if (!account || !method || !pathname || !org) {
  console.error("usage : pnpm test:call <compte> <METHODE> <chemin> [corps-json] [--org alpha|beta] [--file fichier]");
  process.exit(2);
}

const session = await signIn(`${account}@seed.test`);
const jar = { ...session.cookies, fl_active_org: org };
const headers: Record<string, string> = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") };
let body: string | undefined;
if (file) {
  body = readFileSync(file, "utf8");
  headers["content-type"] = "text/csv";
} else if (json) {
  body = json;
  headers["content-type"] = "application/json";
}
if (method.toUpperCase() !== "GET") headers["idempotency-key"] = `guide-${randomUUID()}`;

const response = await fetch(`${BASE_URL}${pathname}`, { method: method.toUpperCase(), headers, ...(body !== undefined ? { body } : {}), redirect: "manual" });
const text = await response.text();
let shown = text;
try {
  shown = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  /* texte brut (CSV, HTML...) */
}
console.log(`HTTP ${response.status}`);
console.log(shown.length > 4000 ? `${shown.slice(0, 4000)}\n… (${shown.length} caractères)` : shown);
