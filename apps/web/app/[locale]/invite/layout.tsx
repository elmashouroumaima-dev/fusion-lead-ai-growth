import type { ReactNode } from "react";
import { BrandPanel } from "@/components/public/brand-panel";
import { PublicFrame } from "@/components/public/public-frame";

/** Page d'invitation (hors du groupe (app)) : même cadre que les pages publiques. */
export default function InviteLayout({ children }: { children: ReactNode }) {
  return <PublicFrame brand={<BrandPanel />}>{children}</PublicFrame>;
}
