/**
 * Validation d'une connexion WhatsApp Cloud API (J34, spec §9.3) : le jeton d'accès (déchiffré en mémoire par le serveur, jamais journalisé) est
 * essayé sur le numéro de l'intégration. Adresse FIXE de l'API Graph (jamais configurable : pas de requête sortante vers un hôte choisi par un
 * utilisateur) ; l'identifiant du numéro n'entre dans le chemin qu'après contrôle (chiffres seulement). Aucun texte du fournisseur n'est recopié
 * (il peut citer le numéro ou le jeton) : seuls des codes courts sortent d'ici.
 *  - `valid`                 : le jeton lit ce numéro ;
 *  - `provider_auth`         : jeton refusé ou expiré ;
 *  - `provider_account`      : numéro introuvable ou non autorisé pour ce jeton ;
 *  - `provider_unavailable`  : panne, limite ou délai dépassé (réessayer) ;
 *  - `provider_unreadable`   : réponse inexploitable.
 */
export const WHATSAPP_GRAPH_BASE = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const PHONE_NUMBER_ID = /^[0-9]{5,30}$/;
/** Codes d'erreur Graph de panne ou de limite de débit (1, 2, 4, 17, 32, 341, 368, 613, 80007, 130429, 131056). */
const THROTTLE_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 80007, 130429, 131056]);

export type WhatsAppValidation = { kind: "valid" } | { kind: "invalid"; code: "provider_auth" | "provider_account" | "provider_unavailable" | "provider_unreadable" };

export type WhatsAppCloudOptions = { fetch?: typeof fetch; timeoutMs?: number };

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

export function createWhatsAppCloudClient(options: WhatsAppCloudOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async validate(input: { phoneNumberId: string; accessToken: string }): Promise<WhatsAppValidation> {
      const { phoneNumberId, accessToken } = input;
      if (!PHONE_NUMBER_ID.test(phoneNumberId) || accessToken.length === 0 || accessToken.length > 4096 || /[^ -~]/.test(accessToken)) {
        return { kind: "invalid", code: "provider_account" };
      }
      let response: Response;
      try {
        response = await doFetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}?fields=id`, {
          method: "GET",
          redirect: "error",
          headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "invalid", code: "provider_unavailable" };
      }
      const body = (await readJson(response)) as { id?: unknown; error?: { code?: unknown } } | null;
      if (response.status === 200) {
        return body && body.id === phoneNumberId ? { kind: "valid" } : { kind: "invalid", code: "provider_unreadable" };
      }
      const code = body && typeof body.error?.code === "number" ? body.error.code : 0;
      // limites et pannes passagères de l'API Graph (souvent un HTTP 400 avec ces codes) : on ne dégrade jamais une intégration pour cela
      if (response.status >= 500 || response.status === 429 || THROTTLE_CODES.has(code)) return { kind: "invalid", code: "provider_unavailable" };
      if (response.status === 401 || response.status === 403 || code === 190) return { kind: "invalid", code: "provider_auth" };
      if (response.status === 404 || code === 100 || code === 33) return { kind: "invalid", code: "provider_account" };
      return { kind: "invalid", code: "provider_unreadable" };
    },
  };
}
export type WhatsAppCloudClient = ReturnType<typeof createWhatsAppCloudClient>;
