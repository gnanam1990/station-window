/**
 * Station Window worker entry. Roles via SW_WORKER_ROLES (comma list):
 *   ingest   - poll permitted source releases
 *   outbox   - lease and send queued dispatches
 *   poll     - poll remote judgment / bounty state
 *   research - rank candidate changes and draft notes
 * Example: SW_WORKER_ROLES=ingest,outbox,poll npm run worker
 */
import { loadConfig } from "./config.ts";
import { clockFromEnv } from "./core/clock.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { runWorkerLoop } from "./worker/loop.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
const clock = clockFromEnv();
const roles = (process.env.SW_WORKER_ROLES ?? "ingest,outbox,poll,research,reconcile")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const stop = await runWorkerLoop({ pool, clock, config, roles, workerId: `w-${process.pid}` });
console.log(`station-window worker roles=${roles.join(",")} pid=${process.pid}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void stop().then(() => pool.end()).then(() => process.exit(0));
  });
}
