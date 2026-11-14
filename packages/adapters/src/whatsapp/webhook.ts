import { createHash, timingSafeEqual } from "node:crypto";
import { verifyHmacSha256Hex } from "../webhooks/hmac";
import type { WebhookAdapter, WebhookHeaders } from "../webhooks/types";
import { normalizeWhatsAppPayload, readWhatsAppPayload } from "./events";

/**
 * Webhooks WhatsApp Business Platform Cloud API (J34 et J35, spec §9.3 et §11). Meta signe le corps BRUT avec le « secret de l'app » (HMAC-SHA256,
 * en-tête `X-Hub-Signature-256: sha256=<hex>`) : ce secret est celui de l'intégration (emplacement du secret de webhook, J32). Le compte visé est
 * l'identifiant du numéro (`phone_number_id`) : lu dans le payload NON authentifié, il ne sert qu'à retrouver l'intégration et son secret ; un faux
 * identifiant échoue à la signature. Une requête qui mélange plusieurs numéros est refusée (une signature = une intégration) ; les changements sans
 * numéro (notifications d'état du compte ou des modèles) sont acceptés tant qu'un autre changement de la requête désigne le numéro.
 * `parse` NORMALISE (`events.ts`) : c'est la forme réduite qui est conservée et traitée, jamais le corps brut.
 * Pas d'identifiant d'événement unique chez Meta (un envoi contient une liste de messages et de statuts) : l'identifiant de déduplication de la
 * REQUÊTE est l'empreinte de la forme normalisée (Meta renvoie le même corps en cas de nouvel essai, donc le même identifiant) ; la déduplication
 * de chaque MESSAGE (`wamid`) se fait au traitement, en base.
 */
export const whatsappWebhookAdapter: WebhookAdapter = {
  provider: "whatsapp",
  maxBytes: 3 * 1024 * 1024,
  parse(rawBody) {
    try {
      return normalizeWhatsAppPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)));
    } catch {
      return null;
    }
  },
  extractAccount(payload) {
    const parsed = readWhatsAppPayload(payload);
    return parsed ? (parsed.phoneNumberIds[0] ?? null) : null;
  },
  extractEventId(payload) {
    if (readWhatsAppPayload(payload) === null) return null;
    return `wa:${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 40)}`;
  },
  verify({ rawBody, headers, secret }) {
    return verifyHmacSha256Hex({ secret, rawBody, signature: (headers as WebhookHeaders)["x-hub-signature-256"], prefix: "sha256=" });
  },
};

/**
 * Poignée de main d'abonnement de Meta (GET) : `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`. Le jeton de vérification est celui de la
 * PLATEFORME (la requête ne porte aucun compte) ; comparaison à temps constant. Renvoie le défi à répéter (caractères sûrs seulement) ou `null`.
 */
export function answerWhatsAppChallenge(query: URLSearchParams, expectedToken: string | undefined): string | null {
  if (!expectedToken) return null;
  const given = query.get("hub.verify_token");
  const challenge = query.get("hub.challenge");
  if (query.get("hub.mode") !== "subscribe" || given === null || challenge === null || !/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) return null;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(a, b) ? challenge : null;
}
