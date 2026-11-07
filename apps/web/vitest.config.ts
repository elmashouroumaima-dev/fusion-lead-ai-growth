import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["node_modules/**", ".next/**"],
    server: {
      deps: {
        // next-intl (ESM) importe « next/server » sans extension : on le fait résoudre par Vite.
        inline: [/next-intl/],
      },
    },
  },
});
