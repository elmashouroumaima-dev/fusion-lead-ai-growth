import { cleanText, EMAIL_BODY_MAX, type EmailEvent } from "./events";
import { resendAddressOf } from "./resend-webhook";

/**
 * Réception Resend (ADR 008, note du 2026-11-24) : le webhook `email.received` ne porte ni corps ni en-têtes ; le worker relit le message par
 * `GET https://api.resend.com/emails/receiving/{id}` avec la clé d'API de L'INTÉGRATION (jamais une valeur du client). Adresse FIXE ; l'identifiant
 * (déjà validé par l'adaptateur du webhook) est revalidé avant de servir de segment d'adresse ; `html_format=cid` évite les images en base64 dans la
 * réponse ; réponse lue sur 2 Mo au plus ; aucun texte du fournisseur n'est recopié (seuls des codes courts sortent d'ici).
 *
 * Forme tirée de la doc officielle (exemple illustratif, À CONFIRMER sur un compte réel) : `from`, `to`, `received_for`, `subject`, `text`, `html`,
 * `created_at`, `message_id`, `authentication { spf, dkim, dmarc }`. Choix de sécurité :
 *  - destinataires = `received_for` (l'adresse réellement atteinte, posée par le fournisseur) et à défaut `to` : comme `OriginalRecipient` chez Postmark ;
 *  - l'expéditeur est « authentifié » (`spfPass`) seulement si `authentication.dmarc` = `pass` (SPF ou DKIM ALIGNÉ sur le domaine affiché) ;
 *  - aucune information de pourriel : `spam` = faux ; les en-têtes (In-Reply-To, References) ne sont pas garantis dans la réponse : le rattachement se fait,
 *    comme pour Postmark, par l'expéditeur et le canal destinataire.
 */
export const RESEND_RECEIVING_BASE = "https://api.resend.com/emails/receiving/";
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EMAIL_ID = /^[A-Za-z0-9._-]{1,100}$/;
const PROVIDER_ID = /^[A-Za-z0-9._:=+/@<>$%-]{1,998}$/;
const SUBJECT_MAX = 300;
const RECIPIENTS_MAX = 20;

export type InboundMessage = Extract<EmailEvent, { kind: "inbound" }>;
export type ResendReceiveOutcome =
  | { kind: "received"; event: InboundMessage }
  /** Définitif : clé refusée, réponse inexploitable, trop grosse, sans destinataire lisible… */
  | { kind: "rejected"; code: string }
  /** Réessayable : pas encore disponible (404), limite, panne, aucune réponse. */
  | { kind: "retryable"; code: string };

export type ResendReceiverOptions = { fetch?: typeof fetch; timeoutMs?: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Texte d'un message HTML sans texte brut : balises retirées, entités courantes décodées, espaces repliés (jamais interprété ni exécuté). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
        return "too_large";
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return null;
  }
}

function toEvent(emailId: string, body: Record<string, unknown>): ResendReceiveOutcome {
  const from = resendAddressOf(body.from);
  if (from === null) return { kind: "rejected", code: "invalid_sender" };
  const candidates = Array.isArray(body.received_for) && body.received_for.length > 0 ? body.received_for : Array.isArray(body.to) ? body.to : [];
  const recipients = [...new Set(candidates.map(resendAddressOf).filter((a): a is string => a !== null))].slice(0, RECIPIENTS_MAX);
  if (recipients.length === 0) return { kind: "rejected", code: "no_recipient" };
  const text = typeof body.text === "string" ? cleanText(body.text, EMAIL_BODY_MAX).trim() : "";
  const fromHtml = text.length === 0 && typeof body.html === "string" ? cleanText(htmlToText(body.html), EMAIL_BODY_MAX).trim() : "";
  const subject = typeof body.subject === "string" ? cleanText(body.subject, SUBJECT_MAX).trim() : "";
  const time = typeof body.created_at === "string" && body.created_at.length <= 64 ? Date.parse(body.created_at) : Number.NaN;
  const auth = isRecord(body.authentication) ? body.authentication : null;
  const providerMessageId = emailId;
  if (!PROVIDER_ID.test(providerMessageId)) return { kind: "rejected", code: "invalid_id" };
  return {
    kind: "received",
    event: {
      kind: "inbound",
      eventId: `inbound:${emailId}`,
      providerMessageId,
      from,
      recipients,
      subject: subject.length > 0 ? subject : null,
      body: text.length > 0 ? text : fromHtml.length > 0 ? fromHtml : "(message sans texte)",
      at: Number.isFinite(time) ? new Date(time).toISOString() : null,
      spfPass: auth !== null && auth.dmarc === "pass",
      spam: false,
    },
  };
}

export function createResendReceiver(options: ResendReceiverOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async fetchInbound(emailId: string, apiKey: string): Promise<ResendReceiveOutcome> {
      if (!EMAIL_ID.test(emailId)) return { kind: "rejected", code: "invalid_id" };
      if (apiKey.length === 0 || apiKey.length > 4096 || /[^ -~]/.test(apiKey)) return { kind: "rejected", code: "provider_auth" };
      let response: Response;
      try {
        response = await doFetch(`${RESEND_RECEIVING_BASE}${emailId}?html_format=cid`, {
          method: "GET",
          redirect: "error",
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "retryable", code: "no_response" };
      }
      const status = response.status;
      if (status === 401 || status === 403) return { kind: "rejected", code: "provider_auth" };
      // 404 : le message n'est peut-être pas encore lisible juste après le webhook ; le job est rejoué, puis échoue visiblement
      if (status === 404) return { kind: "retryable", code: "not_found_yet" };
      if (status === 429) return { kind: "retryable", code: "provider_rate_limited" };
      if (status >= 500) return { kind: "retryable", code: "provider_unavailable" };
      if (status !== 200) return { kind: "rejected", code: "provider_rejected" };
      const body = await readLimited(response);
      if (body === "too_large") return { kind: "rejected", code: "response_too_large" };
      if (!isRecord(body)) return { kind: "rejected", code: "unreadable_response" };
      return toEvent(emailId, body);
    },
  };
}
export type ResendReceiver = ReturnType<typeof createResendReceiver>;
