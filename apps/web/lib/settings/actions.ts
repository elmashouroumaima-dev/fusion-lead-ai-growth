"use server";

import { resetLogoSchema, resetPaletteSchema, saveLogoSchema, savePaletteSchema } from "@fusion-leap/domain";
import { revalidatePath } from "next/cache";
import { LOGO_KEY, PALETTE_KEY } from "../service/platform-config";
import { serviceCodeToFormCode, uiLocaleOf } from "../service/form";
import { withAction, type ActionFailure } from "../service/with-service";
import type { SettingsActionState } from "./types";

/*
 * Server Actions du Paramétrage GLOBAL (palette de la plateforme, ADR 016). Réservées aux owner / admin
 * d'organisation : la vérification décisive est faite par la base (set_platform_config / reset_platform_config
 * lisent auth.uid() dans organization_members) ; ici, pipeline commun (zod, session, limitation de débit).
 * Aucune organisation n'est concernée : tout organization_id posté est refusé. L'écriture est un upsert
 * naturellement idempotent (clé d'idempotence sans objet : l'idempotence est rattachée à une organisation).
 */

const failure = ({ code, fieldErrors }: ActionFailure): SettingsActionState =>
  fieldErrors ? { status: "error", code: serviceCodeToFormCode(code), fieldErrors } : { status: "error", code: serviceCodeToFormCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

const savePalette = withAction(
  {
    name: "settings.save_palette",
    auth: "user",
    schema: savePaletteSchema,
    fields: ["palette"],
    forbidOrganizationId: true,
    rateLimit: "mutation",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx, input): Promise<SettingsActionState> => {
    const { error } = await ctx.supabase.rpc("set_platform_config", { p_key: PALETTE_KEY, p_value: input.palette });
    if (error) return { status: "error", code: error.code === "42501" ? "forbidden" : "generic" };
    revalidatePath(`/${uiLocaleOf(ctx.formData)}`, "layout");
    return { status: "success" };
  },
);

export async function savePaletteAction(prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  return savePalette(prev, formData);
}

const resetPalette = withAction(
  {
    name: "settings.reset_palette",
    auth: "user",
    schema: resetPaletteSchema,
    fields: [],
    forbidOrganizationId: true,
    rateLimit: "mutation",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx): Promise<SettingsActionState> => {
    const { error } = await ctx.supabase.rpc("reset_platform_config", { p_key: PALETTE_KEY });
    if (error) return { status: "error", code: error.code === "42501" ? "forbidden" : "generic" };
    revalidatePath(`/${uiLocaleOf(ctx.formData)}`, "layout");
    return { status: "success" };
  },
);

export async function resetPaletteAction(prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  return resetPalette(prev, formData);
}

const saveLogo = withAction(
  {
    name: "settings.save_logo",
    auth: "user",
    schema: saveLogoSchema,
    fields: ["logo"],
    forbidOrganizationId: true,
    rateLimit: "mutation",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx, input): Promise<SettingsActionState> => {
    // Le logo est re-validé (type, base64, taille, signature) par le schéma ET par la base.
    const { error } = await ctx.supabase.rpc("set_platform_config", { p_key: LOGO_KEY, p_value: input.logo });
    if (error) return { status: "error", code: error.code === "42501" ? "forbidden" : "generic" };
    revalidatePath(`/${uiLocaleOf(ctx.formData)}`, "layout");
    return { status: "success" };
  },
);

export async function saveLogoAction(prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  return saveLogo(prev, formData);
}

const resetLogo = withAction(
  {
    name: "settings.reset_logo",
    auth: "user",
    schema: resetLogoSchema,
    fields: [],
    forbidOrganizationId: true,
    rateLimit: "mutation",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx): Promise<SettingsActionState> => {
    const { error } = await ctx.supabase.rpc("reset_platform_config", { p_key: LOGO_KEY });
    if (error) return { status: "error", code: error.code === "42501" ? "forbidden" : "generic" };
    revalidatePath(`/${uiLocaleOf(ctx.formData)}`, "layout");
    return { status: "success" };
  },
);

export async function resetLogoAction(prev: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  return resetLogo(prev, formData);
}
