/**
 * Envoi d'e-mail par un fournisseur transactionnel (ADR 008, spec §6 et §9.2). Le domaine ne connaît que cette interface : changer de
 * fournisseur ne touche ni la chaîne de contrôles ni le worker. Le jeton du fournisseur est passé à chaque appel (lu par le worker via
 * `secret_ref`) ; il n'apparaît jamais dans une erreur, un code ou un journal.
 *
 * Résultat d'un envoi, à lire avec soin (c'est ce qui évite les doublons chez le destinataire) :
 *  - `accepted`  : le fournisseur a accepté le message (≠ livré : `delivered` ne vient que d'un événement du fournisseur, J32) ;
 *  - `rejected`  : refus DÉFINITIF (adresse invalide, jeton refusé…) : inutile de réessayer ;
 *  - `retryable` : le fournisseur a répondu qu'il n'a PAS accepté (limite, panne) : un nouvel essai est sûr ;
 *  - `unknown`   : aucune réponse exploitable (délai dépassé, coupure) : le message a PEUT-ÊTRE été envoyé, il ne faut JAMAIS le renvoyer.
 */
export type EmailSendInput = {
  /** Identité d'expéditeur du canal (adresse e-mail). */
  from: string;
  /** Adresse du destinataire (contact du fil). */
  to: string;
  subject: string;
  textBody: string;
  /** Métadonnées renvoyées telles quelles dans les événements du fournisseur (J32) : identifiant de NOTRE message, pour retrouver un envoi dont la réponse s'est perdue. */
  metadata?: Record<string, string>;
  /** En-têtes ajoutés par NOTRE code (désabonnement, J33) : jamais une valeur saisie par un utilisateur. */
  headers?: { name: string; value: string }[];
};

export type EmailSendOutcome =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "rejected"; code: string }
  | { kind: "retryable"; code: string }
  | { kind: "unknown"; code: string };

export interface EmailProvider {
  readonly name: string;
  send(input: EmailSendInput, secret: string): Promise<EmailSendOutcome>;
}
