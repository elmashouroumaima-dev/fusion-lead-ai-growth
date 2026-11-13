/**
 * Envoi WhatsApp par l'API Cloud officielle (J36, spec §9.3). Le domaine ne connaît que cette interface ; le jeton est passé à chaque appel (lu par le
 * worker via `secret_ref`) et n'apparaît jamais dans une erreur, un code ou un journal. Adresse FIXE de l'API Graph (jamais configurable), identifiant du
 * numéro et destinataire contrôlés (chiffres), corps JSON strict, délai limité, réponse lue sur 64 Ko. Aucun texte renvoyé par Meta n'est recopié (il peut
 * citer le numéro ou le jeton) : seuls des codes courts sortent d'ici.
 *
 * Résultat d'un envoi (même contrat que l'e-mail : c'est ce qui évite les doublons chez le destinataire) :
 *  - `accepted`  : Meta a accepté (identifiant `wamid`) ; ≠ livré (`delivered` vient d'un statut, J35) ;
 *  - `rejected`  : refus DÉFINITIF (jeton refusé, numéro invalide, fenêtre fermée, modèle invalide...) ;
 *  - `retryable` : Meta a répondu qu'il n'a PAS accepté (limite, panne) : un nouvel essai est sûr ;
 *  - `unknown`   : aucune réponse exploitable (coupure, passerelle) : le message a PEUT-ÊTRE été envoyé, il ne faut JAMAIS le renvoyer.
 */
export const WHATSAPP_MESSAGES_BASE = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;
const PHONE_NUMBER_ID = /^[0-9]{5,30}$/;
const RECIPIENT = /^[0-9]{5,20}$/;
const WAMID = /^[A-Za-z0-9._=+/-]{1,255}$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,200}$/;
const LANGUAGE = /^[a-z]{2}(_[A-Z]{2})?$/;

export type WhatsAppSendInput =
  | { kind: "text"; phoneNumberId: string; to: string; text: string }
  | { kind: "template"; phoneNumberId: string; to: string; template: { name: string; language: string; variables: string[] } };

export type WhatsAppSendOutcome =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "rejected"; code: string }
  | { kind: "retryable"; code: string }
  | { kind: "unknown"; code: string };

export interface WhatsAppSender {
  readonly name: string;
  send(input: WhatsAppSendInput, accessToken: string): Promise<WhatsAppSendOutcome>;
}

export type WhatsAppSenderOptions = { fetch?: typeof fetch; timeoutMs?: number };

/** Codes Graph de limite de débit SANS ambiguïté : l'envoi n'a pas été accepté, un nouvel essai est sûr. Les erreurs 500, 503 et les codes 1, 2 (erreur interne) arrivent parfois APRÈS l'acceptation : jamais réessayées à l'aveugle. */
const RETRYABLE_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) return true;
    if (code === 0x7f) return true;
  }
  return false;
}

/** Vrai si le texte contient un caractère de contrôle (y compris saut de ligne et tabulation : Meta les refuse dans les variables d'un modèle). */
function hasAnyControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validInput(input: WhatsAppSendInput, token: string): boolean {
  if (token.length === 0 || token.length > 4096 || /[^ -~]/.test(token)) return false;
  if (!PHONE_NUMBER_ID.test(input.phoneNumberId) || !RECIPIENT.test(input.to)) return false;
  if (input.kind === "text") return input.text.length >= 1 && input.text.length <= 4096 && !hasControlChar(input.text);
  const t = input.template;
  return (
    TEMPLATE_NAME.test(t.name) && LANGUAGE.test(t.language) && t.variables.length <= 10 &&
    t.variables.every((v) => v.length >= 1 && v.length <= 1024 && !hasAnyControl(v))
  );
}

function payload(input: WhatsAppSendInput): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: input.to };
  if (input.kind === "text") return { ...base, type: "text", text: { preview_url: false, body: input.text } };
  const { name, language, variables } = input.template;
  return {
    ...base, type: "template",
    template: { name, language: { code: language }, ...(variables.length > 0 ? { components: [{ type: "body", parameters: variables.map((text) => ({ type: "text", text })) }] } : {}) },
  };
}

async function readJson(response: Response): Promise<unknown> {
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

export function createWhatsAppSender(options: WhatsAppSenderOptions = {}): WhatsAppSender {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    name: "whatsapp_cloud",
    async send(input, accessToken): Promise<WhatsAppSendOutcome> {
      if (!validInput(input, accessToken)) return { kind: "rejected", code: "invalid_input" };
      let response: Response;
      try {
        response = await doFetch(`${WHATSAPP_MESSAGES_BASE}/${input.phoneNumberId}/messages`, {
          method: "POST",
          redirect: "error",
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(payload(input)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // aucune réponse : le message a peut-être été envoyé
        return { kind: "unknown", code: "no_response" };
      }
      const status = response.status;
      const body = (await readJson(response)) as { messages?: Array<{ id?: unknown }>; error?: { code?: unknown } } | null;
      if (status === 200) {
        const id = body?.messages?.[0]?.id;
        // 200 sans identifiant exploitable : on ne sait pas si c'est parti
        return typeof id === "string" && WAMID.test(id) ? { kind: "accepted", providerMessageId: id } : { kind: "unknown", code: "unreadable_response" };
      }
      const code = body && typeof body.error?.code === "number" ? body.error.code : 0;
      // toute erreur 5xx (et les erreurs internes 1 et 2) : le message a PEUT-ÊTRE été accepté : résultat inconnu, jamais renvoyé
      if (status >= 500 || code === 1 || code === 2) return { kind: "unknown", code: "gateway_uncertain" };
      if (status === 429 || RETRYABLE_CODES.has(code)) return { kind: "retryable", code: "provider_rate_limited" };
      if (status === 401 || status === 403 || code === 190) return { kind: "rejected", code: "provider_auth" };
      if (code === 131047) return { kind: "rejected", code: "window_closed" };
      if (code === 131026 || code === 131030 || code === 131021) return { kind: "rejected", code: "recipient_invalid" };
      if (code === 132000 || code === 132001 || code === 132005 || code === 132007 || code === 132012 || code === 132015 || code === 132016) return { kind: "rejected", code: "template_invalid" };
      return { kind: "rejected", code: "provider_rejected" };
    },
  };
}
