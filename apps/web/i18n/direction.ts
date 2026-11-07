export type TextDirection = "rtl" | "ltr";

/** ar -> rtl ; fr et en -> ltr (ADR 011 amendé). */
export function getDirection(locale: string): TextDirection {
  return locale === "ar" ? "rtl" : "ltr";
}
