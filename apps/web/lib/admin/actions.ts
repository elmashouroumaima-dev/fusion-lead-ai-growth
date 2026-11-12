"use server";

import { setSubscriptionSchema } from "@fusion-leap/domain";
import { revalidatePath } from "next/cache";
import { serviceCodeToFormCode, uiLocaleOf } from "../service/form";
import { withAction, type ActionFailure } from "../service/with-service";
import type { AdminActionState } from "./types";

/*
 * Server Actions d'administration de la plateforme (J14). Réservées aux administrateurs de la plateforme :
 * la vérification décisive est faite par la base (admin_set_subscription lit auth.uid() dans
 * private.platform_admins) ; ici, pipeline commun (zod, session, limitation de débit « sensible »). L'organisation
 * cible est un champ explicite (`target_organization_id`) ; l'identifiant n'est jamais pris dans un contexte
 * tenant (l'administrateur n'en a pas). Chaque changement est audité par un déclencheur (subscription.changed).
 */

const failure = ({ code, fieldErrors }: ActionFailure): AdminActionState =>
  fieldErrors ? { status: "error", code: serviceCodeToFormCode(code), fieldErrors } : { status: "error", code: serviceCodeToFormCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

const setSubscription = withAction(
  {
    name: "admin.set_subscription",
    auth: "user",
    schema: setSubscriptionSchema,
    fields: ["target_organization_id", "plan_code", "status", "limits_override", "reason", "period_end"],
    forbidOrganizationId: true,
    rateLimit: "sensitive",
    idempotency: "none",
    failure,
    loginPath,
  },
  async (ctx, input): Promise<AdminActionState> => {
    const { error } = await ctx.supabase.rpc("admin_set_subscription", {
      p_org: input.target_organization_id,
      p_plan_code: input.plan_code,
      p_status: input.status,
      p_limits_override: input.limits_override,
      p_reason: input.reason,
      p_period_end: input.period_end ? `${input.period_end}T23:59:59Z` : null,
    });
    if (error) {
      if (error.code === "42501" || error.code === "28000") return { status: "error", code: "forbidden" };
      if (error.code === "22023") return { status: "error", code: "invalid_input" };
      return { status: "error", code: "generic" };
    }
    revalidatePath(`/${uiLocaleOf(ctx.formData)}/admin/organizations`);
    return { status: "success" };
  },
);

export async function setSubscriptionAction(prev: AdminActionState, formData: FormData): Promise<AdminActionState> {
  return setSubscription(prev, formData);
}
