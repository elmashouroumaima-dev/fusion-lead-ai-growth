import type { ReactNode } from "react";

// Squelette J4 : l'i18n arabe (RTL) / anglais arrive au J8 (ADR 011).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
