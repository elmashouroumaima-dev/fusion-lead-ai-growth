import localFont from "next/font/local";

/**
 * Polices locales (aucun réseau au build), WOFF2 sous-ensemblées. Licence OFL : voir OFL-*.txt dans ce dossier.
 * Inter : latin (fr / en), graisses 400 à 700, tirée de `@fontsource/inter` 5.2.8 (design Mintlify, ADR 015).
 * Cairo (arabe) vit dans `cairo.ts` : il n'est chargé, ni préchargé, que par la locale arabe.
 */
export const inter = localFont({
  src: [
    { path: "./Inter-Regular.woff2", weight: "400", style: "normal" },
    { path: "./Inter-Medium.woff2", weight: "500", style: "normal" },
    { path: "./Inter-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "./Inter-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});
