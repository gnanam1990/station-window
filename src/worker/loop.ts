import type pg from "pg";
import type { Clock } from "../core/clock.ts";
import type { AppConfig } from "../config.ts";

export interface WorkerDeps {
  pool: pg.Pool;
  clock: Clock;
  config: AppConfig;
  roles: string[];
  workerId: string;
  intervalMs?: number;
}

/** Schedule the next role tick after its previous invocation settles. */
export async function runWorkerLoop(deps: WorkerDeps): Promise<() => Promise<void>> {
  const interval = deps.intervalMs ?? 10_000;
  const tickers: Record<string, () => Promise<unknown>> = {
    ingest: async () => (await import("../modules/ingest.ts")).ingestTick(deps.pool, deps.config, deps.clock),
    outbox: async () => (await import("../modules/outbox.ts")).outboxTick(deps.pool, deps.config, deps.clock, deps.workerId),
    poll: async () => (await import("../modules/outbox.ts")).pollTick(deps.pool, deps.config, deps.clock),
    research: async () => (await import("../modules/research.ts")).researchTick(deps.pool, deps.clock),
    reconcile: async () => (await import("../modules/recovery.ts")).reconcileTick(deps.pool, deps.config, deps.clock),
  };
  const roles = [...new Set(deps.roles)];
  for (const role of roles) {
    if (!Object.hasOwn(tickers, role)) throw new Error(`Unknown worker role: ${role}`);
  }
  if (!roles.length) throw new Error("At least one worker role is required");

  let stopped = false;
  const timers = new Map<string, NodeJS.Timeout>();
  const pending = new Map<string, Promise<void>>();
  function start(role: string) {
    if (stopped) return;
    pending.set(role, tickers[role]!()
      .catch((err: Error) => console.error(`Worker role ${role} tick failed:`, err.message))
      .then(() => {
        pending.delete(role);
        if (!stopped) timers.set(role, setTimeout(() => start(role), interval));
      }));
  }
  for (const role of roles) start(role);
  return async () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    await Promise.all([...pending.values()]);
  };
}
