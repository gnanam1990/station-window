import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import { exportDesk, doctor } from "../modules/ops.ts";
import { reconcileTick } from "../modules/recovery.ts";
import { requireWorker } from "../auth.ts";

/**
 * M09 operator surface. Backup/restore are deliberately absent: they write
 * server-side files and cross desk boundaries, so they are local CLI-only.
 * Doctor results are scoped to the authenticated desk.
 */
export function registerOpsRoutes(
  app: FastifyInstance, pool: pg.Pool, config: AppConfig, clock: Clock,
) {
  app.get("/api/ops/export", async (req) => exportDesk(pool, req.ctx));

  app.get("/api/ops/doctor", async (req) => doctor(pool, config, clock, req.ctx.deskId));

  app.post("/api/ops/reconcile", async (req) => {
    requireWorker(req.ctx);
    return reconcileTick(pool, config, clock);
  });
}
