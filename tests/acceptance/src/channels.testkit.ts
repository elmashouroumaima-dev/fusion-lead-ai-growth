import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPostmarkProvider, createWhatsAppSender } from "../../../packages/adapters/src";
import { HandlerRegistry, createProcessWebhookHandler, createSendMessageHandler } from "../../../apps/worker/src/handlers";
import { Runner, silentLogger } from "../../../apps/worker/src/runner";
import { createSupabaseSecretReader, createSupabaseSendGateway } from "../../../apps/worker/src/send";
import { createSupabaseJobStore } from "../../../apps/worker/src/store";
import { createSupabaseWebhookGateway } from "../../../apps/worker/src/webhooks";
import { createSupabaseWhatsAppEventGateway, createWhatsAppWebhookProcessor } from "../../../apps/worker/src/whatsapp-webhook";
import { createKeyRing } from "../../../packages/adapters/src/secrets";
import { psql } from "../../../supabase/tests/rls/src/harness";

/**
 * Outils des scénarios canaux (J40, T3 et T4) : le VRAI worker (Runner, file de jobs, handler `send_message`, passerelle SQL, lecture du jeton
 * chiffré) contre la VRAIE base locale ; seuls les FOURNISSEURS sont simulés, par un `fetch` injecté dans les adaptateurs réels (Postmark, Meta).
 * Le Runner est piloté pas à pas (`tick` puis `idle`) : aucune horloge, aucun sommeil, résultat déterministe.
 */
export type Call = { url: string; to: string; body: Record<string, unknown>; headers: Record<string, string> };

/** Clé de service de la pile locale : variable d'environnement (CI) ou `supabase status`. */
function stackEnv(): { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string } {
  const url = process.env.SUPABASE_API_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (url && key) return { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key };
  const raw = execSync("pnpm exec supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" });
  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  if (!status.API_URL || !status.SECRET_KEY) throw new Error("Pile Supabase locale introuvable : lancer `pnpm db:start`.");
  return { SUPABASE_URL: status.API_URL, SUPABASE_SECRET_KEY: status.SECRET_KEY };
}

/**
 * Fournisseur simulé. `script[destinataire]` est la liste des réponses successives (statuts HTTP) ; une fois épuisée, ou sans script : succès.
 * Postmark : destinataire = `To` ; Meta : destinataire = `to` (numéro sans « + »). Chaque appel est enregistré (jamais le jeton).
 */
export function providerMock(script: Record<string, Array<{ status: number; body?: unknown }>> = {}): { fetch: typeof fetch; calls: Call[]; toRecipient: (to: string) => Call[] } {
  const calls: Call[] = [];
  const remaining = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  let counter = 0;
  const mockFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const to = String(body.To ?? body.to ?? "");
    calls.push({ url, to, body, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).filter(([k]) => !/token|authorization/i.test(k))) });
    const next = remaining.get(to)?.shift();
    counter += 1;
    if (next) return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json" } });
    const id = `${url.includes("postmarkapp") ? "pm" : "wamid.HBg"}${randomUUID().replace(/-/g, "").slice(0, 20)}${counter}`;
    const ok = url.includes("postmarkapp") ? { ErrorCode: 0, Message: "OK", MessageID: id, To: to } : { messaging_product: "whatsapp", messages: [{ id }] };
    return new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: mockFetch, calls, toRecipient: (to) => calls.filter((c) => c.to === to) };
}

export function createSendWorker(input: { masterKey: string; version: number; provider: typeof fetch; siteUrl?: string }): Runner {
  const env = { ...stackEnv(), SECRETS_MASTER_KEY: input.masterKey, SECRETS_KEY_VERSION: input.version };
  const registry = new HandlerRegistry()
    // événements WhatsApp reçus par la route (message entrant, statuts) : le VRAI processeur et les VRAIES fonctions SQL
    .register(createProcessWebhookHandler(createSupabaseWebhookGateway(env), new Map([["whatsapp", createWhatsAppWebhookProcessor(createSupabaseWhatsAppEventGateway(env))]])))
    .register(
    createSendMessageHandler({
      gateway: createSupabaseSendGateway(env),
      readSecret: createSupabaseSecretReader(env),
      provider: createPostmarkProvider({ fetch: input.provider }),
      whatsapp: createWhatsAppSender({ fetch: input.provider }),
      unsubscribe: { keyRing: createKeyRing(input.version, { [input.version]: input.masterKey }), siteUrl: input.siteUrl ?? "http://localhost:3000" },
    }),
  );
  return new Runner({ store: createSupabaseJobStore(env), registry, workerId: `acc40:${randomUUID().slice(0, 8)}`, concurrency: 1, logger: silentLogger });
}

/** Un tour : réclame (un job à la fois) puis attend la fin. Renvoie le nombre de jobs exécutés. */
export async function step(runner: Runner): Promise<number> {
  const claimed = await runner.tick();
  await runner.idle();
  return claimed;
}

/** Exécute tous les jobs échus jusqu'à file vide. */
export async function drain(runner: Runner, max = 30): Promise<number> {
  let total = 0;
  for (let i = 0; i < max; i += 1) {
    const n = await step(runner);
    if (n === 0) break;
    total += n;
  }
  return total;
}

/** Rend échus les jobs en attente de CE test (le recul exponentiel est de l'ordre de la minute). */
export const makeDue = (keyLike: string): void => {
  psql(`update public.jobs set next_run_at = now() - interval '1 second' where status = 'queued' and idempotency_key like '${keyLike}%'`);
};
/** Repousse des jobs hors de portée du worker (pour simuler « en cours de série »). */
export const holdBack = (messageIds: string[]): void => {
  if (messageIds.length === 0) return;
  psql(`update public.jobs set next_run_at = now() + interval '1 hour' where kind = 'send_message' and status = 'queued' and payload ->> 'message_id' in (${messageIds.map((m) => `'${m}'`).join(",")})`);
};
export const release = (messageIds: string[]): void => {
  if (messageIds.length === 0) return;
  psql(`update public.jobs set next_run_at = now() - interval '1 second' where kind = 'send_message' and status = 'queued' and payload ->> 'message_id' in (${messageIds.map((m) => `'${m}'`).join(",")})`);
};
