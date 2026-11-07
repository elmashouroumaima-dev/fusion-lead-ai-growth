"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/** Clair / sombre / système (classe `dark` sur <html>), mémorisé sous la clé « fl-theme ». */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem storageKey="fl-theme" disableTransitionOnChange {...props}>
      {children}
    </NextThemesProvider>
  );
}
