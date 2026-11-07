import { beforeEach, vi } from "vitest";

/*
 * Les lignes de journal structurées attendues (service_failure, org_create_failed...) polluent la sortie
 * des tests. On les neutralise AVANT chaque test (un `vi.restoreAllMocks()` d'un test ne laisse donc pas
 * la console réelle pour les suivants). Un test qui veut vérifier la forme d'une ligne installe son propre
 * espion (`vi.spyOn(console, "warn")`) : il remplace celui-ci et reste libre de ses assertions.
 */
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
