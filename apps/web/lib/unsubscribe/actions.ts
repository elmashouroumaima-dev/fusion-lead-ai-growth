"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp, ipBucketKey } from "../service/capture-lead";
import { takePublicToken } from "../service/rate-limit";
import { applyUnsubscribe, isValidUnsubscribeToken, UNSUBSCRIBE_TOKEN_SHAPE } from "../service/unsubscribe";

/**
 * Confirmation du désabonnement depuis la page publique (J33) : sans session, le jeton (signé) est la seule autorité. Le jeton est relu et
 * vérifié ici (jamais confiance au formulaire) ; l'adresse de redirection n'est construite qu'à partir d'un jeton bien formé et d'une langue
 * connue. Résultats : `done` (désabonné), `invalid` (lien invalide), `error` (service indisponible ou limite atteinte, on peut réessayer).
 */
export async function confirmUnsubscribeAction(locale: string, token: string): Promise<void> {
  const safeLocale = locale === "ar" || locale === "en" ? locale : "fr";
  if (!UNSUBSCRIBE_TOKEN_SHAPE.test(token)) redirect(`/${safeLocale}`);
  if (!isValidUnsubscribeToken(token)) redirect(`/${safeLocale}/unsubscribe/${token}?result=invalid`);
  let result: "done" | "invalid" | "error";
  try {
    const limit = await takePublicToken({ scope: "unsubscribe_ip", bucketKey: ipBucketKey(clientIp(await headers()) ?? "unknown") });
    if (!limit.allowed) {
      result = "error";
    } else {
      const outcome = await applyUnsubscribe(token);
      result = outcome === "invalid" ? "invalid" : "done";
    }
  } catch {
    result = "error";
  }
  redirect(`/${safeLocale}/unsubscribe/${token}?result=${result}`);
}
