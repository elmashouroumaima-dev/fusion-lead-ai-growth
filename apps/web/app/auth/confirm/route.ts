import { confirmQuerySchema, type EmailOtpType } from "@fusion-leap/domain";
import { NextResponse, type NextRequest } from "next/server";
import { RECOVERY_COOKIE } from "../../../lib/auth/routes";
import { safeNext } from "../../../lib/auth/safe-redirect";
import { getSiteUrl } from "../../../lib/auth/site-url";
import { createClient } from "../../../lib/supabase/server";

/** Types de lien acceptés ici (le schéma du domaine reste général) : inscription et récupération. */
const ALLOWED_TYPES: ReadonlySet<EmailOtpType> = new Set(["signup", "email", "recovery"]);

/**
 * Callback des liens e-mail (confirmation d'inscription, récupération de mot de passe).
 * GET est imposé par le lien du mail ; l'échange du jeton (verifyOtp) pose la session en cookies.
 * Le chemin est sans préfixe de locale : le proxy (next-intl) le redirigera vers la bonne locale.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const failure = () => relativeRedirect("/login?error=link_invalid");

  const parsed = confirmQuerySchema.safeParse({
    token_hash: request.nextUrl.searchParams.get("token_hash") ?? undefined,
    type: request.nextUrl.searchParams.get("type") ?? undefined,
    next: request.nextUrl.searchParams.get("next") ?? undefined,
  });
  if (!parsed.success || !ALLOWED_TYPES.has(parsed.data.type)) return failure();
  const { token_hash, type, next } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) return failure();

  // Récupération : destination imposée (on ignore `next`) + cookie qui autorise reset-password.
  if (type === "recovery") {
    const response = relativeRedirect("/reset-password");
    response.cookies.set(RECOVERY_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureDeployment(),
      path: "/",
      maxAge: 15 * 60,
    });
    return response;
  }
  return relativeRedirect(safeNext(next, "/dashboard"));
}

/** Secure en production ou si l'URL publique du site est en https (jamais d'après la requête). */
function isSecureDeployment(): boolean {
  return process.env.NODE_ENV === "production" || new URL(getSiteUrl()).protocol === "https:";
}

/**
 * Redirection à Location RELATIVE : le navigateur reste sur l'hôte exact qu'il a utilisé
 * (127.0.0.1 ≠ localhost pour les cookies), et aucune origine fournie par l'appelant n'est utilisée.
 */
function relativeRedirect(path: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: path, "Cache-Control": "no-store" },
  });
}
