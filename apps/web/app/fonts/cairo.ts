import localFont from "next/font/local";

/**
 * Cairo (arabe), WOFF2 sous-ensemblée : arabe + formes de présentation + latin de base + chiffres arabo-indiens.
 * Importé dynamiquement par le layout, uniquement pour la locale `ar`. `preload: false` : Next ajouterait sinon un
 * <link rel="preload"> de Cairo (97 Ko) à TOUTES les pages dès que le module est dans le graphe du layout, y compris
 * fr / en (vérifié sur le build de production). La classe de variable n'étant posée que sur <html lang="ar">, le
 * fichier n'est téléchargé que par l'arabe, à la demande (display: swap).
 */
export const cairo = localFont({
  src: [{ path: "./Cairo-Variable.woff2", weight: "200 1000", style: "normal" }],
  variable: "--font-cairo",
  display: "swap",
  preload: false,
});
