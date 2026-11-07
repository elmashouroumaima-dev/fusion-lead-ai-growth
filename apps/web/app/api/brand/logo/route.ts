import { getPlatformLogo } from "../../../../lib/service/platform-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/brand/logo : sert le logo de la plateforme (public : il apparaît sur la page de connexion).
 * Les octets sont re-validés par getPlatformLogo (PNG / JPEG / WebP reconnus par leur signature, ≤ 128 Ko) ;
 * le type de contenu est celui DÉTECTÉ, jamais une valeur libre. `nosniff` et une CSP restrictive empêchent
 * toute interprétation active. Aucun logo => 404 (l'interface garde le logo par défaut).
 * L'URL est versionnée par l'interface (`?v=`) : le cache navigateur est court mais suffisant.
 */
export async function GET(): Promise<Response> {
  const logo = await getPlatformLogo();
  if (!logo) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(logo.bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": logo.mime,
      "Content-Length": String(logo.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
