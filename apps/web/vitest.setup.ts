/*
 * Fichier d'amorçage Vitest (référencé par vitest.config.ts). Volontairement vide de simulacres :
 * le journal JSON (lib/service/logger.ts) est silencieux sous NODE_ENV=test, il n'y a donc plus de
 * console.warn / console.error à neutraliser globalement. Un test qui veut lire les lignes de journal
 * installe un récepteur (`captureLogs()` de lib/service/log-capture.testkit.ts).
 */
export {};
