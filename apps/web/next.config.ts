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
  transpilePackages: ["@fusion-leap/domain", "@fusion-leap/permissions"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Le jeton d'invitation est dans l'URL : jamais de Referer sortant, jamais de cache, jamais indexé.
        source: "/:locale/invite/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // Le jeton d'invitation peut transiter par le paramètre `next=` de la connexion / inscription :
        // aucun Referer sortant depuis ces pages non plus.
        source: "/:locale/login",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        source: "/:locale/signup",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(nextConfig);
