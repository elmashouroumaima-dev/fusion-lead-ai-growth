"use server";

import { revalidatePath } from "next/cache";
import { uiLocaleOf } from "../service/form";
import { withAction, type ActionFailure } from "../service/with-service";
import { toActionCode } from "./action-code";
import {
  CONSENT_RECORD_FIELDS,
  CONSENT_REVOKE_FIELDS,
  DO_NOT_CONTACT_FIELDS,
  recordConsentFormSchema,
  revokeConsentFormSchema,
  setDoNotContactFormSchema,
} from "./action-schemas";
import { recordConsent, revokeConsent, setDoNotContact } from "./service";
import type { ContactsActionState } from "./types";

/*
 * Server Actions de l'écran Contacts (J30b), branchées sur la couche service (`withAction` : zod, contexte tenant relu en base,
 * comparaison de l'organization_id posté, can() de la matrice ADR 014, limitation de débit, idempotence) puis sur les services J18
 * (fonctions SQL : rôle relu par la base, quota, audit sans donnée personnelle). L'entreprise vient du CONTEXTE, jamais du
 * formulaire ; on ne renvoie que des codes.
 */

const failure = ({ code, fieldErrors }: ActionFailure): ContactsActionState =>
  fieldErrors ? { status: "error", code: toActionCode(code), fieldErrors } : { status: "error", code: toActionCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

function refresh(uiLocale: string, contactId: string): void {
  revalidatePath(`/${uiLocale}/contacts`);
  revalidatePath(`/${uiLocale}/contacts/${contactId}`);
}

const recordConsentAct = withAction(
  {
    name: "contacts.consent.record",
    auth: "tenant",
    schema: recordConsentFormSchema,
    fields: CONSENT_RECORD_FIELDS,
    permission: { action: "create", resource: "contacts" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ContactsActionState> => {
    const result = await recordConsent(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData), input.contact_id);
    return { status: "success", success: "consentRecorded" };
  },
);

/** Enregistre un consentement saisi à la main (preuve : texte et version). Clé d'idempotence obligatoire (champ caché). */
export async function recordConsentAction(prev: ContactsActionState, formData: FormData): Promise<ContactsActionState> {
  return recordConsentAct(prev, formData);
}

const revokeConsentAct = withAction(
  {
    name: "contacts.consent.revoke",
    auth: "tenant",
    schema: revokeConsentFormSchema,
    fields: CONSENT_REVOKE_FIELDS,
    permission: { action: "revoke", resource: "consent" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ContactsActionState> => {
    const result = await revokeConsent(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData), input.contact_id);
    return { status: "success", success: "consentRevoked" };
  },
);

/** Révoque les consentements actifs d'un canal (et d'une finalité), avec « ne plus contacter » en option. Effet immédiat. */
export async function revokeConsentAction(prev: ContactsActionState, formData: FormData): Promise<ContactsActionState> {
  return revokeConsentAct(prev, formData);
}

const setDoNotContactAct = withAction(
  {
    name: "contacts.do_not_contact.set",
    auth: "tenant",
    schema: setDoNotContactFormSchema,
    fields: DO_NOT_CONTACT_FIELDS,
    permission: { action: "mark_do_not_contact", resource: "consent" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ContactsActionState> => {
    const result = await setDoNotContact(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData), input.contact_id);
    return { status: "success", success: input.value ? "doNotContactSet" : "doNotContactCleared" };
  },
);

/** Pose ou retire « ne plus contacter » (le retrait est réservé à owner et admin : la base le revérifie). */
export async function setDoNotContactAction(prev: ContactsActionState, formData: FormData): Promise<ContactsActionState> {
  return setDoNotContactAct(prev, formData);
}
