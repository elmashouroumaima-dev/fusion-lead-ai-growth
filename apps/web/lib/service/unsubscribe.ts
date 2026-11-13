import "server-only";
import { verifyUnsubscribeToken } from "@fusion-leap/adapters";
import { createAdminClient } from "../supabase/admin";
import { getKeyRing } from "../smtp/secrets";
import { ServiceError } from "./errors";

/**
 * Désabonnement public (J33, spec §9.2) : pas de session. L'entreprise et le message viennent UNIQUEMENT du jeton signé (HMAC) ; le contact est
 * retrouvé par la base à partir du message. Seul module de l'application web qui appelle `unsubscribe_apply` (service_role).
 *  - `applied`  : consentements e-mail révoqués, adresse supprimée, envois en file annulés ;
 *  - `already`  : déjà désabonné (la demande est idempotente) ;
 *  - `invalid`  : jeton falsifié, message inconnu ou clé inconnue : rien n'est écrit.
 * Sans clé de signature configurée ou base indisponible : `service_unavailable` (503) : le lien reste utilisable plus tard.
 */
export type UnsubscribeOutcome = "applied" | "already" | "invalid";

/** Format d'un jeton, vérifié AVANT toute utilisation dans une adresse (redirection, formulaire). */
export const UNSUBSCRIBE_TOKEN_SHAPE = /^v1\.[1-9][0-9]{0,3}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

/** Vrai si la signature du jeton est valide (aucune écriture). */
export function isValidUnsubscribeToken(token: string): boolean {
  if (!UNSUBSCRIBE_TOKEN_SHAPE.test(token)) return false;
  const keyRing = getKeyRing();
  return keyRing !== null && verifyUnsubscribeToken(keyRing, token) !== null;
}

export async function applyUnsubscribe(token: string): Promise<UnsubscribeOutcome> {
  const keyRing = getKeyRing();
  if (!keyRing) throw new ServiceError("service_unavailable");
  const claims = UNSUBSCRIBE_TOKEN_SHAPE.test(token) ? verifyUnsubscribeToken(keyRing, token) : null;
  if (!claims) return "invalid";
  const { data, error } = await createAdminClient().rpc("unsubscribe_apply", { p_org: claims.organizationId, p_message: claims.messageId });
  if (error) {
    if (error.code === "PT404" || error.code === "22023") return "invalid";
    throw new ServiceError("service_unavailable");
  }
  const outcome = (data as { outcome?: unknown } | null)?.outcome;
  if (outcome === "applied" || outcome === "already") return outcome;
  throw new ServiceError("internal_error");
}
