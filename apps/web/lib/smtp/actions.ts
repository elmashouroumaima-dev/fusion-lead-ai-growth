"use server";

import { decryptSecret, encryptSecret, platformSecretAad } from "@fusion-leap/adapters";
import { emptyActionSchema, isInternalSmtpHost, smtpSettingsSchema } from "@fusion-leap/domain";
import { revalidatePath } from "next/cache";
import { getServerEnv } from "../env/server";
import { serviceCodeToFormCode, uiLocaleOf } from "../service/form";
import { logger } from "../service/logger";
import { getSmtpDelivery } from "../service/smtp-delivery";
import { withAction, type ActionFailure } from "../service/with-service";
import { sendSmtpTest } from "./send-test";
import { SMTP_SECRET_PURPOSE, getKeyRing } from "./secrets";
import type { SmtpActionState } from "./types";

/*
 * Server Actions des paramètres SMTP (Paramétrage), réservées aux ADMINISTRATEURS DE LA PLATEFORME : la décision est
 * prise par la base (set_smtp_settings / reset_smtp_settings lisent auth.uid() dans private.platform_admins) ; ici,
 * pipeline commun (zod, session, limitation de débit « sensible »). Le mot de passe est chiffré (AES-256-GCM, ADR 004)
 * DANS CETTE ACTION, avec la clé maître de l'environnement serveur : le navigateur et la base ne voient jamais le clair,
 * et aucune réponse ne le contient. Les journaux ne portent que des codes.
 */

const failure = ({ code, fieldErrors }: ActionFailure): SmtpActionState =>
  fieldErrors ? { status: "error", code: serviceCodeToFormCode(code), fieldErrors } : { status: "error", code: serviceCodeToFormCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

/** Hôtes locaux ou internes autorisés seulement en développement et en test. */
const allowInternalHosts = (): boolean => {
  const appEnv = getServerEnv().APP_ENV;
  return appEnv === "development" || appEnv === "test";
};

const dbError = (error: { code?: string | null; message?: string | null }): SmtpActionState => {
  if (error.code === "42501" || error.code === "28000") return { status: "error", code: "forbidden" };
  if (error.code === "22023" && error.message?.includes("password_required")) return { status: "error", code: "password_required" };
  if (error.code === "22023" || error.code === "23514") return { status: "error", code: "invalid_input" };
  return { status: "error", code: "generic" };
};

const saveSmtp = withAction(
  {
    name: "settings.save_smtp",
    auth: "user",
    schema: smtpSettingsSchema,
    fields: ["host", "port", "security", "username", "password", "from_email", "from_name"],
    forbidOrganizationId: true,
    rateLimit: "sensitive",
    idempotency: "none",
    secretFields: [],
    failure,
    loginPath,
  },
  async (ctx, input): Promise<SmtpActionState> => {
    if (!allowInternalHosts() && isInternalSmtpHost(input.host)) return { status: "error", code: "blocked_host" };

    let secretId: string | null = null;
    let encrypted: { ciphertext: string; nonce: string; keyVersion: number } | null = null;
    if (input.password !== undefined) {
      const keyRing = getKeyRing();
      if (!keyRing) return { status: "error", code: "secrets_unavailable" };
      secretId = crypto.randomUUID();
      encrypted = encryptSecret({ plaintext: input.password, keyRing, aad: platformSecretAad(SMTP_SECRET_PURPOSE, secretId) });
    }

    const settings = {
      host: input.host,
      port: input.port,
      security: input.security,
      from_email: input.from_email,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.from_name !== undefined ? { from_name: input.from_name } : {}),
    };
    const { error } = await ctx.supabase.rpc("set_smtp_settings", {
      p_settings: settings,
      p_secret_id: secretId,
      p_ciphertext: encrypted?.ciphertext ?? null,
      p_nonce: encrypted?.nonce ?? null,
      p_key_version: encrypted?.keyVersion ?? null,
    });
    if (error) return dbError(error);
    logger.info("smtp_settings_saved", { password_changed: input.password !== undefined });
    revalidatePath(`/${uiLocaleOf(ctx.formData)}/settings/appearance`);
    return { status: "success" };
  },
);

export async function saveSmtpAction(prev: SmtpActionState, formData: FormData): Promise<SmtpActionState> {
  return saveSmtp(prev, formData);
}

const resetSmtp = withAction(
  {
    name: "settings.reset_smtp",
    auth: "user",
    schema: emptyActionSchema,
    fields: [],
    forbidOrganizationId: true,
    rateLimit: "sensitive",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx): Promise<SmtpActionState> => {
    const { error } = await ctx.supabase.rpc("reset_smtp_settings");
    if (error) return dbError(error);
    logger.info("smtp_settings_reset");
    revalidatePath(`/${uiLocaleOf(ctx.formData)}/settings/appearance`);
    return { status: "success" };
  },
);

export async function resetSmtpAction(prev: SmtpActionState, formData: FormData): Promise<SmtpActionState> {
  return resetSmtp(prev, formData);
}

const testSmtp = withAction(
  {
    name: "settings.test_smtp",
    auth: "user",
    schema: emptyActionSchema,
    fields: [],
    forbidOrganizationId: true,
    rateLimit: "sensitive",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx): Promise<SmtpActionState> => {
    // Le droit est vérifié par la base AVANT toute lecture du secret chiffré (lecture serveur avec service_role).
    const { data: isAdmin, error: adminError } = await ctx.supabase.rpc("is_platform_admin");
    if (adminError || isAdmin !== true) return { status: "error", code: "forbidden" };

    const delivery = await getSmtpDelivery();
    if (!delivery) return { status: "error", code: "not_configured" };

    let password: string | undefined;
    if (delivery.secret) {
      const keyRing = getKeyRing();
      if (!keyRing) return { status: "error", code: "secrets_unavailable" };
      try {
        password = decryptSecret({
          secret: { ciphertext: delivery.secret.ciphertext, nonce: delivery.secret.nonce, keyVersion: delivery.secret.key_version },
          keyRing,
          aad: platformSecretAad(SMTP_SECRET_PURPOSE, delivery.secret.id),
        });
      } catch {
        return { status: "error", code: "secrets_unavailable" };
      }
    }

    // Destinataire : l'adresse de l'administrateur connecté (jamais une saisie libre : pas de relais de courrier).
    const { data: userData, error: userError } = await ctx.supabase.auth.getUser();
    const to = userData.user?.email;
    if (userError || !to) return { status: "error", code: "forbidden" };

    const result = await sendSmtpTest({ delivery, password, to, allowInternalHosts: allowInternalHosts() });
    logger.info("smtp_test", { ok: result.ok, ...(result.ok ? {} : { code: result.code }) });
    return result.ok ? { status: "success" } : { status: "error", code: result.code };
  },
);

export async function testSmtpAction(prev: SmtpActionState, formData: FormData): Promise<SmtpActionState> {
  return testSmtp(prev, formData);
}
