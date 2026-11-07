import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

/** Chargeurs à littéraux (aucun chemin de module calculé : confinement ESLint de apps/web). */
const MESSAGE_LOADERS: Record<(typeof routing.locales)[number], () => Promise<{ default: Record<string, unknown> }>> = {
  fr: () => import("../messages/fr.json"),
  en: () => import("../messages/en.json"),
  ar: () => import("../messages/ar.json"),
};

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    messages: (await MESSAGE_LOADERS[locale]()).default,
  };
});
