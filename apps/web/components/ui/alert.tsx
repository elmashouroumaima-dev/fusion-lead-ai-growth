import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "border-destructive/40 text-destructive-text bg-card [&>svg]:text-current *:data-[slot=alert-description]:text-destructive-text",
        success:
          "border-emerald-600/40 bg-card text-emerald-800 dark:text-emerald-300 [&>svg]:text-current *:data-[slot=alert-description]:text-emerald-800/90 dark:*:data-[slot=alert-description]:text-emerald-300/90",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type AlertProps = ComponentProps<"div"> & VariantProps<typeof alertVariants>;

/** role="alert" par défaut ; passer role="status" pour un message non urgent. */
function Alert({ className, variant, role = "alert", ...props }: AlertProps) {
  return <div data-slot="alert" role={role} className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 min-h-4 font-medium tracking-tight", className)} {...props} />;
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
