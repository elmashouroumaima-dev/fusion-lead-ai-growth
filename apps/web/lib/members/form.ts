import type { MembersActionErrorCode, MembersActionState } from "./types";

export const fail = (code: MembersActionErrorCode, fieldErrors?: Record<string, string[]>): MembersActionState =>
  fieldErrors ? { status: "error", code, fieldErrors } : { status: "error", code };
