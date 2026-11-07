// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import nextVitals from "eslint-config-next/core-web-vitals";

/** Imports interdits entre couches du monorepo (ADR 002). */
const forbid = (names, why) => ({
  "no-restricted-imports": [
    "error",
    { patterns: names.map((group) => ({ group: [group], message: why })) },
  ],
});

const INTERNAL = ["@fusion-leap/*"];

const WORKER_IMPORT = { group: ["@fusion-leap/worker"], message: "apps/web n'importe jamais apps/worker." };

/**
 * Confinement du client service_role (`apps/web/lib/supabase/admin.ts`, invariant 7, J11) : importable
 * uniquement depuis `apps/web/lib/service/**` et les tests. Les motifs couvrent le module, ses suffixes
 * (`.ts`, `.js`, `.mjs`...) et les variantes de dossier (`admin/index`).
 */
const ADMIN_MESSAGE = "Le client service_role n'est importable que depuis apps/web/lib/service/** (et les tests).";
const ADMIN_CLIENT_IMPORT = {
  group: ["**/supabase/admin", "**/supabase/admin*", "**/supabase/admin/**"],
  message: ADMIN_MESSAGE,
};
/** Import relatif depuis lib/supabase/** (frère de admin.ts), que les motifs `**\/supabase/admin*` ne voient pas. */
const ADMIN_SIBLING_IMPORT = {
  group: ["./admin", "./admin*", "./admin/**"],
  message: ADMIN_MESSAGE,
};
/** `@supabase/supabase-js` (client avec clé secrète possible) : seul admin.ts l'importe ; @supabase/ssr reste libre. */
const SUPABASE_JS_IMPORT = {
  group: ["@supabase/supabase-js", "@supabase/supabase-js/**"],
  message: "@supabase/supabase-js n'est importable que depuis le module admin de apps/web/lib/supabase (utiliser @supabase/ssr ailleurs).",
};

/** Extensions couvertes pour apps/web : un `.js` / `.cjs` / `.mjs` ne doit pas échapper au confinement. */
const WEB_EXT = "{ts,tsx,js,jsx,mjs,cjs}";
const WEB_FILES = [`apps/web/**/*.${WEB_EXT}`];
const WEB_TEST_FILES = [`apps/web/**/*.test.${WEB_EXT}`];

const NO_ONLY_SKIP = {
  selector: "CallExpression[callee.property.name=/^(only|skip)$/][callee.object.name=/^(describe|it|test)$/]",
  message: "Aucun test .only/.skip commité.",
};
const NO_DYNAMIC_ADMIN = [
  {
    selector: "ImportExpression[source.value=/supabase.admin/]",
    message: ADMIN_MESSAGE,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/supabase.admin/]",
    message: ADMIN_MESSAGE,
  },
];
const NO_DYNAMIC_ADMIN_SIBLING = [
  { selector: "ImportExpression[source.value=/^[.].admin/]", message: ADMIN_MESSAGE },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/^[.].admin/]", message: ADMIN_MESSAGE },
];
const NO_DYNAMIC_SUPABASE_JS = [
  { selector: "ImportExpression[source.value=/@supabase.supabase-js/]", message: SUPABASE_JS_IMPORT.message },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/@supabase.supabase-js/]", message: SUPABASE_JS_IMPORT.message },
];
/**
 * import() / require() dont l'argument n'est pas un littéral de chaîne simple (gabarit, concaténation,
 * variable...) : le chemin ne peut pas être vérifié statiquement, donc il pourrait viser le client admin.
 * Seuls `import("littéral")` et `require("littéral")` sont permis (et alors soumis aux règles ci-dessus).
 */
const DYNAMIC_MESSAGE =
  "import() / require() n'accepte qu'un littéral de chaîne simple dans apps/web (confinement de service_role : un chemin calculé ne peut pas être vérifié).";
const NO_COMPUTED_MODULE_PATH = [
  { selector: "ImportExpression:not([source.type='Literal'])", message: DYNAMIC_MESSAGE },
  { selector: "CallExpression[callee.name='require']:not([arguments.length=1][arguments.0.type='Literal'])", message: DYNAMIC_MESSAGE },
  // Autres portes d'entrée vers un chargement de module / de code calculé.
  { selector: "CallExpression[callee.property.name='require']", message: DYNAMIC_MESSAGE },
  { selector: "CallExpression[callee.name='createRequire']", message: DYNAMIC_MESSAGE },
  { selector: "Identifier[name='createRequire']", message: DYNAMIC_MESSAGE },
  { selector: "CallExpression[callee.name='eval']", message: DYNAMIC_MESSAGE },
  { selector: "NewExpression[callee.name='Function']", message: DYNAMIC_MESSAGE },
];

/** Le code de production n'importe jamais un fichier de test (un test peut simuler / importer le client admin). */
const TEST_IMPORT_MESSAGE = "Le code hors tests n'importe jamais un fichier *.test.* (les tests peuvent importer le client service_role).";
const TEST_FILE_IMPORT = {
  group: ["**/*.test", "**/*.test.*", "./*.test", "./*.test.*"],
  message: TEST_IMPORT_MESSAGE,
};
const NO_DYNAMIC_TEST_IMPORT = [
  { selector: "ImportExpression[source.value=/[.]test([.][A-Za-z]+)?$/]", message: TEST_IMPORT_MESSAGE },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/[.]test([.][A-Za-z]+)?$/]", message: TEST_IMPORT_MESSAGE },
];

const SECRET_KEY_MESSAGE = "SUPABASE_SECRET_KEY n'est lu que par apps/web/lib/supabase/admin.ts et apps/web/lib/env/**.";
const NO_SECRET_KEY = [
  { selector: "Identifier[name='SUPABASE_SECRET_KEY']", message: SECRET_KEY_MESSAGE },
  { selector: "Literal[value=/SUPABASE_SECRET_KEY/]", message: SECRET_KEY_MESSAGE },
  { selector: "TemplateElement[value.raw=/SUPABASE_SECRET_KEY/]", message: SECRET_KEY_MESSAGE },
];

/**
 * Règles de confinement d'un morceau de apps/web. `admin` : import du client service_role permis ;
 * `secretKey` : lecture de SUPABASE_SECRET_KEY permise ; `supabaseJs` : import de @supabase/supabase-js permis ;
 * `sibling` : interdit aussi `./admin` (fichiers de lib/supabase/** autres que admin.ts) ;
 * `tests` : le fichier est un test (peut importer d'autres *.test.*).
 */
const webRules = ({ admin = false, secretKey = false, supabaseJs = false, sibling = false, tests = false } = {}) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        WORKER_IMPORT,
        ...(tests ? [] : [TEST_FILE_IMPORT]),
        ...(admin ? [] : [ADMIN_CLIENT_IMPORT]),
        ...(sibling ? [ADMIN_SIBLING_IMPORT] : []),
        ...(supabaseJs ? [] : [SUPABASE_JS_IMPORT]),
      ],
    },
  ],
  "no-restricted-syntax": [
    "error",
    NO_ONLY_SKIP,
    ...NO_COMPUTED_MODULE_PATH,
    ...(tests ? [] : NO_DYNAMIC_TEST_IMPORT),
    ...(admin ? [] : NO_DYNAMIC_ADMIN),
    ...(sibling ? NO_DYNAMIC_ADMIN_SIBLING : []),
    ...(supabaseJs ? [] : NO_DYNAMIC_SUPABASE_JS),
    ...(secretKey ? [] : NO_SECRET_KEY),
  ],
});

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "docs/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // CLAUDE.md : pas de `any` non justifié (justifier par un commentaire eslint-disable ciblé).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      // Pas de test isolé/ignoré commité (docs/testing/strategy.md §7).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(only|skip)$/][callee.object.name=/^(describe|it|test)$/]",
          message: "Aucun test .only/.skip commité.",
        },
      ],
    },
  },
  // --- Frontières de packages (ADR 002) ---
  {
    files: ["packages/domain/**/*.{ts,tsx}"],
    rules: forbid(INTERNAL, "packages/domain ne dépend d'aucun package ni app interne."),
  },
  {
    files: ["packages/permissions/**/*.{ts,tsx}"],
    rules: forbid(
      ["@fusion-leap/adapters", "@fusion-leap/web", "@fusion-leap/worker"],
      "packages/permissions ne dépend que de @fusion-leap/domain.",
    ),
  },
  {
    files: ["packages/adapters/**/*.{ts,tsx}"],
    rules: forbid(
      ["@fusion-leap/permissions", "@fusion-leap/web", "@fusion-leap/worker"],
      "packages/adapters ne dépend que de @fusion-leap/domain.",
    ),
  },
  // --- apps/web : confinement de service_role (J11). L'ordre compte : le dernier bloc applicable l'emporte. ---
  {
    files: WEB_FILES,
    rules: webRules(),
    // Aucun commentaire eslint-disable / eslint-enable / `eslint rule: ...` n'est pris en compte dans apps/web :
    // ESLint ne sait pas interdire le désactivage de RÈGLES PRÉCISES (no-restricted-imports / -syntax) seul, donc
    // on interdit toute configuration en ligne. Une dérogation passe par un bloc `files` ci-dessous (revue de
    // config). Limite connue : hors apps/web (packages/*, apps/worker) les commentaires en ligne restent permis.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
  },
  // Dérogations ciblées (anciens `eslint-disable-next-line no-control-regex`, désormais ignorés par noInlineConfig).
  { files: ["apps/web/lib/auth/routes.ts", "apps/web/lib/auth/safe-redirect.ts"], rules: { "no-control-regex": "off" } },
  // Frères de admin.ts : pas d'import relatif `./admin`.
  { files: [`apps/web/lib/supabase/**/*.${WEB_EXT}`], ignores: ["apps/web/lib/supabase/admin.ts", ...WEB_TEST_FILES], rules: webRules({ sibling: true }) },
  // Environnement serveur validé : seul autre lecteur légitime de la clé secrète.
  { files: [`apps/web/lib/env/**/*.${WEB_EXT}`], rules: webRules({ secretKey: true }) },
  // Couche service : peut importer le client service_role.
  { files: [`apps/web/lib/service/**/*.${WEB_EXT}`], rules: webRules({ admin: true }) },
  // Tests : importent / simulent le client admin et nomment la clé pour les assertions.
  { files: WEB_TEST_FILES, rules: webRules({ admin: true, secretKey: true, tests: true }) },
  // Le module admin lui-même.
  { files: ["apps/web/lib/supabase/admin.ts"], rules: webRules({ admin: true, secretKey: true, supabaseJs: true }) },
  {
    files: ["apps/worker/**/*.{ts,tsx}"],
    rules: forbid(["@fusion-leap/web"], "apps/worker n'importe jamais apps/web."),
  },
  // --- Next.js (apps/web uniquement) ---
  ...nextVitals.map((config) => ({ ...config, files: ["apps/web/**/*.{ts,tsx,js,jsx,mjs}"] })),
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "apps/web" } },
  },
);
