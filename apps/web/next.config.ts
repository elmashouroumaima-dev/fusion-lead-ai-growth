import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Monorepo : les fichiers `.env*` vivent à la racine du dépôt (jamais commités, voir .gitignore).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnvConfig(root, process.env.NODE_ENV !== "production");

const nextConfig: NextConfig = {
  // Les packages du monorepo sont consommés en TypeScript source.
  transpilePackages: ["@fusion-leap/domain"],
  poweredByHeader: false,
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(nextConfig);
