import { createHash, randomBytes } from "node:crypto";

/**
 * Jeton d'invitation : 32 octets aléatoires (CSPRNG) en base64url = 43 caractères. Seule l'empreinte
 * sha256 (hex minuscule, 64 caractères) est envoyée à la base ; le jeton n'est jamais stocké ni journalisé.
 */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}
