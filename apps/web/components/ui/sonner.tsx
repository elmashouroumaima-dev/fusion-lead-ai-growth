"use client";

import { useTheme } from "next-themes";
import type { ComponentProps, CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

/**
 * Notifications (sonner) : en haut, au centre ; succès en vert et erreur en rouge (jetons `--success` et
 * `--destructive`, contraste AA du texte blanc en clair et en sombre) ; les autres restent neutres.
 * Le thème suit next-themes ; la direction est donnée par le parent. Les erreurs restent un peu plus
 * longtemps à l'écran (6 s) pour être lues ; le bouton de fermeture est toujours disponible.
 */
function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  const sonnerTheme: NonNullable<ToasterProps["theme"]> = theme === "light" || theme === "dark" ? theme : "system";
  return (
    <Sonner
      theme={sonnerTheme}
      position="top-center"
      richColors
      closeButton
      duration={6000}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border !px-4 !py-3 !shadow-lg !text-sm !font-medium",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--success)",
          "--success-text": "var(--success-foreground)",
          "--success-border": "var(--success)",
          "--error-bg": "var(--destructive)",
          "--error-text": "var(--destructive-foreground)",
          "--error-border": "var(--destructive)",
          "--border-radius": "0.75rem",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
