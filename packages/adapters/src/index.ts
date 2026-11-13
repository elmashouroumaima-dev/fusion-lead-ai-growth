/** Nom du package : sert de point d'ancrage au smoke test de J4 (aucune règle métier avant J5+). */
export const PACKAGE_NAME = "@fusion-leap/adapters" as const;

export * from "./secrets";
export * from "./email";

export * from "./crm";
export * from "./webhooks";
export * from "./whatsapp";
