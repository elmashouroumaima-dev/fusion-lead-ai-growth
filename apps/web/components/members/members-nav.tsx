"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "../../i18n/navigation";
import styles from "./members.module.css";

/**
 * Lien « Membres » de la barre d'application. Affiché seulement quand le layout (serveur) a établi
 * que le rôle actif peut lister les membres ; la page et les actions revérifient de toute façon.
 */
export function MembersNav() {
  const t = useTranslations("Members");
  const pathname = usePathname();
  const current = pathname === "/members" || pathname.startsWith("/members/");
  return (
    <Link className={styles.navLink} href="/members" aria-current={current ? "page" : undefined}>
      {t("nav.link")}
    </Link>
  );
}
