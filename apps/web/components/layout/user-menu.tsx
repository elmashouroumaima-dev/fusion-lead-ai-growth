"use client";

import { LogOutIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "../../lib/auth/actions";
import type { AuthActionState } from "../../lib/auth/types";

const initialState: AuthActionState = { status: "idle" };

const initialsOf = (email: string | null): string => (email ? (email.trim().charAt(0) || "?").toUpperCase() : "?");

/** Menu du compte : e-mail de l'utilisateur et déconnexion (même action serveur qu'auparavant). */
export function UserMenu({ email }: { email: string | null }) {
  const t = useTranslations("Shell.profile");
  const locale = useLocale();
  const formRef = useRef<HTMLFormElement>(null);
  const [, formAction, pending] = useActionState(signOutAction, initialState);

  return (
    <>
      {/* Formulaire hors du menu (le contenu Radix est démonté à la fermeture) ; l'élément de menu le soumet. */}
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="locale" value={locale} />
      </form>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={t("menu")}>
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">{initialsOf(email)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <span className="text-muted-foreground block text-xs">{t("signedInAs")}</span>
            <bdi dir="ltr" className="block truncate text-sm font-medium">
              {email ?? t("unknownUser")}
            </bdi>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => {
              formRef.current?.requestSubmit();
            }}
          >
            <LogOutIcon aria-hidden="true" className="rtl:-scale-x-100" />
            {t("signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
