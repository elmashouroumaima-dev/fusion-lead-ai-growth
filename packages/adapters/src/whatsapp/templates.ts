import { WHATSAPP_GRAPH_BASE } from "./cloud";

/**
 * Liste des modèles de message d'un compte WhatsApp Business (J36, spec §9.3) : `GET {graph}/{waba_id}/message_templates`. Même cadre que les autres appels
 * Graph (adresse fixe, jeton en en-tête, délai, 64 Ko, codes courts). `parseMessageTemplates` réduit la réponse de Meta aux champs utiles et ignore ce qu'il
 * ne sait pas lire (un modèle mal formé n'empêche pas les autres). Les statuts de Meta sont ramenés à 4 valeurs : approuvé (`approved`), en attente
 * (`pending`, `in_appeal`), refusé (`rejected`), suspendu (`paused`, `disabled`, `flagged`...).
 */
const WABA_ID = /^[0-9]{5,30}$/;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TEMPLATES = 200;

export type TemplateItem = { name: string; language: string; category: "marketing" | "utility" | "authentication"; status: "pending" | "approved" | "rejected" | "paused"; components: unknown[] };
export type TemplateList = { kind: "ok"; items: TemplateItem[]; skipped: number } | { kind: "error"; code: "provider_auth" | "provider_account" | "provider_unavailable" | "provider_unreadable" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function mapStatus(value: unknown): TemplateItem["status"] {
  const s = typeof value === "string" ? value.toUpperCase() : "";
  if (s === "APPROVED") return "approved";
  if (s === "REJECTED") return "rejected";
  if (s === "PENDING" || s === "IN_APPEAL") return "pending";
  return "paused";
}
function mapCategory(value: unknown): TemplateItem["category"] | null {
  const c = typeof value === "string" ? value.toUpperCase() : "";
  return c === "MARKETING" ? "marketing" : c === "UTILITY" ? "utility" : c === "AUTHENTICATION" ? "authentication" : null;
}

export function parseMessageTemplates(body: unknown): { items: TemplateItem[]; skipped: number } | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const items: TemplateItem[] = [];
  let skipped = 0;
  for (const raw of body.data.slice(0, MAX_TEMPLATES)) {
    const category = isRecord(raw) ? mapCategory(raw.category) : null;
    if (!isRecord(raw) || typeof raw.name !== "string" || !/^[a-z0-9_]{1,200}$/.test(raw.name) || typeof raw.language !== "string" || !/^[a-z]{2}(_[A-Z]{2})?$/.test(raw.language) || category === null) {
      skipped += 1;
      continue;
    }
    // seuls type, format et texte sont conservés, bornés ; la taille est mesurée comme en base (le texte jsonb ajoute des espaces : marge de 25 %)
    const components = Array.isArray(raw.components)
      ? raw.components.filter(isRecord).map((c) => ({ type: typeof c.type === "string" ? c.type.slice(0, 40) : "UNKNOWN", ...(typeof c.text === "string" ? { text: c.text.slice(0, 1024) } : {}), ...(typeof c.format === "string" ? { format: c.format.slice(0, 40) } : {}) }))
      : [];
    if (JSON.stringify(components).length > 12000) {
      skipped += 1;
      continue;
    }
    items.push({ name: raw.name, language: raw.language, category, status: mapStatus(raw.status), components });
  }
  skipped += Math.max(0, body.data.length - MAX_TEMPLATES);
  return { items, skipped };
}

export function createWhatsAppTemplateClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async list(input: { wabaId: string; accessToken: string }): Promise<TemplateList> {
      const { wabaId, accessToken } = input;
      if (!WABA_ID.test(wabaId) || accessToken.length === 0 || accessToken.length > 4096 || /[^ -~]/.test(accessToken)) return { kind: "error", code: "provider_account" };
      let response: Response;
      try {
        response = await doFetch(`${WHATSAPP_GRAPH_BASE}/${wabaId}/message_templates?fields=name,language,category,status,components&limit=${MAX_TEMPLATES}`, {
          method: "GET", redirect: "error",
          headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "error", code: "provider_unavailable" };
      }
      let json: unknown = null;
      try {
        const text = await response.text();
        json = text.length <= MAX_RESPONSE_BYTES ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
      if (response.status === 200) {
        const parsed = parseMessageTemplates(json);
        return parsed ? { kind: "ok", ...parsed } : { kind: "error", code: "provider_unreadable" };
      }
      const code = isRecord(json) && isRecord(json.error) && typeof json.error.code === "number" ? json.error.code : 0;
      if (response.status >= 500 || response.status === 429 || [1, 2, 4, 17, 32, 341, 368, 613, 80007].includes(code)) return { kind: "error", code: "provider_unavailable" };
      if (response.status === 401 || response.status === 403 || code === 190) return { kind: "error", code: "provider_auth" };
      if (response.status === 404 || code === 100 || code === 33) return { kind: "error", code: "provider_account" };
      return { kind: "error", code: "provider_unreadable" };
    },
  };
}
