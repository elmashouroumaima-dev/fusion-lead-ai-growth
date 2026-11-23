import type { EmailProvider, EmailSendInput, EmailSendOutcome } from "./provider";

/**
 * Fournisseur e-mail : Resend (ADR 008, ajouté à côté de Postmark ; docs officielles lues le 2026-11-23, voir docs/integrations/email.md).
 * Mêmes garde-fous que `postmark.ts` : adresse FIXE, jeton dans l'en-tête `Authorization` seulement, délai limité, réponse lue sur 64 Ko au plus,
 * aucun texte du fournisseur recopié (il peut citer le destinataire) : seuls des codes courts sortent d'ici.
 * Limite connue : sans domaine vérifié, Resend n'envoie qu'à l'adresse du compte (403 `validation_error`, code `sender_not_allowed`).
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;
const PROVIDER_ID = /^[A-Za-z0-9._:=+/@<>$%-]{1,998}$/;
const ADDRESS = /^[^\s<>"',;:\\]+@[^\s<>"',;:\\]+$/;
/** Étiquettes Resend : lettres ASCII, chiffres, `_` ou `-` seulement (docs) ; nos clés/valeurs d'identifiants y tiennent, sinon refus local. */
const TAG = /^[A-Za-z0-9_-]{1,100}$/;

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type ResendOptions = {
  /** Injectable pour les tests ; par défaut `fetch` global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function validMetadata(metadata: Record<string, string> | undefined): boolean {
  if (metadata === undefined) return true;
  const entries = Object.entries(metadata);
  return entries.length <= 10 && entries.every(([key, value]) => /^[a-z_]{1,40}$/.test(key) && TAG.test(value));
}

const ALLOWED_HEADERS = new Set(["List-Unsubscribe", "List-Unsubscribe-Post"]);
function validHeaders(headers: EmailSendInput["headers"]): boolean {
  if (headers === undefined) return true;
  return (
    headers.length <= 4 &&
    headers.every((h) => ALLOWED_HEADERS.has(h.name) && h.value.length >= 1 && h.value.length <= 1000 && !hasControlChar(h.value) && !/[^ -~]/.test(h.value))
  );
}

function validInput(input: EmailSendInput, secret: string): boolean {
  return (
    secret.length > 0 && secret.length <= 200 && !hasControlChar(secret) && !/[^ -~]/.test(secret) &&
    ADDRESS.test(input.from) && !hasControlChar(input.from) && input.from.length <= 320 &&
    ADDRESS.test(input.to) && !hasControlChar(input.to) && input.to.length <= 320 &&
    input.subject.length >= 1 && input.subject.length <= 200 && !hasControlChar(input.subject) &&
    input.textBody.length >= 1 && input.textBody.length <= 100_000 &&
    validMetadata(input.metadata) && validHeaders(input.headers)
  );
}

async function readLimited(response: Response): Promise<unknown> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return null;
  }
}

export function createResendProvider(options: ResendOptions = {}): EmailProvider {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    name: "resend",
    async send(input, secret): Promise<EmailSendOutcome> {
      if (!validInput(input, secret)) return { kind: "rejected", code: "invalid_input" };
      let response: Response;
      try {
        response = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            from: input.from, to: input.to, subject: input.subject, text: input.textBody,
            ...(input.metadata ? { tags: Object.entries(input.metadata).map(([name, value]) => ({ name, value })) } : {}),
            ...(input.headers && input.headers.length > 0 ? { headers: Object.fromEntries(input.headers.map((h) => [h.name, h.value])) } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // aucune réponse : le message a peut-être été envoyé
        return { kind: "unknown", code: "no_response" };
      }
      const status = response.status;
      const body = (await readLimited(response)) as { id?: unknown; name?: unknown } | null;
      const name = body && typeof body.name === "string" ? body.name : "";
      if (status === 200) {
        if (body && typeof body.id === "string" && PROVIDER_ID.test(body.id)) return { kind: "accepted", providerMessageId: body.id };
        return { kind: "unknown", code: "unreadable_response" };
      }
      if (status === 401) return { kind: "rejected", code: "provider_auth" };
      if (status === 403) return { kind: "rejected", code: name === "validation_error" ? "sender_not_allowed" : name === "email_above_quota" ? "provider_quota" : "provider_auth" };
      if (status === 429) return name === "rate_limit_exceeded" ? { kind: "retryable", code: "provider_rate_limited" } : { kind: "rejected", code: "provider_quota" };
      if (status === 400 || status === 422) return { kind: "rejected", code: "provider_rejected" };
      // 503 : le fournisseur dit qu'il n'a rien traité. Les autres 5xx (dont 500, non garanti par la doc) : message peut-être accepté, jamais renvoyé à l'aveugle.
      if (status === 503) return { kind: "retryable", code: "provider_unavailable" };
      if (status >= 500) return { kind: "unknown", code: "gateway_uncertain" };
      return { kind: "rejected", code: "provider_rejected" };
    },
  };
}
