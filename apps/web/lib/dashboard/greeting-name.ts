/**
 * Prénom d'accueil du tableau de bord (affichage seulement) : l'application ne stocke pas encore de nom de personne (ni table de profil, ni champ à l'inscription).
 * On affiche donc le début de l'adresse de connexion vérifiée (claims du serveur) : la partie avant « @ », sans « +étiquette », limitée à 40 caractères.
 * `null` si l'adresse est absente ou inexploitable : la page affiche alors la salutation seule. Jamais utilisé pour une décision d'autorisation.
 */
export function greetingName(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const local = email.split("@")[0] ?? "";
  const name = (local.split("+")[0] ?? "").trim().slice(0, 40);
  return name.length > 0 ? name : null;
}
