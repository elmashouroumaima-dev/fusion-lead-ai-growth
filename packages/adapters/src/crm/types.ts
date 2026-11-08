import type { CrmProvider } from "@fusion-leap/domain";

/**
 * Interface commune des adaptateurs CRM (spec §6 : `connect`, `validate`, `send`, `receive`, `refresh`, `disconnect`). Les différences
 * de transport (fichier, API REST, webhook) restent DANS l'adaptateur ; le reste de l'application ne manipule que ces types.
 * Aucun secret ni jeton n'apparaît ici : les identifiants d'un fournisseur vivront dans le coffre (J28), jamais dans un enregistrement.
 */
export type CrmRecord = {
  entity: "contact";
  /** Identifiant STABLE chez le fournisseur : clé d'idempotence de la synchro. */
  externalId: string;
  /** Valeurs par NOM DE CHAMP INTERNE (`name`, `email`, `phone`, `language`, `country`), texte brut ou `null`. */
  fields: Record<string, string | null>;
  /** Dernière modification chez le fournisseur, `null` si inconnue. */
  updatedAt: Date | null;
};

export type CrmRejection = { rowNo: number; reason: "no_external_id" | "invalid_date" | "row_too_short" };
export type CrmReceiveResult = {
  records: CrmRecord[];
  rejected: CrmRejection[];
  /** Colonnes du mapping (`external_field`) ABSENTES de l'en-tête du fichier : un fichier sans colonne d'identifiant n'est pas une synchro. */
  missingColumns: string[];
};
export type CrmSendResult = { accepted: number; skipped: number; payload?: string };
export type CrmAdapterResult = { ok: true } | { ok: false; code: "not_configured" | "invalid_mapping" | "unsupported" };

export interface CrmAdapter {
  readonly provider: CrmProvider;
  /** Établit la connexion (sans objet pour un fichier ou le CRM interne). */
  connect(): Promise<CrmAdapterResult>;
  /** Vérifie que la configuration (mapping) est utilisable par ce fournisseur. */
  validate(): Promise<CrmAdapterResult>;
  /** Pousse des enregistrements vers le fournisseur (sens `push` ou `both`). */
  send(records: readonly CrmRecord[]): Promise<CrmSendResult>;
  /** Lit les enregistrements du fournisseur (sens `pull` ou `both`) depuis `input`, propre au transport (texte CSV, curseur d'API). */
  receive(input: { text: string }): Promise<CrmReceiveResult>;
  /** Renouvelle l'autorisation (jeton) ; sans objet pour les adaptateurs sans jeton. */
  refresh(): Promise<CrmAdapterResult>;
  disconnect(): Promise<void>;
}
