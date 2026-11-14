import { ArrowUpRightIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Link } from "../../i18n/navigation";

type Props = {
  label: string;
  value: number | null;
  hint: string;
  href: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  locale: string;
};

/**
 * Carte d'indicateur : grand chiffre (formaté selon la locale), libellé, lien vers l'écran concerné. `value = null` (rôle sans accès
 * ou lecture en échec) : la carte n'est pas rendue, jamais de faux zéro.
 */
export function StatCard({ label, value, hint, href, icon: Icon, locale }: Props) {
  if (value === null) return null;
  return (
    <Link
      href={href}
      className="bg-card text-card-foreground group focus-visible:ring-ring relative grid gap-3 overflow-hidden rounded-xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <span
        aria-hidden="true"
        className="bg-brand/15 pointer-events-none absolute -end-6 -top-6 size-24 rounded-full transition group-hover:scale-125 motion-reduce:transition-none"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="bg-brand/15 text-primary-text grid size-9 place-items-center rounded-lg">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <ArrowUpRightIcon
          className="text-muted-foreground size-4 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 rtl:-scale-x-100"
          aria-hidden="true"
        />
      </div>
      <div className="grid gap-0.5">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">{new Intl.NumberFormat(locale).format(value)}</span>
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </div>
    </Link>
  );
}
