import { describe, expect, it } from "vitest";
import { signHmacSha256Hex, verifyHmacSha256Hex } from "./hmac";
import { ingestWebhook, WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from "./ingest";
import type { WebhookAdapter, WebhookHeaders, WebhookStore } from "./types";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const SECRET = "secret-webhook-de-test";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INT_A = "11111111-1111-4111-8111-111111111111";
const INT_B = "22222222-2222-4222-8222-222222222222";
const NOW = 1_800_000_000;

type Body = { account?: string; event?: string; ts?: number; org?: string };

/** Adaptateur factice : signature HMAC dans `x-signature`, corps JSON { account, event, ts }. */
const adapter = (over: Partial<WebhookAdapter> = {}): WebhookAdapter => ({
  provider: "whatsapp",
  maxBytes: 1024,
  parse(raw) {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(raw));
      return typeof value === "object" && value !== null ? value : null;
    } catch {
      return null;
    }
  },
  extractAccount: (payload) => ((payload as Body).account ?? null),
  extractEventId: (payload) => ((payload as Body).event ?? null),
  extractTimestamp: (payload) => ((payload as Body).ts ?? null),
  verify: ({ rawBody, headers, secret }) => verifyHmacSha256Hex({ secret, rawBody, signature: headers["x-signature"], prefix: "sha256=" }),
  ...over,
});

function fakeStore() {
  const events = new Map<string, { eventId: string; payload: unknown; organizationId: string }>();
  const rejections: Array<{ organizationId: string; integrationId: string }> = [];
  const resolved: Array<{ provider: string; account: string }> = [];
  const accounts = new Map([
    ["acc-a", { organizationId: ORG_A, integrationId: INT_A }],
    ["acc-b", { organizationId: ORG_B, integrationId: INT_B }],
  ]);
  const store: WebhookStore = {
    async resolve(provider, account) {
      resolved.push({ provider, account });
      return accounts.get(account) ?? null;
    },
    async record(input) {
      const key = `${input.organizationId}:${input.provider}:${input.externalEventId}`;
      const existing = events.get(key);
      if (existing) return { eventId: existing.eventId, duplicate: true };
      const eventId = `evt-${events.size + 1}`;
      events.set(key, { eventId, payload: input.payload, organizationId: input.organizationId });
      return { eventId, duplicate: false };
    },
    async recordRejection({ organizationId, integrationId }) {
      rejections.push({ organizationId, integrationId });
    },
  };
  return { store, events, rejections, resolved };
}

const secrets = async (organizationId: string): Promise<string | null> => (organizationId === ORG_A ? SECRET : "secret-de-beta");
const signed = (body: Body | string, secret = SECRET): { raw: Uint8Array; headers: WebhookHeaders } => {
  const raw = bytes(typeof body === "string" ? body : JSON.stringify(body));
  return { raw, headers: { "x-signature": `sha256=${signHmacSha256Hex(secret, raw)}` } };
};

describe("verifyHmacSha256Hex", () => {
  const raw = bytes('{"a":1}');
  const good = signHmacSha256Hex(SECRET, raw);
  it("accepte la bonne signature, avec ou sans le préfixe attendu", () => {
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: good })).toBe(true);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: `sha256=${good}`, prefix: "sha256=" })).toBe(true);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: good.toUpperCase() })).toBe(true);
  });
  it("refuse sans jamais lever : secret absent, signature absente, mal formée, trop courte, autre corps, autre secret, préfixe manquant", () => {
    expect(verifyHmacSha256Hex({ secret: null, rawBody: raw, signature: good })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: "", rawBody: raw, signature: good })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: undefined })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: "zz".repeat(32) })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: good.slice(2) })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: bytes('{"a":2}'), signature: good })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: "autre", rawBody: raw, signature: good })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: raw, signature: good, prefix: "sha256=" })).toBe(false);
  });
  it("la signature porte sur le corps BRUT : un espace de plus change tout", () => {
    expect(verifyHmacSha256Hex({ secret: SECRET, rawBody: bytes('{"a": 1}'), signature: good })).toBe(false);
  });
});

describe("ingestWebhook : chemin nominal et rejeu", () => {
  it("événement valide : accepté, enregistré pour l'entreprise du COMPTE ; payload conservé", async () => {
    const f = fakeStore();
    const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW });
    const outcome = await ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW });
    expect(outcome).toEqual({ kind: "accepted", eventId: "evt-1" });
    expect([...f.events.values()].map((e) => e.organizationId)).toEqual([ORG_A]);
    expect(f.rejections).toEqual([]);
  });

  it("rejeu du même événement : « duplicate », un seul enregistrement", async () => {
    const f = fakeStore();
    const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW });
    const run = () => ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW });
    expect((await run()).kind).toBe("accepted");
    expect(await run()).toEqual({ kind: "duplicate", eventId: "evt-1" });
    expect(f.events.size).toBe(1);
  });

  it("le même identifiant d'événement chez une autre entreprise est un événement distinct", async () => {
    const f = fakeStore();
    const a = signed({ account: "acc-a", event: "e1", ts: NOW });
    const b = signed({ account: "acc-b", event: "e1", ts: NOW }, "secret-de-beta");
    expect((await ingestWebhook({ adapter: adapter(), rawBody: a.raw, headers: a.headers, store: f.store, readSecret: secrets, now: () => NOW })).kind).toBe("accepted");
    expect((await ingestWebhook({ adapter: adapter(), rawBody: b.raw, headers: b.headers, store: f.store, readSecret: secrets, now: () => NOW })).kind).toBe("accepted");
    expect(f.events.size).toBe(2);
  });
});

describe("ingestWebhook : refus", () => {
  it("signature invalide (mauvais secret, absente, corps modifié) : refusée, trace de rejet, rien d'enregistré", async () => {
    const f = fakeStore();
    const body: Body = { account: "acc-a", event: "e1", ts: NOW };
    const forged = signed(body, "pas-le-bon-secret");
    const none = { raw: bytes(JSON.stringify(body)), headers: {} as WebhookHeaders };
    const tampered = { raw: bytes(JSON.stringify({ ...body, event: "e2" })), headers: signed(body).headers };
    for (const attempt of [forged, none, tampered]) {
      expect(await ingestWebhook({ adapter: adapter(), rawBody: attempt.raw, headers: attempt.headers, store: f.store, readSecret: secrets, now: () => NOW })).toEqual({ kind: "invalid_signature" });
    }
    expect(f.events.size).toBe(0);
    expect(f.rejections).toHaveLength(3);
  });

  it("intégration sans secret : refusée (jamais acceptée par défaut)", async () => {
    const f = fakeStore();
    const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW });
    expect(await ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: async () => null, now: () => NOW })).toEqual({ kind: "invalid_signature" });
    expect(f.events.size).toBe(0);
  });

  it("horodatage hors fenêtre (trop ancien ou dans le futur) ou absent alors que l'adaptateur en exige un : même refus", async () => {
    const f = fakeStore();
    const run = async (ts: number | undefined) => {
      const { raw, headers } = signed({ account: "acc-a", event: `e-${String(ts)}`, ...(ts === undefined ? {} : { ts }) });
      return ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW });
    };
    expect(await run(NOW - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 1)).toEqual({ kind: "invalid_signature" });
    expect(await run(NOW + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1)).toEqual({ kind: "invalid_signature" });
    expect(await run(undefined)).toEqual({ kind: "invalid_signature" });
    expect((await run(NOW - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS)).kind).toBe("accepted");
    expect(f.events.size).toBe(1);
  });

  it("adaptateur sans horodatage : aucune vérification de fenêtre", async () => {
    const f = fakeStore();
    const { raw, headers } = signed({ account: "acc-a", event: "e1" });
    const { extractTimestamp: _unused, ...rest } = adapter();
    void _unused;
    expect((await ingestWebhook({ adapter: rest as WebhookAdapter, rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW })).kind).toBe("accepted");
  });

  it("corps trop gros : refusé AVANT toute lecture ou résolution", async () => {
    const f = fakeStore();
    const raw = bytes(`{"account":"acc-a","event":"e1","pad":"${"x".repeat(2000)}"}`);
    expect(await ingestWebhook({ adapter: adapter(), rawBody: raw, headers: {}, store: f.store, readSecret: secrets, now: () => NOW })).toEqual({ kind: "too_large" });
    expect(f.resolved).toEqual([]);
  });

  it("corps illisible, sans compte, ou sans identifiant d'événement : requête invalide", async () => {
    const f = fakeStore();
    for (const body of ["pas du json", "[1,2]", '{"event":"e1"}']) {
      const { raw, headers } = signed(body);
      expect((await ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW })).kind, body).toBe("bad_request");
    }
    const noEvent = signed({ account: "acc-a", ts: NOW });
    expect((await ingestWebhook({ adapter: adapter(), rawBody: noEvent.raw, headers: noEvent.headers, store: f.store, readSecret: secrets, now: () => NOW })).kind).toBe("bad_request");
    expect(f.events.size).toBe(0);
  });

  it("compte inconnu : MÊME refus qu'une signature invalide (aucun oracle), même travail (vérification factice), sans lecture de secret ni écriture", async () => {
    const f = fakeStore();
    let secretReads = 0;
    let verifications = 0;
    const counting = adapter({ verify: (input) => ((verifications += 1), adapter().verify(input)) });
    const unknown = signed({ account: "inconnu", event: "e1", ts: NOW });
    const known = signed({ account: "acc-a", event: "e1", ts: NOW }, "pas-le-bon-secret");
    const run = (attempt: { raw: Uint8Array; headers: WebhookHeaders }) =>
      ingestWebhook({ adapter: counting, rawBody: attempt.raw, headers: attempt.headers, store: f.store, readSecret: async () => ((secretReads += 1), SECRET), now: () => NOW });
    const unknownOutcome = await run(unknown);
    const knownOutcome = await run(known);
    expect(unknownOutcome).toEqual({ kind: "invalid_signature" });
    expect(knownOutcome).toEqual(unknownOutcome);
    expect(verifications).toBe(2);
    expect(secretReads).toBe(1);
    expect(f.events.size).toBe(0);
    expect(f.rejections).toEqual([{ organizationId: ORG_A, integrationId: INT_A }]);
  });
});

describe("ingestWebhook : l'entreprise vient du COMPTE, jamais du payload", () => {
  it("un payload qui désigne l'entreprise B dans un champ libre est attribué à l'entreprise du compte (A)", async () => {
    const f = fakeStore();
    const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW, org: ORG_B });
    await ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW });
    expect([...f.events.values()].map((e) => e.organizationId)).toEqual([ORG_A]);
  });

  it("signé avec le secret d'Alpha mais visant le compte de Beta : la signature est vérifiée avec le secret de BETA, donc refusée", async () => {
    const f = fakeStore();
    const { raw, headers } = signed({ account: "acc-b", event: "e1", ts: NOW }, SECRET);
    expect(await ingestWebhook({ adapter: adapter(), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW })).toEqual({ kind: "invalid_signature" });
    expect(f.events.size).toBe(0);
    expect(f.rejections).toEqual([{ organizationId: ORG_B, integrationId: INT_B }]);
  });
});

describe("ingestWebhook : défense en profondeur (revue J29)", () => {
  it("intégration sans secret : refusée même si l'adaptateur répondrait « vrai » quand le secret est absent", async () => {
    const f = fakeStore();
    const lax = adapter({ verify: () => true });
    const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW });
    expect(await ingestWebhook({ adapter: lax, rawBody: raw, headers, store: f.store, readSecret: async () => null, now: () => NOW })).toEqual({ kind: "invalid_signature" });
    expect(await ingestWebhook({ adapter: lax, rawBody: raw, headers, store: f.store, readSecret: async () => "", now: () => NOW })).toEqual({ kind: "invalid_signature" });
    expect(f.events.size).toBe(0);
    expect(f.rejections).toHaveLength(2);
  });

  it("horodatage : une méthode qui ne renvoie rien (undefined), une chaîne ou NaN = refus, jamais « pas de fenêtre »", async () => {
    for (const bad of [undefined, "1800000000", Number.NaN, Number.POSITIVE_INFINITY] as unknown[]) {
      const f = fakeStore();
      const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW });
      const outcome = await ingestWebhook({
        adapter: adapter({ extractTimestamp: () => bad as number }), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW,
      });
      expect(outcome, String(bad)).toEqual({ kind: "invalid_signature" });
      expect(f.events.size).toBe(0);
    }
  });

  it("un adaptateur qui lève une exception ne produit jamais une erreur serveur : requête invalide ou refus", async () => {
    const boom = () => {
      throw new Error("adaptateur défaillant");
    };
    const { raw, headers } = signed({ account: "acc-a", event: "e1", ts: NOW });
    const cases: Array<[Partial<WebhookAdapter>, string]> = [
      [{ parse: boom }, "bad_request"],
      [{ extractAccount: boom }, "bad_request"],
      [{ verify: boom }, "invalid_signature"],
      [{ extractTimestamp: boom }, "invalid_signature"],
      [{ extractEventId: boom }, "bad_request"],
    ];
    for (const [over, expected] of cases) {
      const f = fakeStore();
      const outcome = await ingestWebhook({ adapter: adapter(over), rawBody: raw, headers, store: f.store, readSecret: secrets, now: () => NOW });
      expect(outcome.kind, Object.keys(over)[0]).toBe(expected);
      expect(f.events.size).toBe(0);
    }
  });

  it("un compte qui n'est pas une chaîne exploitable (objet, nombre) : requête invalide", async () => {
    const f = fakeStore();
    const raw = bytes('{"account":{"x":1},"event":"e1"}');
    const outcome = await ingestWebhook({ adapter: adapter({ extractAccount: (p) => (typeof (p as { account: unknown }).account === "string" ? (p as { account: string }).account : null) }), rawBody: raw, headers: {}, store: f.store, readSecret: secrets, now: () => NOW });
    expect(outcome).toEqual({ kind: "bad_request" });
  });
});
