import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import {
  RECOVERY_COOKIE,
  isGuestOnlyPath,
  isPublicPath,
  normalizePathname,
  parseLocalePath,
} from "./lib/auth/routes";
import { safeNext } from "./lib/auth/safe-redirect";
import { copySessionState, updateSession } from "./lib/supabase/session";

const handleIntl = createIntlMiddleware(routing);

const isRedirect = (response: NextResponse): boolean =>
  response.status >= 300 && response.status < 400 && response.headers.has("location");

/**
 * Proxy Next.js 16 (ex-middleware) : i18n (next-intl) PUIS session Supabase PUIS protection des
 * routes. Un seul fichier proxy est permis ; c'est aussi le SEUL endroit qui rafraîchit la
 * session (les cookies sont posés sur la même réponse que celle renvoyée par next-intl).
 * Fail closed : un chemin non canonique est refusé (404) ; un chemin sans locale connue n'est
 * jamais servi (redirection next-intl vers la locale par défaut, sinon 404).
 */
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  // La décision d'accès porte sur le chemin décodé, comme le routage de Next.js.
  const pathname = normalizePathname(request.nextUrl.pathname);
  if (pathname === null) return new NextResponse(null, { status: 404 });

  const intlResponse = handleIntl(request);
  const { response, claims } = await updateSession(request, intlResponse);

  const parsed = parseLocalePath(pathname);
  if (!parsed) {
    // Pas de locale connue : seule une redirection préparée par next-intl (qui sera de nouveau
    // évaluée par ce proxy) est acceptable ; sinon on ne sert rien sans contrôle d'accès.
    return isRedirect(response)
      ? response
      : copySessionState(response, new NextResponse(null, { status: 404 }));
  }
  const { locale, rest } = parsed;
  const signedIn = claims !== null;

  const redirectTo = (path: string, search = ""): NextResponse => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = search;
    return copySessionState(response, NextResponse.redirect(url));
  };

  if (!signedIn && !isPublicPath(rest)) {
    const original = `/${locale}${rest}${request.nextUrl.search}`;
    const next = safeNext(original, `/${locale}/dashboard`);
    return redirectTo(`/${locale}/login`, `?next=${encodeURIComponent(next)}`);
  }

  if (signedIn && isGuestOnlyPath(rest)) {
    return redirectTo(`/${locale}/dashboard`);
  }

  // reset-password exige la session de récupération créée par /auth/confirm (cookie dédié).
  if (rest === "/reset-password") {
    const hasRecovery = request.cookies.get(RECOVERY_COOKIE)?.value === "1";
    if (!signedIn || !hasRecovery) return redirectTo(`/${locale}/forgot-password`);
  }

  return response;
}

export const config = {
  // Exclut api, _next, _vercel, auth (frontières exactes : /authx reste traité) et les fichiers
  // avec extension. Un chemin contenant un point ne passe donc pas ici : les pages privées
  // revérifient les claims côté serveur (lib/auth/require-claims.ts).
  matcher: ["/((?!(?:api|auth|_next|_vercel)(?:/|$)|.*\\..*).*)"],
};
