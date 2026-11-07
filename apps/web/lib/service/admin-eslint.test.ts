import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * La règle ESLint de confinement de service_role (J11) est exécutée pour de bon (API ESLint) sur des
 * sources virtuelles : elle doit échouer hors lib/service/** et passer dans lib/service/** et les tests.
 */
const ROOT = path.resolve(import.meta.dirname, "../../../..");
const eslint = new ESLint({ cwd: ROOT });

async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) });
  return result?.messages.filter((m) => m.ruleId === "no-restricted-imports") ?? [];
}

const CONFINEMENT_RULES = new Set(["no-restricted-imports", "no-restricted-syntax"]);

/** Toutes les violations de confinement (imports ET syntaxe : import() dynamique, require, SUPABASE_SECRET_KEY...). */
async function violations(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) });
  return result?.messages.filter((m) => m.ruleId !== null && CONFINEMENT_RULES.has(m.ruleId)) ?? [];
}

const IMPORT_ADMIN = (rel: string) => `import { createAdminClient } from "${rel}";\nexport const x = createAdminClient;\n`;

describe("règle ESLint : le client service_role n'est importable que depuis lib/service/**", () => {
  it.each([
    ["apps/web/app/api/orgs/route.ts", "../../../lib/supabase/admin"],
    ["apps/web/components/members/invite-form.tsx", "../../lib/supabase/admin"],
    ["apps/web/lib/members/actions.ts", "../supabase/admin"],
    ["apps/web/lib/tenant/actions.ts", "@/lib/supabase/admin"],
    ["apps/web/app/[locale]/(app)/page.tsx", "../../../lib/supabase/admin.ts"],
  ])("%s important %s -> erreur", async (file, spec) => {
    const found = await messages(file, IMPORT_ADMIN(spec));
    expect(found.length, `${file} <- ${spec}`).toBeGreaterThan(0);
    expect(found[0]?.message).toMatch(/service_role/);
  });

  it.each([
    ["apps/web/lib/service/rate-limit.ts", "../supabase/admin"],
    ["apps/web/lib/service/with-service.ts", "../supabase/admin"],
    ["apps/web/lib/service/nouveau-module.ts", "../supabase/admin"],
    ["apps/web/lib/supabase/admin.test.ts", "./admin"],
    ["apps/web/lib/members/actions.test.ts", "../supabase/admin"],
  ])("%s important %s -> autorisé", async (file, spec) => {
    expect(await messages(file, IMPORT_ADMIN(spec))).toEqual([]);
  });

  it("la restriction du worker s'applique toujours dans les pages (non service)", async () => {
    const config = await eslint.calculateConfigForFile(path.join(ROOT, "apps/web/app/page.tsx"));
    const rule = JSON.stringify(config.rules?.["no-restricted-imports"]);
    expect(rule).toContain("supabase/admin");
    expect(rule).toMatch(/worker/);
  });

  it("dans lib/service/** la règle ne mentionne plus admin mais garde le worker", async () => {
    const config = await eslint.calculateConfigForFile(path.join(ROOT, "apps/web/lib/service/with-service.ts"));
    const rule = JSON.stringify(config.rules?.["no-restricted-imports"]);
    expect(rule).not.toContain("supabase/admin");
    expect(rule).toMatch(/worker/);
  });
});

/*
 * Fixtures qui DOIVENT échouer (et leurs contreparties autorisées) : la règle est exécutée pour de bon sur
 * des sources virtuelles, y compris suffixes `.js`, variantes `index`, import() dynamique, require(),
 * @supabase/supabase-js et SUPABASE_SECRET_KEY (identifiant, chaîne, gabarit, accès par crochets).
 */
describe("confinement renforcé (J11) : fixtures qui doivent échouer", () => {
  const PAGE = "apps/web/app/[locale]/(app)/members/page.tsx";
  const ACTION = "apps/web/lib/members/actions.ts";

  it.each([
    ['import { createAdminClient } from "../../lib/supabase/admin.js";'],
    ['import { createAdminClient } from "../supabase/admin.mjs";'],
    ['import { createAdminClient } from "../supabase/admin/index";'],
    ['import { createAdminClient } from "../supabase/admin/index.ts";'],
    ['import { createAdminClient } from "@/lib/supabase/admin.js";'],
    ['export { createAdminClient } from "../supabase/admin";'],
    ['export * from "../supabase/admin.ts";'],
    ['import type { createAdminClient } from "../supabase/admin";'],
  ])("import statique %s hors lib/service -> erreur", async (code) => {
    expect((await violations(ACTION, `${code}\n`)).length, code).toBeGreaterThan(0);
  });

  it.each([
    ['export const load = () => import("../supabase/admin");'],
    ['export const load = () => import("../supabase/admin.js");'],
    ['export const load = () => import("../supabase/admin/index");'],
    ['export const load = () => import("@/lib/supabase/admin");'],
    ['const admin = require("../supabase/admin");\nexport default admin;'],
  ])("import dynamique / require %s hors lib/service -> erreur", async (code) => {
    expect((await violations(ACTION, `${code}\n`)).length, code).toBeGreaterThan(0);
  });

  it.each([
    ['import { createClient } from "@supabase/supabase-js";\nexport const c = createClient;'],
    ['import type { SupabaseClient } from "@supabase/supabase-js";\nexport type C = SupabaseClient;'],
    ['export const load = () => import("@supabase/supabase-js");'],
    ['const sb = require("@supabase/supabase-js");\nexport default sb;'],
  ])("@supabase/supabase-js hors admin.ts -> erreur (%s)", async (code) => {
    for (const file of [PAGE, ACTION, "apps/web/lib/service/with-service.ts", "apps/web/lib/members/actions.test.ts", "apps/web/lib/supabase/server.ts"]) {
      expect((await violations(file, `${code}\n`)).length, `${file} <- ${code}`).toBeGreaterThan(0);
    }
  });

  it.each([
    ["identifiant", "export const key = process.env.SUPABASE_SECRET_KEY;"],
    ["chaîne", 'export const name = "SUPABASE_SECRET_KEY";'],
    ["accès par crochets", 'export const key = process.env["SUPABASE_SECRET_KEY"];'],
    ["gabarit", "export const msg = `clé ${1} SUPABASE_SECRET_KEY`;"],
    ["destructuration", "export const { SUPABASE_SECRET_KEY } = process.env;"],
  ])("SUPABASE_SECRET_KEY (%s) hors admin.ts / lib/env -> erreur, y compris dans lib/service", async (_l, code) => {
    for (const file of [PAGE, ACTION, "apps/web/lib/service/rate-limit.ts", "apps/web/lib/tenant/context.ts"]) {
      expect((await violations(file, `${code}\n`)).length, `${file} <- ${code}`).toBeGreaterThan(0);
    }
  });

  it.each([
    ['import { createAdminClient } from "./admin";\nexport const x = createAdminClient;'],
    ['import { createAdminClient } from "./admin.js";\nexport const x = createAdminClient;'],
    ['import { createAdminClient } from "./admin/index";\nexport const x = createAdminClient;'],
    ['export const load = () => import("./admin");'],
  ])("un frère de admin.ts (lib/supabase/server.ts) ne l'importe pas non plus : %s", async (code) => {
    expect((await violations("apps/web/lib/supabase/server.ts", `${code}\n`)).length, code).toBeGreaterThan(0);
  });
});

describe("confinement renforcé (J11) : usages légitimes qui doivent passer", () => {
  it("@supabase/ssr reste autorisé partout (clients serveur / navigateur)", async () => {
    const code = 'import { createServerClient } from "@supabase/ssr";\nexport const c = createServerClient;\n';
    expect(await violations("apps/web/lib/supabase/server.ts", code)).toEqual([]);
    expect(await violations("apps/web/lib/members/actions.ts", code)).toEqual([]);
  });

  it("admin.ts lui-même peut importer @supabase/supabase-js et nommer la clé secrète", async () => {
    const code = 'import { createClient } from "@supabase/supabase-js";\nexport const key = process.env.SUPABASE_SECRET_KEY;\nexport const c = createClient;\n';
    expect(await violations("apps/web/lib/supabase/admin.ts", code)).toEqual([]);
  });

  it("lib/env/** peut lire SUPABASE_SECRET_KEY (validation de l'environnement serveur)", async () => {
    expect(await violations("apps/web/lib/env/server.ts", "export const key = process.env.SUPABASE_SECRET_KEY;\n")).toEqual([]);
  });

  it("les tests peuvent nommer la clé et simuler @supabase/supabase-js (vi.mock) sans l'importer", async () => {
    const code = 'import { vi } from "vitest";\nvi.mock("@supabase/supabase-js", () => ({}));\nexport const n = "SUPABASE_SECRET_KEY";\n';
    expect(await violations("apps/web/lib/supabase/admin.test.ts", code)).toEqual([]);
  });

  it("lib/service/** peut importer admin (statique ET dynamique)", async () => {
    const code = 'import { createAdminClient } from "../supabase/admin";\nexport const load = () => import("../supabase/admin");\nexport const x = createAdminClient;\n';
    expect(await violations("apps/web/lib/service/rate-limit.ts", code)).toEqual([]);
  });

  it("un import voisin sans rapport (./admin-panel) n'est pas pris pour le client admin", async () => {
    const code = 'import { Panel } from "./admin-panel";\nexport const x = Panel;\n';
    expect(await violations("apps/web/components/members/member-list.tsx", code)).toEqual([]);
  });

  it(".only / .skip restent interdits dans chaque bloc de apps/web (no-restricted-syntax combiné)", async () => {
    for (const file of ["apps/web/lib/members/actions.test.ts", "apps/web/lib/service/with-service.test.ts", "apps/web/lib/supabase/admin.ts"]) {
      const [result] = await eslint.lintText('import { it } from "vitest";\nit.only("x", () => {});\n', { filePath: path.join(ROOT, file) });
      expect(result?.messages.some((m) => m.ruleId === "no-restricted-syntax" && /only/.test(m.message)), file).toBe(true);
    }
  });
});

/*
 * Lacunes de confinement fermées (re-vérification J11) : chemins calculés, extensions js/jsx/mjs/cjs,
 * import de fichiers *.test.* par du code de production, désactivation en ligne des règles.
 */
describe("confinement : import() / require() à chemin calculé (gabarit, concaténation, variable)", () => {
  it.each([
    ["import() gabarit", "export const load = () => import(`../supabase/admin`);"],
    ["import() gabarit interpolé", 'const n = "admin";\nexport const load = () => import(`../supabase/${n}`);'],
    ["import() concaténation", 'export const load = () => import("../supabase/" + "admin");'],
    ["import() variable", "export const load = (p: string) => import(p);"],
    ["import() appel de fonction", "export const load = (p: () => string) => import(p());"],
    ["require() gabarit", "const a = require(`../supabase/admin`);\nexport default a;"],
    ["require() concaténation", 'const a = require("../supabase/" + "admin");\nexport default a;'],
    ["require() variable", "export const f = (p: string) => require(p);"],
    ["require() sans argument", "export const f = () => require();"],
    ["module.require()", 'export const f = () => module.require("../supabase/admin");'],
    ["createRequire", 'import { createRequire } from "node:module";\nexport const r = createRequire(import.meta.url);'],
    ["eval", "export const f = (s: string) => eval(s);"],
    ["new Function", "export const f = (s: string) => new Function(s);"],
  ])("%s -> erreur (action, lib/service, test, page)", async (_label, code) => {
    for (const file of [
      "apps/web/lib/members/actions.ts",
      "apps/web/lib/service/rate-limit.ts",
      "apps/web/lib/members/actions.test.ts",
      "apps/web/app/page.tsx",
    ]) {
      const found = await violations(file, `${code}\n`);
      expect(found.length, `${file} <- ${code}`).toBeGreaterThan(0);
    }
  });

  it.each([
    ["import() littéral relatif", 'export const load = () => import("./panel");'],
    ["import() littéral JSON", 'export const load = () => import("../messages/fr.json");'],
    ["require() littéral", 'const fs = require("node:fs");\nexport default fs;'],
    ["import() littéral @supabase/ssr", 'export const load = () => import("@supabase/ssr");'],
  ])("%s -> reste autorisé", async (_label, code) => {
    expect(await violations("apps/web/components/members/member-list.tsx", `${code}\n`)).toEqual([]);
  });
});

describe("confinement : toutes les extensions de apps/web (ts, tsx, js, jsx, mjs, cjs)", () => {
  it.each(["apps/web/lib/members/helper.js", "apps/web/components/members/panel.jsx", "apps/web/lib/members/helper.mjs"])(
    "%s : admin, supabase-js, clé secrète, import() calculé -> erreur",
    async (file) => {
      const cases = [
        'import { createAdminClient } from "../supabase/admin";\nexport const x = createAdminClient;',
        'import { createClient } from "@supabase/supabase-js";\nexport const c = createClient;',
        "export const key = process.env.SUPABASE_SECRET_KEY;",
        "export const load = (p) => import(`./${p}`);",
        'export const load = () => import("../supabase/admin");',
      ];
      for (const code of cases) expect((await violations(file, `${code}\n`)).length, `${file} <- ${code}`).toBeGreaterThan(0);
    },
  );

  it("fichier .cjs : require() de admin / supabase-js / chemin calculé / clé secrète -> erreur", async () => {
    const file = "apps/web/lib/members/helper.cjs";
    const cases = [
      'const a = require("../supabase/admin");\nmodule.exports = a;',
      'const s = require("@supabase/supabase-js");\nmodule.exports = s;',
      "module.exports = (p) => require(`./${p}`);",
      "module.exports = process.env.SUPABASE_SECRET_KEY;",
    ];
    for (const code of cases) expect((await violations(file, `${code}\n`)).length, `${file} <- ${code}`).toBeGreaterThan(0);
  });

  it.each(["apps/web/lib/service/helper.js", "apps/web/lib/service/helper.mjs", "apps/web/lib/service/helper.jsx"])(
    "%s (lib/service) peut importer admin",
    async (file) => {
      expect(await violations(file, 'import { createAdminClient } from "../supabase/admin";\nexport const x = createAdminClient;\n')).toEqual([]);
    },
  );

  it("un fichier .test.js / .test.mjs / .test.jsx est traité comme un test (admin et clé secrète permis)", async () => {
    const code = 'import { createAdminClient } from "../supabase/admin";\nexport const n = "SUPABASE_SECRET_KEY";\nexport const x = createAdminClient;\n';
    for (const file of ["apps/web/lib/members/a.test.js", "apps/web/lib/members/a.test.mjs", "apps/web/lib/members/a.test.jsx"]) {
      expect(await violations(file, code), file).toEqual([]);
    }
  });
});

describe("confinement : le code de production n'importe pas de fichier *.test.*", () => {
  it.each([
    'import { fixture } from "./actions.test";\nexport const f = fixture;',
    'import { fixture } from "./actions.test.ts";\nexport const f = fixture;',
    'import { fixture } from "../members/actions.test";\nexport const f = fixture;',
    'import { fixture } from "../../lib/members/actions.test.tsx";\nexport const f = fixture;',
    'import { fixture } from "@/lib/members/actions.test";\nexport const f = fixture;',
    'import type { Fixture } from "./actions.test";\nexport type F = Fixture;',
    'export { fixture } from "./actions.test";',
    'export * from "../members/actions.test.js";',
    'export const load = () => import("./actions.test");',
    'export const load = () => import("../members/actions.test.ts");',
    'const t = require("./actions.test");\nexport default t;',
  ])("hors test : %s -> erreur", async (code) => {
    for (const file of [
      "apps/web/lib/members/actions.ts",
      "apps/web/app/[locale]/(app)/members/page.tsx",
      "apps/web/lib/service/with-service.ts",
      "apps/web/lib/supabase/server.ts",
    ]) {
      expect((await violations(file, `${code}\n`)).length, `${file} <- ${code}`).toBeGreaterThan(0);
    }
  });

  it("un test peut importer un autre fichier de test ; contest / latest / test-utils ne sont pas des tests", async () => {
    expect(await violations("apps/web/lib/members/actions.test.ts", 'import { f } from "./helpers.test";\nexport const x = f;\n')).toEqual([]);
    const code = 'import { a } from "./contest";\nimport { b } from "../members/latest";\nimport { c } from "./test-utils";\nexport const x = [a, b, c];\n';
    expect(await violations("apps/web/lib/members/actions.ts", code)).toEqual([]);
  });
});

describe("confinement : aucune désactivation en ligne dans apps/web", () => {
  const ADMIN = 'import { createAdminClient } from "../supabase/admin";\nexport const x = createAdminClient;\n';
  it.each([
    ["eslint-disable-next-line ciblé", `// eslint-disable-next-line no-restricted-imports\n${ADMIN}`],
    ["eslint-disable-next-line sans règle", `// eslint-disable-next-line\n${ADMIN}`],
    ["bloc eslint-disable", `/* eslint-disable */\n${ADMIN}`],
    ["bloc eslint-disable ciblé", `/* eslint-disable no-restricted-imports, no-restricted-syntax */\n${ADMIN}`],
    ["eslint-disable-line", 'import { createAdminClient } from "../supabase/admin"; // eslint-disable-line no-restricted-imports\nexport const x = createAdminClient;\n'],
    ["chemin calculé", "/* eslint-disable no-restricted-syntax */\nexport const load = (p: string) => import(p);\n"],
    ["clé secrète", "// eslint-disable-next-line no-restricted-syntax\nexport const key = process.env.SUPABASE_SECRET_KEY;\n"],
    ["import de test", '// eslint-disable-next-line no-restricted-imports\nimport { f } from "./a.test";\nexport const x = f;\n'],
  ])("%s : l'erreur de confinement reste signalée", async (_label, code) => {
    for (const file of ["apps/web/lib/members/actions.ts", "apps/web/app/page.tsx", "apps/web/lib/supabase/server.ts"]) {
      expect((await violations(file, code)).length, `${file} <- ${code}`).toBeGreaterThan(0);
    }
  });

  it("le commentaire est lui-même signalé comme sans effet (noInlineConfig)", async () => {
    const [result] = await eslint.lintText("// eslint-disable-next-line no-restricted-imports\nexport const a = 1;\n", {
      filePath: path.join(ROOT, "apps/web/lib/members/actions.ts"),
    });
    expect(result?.messages.some((m) => /noInlineConfig/.test(m.message))).toBe(true);
  });

  it("la configuration calculée de apps/web active noInlineConfig et reportUnusedDisableDirectives", async () => {
    const config = await eslint.calculateConfigForFile(path.join(ROOT, "apps/web/lib/members/actions.ts"));
    expect(config.linterOptions?.noInlineConfig).toBe(true);
    expect(String(config.linterOptions?.reportUnusedDisableDirectives)).toMatch(/error|2/);
  });

  it("hors apps/web, une directive eslint-disable inutile est une erreur (reportUnusedDisableDirectives)", async () => {
    const [result] = await eslint.lintText("// eslint-disable-next-line no-console\nexport const a = 1;\n", {
      filePath: path.join(ROOT, "packages/domain/src/unused.ts"),
    });
    expect(result?.messages.some((m) => /Unused eslint-disable directive/.test(m.message) && m.severity === 2)).toBe(true);
  });
});

describe("confinement : usages légitimes inchangés après durcissement", () => {
  it("les imports réels de lib/service et les clients @supabase/ssr passent toujours", async () => {
    const service = 'import { createAdminClient } from "../supabase/admin";\nimport { x } from "./errors";\nexport const y = [createAdminClient, x];\n';
    expect(await violations("apps/web/lib/service/with-service.ts", service)).toEqual([]);
    const ssr =
      'import { createBrowserClient } from "@supabase/ssr";\nimport { createServerClient } from "@supabase/ssr";\nexport const c = [createBrowserClient, createServerClient];\n';
    for (const file of ["apps/web/lib/supabase/client.ts", "apps/web/lib/supabase/server.ts", "apps/web/lib/members/actions.ts"]) {
      expect(await violations(file, ssr), file).toEqual([]);
    }
  });
});
