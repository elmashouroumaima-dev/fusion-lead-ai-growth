import { z } from "zod";
import { CsvCrmAdapter, type EmailProvider } from "@fusion-leap/adapters";
import {
  checkCanSend, CsvError, CsvParser, crmMappingsSchema, decideCreate, deriveEmailSubject, detectDelimiter, EMAIL_SENDS_PER_HOUR, IMPORT_MAX_BYTES,
  isRetryableRefusal, normalizeContactEmail, normalizeImportRow, normalizePhone, resolveContactRecord, type CrmMappingEntry,
} from "@fusion-leap/domain";
import type { SecretReader, SendGateway } from "./send";
import type { CrmCounts, CrmSyncGateway } from "./crm-sync";
import type { LeadAssigner } from "./assignment";
import { NonRetryableError } from "./errors";
import { ImportGatewayError, type ImportGateway } from "./imports";
import type { WebhookGateway, WebhookProcessors } from "./webhooks";

/**
 * Contexte d'exécution d'un job. `organizationId` vient de la ligne du job (jamais de la charge utile) : tout
 * handler DOIT l'appliquer explicitement à chaque lecture ou écriture (le worker utilise service_role, qui
 * contourne la RLS ; spec §11, ADR 003).
 */
export type JobContext = {
  jobId: string;
  organizationId: string;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  /** Déclenché si le bail est perdu ou à l'arrêt forcé : le handler doit s'interrompre. */
  signal: AbortSignal;
};

/** Handler typé : la charge utile est validée par `schema` AVANT l'appel de `run`. */
export type JobHandler = {
  readonly kind: string;
  parse(payload: unknown): { success: true; data: unknown } | { success: false };
  run(ctx: JobContext, payload: unknown): Promise<void>;
};

const KIND = /^[a-z0-9_.]{1,64}$/;

export function defineHandler<S extends z.ZodType>(definition: {
  kind: string;
  schema: S;
  run: (ctx: JobContext, payload: z.output<S>) => Promise<void>;
}): JobHandler {
  if (!KIND.test(definition.kind)) throw new Error("handler_kind_invalid");
  return {
    kind: definition.kind,
    parse(payload) {
      const parsed = definition.schema.safeParse(payload);
      return parsed.success ? { success: true, data: parsed.data } : { success: false };
    },
    run: (ctx, payload) => definition.run(ctx, payload as z.output<S>),
  };
}

/** Registre des handlers par type de job. Un type inconnu est un échec définitif (jamais réessayé). */
export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(handler: JobHandler): this {
    if (this.handlers.has(handler.kind)) throw new Error("handler_already_registered");
    this.handlers.set(handler.kind, handler);
    return this;
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

/** Job de démonstration : ne fait rien (sert à vérifier la chaîne complète file → worker → base). */
export const noopHandler = defineHandler({
  kind: "noop",
  schema: z.record(z.string(), z.unknown()),
  run: async () => {},
});

/**
 * `lead.assign` (enregistré par la capture publique, J21 ; spec §9.1 étape 4). L'entreprise est celle de la LIGNE DU JOB ; la charge
 * utile ne porte que l'identifiant du lead. Idempotent : un lead déjà assigné (ou plus dans la file « non assignés ») est ignoré,
 * donc un rejeu ne réassigne pas. Sans règle ni membre éligible, la base laisse le lead « non assigné » et alerte les admins
 * (réussite du job). Une erreur technique est réessayée ; à la dernière tentative, le lead reste « non assigné » et les admins
 * sont alertés avant l'échec définitif.
 */
export function createLeadAssignHandler(assigner: LeadAssigner): JobHandler {
  return defineHandler({
    kind: "lead.assign",
    schema: z.object({ lead_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      try {
        await assigner.assign(ctx.organizationId, payload.lead_id);
      } catch (error) {
        if (ctx.attempt >= ctx.maxAttempts) {
          try {
            await assigner.flagUnassigned(ctx.organizationId, payload.lead_id);
          } catch {
            // l'alerte est un effort ; l'erreur d'origine reste celle du job
          }
        }
        throw error;
      }
    },
  });
}

/**
 * `import_csv` (J23, plan J23) : crée contacts et leads d'un lot d'import CONFIRMÉ. L'entreprise est celle de la LIGNE DU JOB ; la charge
 * utile ne porte que l'identifiant du lot. Le fichier (Storage privé, 10 Mo au plus) est lu en une fois puis analysé ligne par ligne ;
 * chaque ligne passe par `import_row` (même dédup que la capture publique, AUCUN consentement créé, rapport sans donnée de contact).
 * Rejeu : chaque ligne est enregistrée une seule fois côté base ; un lot terminé, annulé ou inconnu est ignoré. Fichier absent ou
 * illisible, trop de lignes, abonnement inactif : échec définitif du lot (code seulement). Panne technique : réessayée ; à la dernière
 * tentative le lot est marqué « failed » (il ne reste jamais « running »).
 */
export function createImportCsvHandler(gateway: ImportGateway): JobHandler {
  return defineHandler({
    kind: "import_csv",
    schema: z.object({ batch_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      const org = ctx.organizationId;
      const batch = payload.batch_id;
      try {
        await runImport(gateway, ctx, org, batch);
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        if (error instanceof ImportGatewayError && (error.kind === "subscription_inactive" || error.kind === "project_archived")) {
          await bestEffort(() => gateway.fail(org, batch, error.kind as "subscription_inactive" | "project_archived"));
          throw new NonRetryableError(error.kind);
        }
        if (ctx.attempt >= ctx.maxAttempts) await bestEffort(() => gateway.fail(org, batch, "failed"));
        throw error;
      }
    },
  });
}

async function bestEffort(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // l'erreur d'origine reste celle du job
  }
}

async function runImport(gateway: ImportGateway, ctx: JobContext, org: string, batch: string): Promise<void> {
  const started = await gateway.start(org, batch);
  if (started.status !== "running") return;

  const bytes = await gateway.readFile(started.path);
  if (bytes === null) {
    await gateway.fail(org, batch, "file_missing");
    throw new NonRetryableError("file_missing");
  }
  let rows: string[][];
  try {
    if (bytes.byteLength > IMPORT_MAX_BYTES) throw new CsvError("too_many_rows");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rows = [];
    const parser = new CsvParser(detectDelimiter(text));
    for (let offset = 0; offset < text.length; offset += 65536) rows.push(...parser.push(text.slice(offset, offset + 65536)));
    rows.push(...parser.end());
  } catch (error) {
    const code = error instanceof CsvError && error.code === "too_many_rows" ? "too_many_rows" : "file_malformed";
    await gateway.fail(org, batch, code);
    throw new NonRetryableError(code);
  }

  // rows[0] = en-tête ; les numéros de ligne du rapport sont ceux du fichier (en-tête = ligne 1)
  for (let index = 1; index < rows.length; index += 1) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const rowNo = index + 1;
    const normalized = normalizeImportRow(rows[index] as string[], started.mapping, started.defaultCountry);
    if (normalized.ok) await gateway.row(org, batch, rowNo, normalized.value);
    else await gateway.rowError(org, batch, rowNo, normalized.reason);
  }
  await gateway.finish(org, batch, Math.max(rows.length - 1, 0));
}

/**
 * `crm_sync` (J25, spec §9.1 étapes 5–6) : synchronise des CONTACTS depuis un fichier CSV déjà envoyé (assistant d'import) selon le
 * mapping de l'intégration. L'entreprise est celle de la LIGNE DU JOB ; la charge utile ne porte que des identifiants. Pour chaque ligne :
 * création, rattachement ou mise à jour décidés par le moteur du domaine (`decideCreate` / `resolveContactRecord` : conflit seulement si
 * les deux côtés ont changé, `source_of_truth` par champ, perdant consigné dans l'audit sans valeur), idempotent par identifiant externe
 * (un rejeu ne recrée rien). Jamais d'écrasement de l'identité, jamais de contact « ne plus contacter » modifié, aucun consentement
 * touché. Fichier absent ou illisible, mapping invalide : échec définitif (code seulement). Panne technique : réessayée ; à la dernière
 * tentative l'échec est enregistré sur l'intégration (visible, rejouable).
 */
export function createCrmSyncHandler(gateway: CrmSyncGateway): JobHandler {
  return defineHandler({
    kind: "crm_sync",
    schema: z.object({ integration_id: z.uuid(), batch_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      const org = ctx.organizationId;
      try {
        await runCrmSync(gateway, ctx, org, payload.integration_id, payload.batch_id);
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        if (ctx.attempt >= ctx.maxAttempts) await bestEffort(() => gateway.fail(org, payload.integration_id, "failed"));
        throw error;
      }
    },
  });
}

async function crmFail(gateway: CrmSyncGateway, org: string, integration: string, code: "file_missing" | "file_malformed" | "mapping_invalid"): Promise<never> {
  await gateway.fail(org, integration, code);
  throw new NonRetryableError(code);
}

async function runCrmSync(gateway: CrmSyncGateway, ctx: JobContext, org: string, integration: string, batch: string): Promise<void> {
  const started = await gateway.start(org, integration, batch);
  if (started.status !== "running") {
    if (started.status === "missing") return;
    return crmFail(gateway, org, integration, "file_missing");
  }

  const mappings = crmMappingsSchema.safeParse(started.mappings);
  if (!mappings.success) return crmFail(gateway, org, integration, "mapping_invalid");
  const entries: CrmMappingEntry[] = mappings.data;

  const bytes = await gateway.readFile(started.path);
  if (bytes === null) return crmFail(gateway, org, integration, "file_missing");
  if (bytes.byteLength > IMPORT_MAX_BYTES) return crmFail(gateway, org, integration, "file_malformed");
  let received;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    received = await new CsvCrmAdapter(entries).receive({ text });
  } catch (error) {
    if (error instanceof CsvError || error instanceof TypeError) return crmFail(gateway, org, integration, "file_malformed");
    throw error;
  }

  // Revue sécurité : un fichier SANS colonne d'identifiant externe (mauvais fichier, en-tête renommé), ou dont AUCUNE ligne n'est lisible,
  // n'est pas une synchro réussie : échec définitif (sinon la date de synchro avancerait et un ancien export serait ignoré ensuite).
  const idColumn = entries.find((entry) => entry.internal_field === "external_id")?.external_field;
  if (idColumn !== undefined && received.missingColumns.includes(idColumn)) return crmFail(gateway, org, integration, "mapping_invalid");
  if (received.records.length === 0 && received.rejected.length > 0) return crmFail(gateway, org, integration, "file_malformed");

  const counts: CrmCounts = { created: 0, updated: 0, linked: 0, unchanged: 0, skipped: 0, rejected: received.rejected.length, conflicts: 0 };
  for (const record of received.records) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const rawEmail = (record.fields.email ?? "").trim();
    const rawPhone = (record.fields.phone ?? "").trim();
    const email = rawEmail ? normalizeContactEmail(rawEmail) : null;
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    const external = { externalId: record.externalId, fields: record.fields as never, externalUpdatedAt: record.updatedAt };

    const found = await gateway.find(org, started.source, record.externalId, email?.ok ? email.value : null, phone?.ok ? phone.value : null);
    if (found !== null && found.status === "identity_taken") {
      counts.rejected += 1;
      continue;
    }
    if (found === null) {
      const decision = decideCreate(external);
      if (decision.kind !== "create") {
        counts.rejected += 1;
        continue;
      }
      const phoneOk = decision.fields.phone;
      const result = await gateway.create(org, started.source, {
        externalId: record.externalId, name: decision.fields.name, emailRaw: decision.fields.email,
        emailNormalized: decision.fields.email ? (normalizeContactEmail(decision.fields.email) as { ok: true; value: string }).value : null,
        phoneE164: phoneOk, language: decision.fields.language, country: decision.fields.country,
      });
      if (result.status === "created") counts.created += 1;
      else if (result.status === "exists") counts.unchanged += 1;
      else counts.rejected += 1;
      continue;
    }

    const decision = resolveContactRecord(
      external,
      { id: found.id, fields: { name: found.name, language: found.language, country: found.country }, updatedAt: found.updatedAt, doNotContact: found.doNotContact },
      entries,
      started.lastSyncAt,
      started.lastSyncFinishedAt,
    );
    if (decision.kind === "invalid") {
      counts.rejected += 1;
      continue;
    }
    if (decision.kind === "skip" && decision.reason === "do_not_contact") {
      counts.skipped += 1;
      continue;
    }
    const fields = decision.kind === "update" ? decision.fields : {};
    // un contact rattachable (même e-mail ou téléphone, sans identifiant externe) est RATTACHÉ même sans changement de valeur
    if (decision.kind === "skip" && found.linked) {
      counts.unchanged += 1;
      continue;
    }
    const written = await gateway.update(org, found.id, started.source, record.externalId, fields as Record<string, string | null>);
    if (written.status !== "updated") {
      if (written.status === "do_not_contact") counts.skipped += 1;
      else counts.rejected += 1;
      continue;
    }
    if (!found.linked) counts.linked += 1;
    else counts.updated += 1;
    if (decision.kind === "update" && decision.conflicts.length > 0) {
      counts.conflicts += decision.conflicts.length;
      await gateway.auditConflict(org, integration, found.id, decision.conflicts.map((c) => ({ field: c.field, winner: c.winner })));
    }
  }
  await gateway.finish(org, integration, batch, started.startedAt, counts);
}

/**
 * `process_webhook` (J29) : traite un événement webhook DÉJÀ enregistré et authentifié par la route publique. L'entreprise est celle de
 * la LIGNE du job. Un événement terminé, inconnu ou d'une autre entreprise est ignoré (rejeu sans effet). Sans processeur pour le
 * fournisseur (e-mail J32, WhatsApp J35), l'événement est marqué `failed` avec le code `no_processor` : il reste visible et RE-JOUABLE (le
 * payload reste en base), au lieu d'être classé « sans effet ».
 * Échec définitif : `failed` + code ; le job suit la politique de reprise habituelle.
 */
export function createProcessWebhookHandler(gateway: WebhookGateway, processors: WebhookProcessors): JobHandler {
  return defineHandler({
    kind: "process_webhook",
    schema: z.object({ event_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      const org = ctx.organizationId;
      const event = payload.event_id;
      const started = await gateway.start(org, event);
      if (started.status !== "running") return;
      const processor = processors.get(started.provider);
      if (!processor) {
        await gateway.finish(org, event, "failed", "no_processor");
        return;
      }
      try {
        const outcome = await processor.process({ organizationId: org, eventId: event, integrationId: started.integrationId, payload: started.payload });
        await gateway.finish(org, event, outcome, null);
      } catch (error) {
        if (error instanceof NonRetryableError) {
          await bestEffort(() => gateway.finish(org, event, "failed", error.code));
          throw error;
        }
        if (ctx.attempt >= ctx.maxAttempts) await bestEffort(() => gateway.finish(org, event, "failed", "failed"));
        throw error;
      }
    },
  });
}

/**
 * `send_message` (J31, spec §5.7 et §9.2, figure 9) : envoie UN e-mail déjà approuvé par un humain habilitée, depuis le worker (jamais depuis
 * une requête HTTP). L'entreprise est celle de la LIGNE du job ; la charge utile ne porte que l'identifiant du message. Ordre fixe :
 *  1. `claim` : relit l'état (approbation, consentement, ne plus contacter, suppression, canal, pause, débit) dans une transaction verrouillée
 *     et pose l'UNIQUE tentative ; un message déjà tenté sans résultat connu n'est JAMAIS renvoyé (`send_outcome_unknown`) ;
 *  2. `checkCanSend` (domaine) : contrôle final, juste avant l'appel ; un refus est un résultat métier (message `failed` + code, le job réussit),
 *     sauf la limite de débit (tentative libérée, job rejoué plus tard) ;
 *  3. lecture du jeton (`secret_ref`, déchiffré en mémoire) puis appel du fournisseur ;
 *  4. `accepted` ≠ `delivered` : seul l'événement du fournisseur (J32) fera passer le message à `delivered`.
 * Résultat inconnu (aucune réponse) : message `failed` / `send_outcome_unknown`, jamais renvoyé automatiquement. Aucun corps, adresse ni jeton
 * n'est journalisé : seuls des codes courts sortent d'ici.
 */
export type SendDeps = { gateway: SendGateway; readSecret: SecretReader; provider: EmailProvider };

export function createSendMessageHandler(deps: SendDeps): JobHandler {
  return defineHandler({
    kind: "send_message",
    schema: z.object({ message_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      const org = ctx.organizationId;
      const messageId = payload.message_id;
      const { gateway } = deps;
      const claim = await gateway.claim(org, messageId);
      if (claim.status === "missing" || claim.status === "not_queued") return;
      if (claim.status === "in_progress") {
        // un autre worker a posé la tentative il y a moins de 5 minutes : on ne la déclare pas « inconnue » tout de suite
        if (ctx.attempt < ctx.maxAttempts) throw new Error("send_in_progress");
        return;
      }
      if (claim.status === "ambiguous") {
        await gateway.markFailed(org, messageId, "send_outcome_unknown");
        return;
      }
      // à partir d'ici la tentative est posée : toute sortie anticipée la libère (essai sûr) ou clôt le message
      if (claim.channel.type !== "email") {
        await gateway.markFailed(org, messageId, "channel_unsupported");
        return;
      }
      const check = checkCanSend({
        approved: claim.message.approved,
        approval: { validApprover: claim.message.approverValid, ageSeconds: claim.message.approvalAgeSeconds, recipientUnchanged: claim.message.recipientUnchanged },
        purpose: claim.message.purpose,
        organizationActive: claim.organizationActive,
        organizationSendPaused: claim.organizationSendPaused,
        channel: { status: claim.channel.status, sendPaused: claim.channel.sendPaused, integrationStatus: claim.channel.integrationStatus },
        recipient: claim.contact.email,
        doNotContact: claim.contact.doNotContact,
        suppressed: claim.suppressed,
        consent: claim.consent,
        template: { required: false, approved: false },
        rate: { sentInWindow: claim.sentLastHour, limit: EMAIL_SENDS_PER_HOUR },
      });
      if (!check.ok) {
        if (isRetryableRefusal(check.reason) && ctx.attempt < ctx.maxAttempts) {
          await gateway.releaseClaim(org, messageId);
          throw new Error(check.reason);
        }
        await gateway.markFailed(org, messageId, `refused_${check.reason}`.slice(0, 40));
        return;
      }

      let secret: string | null;
      try {
        secret = await deps.readSecret(org, claim.channel.integrationId);
      } catch (error) {
        await bestEffort(() => gateway.releaseClaim(org, messageId));
        throw error;
      }
      if (secret === null) {
        await gateway.markFailed(org, messageId, "no_credentials");
        return;
      }
      if (ctx.signal.aborted) {
        await bestEffort(() => gateway.releaseClaim(org, messageId));
        throw new Error("aborted");
      }

      // juste avant l'appel : aucun autre accès base entre le contrôle final et le fournisseur
      const outcome = await deps.provider.send(
        {
          from: claim.channel.sender, to: claim.contact.email as string, subject: deriveEmailSubject(claim.message.body), textBody: claim.message.body,
          metadata: { fusion_message_id: messageId },
        },
        secret,
      );
      switch (outcome.kind) {
        case "accepted":
          await markAcceptedWithRetry(gateway, org, messageId, outcome.providerMessageId);
          return;
        case "rejected":
          await gateway.markFailed(org, messageId, outcome.code);
          return;
        case "retryable":
          if (ctx.attempt >= ctx.maxAttempts) {
            await gateway.markFailed(org, messageId, outcome.code);
            return;
          }
          await gateway.releaseClaim(org, messageId);
          throw new Error(outcome.code);
        case "unknown":
          await gateway.markFailed(org, messageId, "send_outcome_unknown");
          return;
      }
    },
  });
}

/** Le fournisseur a accepté : l'enregistrement ne doit pas se perdre sur une panne brève (sinon le message serait déclaré « résultat inconnu »). */
async function markAcceptedWithRetry(gateway: SendGateway, org: string, messageId: string, providerMessageId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await gateway.markAccepted(org, messageId, providerMessageId);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw lastError;
}

export type RegistryDeps = {
  assigner: LeadAssigner;
  imports: ImportGateway;
  crm: CrmSyncGateway;
  webhooks: { gateway: WebhookGateway; processors: WebhookProcessors };
  send: SendDeps;
};

export function createDefaultRegistry(deps: RegistryDeps): HandlerRegistry {
  return new HandlerRegistry()
    .register(noopHandler)
    .register(createLeadAssignHandler(deps.assigner))
    .register(createImportCsvHandler(deps.imports))
    .register(createCrmSyncHandler(deps.crm))
    .register(createProcessWebhookHandler(deps.webhooks.gateway, deps.webhooks.processors))
    .register(createSendMessageHandler(deps.send));
}
