"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { signOutAction } from "../../lib/auth/actions";
import type { AuthActionState } from "../../lib/auth/types";

const initialState: AuthActionState = { status: "idle" };

export function SignOutForm() {
  const t = useTranslations("Dashboard");
  const locale = useLocale();
  const [, formAction, pending] = useActionState(signOutAction, initialState);

  return (
    <form action={formAction}>
      <input type="hidden" name="locale" value={locale} />
      <button className="btn btn-secondary" type="submit" disabled={pending}>
        {t("signOut")}
      </button>
    </form>
  );
}
