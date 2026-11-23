import type { PostmarkValidation } from "./postmark-validate";

/**
 * Validation d'une intégration e-mail Resend (ADR 008) : la clé d'API (déchiffrée en mémoire, jamais journalisée) est essayée sur `GET /domains`.
 * Adresse FIXE. Seuls des codes courts sortent d'ici (mêmes codes que Postmark).
 *  - 200 : clé acceptée (accès complet) ;
 *  - 401 `restricted_api_key` : clé valide limitée à l'envoi (cas recommandé), donc acceptée ;
 *  - 401/403 autre : clé refusée (`provider_auth`) ; 429 et 5xx : `provider_unavailable`.
 * Hypothèse à confirmer sur un compte réel : la doc décrit `restricted_api_key` (« la clé ne peut qu'envoyer ») mais pas explicitement ce point d'entrée.
 * Limite : une clé valide ne prouve pas que le domaine de l'expéditeur est vérifié (sans domaine : envoi seulement à l'adresse du compte).
 */
export const RESEND_DOMAINS_URL = "https://api.resend.com/domains";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

export type ResendValidatorOptions = { fetch?: typeof fetch; timeoutMs?: number };

async function readName(response: Response): Promise<string> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return "";
      }
      chunks.push(value);
    }
    const body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as { name?: unknown } | null;
    return body && typeof body.name === "string" ? body.name : "";
  } catch {
    return "";
  }
}

export function createResendValidator(options: ResendValidatorOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async validate(input: { apiKey: string }): Promise<PostmarkValidation> {
      const { apiKey } = input;
      if (apiKey.length === 0 || apiKey.length > 4096 || /[^ -~]/.test(apiKey)) return { kind: "invalid", code: "provider_auth" };
      let response: Response;
      try {
        response = await doFetch(RESEND_DOMAINS_URL, {
          method: "GET",
          redirect: "error",
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "invalid", code: "provider_unavailable" };
      }
      if (response.status === 200) return { kind: "valid" };
      if (response.status === 401 || response.status === 403) {
        return (await readName(response)) === "restricted_api_key" && response.status === 401 ? { kind: "valid" } : { kind: "invalid", code: "provider_auth" };
      }
      if (response.status === 429 || response.status >= 500) return { kind: "invalid", code: "provider_unavailable" };
      return { kind: "invalid", code: "provider_unreadable" };
    },
  };
}
export type ResendValidator = ReturnType<typeof createResendValidator>;
