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
        // En-têtes globaux. DOIT rester la première règle : pour une même clé, la dernière règle qui correspond
        // l'emporte (les règles invite / login / signup ci-dessous durcissent Referrer-Policy à `no-referrer`).
        // CSP volontairement réduite à `frame-ancestors 'none'` : une CSP complète (script-src) casserait le script
        // inline de next-themes ; voir docs/adr/015-ui-kit.md.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
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
