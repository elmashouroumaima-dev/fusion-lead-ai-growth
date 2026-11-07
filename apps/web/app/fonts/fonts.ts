import localFont from "next/font/local";

/**
 * Polices locales (aucun réseau au build), WOFF2 sous-ensemblées. Licence OFL : voir OFL-*.txt dans ce dossier.
 * Poppins : latin + latin-1 + ponctuation typographique + €. Cairo (arabe) vit dans `cairo.ts` : il n'est chargé,
 * ni préchargé, que par la locale arabe.
 */
export const poppins = localFont({
  src: [
    { path: "./Poppins-Regular.woff2", weight: "400", style: "normal" },
    { path: "./Poppins-Medium.woff2", weight: "500", style: "normal" },
    { path: "./Poppins-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "./Poppins-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-poppins",
  display: "swap",
});
