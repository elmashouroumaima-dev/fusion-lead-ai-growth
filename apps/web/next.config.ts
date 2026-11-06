import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Monorepo : les fichiers `.env*` vivent à la racine du dépôt (jamais commités, voir .gitignore).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnvConfig(root, process.env.NODE_ENV !== "production");

const nextConfig: NextConfig = {
  // Les packages du monorepo sont consommés en TypeScript source.
  transpilePackages: ["@fusion-leap/domain"],
  poweredByHeader: false,
};

export default nextConfig;
