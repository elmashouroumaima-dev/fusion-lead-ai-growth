import { postmarkWebhookAdapter, whatsappWebhookAdapter, type WebhookAdapter, type WebhookProvider } from "@fusion-leap/adapters";

/**
 * Adaptateurs de webhooks enregistrés (J29). E-mail (Postmark, ADR 008) depuis le J32, WhatsApp (signature `X-Hub-Signature-256`, J34 ; le traitement des messages arrive au J35). Un fournisseur
 * sans adaptateur répond 404 sur `/api/webhooks/[provider]`.
 */
const ADAPTERS: Partial<Record<WebhookProvider, WebhookAdapter>> = { email: postmarkWebhookAdapter, whatsapp: whatsappWebhookAdapter };

export function getWebhookAdapter(provider: string): WebhookAdapter | null {
  return Object.hasOwn(ADAPTERS, provider) ? (ADAPTERS[provider as WebhookProvider] ?? null) : null;
}
