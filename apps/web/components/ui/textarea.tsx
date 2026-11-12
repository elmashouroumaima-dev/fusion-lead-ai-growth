import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type TextareaProps = ComponentProps<"textarea"> & {
  /** Marque le champ invalide (aria-invalid) ; relier le message avec aria-describedby. */
  error?: boolean;
};

function Textarea({ className, error, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      {...(error ? { "aria-invalid": true } : {})}
      className={cn(
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex min-h-20 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
export type { TextareaProps };
