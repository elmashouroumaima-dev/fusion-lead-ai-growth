import type { WebhookAdapter, WebhookProvider } from "@fusion-leap/adapters";

/**
 * Adaptateurs de webhooks enregistrés (J29). VIDE pour l'instant : l'adaptateur e-mail arrive au J32 (après la décision sur le
 * fournisseur, ADR 008, Q2) et l'adaptateur WhatsApp au J34 / J35. Un fournisseur sans adaptateur répond 404 sur `/api/webhooks/[provider]`.
 */
const ADAPTERS: Partial<Record<WebhookProvider, WebhookAdapter>> = {};

export function getWebhookAdapter(provider: string): WebhookAdapter | null {
  return Object.hasOwn(ADAPTERS, provider) ? (ADAPTERS[provider as WebhookProvider] ?? null) : null;
}
