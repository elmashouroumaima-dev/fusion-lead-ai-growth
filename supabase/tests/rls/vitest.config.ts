import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Les tests modifient puis restaurent des lignes partagées : exécution séquentielle.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
