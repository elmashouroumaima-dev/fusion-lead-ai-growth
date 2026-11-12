import { postmarkWebhookAdapter, type WebhookAdapter, type WebhookProvider } from "@fusion-leap/adapters";

/**
 * Adaptateurs de webhooks enregistrés (J29). E-mail (Postmark, ADR 008) depuis le J32 ; l'adaptateur WhatsApp arrive au J34 / J35. Un fournisseur
 * sans adaptateur répond 404 sur `/api/webhooks/[provider]`.
 */
const ADAPTERS: Partial<Record<WebhookProvider, WebhookAdapter>> = { email: postmarkWebhookAdapter };

export function getWebhookAdapter(provider: string): WebhookAdapter | null {
  return Object.hasOwn(ADAPTERS, provider) ? (ADAPTERS[provider as WebhookProvider] ?? null) : null;
}
