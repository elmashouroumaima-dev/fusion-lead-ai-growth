import { defineConfig } from "vitest/config";

/**
 * Couverture de `packages/domain` (plan J26) : seuil de 80 % exigé par `pnpm --filter @fusion-leap/domain test:coverage`.
 * La couverture n'est calculée QUE par cette commande ; `pnpm test` reste inchangé (rapide, sans instrumentation).
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
