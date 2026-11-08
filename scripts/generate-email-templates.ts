/**
 * Génère les gabarits d'e-mail de Supabase Auth (`supabase/templates/*.html`) et leurs objets (`supabase/config.toml`)
 * depuis la source unique `packages/adapters/src/email`. Usage : `pnpm email:templates`. Un test (adapters) échoue si un
 * fichier diffère de la source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderConfirmationSubject,
  renderConfirmationTemplate,
  renderRecoverySubject,
  renderRecoveryTemplate,
} from "../packages/adapters/src/email";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [file, html] of [
  ["confirmation.html", renderConfirmationTemplate()],
  ["recovery.html", renderRecoveryTemplate()],
] as const) {
  writeFileSync(path.join(root, "supabase", "templates", file), html, "utf8");
  console.log(`écrit : supabase/templates/${file}`);
}

// Objets : chaîne littérale TOML (apostrophes simples) : les guillemets du conditionnel Go n'ont pas à être échappés.
const configPath = path.join(root, "supabase", "config.toml");
let config = readFileSync(configPath, "utf8");
for (const [section, subject] of [
  ["confirmation", renderConfirmationSubject()],
  ["recovery", renderRecoverySubject()],
] as const) {
  const re = new RegExp(`(\\[auth\\.email\\.template\\.${section}\\]\\r?\\nsubject = ).*`);
  if (!re.test(config)) throw new Error(`section ${section} introuvable dans config.toml`);
  config = config.replace(re, (_all, prefix: string) => `${prefix}'${subject}'`);
}
writeFileSync(configPath, config, "utf8");
console.log("écrit : supabase/config.toml (objets)");
