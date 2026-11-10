import type { WebhookAdapter, WebhookHeaders, WebhookSecretReader, WebhookStore } from "./types";

/**
 * Pipeline commun de réception d'un webhook (J29). Fonction PURE (aucune session, aucune base : le `store` et le lecteur de secret sont
 * injectés) : la route HTTP, les tests et le worker l'utilisent tels quels.
 *
 * Ordre (chaque étape ne s'exécute que si les précédentes ont réussi) :
 *  1. taille du corps brut <= `maxBytes` de l'adaptateur ;
 *  2. lecture JSON ; compte fournisseur présent ;
 *  3. entreprise résolue par le COMPTE fournisseur (jamais par un champ libre) ; compte inconnu : MÊME refus 401 qu'une signature invalide,
 *     après une vérification factice (même travail, même réponse : aucun oracle d'existence d'un compte, revue J29) et sans aucune écriture ;
 *  4. secret de l'intégration (absent : refus), puis SIGNATURE sur le corps brut ; échec : refus 401 + trace `rejected` sans payload ;
 *  5. horodatage signé (si l'adaptateur en déclare un) : un nombre fini dans une fenêtre de 5 minutes, sinon même refus 401 ;
 *  6. identifiant d'événement présent ; enregistrement idempotent (un rejeu répond 200 « duplicate » sans second traitement).
 * Un adaptateur qui lève une exception ne produit JAMAIS une erreur serveur exploitable par un inconnu : requête invalide ou refus.
 * Le traitement lui-même est différé (job `process_webhook`, créé par la base dans la même transaction que l'enregistrement).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Secret factice pour la vérification d'un compte inconnu : même travail que pour un compte connu, résultat ignoré. */
const DUMMY_SECRET = "webhook-dummy-secret-for-unknown-accounts";

export type WebhookOutcome =
  | { kind: "accepted"; eventId: string }
  | { kind: "duplicate"; eventId: string }
  | { kind: "bad_request" }
  | { kind: "too_large" }
  | { kind: "invalid_signature" };

export type IngestInput = {
  adapter: WebhookAdapter;
  rawBody: Uint8Array;
  headers: WebhookHeaders;
  store: WebhookStore;
  readSecret: WebhookSecretReader;
  /** Secondes Unix (injectable pour les tests). */
  now?: () => number;
};

export async function ingestWebhook(input: IngestInput): Promise<WebhookOutcome> {
  const { adapter, rawBody, headers, store, readSecret } = input;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  if (rawBody.byteLength > adapter.maxBytes) return { kind: "too_large" };

  let payload: unknown;
  let account: string | null;
  try {
    payload = adapter.parse(rawBody);
    if (payload === null || payload === undefined) return { kind: "bad_request" };
    account = adapter.extractAccount(payload, headers);
  } catch {
    return { kind: "bad_request" };
  }
  if (!account) return { kind: "bad_request" };

  const verify = (secret: string | null): boolean => {
    try {
      return adapter.verify({ rawBody, headers, secret }) === true;
    } catch {
      return false;
    }
  };

  const target = await store.resolve(adapter.provider, account);
  if (!target) {
    // même travail et même réponse qu'une signature invalide : un inconnu ne distingue pas un compte inexistant d'un compte existant
    verify(DUMMY_SECRET);
    return { kind: "invalid_signature" };
  }

  const reject = async (): Promise<WebhookOutcome> => {
    await store.recordRejection({ organizationId: target.organizationId, integrationId: target.integrationId, provider: adapter.provider });
    return { kind: "invalid_signature" };
  };

  const secret = await readSecret(target.organizationId, target.integrationId);
  // une intégration sans secret ne peut rien authentifier : refus, quel que soit l'adaptateur (défense en profondeur)
  if (!secret) {
    verify(DUMMY_SECRET);
    return reject();
  }
  if (!verify(secret)) return reject();

  if (adapter.extractTimestamp) {
    let timestamp: number | null;
    try {
      timestamp = adapter.extractTimestamp(payload, headers);
    } catch {
      return reject();
    }
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || Math.abs(now() - timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return reject();
  }

  let externalEventId: string | null;
  try {
    externalEventId = adapter.extractEventId(payload, headers);
  } catch {
    return { kind: "bad_request" };
  }
  if (!externalEventId) return { kind: "bad_request" };

  const recorded = await store.record({
    organizationId: target.organizationId,
    integrationId: target.integrationId,
    provider: adapter.provider,
    externalEventId,
    payload,
  });
  return recorded.duplicate ? { kind: "duplicate", eventId: recorded.eventId } : { kind: "accepted", eventId: recorded.eventId };
}
