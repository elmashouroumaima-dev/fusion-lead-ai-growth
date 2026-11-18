/**
 * Validation d'une intégration e-mail Postmark (écran de canaux, ADR 008) : le jeton du SERVEUR (déchiffré en mémoire par le serveur, jamais journalisé) est
 * essayé sur l'API de Postmark (`GET /server`). Adresse FIXE (jamais configurable : pas de requête sortante vers un hôte choisi par un utilisateur). Aucun
 * texte du fournisseur n'est recopié : seuls des codes courts sortent d'ici, les mêmes que pour WhatsApp.
 *  - `valid`                : le jeton est accepté par Postmark ;
 *  - `provider_auth`        : jeton refusé ;
 *  - `provider_unavailable` : panne, limite ou délai dépassé (réessayer ; l'intégration n'est jamais dégradée pour cela) ;
 *  - `provider_unreadable`  : réponse inexploitable.
 * Limite : un jeton valide ne prouve PAS que l'adresse d'expéditeur du canal est confirmée chez Postmark ; Postmark refuse l'envoi tant qu'une « Sender Signature »
 * n'existe pas pour l'adresse (code `provider_rejected` à l'envoi). Hypothèse sur `GET /server` à confirmer sur un compte réel (checkpoint C3).
 */
export const POSTMARK_SERVER_URL = "https://api.postmarkapp.com/server";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

export type PostmarkValidation = { kind: "valid" } | { kind: "invalid"; code: "provider_auth" | "provider_unavailable" | "provider_unreadable" };
export type PostmarkValidatorOptions = { fetch?: typeof fetch; timeoutMs?: number };

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

export function createPostmarkValidator(options: PostmarkValidatorOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async validate(input: { serverToken: string }): Promise<PostmarkValidation> {
      const { serverToken } = input;
      // un jeton vide, trop long ou avec un caractère de contrôle n'est jamais envoyé
      if (serverToken.length === 0 || serverToken.length > 4096 || /[^ -~]/.test(serverToken)) return { kind: "invalid", code: "provider_auth" };
      let response: Response;
      try {
        response = await doFetch(POSTMARK_SERVER_URL, {
          method: "GET",
          redirect: "error",
          headers: { Accept: "application/json", "X-Postmark-Server-Token": serverToken },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "invalid", code: "provider_unavailable" };
      }
      if (response.status === 200) {
        const body = (await readJson(response)) as { ID?: unknown } | null;
        return body && typeof body.ID === "number" ? { kind: "valid" } : { kind: "invalid", code: "provider_unreadable" };
      }
      if (response.status === 401 || response.status === 403) return { kind: "invalid", code: "provider_auth" };
      if (response.status === 429 || response.status >= 500) return { kind: "invalid", code: "provider_unavailable" };
      return { kind: "invalid", code: "provider_unreadable" };
    },
  };
}
export type PostmarkValidator = ReturnType<typeof createPostmarkValidator>;
