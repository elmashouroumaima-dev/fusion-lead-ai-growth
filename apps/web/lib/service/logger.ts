import { getRequestContext } from "./request-context";

/*
 * Journal JSON maison (J12, ADR 006 « Logs ») : UNE ligne JSON par appel, sans dépendance.
 *   {ts, level, event, request_id?, organization_id?, actor_id?, ...champs expurgés}
 * debug/info -> stdout (console.debug / console.info), warn/error -> stderr (console.warn / console.error).
 * Silencieux quand NODE_ENV === "test", sauf si un test installe un récepteur (`setLogSink`).
 *
 * L'expurgation (`redact`) est faite ICI, pas par l'appelant : par NOM de clé (jetons, secrets, e-mails,
 * corps de message...) ET par VALEUR (JWT, Bearer, clés Supabase, adresses e-mail). Les erreurs sont
 * réduites à {name, code?} : leur message ou leur pile peuvent contenir un secret ou du SQL.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (level: LogLevel, line: string) => void;

export const REDACTED = "[redacted]";

/**
 * Noms de clés dont la valeur n'est jamais journalisée (insensible à la casse, correspondance partielle).
 * Les 13 premiers motifs sont IDENTIQUES à ceux de private.audit_redact (migration J12) : un test de parité
 * (logger.parity.test.ts) échoue si le SQL gagne un motif que ce regex ne couvre pas. Les trois derniers
 * (e-mail, body, invite_path) sont propres au journal applicatif.
 */
const SENSITIVE_KEY =
  /token|secret|password|passwd|hash|api[ ._-]?key|authorization|cookie|credential|jwt|private[ ._-]?key|signature|otp|e-?mail|body|invite_?path/i;

/** Noms de paramètres/champs dont la VALEUR est masquée dans une chaîne (le nom est conservé). */
const PAIR_KEYS = "access[_-]?token|refresh[_-]?token|token[_-]?hash|client[_-]?secret|x-api-key|api[_-]?key|apikey|token|password|passwd|secret|signature|code";

/** Motifs de valeurs secrètes, remplacés dans toute chaîne. Ordre : du plus spécifique au plus général. Tous linéaires. */
const SENSITIVE_VALUES: readonly (readonly [RegExp, string])[] = [
  [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED], // JWT (en-tête.charge.signature)
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED],
  [/\bBasic\s+[A-Za-z0-9+/_-]{8,}={0,2}/gi, "Basic [redacted]"], // Authorization: Basic <base64>
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]*/g, REDACTED],
  // JSON dans une chaîne : {"token":"V"} (valeur entre guillemets, espaces permis, ou valeur nue).
  [new RegExp(String.raw`("(?:${PAIR_KEYS})"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[^\s,}\]]+)`, "gi"), '$1"[redacted]"'],
  // nom<sep>valeur (query string, en-tête, JSON échappé) : séparateur ':' '=' ou '%3D'/'%3A', espaces permis.
  [new RegExp(String.raw`\b(${PAIR_KEYS})(\\?"?\s*(?::|=|%3D|%3A)\s*)(\\?"?)[^\s&",}\\]+`, "gi"), "$1$2$3[redacted]"],
  [/(?:\/|%2F)invite(?:\/|%2F)[A-Za-z0-9_-]{16,}/gi, "/invite/[redacted]"], // jeton d'invitation dans un chemin
  [/:\/\/[^\s/?#]+@/g, "://[redacted]@"], // userinfo de toute URL / chaîne de connexion (scheme://user:pw@hote)
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, REDACTED], // adresse e-mail
];

/** Plafonds : une entrée gigantesque ou profonde ne peut ni saturer la sortie ni bloquer le processus. */
const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 50;
const MAX_NODES = 500;
/** Longueur lue avant les expressions régulières (borne leur coût), puis longueur conservée en sortie. */
const MAX_SCAN_CHARS = 2000;
const MAX_STRING_CHARS = 500;
const MAX_EVENT_CHARS = 100;
const MAX_KEY_CHARS = 100;

function maskString(input: string): string {
  let value = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  for (const [pattern, replacement] of SENSITIVE_VALUES) value = value.replace(pattern, replacement);
  return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
}

/** Nom de clé affichable : masqué par valeur (ex. « token=SECRET ») puis borné à 100 caractères. */
function safeKey(key: string): string {
  return maskString(key).slice(0, MAX_KEY_CHARS);
}

type Budget = { nodes: number };

function readKeys(obj: object): string[] {
  try {
    return Object.keys(obj);
  } catch {
    return [];
  }
}

function readProp(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return REDACTED; // accesseur qui lève : on n'en dit rien
  }
}

/** Erreur -> {name, code?} UNIQUEMENT (jamais message ni pile). */
function serializeError(error: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const name = readProp(error, "name");
  out.name = typeof name === "string" ? maskString(name).slice(0, 64) : "Error";
  const code = readProp(error, "code");
  if (typeof code === "string") out.code = maskString(code).slice(0, 64);
  else if (typeof code === "number" && Number.isFinite(code)) out.code = code;
  return out;
}

/** Objet « comme une erreur » (ex. erreur PostgREST) : chaîne `message` ET (`name` chaîne OU `code` chaîne/nombre). */
function isErrorLike(obj: object): boolean {
  if (typeof readProp(obj, "message") !== "string") return false;
  const code = readProp(obj, "code");
  return typeof readProp(obj, "name") === "string" || typeof code === "string" || typeof code === "number";
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>, budget: Budget): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return maskString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
    case "function":
      return `[${typeof value}]`;
    default:
      break;
  }

  const obj = value as object;
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return "[truncated]";
  if (ancestors.has(obj)) return "[circular]";
  if (obj instanceof Error || (!Array.isArray(obj) && isErrorLike(obj))) return serializeError(obj);
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "[invalid-date]" : obj.toISOString();
  if (depth >= MAX_DEPTH) return "[max-depth]";

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1, ancestors, budget));
      if (obj.length > MAX_ARRAY_ITEMS) items.push(`[+${obj.length - MAX_ARRAY_ITEMS} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    const keys = readKeys(obj);
    for (const key of keys.slice(0, MAX_KEYS)) {
      out[safeKey(key)] = SENSITIVE_KEY.test(key) ? REDACTED : walk(readProp(obj, key), depth + 1, ancestors, budget);
    }
    if (keys.length > MAX_KEYS) out["[truncated_keys]"] = keys.length - MAX_KEYS;
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/** Expurge une valeur arbitraire (clés sensibles, valeurs secrètes, erreurs, cycles, tailles). Ne lève jamais. */
export function redact(value: unknown): unknown {
  try {
    return walk(value, 0, new WeakSet<object>(), { nodes: 0 });
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------

let sink: LogSink | null = null;

/** Installe (ou retire, avec `null`) un récepteur de lignes. Sert aux tests ; actif même sous NODE_ENV=test. */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function emit(level: LogLevel, line: string): void {
  if (sink) {
    sink(level, line);
    return;
  }
  if (process.env.NODE_ENV === "test") return;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "info") console.info(line);
  else console.debug(line);
}

export type LogFields = Record<string, unknown>;
export type Logger = {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

const RESERVED = new Set(["ts", "level", "event"]);
/**
 * Champs posés UNIQUEMENT par le contexte de requête (serveur). Un appelant ne peut pas les fixer : sa valeur
 * (non nulle) est déplacée vers client_* (jamais fiable), une valeur null/undefined est ignorée.
 */
const CONTEXT_KEYS = { request_id: "client_request_id", organization_id: "client_organization_id", actor_id: "client_actor_id" } as const;

function buildLine(level: LogLevel, event: string, base: LogFields | undefined, fields: LogFields | undefined): string {
  const ctx = getRequestContext();
  const merged: Record<string, unknown> = {
    ...(ctx?.requestId ? { request_id: ctx.requestId } : {}),
    ...(ctx?.organizationId ? { organization_id: ctx.organizationId } : {}),
    ...(ctx?.actorId ? { actor_id: ctx.actorId } : {}),
  };
  const moved: Record<string, unknown> = {};
  for (const source of [base, fields]) {
    if (!source) continue;
    const safe = redact(source);
    if (typeof safe !== "object" || safe === null || Array.isArray(safe)) continue;
    for (const [key, val] of Object.entries(safe)) {
      if (RESERVED.has(key)) continue;
      if (Object.hasOwn(CONTEXT_KEYS, key)) {
        if (val !== null && val !== undefined) moved[CONTEXT_KEYS[key as keyof typeof CONTEXT_KEYS]] = val;
        continue;
      }
      merged[key] = val;
    }
  }
  for (const [key, val] of Object.entries(moved)) if (merged[key] === undefined) merged[key] = val;
  const record = { ts: new Date().toISOString(), level, event: maskString(String(event)).slice(0, MAX_EVENT_CHARS), ...merged };
  // U+2028 / U+2029 : valides en JSON mais coupent une ligne pour certains lecteurs de journaux.
  return JSON.stringify(record).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Ne lève jamais : un échec de journalisation ne doit pas casser une requête. */
function write(level: LogLevel, event: string, base: LogFields | undefined, fields: LogFields | undefined): void {
  try {
    emit(level, buildLine(level, event, base, fields));
  } catch {
    try {
      emit(level, JSON.stringify({ ts: new Date().toISOString(), level, event: "log_failed" }));
    } catch {
      // rien d'autre à faire
    }
  }
}

export function createLogger(options: { base?: LogFields } = {}): Logger {
  const { base } = options;
  return {
    debug: (event, fields) => write("debug", event, base, fields),
    info: (event, fields) => write("info", event, base, fields),
    warn: (event, fields) => write("warn", event, base, fields),
    error: (event, fields) => write("error", event, base, fields),
  };
}

/** Journal par défaut de apps/web. */
export const logger: Logger = createLogger();
