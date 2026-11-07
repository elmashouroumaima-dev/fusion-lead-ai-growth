import { setLogSink, type LogLevel } from "./logger";

/** Aide de test : capture les lignes du logger (récepteur installé le temps du test). Jamais importée par le code de production. */
export type CapturedLog = { level: LogLevel; line: string };

export function captureLogs(): { logs: CapturedLog[]; lines: (level?: LogLevel) => string[]; parsed: (level?: LogLevel) => Record<string, unknown>[]; stop: () => void } {
  const logs: CapturedLog[] = [];
  setLogSink((level, line) => {
    logs.push({ level, line });
  });
  const lines = (level?: LogLevel) => logs.filter((l) => level === undefined || l.level === level).map((l) => l.line);
  return {
    logs,
    lines,
    parsed: (level) => lines(level).map((l) => JSON.parse(l) as Record<string, unknown>),
    stop: () => setLogSink(null),
  };
}
