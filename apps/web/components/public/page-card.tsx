import type { ComponentProps } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Carte de page (connexion, inscription, invitation, onboarding…) : bande de dégradé en tête puis
 * en-tête / contenu / pied. Composée par les pages avec de simples enfants (titre = <h1>).
 */
export function PageCard({ className, children, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card className={cn("w-full max-w-md gap-0 overflow-hidden pt-0 shadow-xl", className)} {...props}>
      <div aria-hidden="true" className="h-1.5 w-full bg-linear-to-r from-primary to-secondary rtl:bg-linear-to-l" />
      {children}
    </Card>
  );
}

export function PageCardHeader({ className, ...props }: ComponentProps<typeof CardHeader>) {
  return <CardHeader className={cn("pt-6 pb-4", className)} {...props} />;
}

/** Titre unique de la page (h1). */
export function PageCardTitle({ className, ...props }: ComponentProps<"h1">) {
  return <h1 data-slot="card-title" className={cn("text-2xl leading-tight font-semibold tracking-tight", className)} {...props} />;
}

export function PageCardDescription(props: ComponentProps<typeof CardDescription>) {
  return <CardDescription {...props} />;
}

export function PageCardContent({ className, ...props }: ComponentProps<typeof CardContent>) {
  return <CardContent className={cn("grid gap-4", className)} {...props} />;
}

export function PageCardFooter({ className, ...props }: ComponentProps<typeof CardFooter>) {
  return <CardFooter className={cn("flex-col items-start gap-2 pt-2 text-sm", className)} {...props} />;
}
