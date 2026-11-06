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
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: forbid(["@fusion-leap/worker"], "apps/web n'importe jamais apps/worker."),
  },
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
