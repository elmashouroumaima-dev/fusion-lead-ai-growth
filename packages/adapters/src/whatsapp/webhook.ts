import { createHash, timingSafeEqual } from "node:crypto";
import { verifyHmacSha256Hex } from "../webhooks/hmac";
import type { WebhookAdapter, WebhookHeaders } from "../webhooks/types";

/**
 * Webhooks WhatsApp Business Platform Cloud API (J34, spec §9.3 et §11). Meta signe le corps BRUT avec le « secret de l'app » (HMAC-SHA256,
 * en-tête `X-Hub-Signature-256: sha256=<hex>`) : ce secret est celui de l'intégration (emplacement du secret de webhook, J32). Le compte visé est
 * l'identifiant du numéro (`phone_number_id`) : lu dans le payload NON authentifié, il ne sert qu'à retrouver l'intégration et son secret ; un faux
 * identifiant échoue à la signature. Une requête qui mélange plusieurs numéros est refusée (une signature = une intégration) ; les changements sans numéro
 * (notifications d'état du compte ou des modèles) sont acceptés tant qu'un autre changement de la requête désigne le numéro.
 * Pas d'identifiant d'événement unique chez Meta (un envoi contient une liste de messages et de statuts) : l'identifiant de déduplication est
 * l'empreinte du contenu signé ; Meta renvoie le même corps en cas de nouvel essai, donc le même identifiant.
 */
const PHONE_NUMBER_ID = /^[0-9]{5,30}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function phoneNumberIds(payload: unknown): string[] | null {
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry) || payload.entry.length === 0 || payload.entry.length > 100) return null;
  const ids: string[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes) || entry.changes.length === 0 || entry.changes.length > 100) return null;
    for (const change of entry.changes) {
      const metadata = isRecord(change) && isRecord(change.value) && isRecord(change.value.metadata) ? change.value.metadata : null;
      // d'autres notifications de Meta (qualité du numéro, état d'un modèle...) n'ont pas de numéro : on les laisse passer, seuls les changements AVEC un numéro désignent l'intégration
      if (!metadata || metadata.phone_number_id === undefined) continue;
      const id = metadata.phone_number_id;
      if (typeof id !== "string" || !PHONE_NUMBER_ID.test(id)) return null;
      ids.push(id);
    }
  }
  return ids.length > 0 ? ids : null;
}

export const whatsappWebhookAdapter: WebhookAdapter = {
  provider: "whatsapp",
  maxBytes: 3 * 1024 * 1024,
  parse(rawBody) {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
    } catch {
      return null;
    }
  },
  extractAccount(payload) {
    const ids = phoneNumberIds(payload);
    if (!ids) return null;
    const first = ids[0] as string;
    return ids.every((id) => id === first) ? first : null;
  },
  extractEventId(payload) {
    if (phoneNumberIds(payload) === null) return null;
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
