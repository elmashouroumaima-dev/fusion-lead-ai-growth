import type { ReactNode } from "react";
import { BrandPanel } from "@/components/public/brand-panel";
import { PublicFrame } from "@/components/public/public-frame";

/** Pages publiques (connexion, inscription, mot de passe) : cadre en dégradé, marque du côté début (droite en arabe). */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicFrame brand={<BrandPanel />}>{children}</PublicFrame>;
}
