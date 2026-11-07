import type { MembersActionState } from "./types";

/**
 * Faut-il générer une NOUVELLE clé d'idempotence pour le prochain envoi du formulaire d'invitation ?
 *  - succès : l'invitation suivante est une nouvelle intention ;
 *  - `idempotency_conflict` : la clé a servi avec d'autres valeurs, elle est inutilisable ;
 *  - JAMAIS pour `idempotency_in_progress` : la première demande peut encore aboutir, un renvoi doit
 *    porter la même clé pour ne pas créer de doublon ;
 *  - ni pour les autres erreurs (le serveur abandonne la ligne : réessayer avec la même clé est sûr).
 */
export function shouldRenewIdempotencyKey(result: Pick<MembersActionState, "status" | "code">): boolean {
  return result.status === "success" || result.code === "idempotency_conflict";
}
