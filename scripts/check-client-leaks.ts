/**
 * Garde-fou CI anti-fuite (J5, spec §6, invariant 7) :
 *  1. aucune variable `NEXT_PUBLIC_*` n'a un nom de secret ni une valeur de clé secrète ;
 *  2. les modèles `.env*.example` respectent la même règle ;
 *  3. le bundle client (`apps/web/.next/static`) ne contient ni valeur de secret serveur connue,
 *     ni clé `sb_secret_…`, ni JWT `service_role`.
 *
 * Usage : `pnpm check:leaks [--require-bundle]`. Code de sortie 1 si une fuite est trouvée.
 * Les valeurs trouvées ne sont JAMAIS affichées (seulement le lieu et la raison).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  findBundleLeaks,
  findPublicVariableLeaks,
  type EnvSource,
  type LeakFinding,
} from "../packages/domain/src/env/guards";

const root = path.resolve(import.meta.dirname, "..");
const requireBundle = process.argv.includes("--require-bundle");

const findings: LeakFinding[] = [];

// 1. Variables d'environnement courantes
findings.push(...findPublicVariableLeaks(process.env));

// 2. Modèles .env*.example commités
function parseDotenv(content: string): EnvSource {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1]) out[match[1]] = (match[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}
for (const file of readdirSync(root)) {
  if (!/^\.env(\..+)?\.example$/.test(file)) continue;
  for (const f of findPublicVariableLeaks(
    parseDotenv(readFileSync(path.join(root, file), "utf8")),
  )) {
    findings.push({ ...f, where: `${file} → ${f.where}` });
  }
}

// 3. Bundle client
const SERVER_SECRET_NAMES = /(secret|token|password|api[_-]?key|service[_-]?role|master[_-]?key)/i;
// Valeurs des fichiers .env locaux (jamais commités) : Next les charge sans qu'elles figurent dans le shell.
const localEnv: Record<string, string | undefined> = {};
for (const file of [".env", ".env.local"]) {
  const full = path.join(root, file);
  if (existsSync(full)) Object.assign(localEnv, parseDotenv(readFileSync(full, "utf8")));
}
const knownSecretValues = Object.entries({ ...localEnv, ...process.env })
  .filter(
    ([name, value]) =>
      !name.startsWith("NEXT_PUBLIC_") &&
      SERVER_SECRET_NAMES.test(name) &&
      (value ?? "").length >= 8,
  )
  .map(([, value]) => value as string);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const bundleDir = path.join(root, "apps", "web", ".next", "static");
let scanned = 0;
if (existsSync(bundleDir)) {
  for (const file of walk(bundleDir)) {
    if (!/\.(js|css|map|html|json|txt)$/.test(file)) continue;
    scanned += 1;
    const label = path.relative(root, file).split(path.sep).join("/");
    findings.push(...findBundleLeaks(label, readFileSync(file, "utf8"), knownSecretValues));
  }
} else if (requireBundle) {
  console.error("Bundle client introuvable (apps/web/.next/static) : lancer `pnpm build` d'abord.");
  process.exit(1);
} else {
  console.warn(
    "Bundle client absent : contrôle du bundle ignoré (utiliser --require-bundle en CI).",
  );
}

if (findings.length > 0) {
  console.error(`\n✖ ${findings.length} fuite(s) potentielle(s) de secret :`);
  for (const f of findings) console.error(`  - [${f.kind}] ${f.where} : ${f.reason}`);
  process.exit(1);
}
console.info(
  `✔ Aucune fuite détectée (variables publiques, modèles .env*.example, ${scanned} fichier(s) du bundle client).`,
);
