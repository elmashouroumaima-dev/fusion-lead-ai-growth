import type { EmailProvider, EmailSendInput, EmailSendOutcome } from "./provider";

/**
 * Fournisseur e-mail : Postmark (ADR 008, hypothèse de la spec §14 en attendant Q2 ; à confirmer sur un compte sandbox, C3).
 * Adresse FIXE (jamais configurable : pas de requête sortante vers un hôte choisi par un utilisateur), jeton dans l'en-tête dédié, corps JSON
 * strict, délai limité, réponse lue sur 64 Ko au plus. Aucun texte renvoyé par le fournisseur n'est recopié dans un résultat (il peut citer
 * l'adresse du destinataire) : seuls des codes courts sortent d'ici.
 */
export const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;
const PROVIDER_ID = /^[A-Za-z0-9._:=+/@<>$%-]{1,998}$/;
const ADDRESS = /^[^\s<>"',;:\\]+@[^\s<>"',;:\\]+$/;

/** Vrai si le texte contient un caractère de contrôle (saut de ligne, NUL, DEL...) : jamais dans une adresse ni un objet. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type PostmarkOptions = {
  /** Injectable pour les tests ; par défaut `fetch` global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function validInput(input: EmailSendInput, secret: string): boolean {
  return (
    secret.length > 0 && secret.length <= 200 && !hasControlChar(secret) && !/[^ -~]/.test(secret) &&
    ADDRESS.test(input.from) && !hasControlChar(input.from) && input.from.length <= 320 &&
    ADDRESS.test(input.to) && !hasControlChar(input.to) && input.to.length <= 320 &&
    input.subject.length >= 1 && input.subject.length <= 200 && !hasControlChar(input.subject) &&
    input.textBody.length >= 1 && input.textBody.length <= 100_000
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
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createPostmarkProvider(options: PostmarkOptions = {}): EmailProvider {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    name: "postmark",
    async send(input, secret): Promise<EmailSendOutcome> {
      if (!validInput(input, secret)) return { kind: "rejected", code: "invalid_input" };
      let response: Response;
      try {
        response = await doFetch(POSTMARK_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": secret,
          },
          body: JSON.stringify({ From: input.from, To: input.to, Subject: input.subject, TextBody: input.textBody, MessageStream: "outbound" }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // aucune réponse : le message a peut-être été envoyé
        return { kind: "unknown", code: "no_response" };
      }
      const status = response.status;
      const body = (await readLimited(response)) as { ErrorCode?: unknown; MessageID?: unknown } | null;
      if (status === 200) {
        if (body && body.ErrorCode === 0 && typeof body.MessageID === "string" && PROVIDER_ID.test(body.MessageID)) {
          return { kind: "accepted", providerMessageId: body.MessageID };
        }
        // 200 sans identifiant exploitable : on ne sait pas si c'est parti
        return { kind: "unknown", code: "unreadable_response" };
      }
      if (status === 401 || status === 403) return { kind: "rejected", code: "provider_auth" };
      if (status === 422) {
        const code = body && typeof body.ErrorCode === "number" ? body.ErrorCode : 0;
        if (code === 406) return { kind: "rejected", code: "recipient_inactive" };
        if (code === 300 || code === 400) return { kind: "rejected", code: "recipient_invalid" };
        return { kind: "rejected", code: "provider_rejected" };
      }
      if (status === 429) return { kind: "retryable", code: "provider_rate_limited" };
      // 500 et 503 : le fournisseur dit qu'il n'a rien traité. 502, 504 et les autres 5xx viennent souvent d'une passerelle devant le fournisseur :
      // le message a PEUT-ÊTRE été accepté, on ne le renvoie donc jamais à l'aveugle.
      if (status === 500 || status === 503) return { kind: "retryable", code: "provider_unavailable" };
      if (status >= 500) return { kind: "unknown", code: "gateway_uncertain" };
      return { kind: "rejected", code: "provider_rejected" };
    },
  };
}
