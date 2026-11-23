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

/** Cooperative worker loop. Each role's tick fn is loaded lazily so missing modules don't block others. */
export async function runWorkerLoop(deps: WorkerDeps): Promise<() => Promise<void>> {
  const interval = deps.intervalMs ?? 10_000;
  let stopped = false;
  const tickers: Record<string, () => Promise<void>> = {};

  for (const role of deps.roles) {
    try {
      if (role === "ingest") {
        const m = await import("../modules/ingest.ts");
        tickers.ingest = () => m.ingestTick(deps.pool, deps.config, deps.clock);
      } else if (role === "outbox") {
        const m = await import("../modules/outbox.ts");
        tickers.outbox = () => m.outboxTick(deps.pool, deps.config, deps.clock, deps.workerId);
      } else if (role === "poll") {
        const m = await import("../modules/outbox.ts");
        tickers.poll = async () => { await m.pollTick(deps.pool, deps.config, deps.clock); };
      } else if (role === "research") {
        const m = await import("../modules/research.ts");
        tickers.research = () => m.researchTick(deps.pool, deps.clock);
      } else {
        console.error(`unknown worker role: ${role}`);
      }
    } catch (err) {
      console.error(`worker role ${role} unavailable:`, (err as Error).message);
    }
  }

  const timer = setInterval(() => {
    for (const [role, fn] of Object.entries(tickers)) {
      void fn().catch((err) => console.error(`worker role ${role} tick failed:`, (err as Error).message));
    }
  }, interval);
  for (const fn of Object.values(tickers)) void fn().catch(() => {});

  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}
