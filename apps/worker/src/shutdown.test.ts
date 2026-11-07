import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { silentLogger, type Runner } from "./runner";
import { installShutdown } from "./shutdown";

const fakeRunner = (result: { timedOut: boolean; abandoned: number } | Error) => {
  const stop = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { runner: { stop } as unknown as Runner, stop };
};
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("installShutdown", () => {
  it("SIGTERM : arrêt propre puis code 0", async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const { runner, stop } = fakeRunner({ timedOut: false, abandoned: 0 });
    installShutdown({ runner, logger: silentLogger, signals, exit });
    signals.emit("SIGTERM");
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("jobs abandonnés : code 1", async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    installShutdown({ runner: fakeRunner({ timedOut: true, abandoned: 2 }).runner, logger: silentLogger, signals, exit });
    signals.emit("SIGINT");
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("erreur pendant l'arrêt : code 1", async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    installShutdown({ runner: fakeRunner(new Error("x")).runner, logger: silentLogger, signals, exit });
    signals.emit("SIGTERM");
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("un second signal ne relance pas l'arrêt", async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const { runner, stop } = fakeRunner({ timedOut: false, abandoned: 0 });
    installShutdown({ runner, logger: silentLogger, signals, exit });
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
