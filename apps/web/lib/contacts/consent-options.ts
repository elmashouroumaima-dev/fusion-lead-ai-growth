/** Finalités et sources proposées par l'écran Contact (codes courts ; la base accepte tout code court en minuscules). */
export const CONSENT_PURPOSES = ["marketing", "newsletter"] as const;
export const CONSENT_SOURCES = ["manual", "phone", "in_person", "paper_form"] as const;

/** Valeur du menu « toutes les finalités » du formulaire de retrait : ce n'est jamais un code de finalité. */
export const ALL_PURPOSES = "__all";
