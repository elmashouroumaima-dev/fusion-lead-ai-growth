import type { ReactNode } from "react";
import { requireLocale } from "../../../i18n/require-locale";
import { requireClaims } from "../../../lib/auth/require-claims";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

/** Défense en profondeur : vérifie la session même si le proxy est contourné. */
export default async function AppLayout({ children, params }: Props) {
  const locale = await requireLocale(params);
  await requireClaims(locale);
  return children;
}
