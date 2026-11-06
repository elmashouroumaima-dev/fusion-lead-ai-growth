import { activeOrgCookieSchema, uuidSchema } from "@fusion-leap/domain";
import { cookies } from "next/headers";

/** Cookie de l'organisation active (ADR 005 §7) : un INDICE, jamais une preuve d'autorisation. */
export const ACTIVE_ORG_COOKIE = "fl_active_org";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 jours

/**
 * Lit l'indice. Une valeur qui n'est pas un uuid est ignorée (traitée comme absente) : on ne
 * propage jamais une valeur arbitraire du client vers une requête. Lecture possible partout.
 */
export async function readActiveOrgCookie(): Promise<string | undefined> {
  const raw = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const parsed = activeOrgCookieSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Pose le cookie. À n'appeler que depuis une Server Action ou un Route Handler (les cookies sont
 * en lecture seule dans un Server Component). L'appelant doit avoir VÉRIFIÉ l'adhésion avant.
 */
export async function setActiveOrgCookie(organizationId: string): Promise<void> {
  const id = uuidSchema.parse(organizationId);
  (await cookies()).set(ACTIVE_ORG_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}
