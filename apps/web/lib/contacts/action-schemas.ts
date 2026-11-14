import {
  recordConsentSchema,
  revokeConsentSchema,
  setDoNotContactSchema,
  type RecordConsentInput,
  type RevokeConsentInput,
  type SetDoNotContactInput,
} from "@fusion-leap/domain";
import type { ServiceSchema } from "../service/with-service";
import { ALL_PURPOSES } from "./consent-options";

/**
 * Schémas des Server Actions Contacts : les champs de formulaire (tous des textes) deviennent les entrées des schémas métier du
 * domaine. `organization_id` n'est jamais une vérité : le pipeline le compare au contexte vérifié. La preuve d'un consentement saisi
 * à la main se limite au texte et à la version : ni IP ni URL ne viennent d'un formulaire.
 */

type Raw = Record<string, string | undefined>;

type Parsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> } };

function through<T>(build: (raw: Raw) => unknown, schema: { safeParse(input: unknown): Parsed<T> }): ServiceSchema<T> {
  return { safeParse: (raw) => schema.safeParse(build(raw as Raw)) };
}

const blankToUndefined = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value);
const blankToNull = (value: string | undefined): string | null => blankToUndefined(value) ?? null;
/** Case à cocher : « on » (valeur par défaut d'un navigateur) ou « true ». Tout le reste est faux. */
const checked = (value: string | undefined): boolean => value === "on" || value === "true";

export const recordConsentFormSchema: ServiceSchema<RecordConsentInput> = through(
  (r) => {
    const text = blankToUndefined(r.consent_text);
    const version = blankToUndefined(r.consent_version);
    return {
      contact_id: r.contact_id,
      channel: r.channel,
      purpose: r.purpose,
      source: r.source,
      proof: { ...(text === undefined ? {} : { consent_text: text }), ...(version === undefined ? {} : { consent_version: version }) },
      organization_id: blankToUndefined(r.organization_id),
    };
  },
  recordConsentSchema,
);

export const revokeConsentFormSchema: ServiceSchema<RevokeConsentInput> = through(
  (r) => ({
    contact_id: r.contact_id,
    channel: r.channel,
    // « __all » : valeur du menu pour « toutes les finalités » (ce n'est jamais un code de finalité).
    purpose: r.purpose === ALL_PURPOSES ? null : blankToNull(r.purpose),
    do_not_contact: checked(r.do_not_contact),
    organization_id: blankToUndefined(r.organization_id),
  }),
  revokeConsentSchema,
);

export const setDoNotContactFormSchema: ServiceSchema<SetDoNotContactInput> = through(
  (r) => ({ contact_id: r.contact_id, value: r.value === "true", organization_id: blankToUndefined(r.organization_id) }),
  setDoNotContactSchema,
);

export const CONSENT_RECORD_FIELDS = ["contact_id", "channel", "purpose", "source", "consent_text", "consent_version", "organization_id"] as const;
export const CONSENT_REVOKE_FIELDS = ["contact_id", "channel", "purpose", "do_not_contact", "organization_id"] as const;
export const DO_NOT_CONTACT_FIELDS = ["contact_id", "value", "organization_id"] as const;
