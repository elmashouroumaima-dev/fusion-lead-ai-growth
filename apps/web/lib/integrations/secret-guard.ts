import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Le secret de webhook et le jeton d'envoi d'une intégration doivent être DIFFÉRENTS (J32) : sinon un secret de webhook divulgué (il circule à chaque
 * requête du fournisseur) permettrait d'envoyer. La base ne peut pas le vérifier (chiffrés avec un nonce aléatoire) : la comparaison se fait ici, sur les
 * clairs, à temps constant, avec la lecture serveur du secret existant. Renvoie `true` si le candidat est IDENTIQUE à l'autre secret (à refuser).
 * Une lecture qui échoue (chiffrement non configuré, secret illisible) est une panne : l'appelant répond 503.
 */
export async function equalsOtherSecret(
  readOther: (organizationId: string, integrationId: string) => Promise<string | null>,
  organizationId: string,
  integrationId: string,
  candidate: string,
): Promise<boolean> {
  const other = await readOther(organizationId, integrationId);
  if (other === null) return false;
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(other), digest(candidate));
}
