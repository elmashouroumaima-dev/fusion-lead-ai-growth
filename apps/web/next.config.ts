import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Monorepo : les fichiers `.env*` vivent à la racine du dépôt (jamais commités, voir .gitignore).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// forceReload : Next a déjà chargé les `.env*` du dossier courant (apps/web) ; sans ce paramètre l'appel
// suivant renvoie le cache et les fichiers de la racine du dépôt ne sont jamais lus.
loadEnvConfig(root, process.env.NODE_ENV !== "production", console, true);

const nextConfig: NextConfig = {
  // Les packages du monorepo sont consommés en TypeScript source.
  transpilePackages: ["@fusion-leap/domain", "@fusion-leap/permissions", "@fusion-leap/adapters"],
  poweredByHeader: false,
  // Développement uniquement : autorise l'accès par 127.0.0.1 (les liens d'e-mail et SITE_URL l'utilisent).
  // Sans cela, Next 16 bloque les ressources de développement et les Server Actions échouent.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Server Actions : corps de 512 Ko au plus (le plus gros envoi légitime est le logo, 128 Ko décodés, environ 175 Ko en base64) ;
  // la valeur par défaut de Next est 1 Mo. Un corps plus gros est refusé par Next AVANT notre pipeline (revue J17).
  experimental: { serverActions: { bodySizeLimit: "512kb" } },
  async redirects() {
    // /settings n'a pas de page propre : le menu latéral liste les sections ; on ouvre la première.
    return [{ source: "/:locale(fr|ar|en)/settings", destination: "/:locale/settings/appearance", permanent: false }];
  },
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
