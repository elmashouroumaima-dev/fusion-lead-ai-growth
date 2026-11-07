export type TextDirection = "rtl" | "ltr";

/** ar -> rtl ; toute autre locale -> ltr (ADR 011). */
export function getDirection(locale: string): TextDirection {
  return locale === "ar" ? "rtl" : "ltr";
}
