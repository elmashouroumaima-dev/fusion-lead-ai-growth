import type { EmailProvider } from "./provider";

/**
 * Aiguillage du fournisseur e-mail par intégration (ADR 008) : `input.gateway` vient de la colonne `integrations.gateway` relue par le worker
 * (jamais d'une valeur du client). Absent ou `postmark` = Postmark (comportement existant) ; `resend` = Resend.
 */
export function createEmailGatewayProvider(providers: { postmark: EmailProvider; resend: EmailProvider }): EmailProvider {
  return {
    name: "gateway",
    send: (input, secret) => (input.gateway === "resend" ? providers.resend : providers.postmark).send(input, secret),
  };
}
