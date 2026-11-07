"use client";

import { useTheme } from "next-themes";
import type { ComponentProps, CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

/** Notifications (sonner). Le thème suit next-themes ; la direction est donnée par le parent. */
function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  const sonnerTheme: NonNullable<ToasterProps["theme"]> = theme === "light" || theme === "dark" ? theme : "system";
  return (
    <Sonner
      theme={sonnerTheme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
