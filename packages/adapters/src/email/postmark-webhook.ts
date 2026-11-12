import { createHash, timingSafeEqual } from "node:crypto";
import type { WebhookAdapter, WebhookHeaders } from "../webhooks/types";
import { normalizePostmarkPayload } from "./events";

/**
 * Adaptateur de webhook e-mail pour Postmark (J32, ADR 008). Postmark ne signe PAS ses webhooks : l'authentification est un Basic Auth
 * (HTTPS obligatoire) dont l'UTILISATEUR est l'identifiant du compte e-mail de l'intégration (`external_account_id`, qui retrouve l'entreprise)
 * et dont le MOT DE PASSE est le secret de webhook de l'intégration (distinct du jeton d'envoi). C'est plus faible qu'une signature sur le corps
 * (le secret circule à chaque requête) : décision actée par la responsable technique (ADR 008). Mesures : comparaison à temps constant, secret
 * propre à chaque intégration, déduplication, charge utile réduite, identifiant d'événement dérivé du contenu.
 * Taille : 5 Mo (un entrant avec de grosses pièces jointes est refusé 413 ; les pièces jointes ne sont de toute façon pas conservées).
 */
const ACCOUNT = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_BYTES = 5 * 1024 * 1024;

function basicCredentials(headers: WebhookHeaders): { user: string; password: string } | null {
  const header = headers.authorization;
  if (typeof header !== "string" || header.length > 600) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

export const postmarkWebhookAdapter: WebhookAdapter = {
  provider: "email",
  maxBytes: MAX_BYTES,
  parse(rawBody) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return null;
    }
    return normalizePostmarkPayload(json);
  },
  extractAccount(_payload, headers) {
    const credentials = basicCredentials(headers);
    return credentials && ACCOUNT.test(credentials.user) ? credentials.user : null;
  },
  extractEventId(payload) {
    return typeof payload === "object" && payload !== null && "eventId" in payload && typeof payload.eventId === "string" ? payload.eventId : null;
  },
  verify({ headers, secret }) {
    const credentials = basicCredentials(headers);
    if (!credentials || secret === null || secret.length === 0) return false;
    // empreintes de même longueur : comparaison à temps constant quel que soit le mot de passe reçu
    return timingSafeEqual(digest(credentials.password), digest(secret));
  },
};
