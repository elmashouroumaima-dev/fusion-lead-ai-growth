/**
 * Webhooks entrants (J29, spec §8 et §11, menaces C1 à C5). Un adaptateur par fournisseur dit COMMENT lire et authentifier ses
 * requêtes ; le pipeline commun (`ingestWebhook`) fait le reste dans un ordre fixe. Aucun adaptateur ne reçoit la session d'un
 * utilisateur : une requête de webhook est authentifiée par sa signature et rattachée à une entreprise par l'identité du COMPTE
 * fournisseur, jamais par un champ libre du payload.
 */
export type WebhookProvider = "email" | "whatsapp" | "kapso" | "resend";
/** Fournisseur sous lequel les événements sont CONSERVÉS (`webhook_events.provider`) : `kapso` est une passerelle de `whatsapp`, pas un fournisseur à part. */
export type WebhookStoreProvider = "email" | "whatsapp";

/** En-têtes en minuscules ; une valeur absente est `undefined`. */
export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface WebhookAdapter {
  readonly provider: WebhookProvider;
  /** Fournisseur de stockage et de résolution (défaut : `provider`). */
  readonly storeProvider?: WebhookStoreProvider;
  /** Passerelle exigée de l'intégration retrouvée (`integrations.gateway`) : un webhook Kapso ne retrouve pas une intégration Meta, et inversement. */
  readonly gateway?: "meta" | "kapso" | "resend";
  /** Taille maximale du corps brut, en octets (WhatsApp : 3 Mo). */
  readonly maxBytes: number;
  /** Corps brut -> valeur JSON, ou `null` si illisible (jamais d'exception). */
  parse(rawBody: Uint8Array): unknown;
  /**
   * Identifiant du compte fournisseur visé (par exemple l'identifiant du numéro WhatsApp). Lu dans le payload NON authentifié : il ne sert
   * QU'À retrouver l'intégration et son secret ; un faux compte échoue à la vérification de signature.
   */
  extractAccount(payload: unknown, headers: WebhookHeaders): string | null;
  /**
   * Corps lisible (JSON valide, déjà passé par `parse`) mais SANS rien d'exploitable pour nous : événement d'un autre type, notification sans compte (état du compte
   * WhatsApp, événement de domaine Resend...). Le pipeline l'ACQUITTE (200 « ignored ») sans rien écrire ni authentifier : un refus (400) ferait réessayer puis désactiver le
   * webhook chez le fournisseur (S-06). Ne jamais renvoyer vrai pour un corps qui porte des données de client non traitées (lot de plusieurs numéros : refus 400).
   */
  isIrrelevant?(payload: unknown, headers: WebhookHeaders): boolean;
  /**
   * Identifiant d'événement stable du fournisseur (déduplication) ; `null` si absent ou invalide. CONTRAT : il doit être tiré de contenu
   * COUVERT par la signature (le corps signé), jamais d'un en-tête non signé : sinon changer l'en-tête d'une capture valide contournerait
   * la déduplication (revue J29). Un adaptateur dont le fournisseur ne signe pas l'identifiant doit le dériver du corps.
   */
  extractEventId(payload: unknown, headers: WebhookHeaders): string | null;
  /** Horodatage de l'événement en secondes Unix, quand le fournisseur en signe un. */
  extractTimestamp?(payload: unknown, headers: WebhookHeaders): number | null;
  /** Signature sur le corps BRUT, comparaison à temps constant. `secret` est le secret de l'intégration (ou `null` s'il n'en a pas). */
  verify(input: { rawBody: Uint8Array; headers: WebhookHeaders; secret: string | null }): boolean;
}

/** Accès à la base, réservé au serveur (fonctions service_role). */
export interface WebhookStore {
  /** Intégrations candidates du compte (5 au plus, actives d'abord) : plusieurs entreprises peuvent déclarer le même compte (S-02), la SIGNATURE désigne la bonne. Liste vide = compte inconnu. */
  resolve(provider: WebhookStoreProvider, account: string, gateway?: "meta" | "kapso" | "resend"): Promise<Array<{ organizationId: string; integrationId: string }>>;
  record(input: { organizationId: string; integrationId: string; provider: WebhookStoreProvider; externalEventId: string; payload: unknown }): Promise<{ eventId: string; duplicate: boolean }>;
  recordRejection(input: { organizationId: string; integrationId: string; provider: WebhookStoreProvider }): Promise<void>;
}

/** Secret de vérification d'une intégration (celui du J28) ; `null` si l'intégration n'en a pas. */
export type WebhookSecretReader = (organizationId: string, integrationId: string) => Promise<string | null>;
