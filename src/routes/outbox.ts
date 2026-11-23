import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireRole, requireWorker } from "../auth.ts";
import { badRequest, notFound } from "../core/errors.ts";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import { createIntent, dispatchTick, pollTick } from "../modules/outbox.ts";

export function registerOutboxRoutes(app: FastifyInstance, db: pg.Pool, config: AppConfig, clock: Clock) {
  app.post("/api/intents", async (req) => {
    const body = (req.body ?? {}) as { approvalId?: string; providerAccount?: string };
    if (!body.approvalId) throw badRequest("approvalId required");
    if (body.providerAccount && body.providerAccount !== config.delphiAccount) throw badRequest("provider account does not match this desk deployment");
    return createIntent(db, req.ctx, { approvalId: body.approvalId, providerAccount: config.delphiAccount });
  });

  app.get("/api/intents", async (req) => {
    const { rows } = await db.query(
      `SELECT id, approval_id, provider_account, market_address, payload_digest,
              idempotency_key, state, block_reason, created_at, updated_at
       FROM intents WHERE desk_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.ctx.deskId],
    );
    return { items: rows };
  });

  app.get("/api/intents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await db.query("SELECT * FROM intents WHERE id=$1 AND desk_id=$2", [id, req.ctx.deskId]);
    if (rows.length === 0) throw notFound("intent");
    const [attempts, receipts, rewards, cases] = await Promise.all([
      db.query("SELECT epoch, worker_id, result, http_status, started_at, finished_at FROM attempts WHERE intent_id=$1 ORDER BY epoch", [id]),
      db.query("SELECT remote_id, raw_status, observed_at FROM receipts WHERE intent_id=$1", [id]),
      db.query("SELECT * FROM rewards WHERE intent_id=$1", [id]),
      db.query("SELECT opened_at, resolved_at, resolution, detail FROM reconciliation_cases WHERE intent_id=$1", [id]),
    ]);
    return { ...rows[0], attempts: attempts.rows, receipts: receipts.rows, rewards: rewards.rows, reconciliations: cases.rows };
  });

  app.post("/api/outbox/tick", async (req) => {
    requireWorker(req.ctx);
    const body = (req.body ?? {}) as { workerId?: string; limit?: number };
    return dispatchTick(db, config, req.ctx.clock, {
      workerId: body.workerId ?? "http-worker", limit: body.limit, deskId: req.ctx.deskId,
    });
  });

  app.post("/api/outbox/poll", async (req) => {
    requireWorker(req.ctx);
    return pollTick(db, config, req.ctx.clock, { deskId: req.ctx.deskId });
  });

  app.get("/api/rewards", async (req) => {
    const { rows } = await db.query(
      `SELECT id, intent_id, market_address, remote_status, verdict, reason,
              bounty_amount_raw, bounty_currency, bounty_state, zero_pay_reason, last_poll_at
       FROM rewards WHERE desk_id=$1 ORDER BY created_at DESC`,
      [req.ctx.deskId],
    );
    return { items: rows };
  });
}
