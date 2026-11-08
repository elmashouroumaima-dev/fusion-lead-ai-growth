import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/global-setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Les scénarios modifient puis restaurent des lignes partagées du seed : exécution séquentielle.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
