/**
 * Exécuté une fois au démarrage du serveur Next.js : l'application refuse de démarrer si une
 * variable d'environnement serveur ou publique manque ou est invalide (J5).
 * Le contrôle vit dans un module Node.js importé uniquement quand le runtime est `nodejs`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnvOrExit } = await import("./lib/env/startup-check");
    assertEnvOrExit();
  }
}
