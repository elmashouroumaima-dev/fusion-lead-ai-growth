import { beforeEach, describe, expect, it, vi } from "vitest";

type Options = Record<string, unknown>;
const { captured, rpc } = vi.hoisted(() => ({ captured: [] as Record<string, unknown>[], rpc: vi.fn() }));

/** Remplace withAction : conserve les options et exécute le gestionnaire avec un contexte minimal. */
vi.mock("../service/with-service", () => ({
  withAction: (options: Options, handler: (ctx: unknown, input: unknown) => Promise<unknown>) => {
    captured.push(options);
    return (_prev: unknown, formData: FormData) =>
      handler({ supabase: { rpc }, formData }, Object.fromEntries(formData.entries()));
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setSubscriptionAction } from "./actions";

const input = {
  target_organization_id: "11111111-1111-4111-8111-111111111111",
  plan_code: "starter",
  status: "active",
  limits_override: { users: 8 },
  reason: "Passage en Starter",
};
/** FormData minimal : `get` (uiLocaleOf) et `entries` (le gestionnaire simulé reconstruit l'entrée zod). */
const fakeForm = (data: Record<string, unknown>): FormData =>
  ({
    get: (key: string) => (typeof data[key] === "string" ? data[key] : null),
    entries: () => Object.entries(data)[Symbol.iterator](),
  }) as unknown as FormData;
const run = (data: Record<string, unknown>) => setSubscriptionAction({ status: "idle" }, fakeForm({ uiLocale: "fr", ...data }));

beforeEach(() => rpc.mockReset());

describe("setSubscriptionAction : garde-fous de configuration", () => {
  it("session sans organisation, champs fermés, organisation posté refusée, débit sensible, pas d'idempotence tenant", () => {
    const options = captured[0]!;
    expect(options.name).toBe("admin.set_subscription");
    expect(options.auth).toBe("user");
    expect(options.forbidOrganizationId).toBe(true);
    expect(options.rateLimit).toBe("sensitive");
    expect(options.idempotency).toBe("none");
    expect(options.fields).toEqual(["target_organization_id", "plan_code", "status", "limits_override", "reason", "period_end"]);
    expect(options.fields).not.toContain("organization_id");
  });
});

describe("setSubscriptionAction : appel de la base", () => {
  it("appelle admin_set_subscription avec l'organisation cible et la date de fin en fin de journée UTC", async () => {
    rpc.mockResolvedValue({ error: null });
    await expect(run({ ...input, period_end: "2027-01-31" })).resolves.toEqual({ status: "success" });
    expect(rpc).toHaveBeenCalledWith("admin_set_subscription", {
      p_org: input.target_organization_id,
      p_plan_code: "starter",
      p_status: "active",
      p_limits_override: { users: 8 },
      p_reason: "Passage en Starter",
      p_period_end: "2027-01-31T23:59:59Z",
    });
  });

  it("sans date : p_period_end null", async () => {
    rpc.mockResolvedValue({ error: null });
    await run(input);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_period_end: null });
  });

  it("traduit les erreurs de la base en codes, sans message brut", async () => {
    rpc.mockResolvedValue({ error: { code: "42501", message: "forbidden" } });
    await expect(run(input)).resolves.toEqual({ status: "error", code: "forbidden" });
    rpc.mockResolvedValue({ error: { code: "28000", message: "unauthenticated" } });
    await expect(run(input)).resolves.toEqual({ status: "error", code: "forbidden" });
    rpc.mockResolvedValue({ error: { code: "22023", message: "validation_failed" } });
    await expect(run(input)).resolves.toEqual({ status: "error", code: "invalid_input" });
    rpc.mockResolvedValue({ error: { code: "XX000", message: "password=secret" } });
    const result = await run(input);
    expect(result).toEqual({ status: "error", code: "generic" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
