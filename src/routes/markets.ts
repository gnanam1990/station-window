import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireRole } from "../auth.ts";
import { badRequest } from "../core/errors.ts";
import {
  createBinding,
  getMarket,
  importCard,
  listMarkets,
  verifyBinding,
  type BindingInput,
  type MarketCard,
} from "../modules/markets.ts";
import { checkDispatchEligibility } from "../modules/gate.ts";

export function registerMarketRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get("/api/markets", async (req) => {
    requireRole(req.ctx, "auditor");
    return { items: await listMarkets(db, req.ctx) };
  });

  app.post("/api/markets/import", async (req) => {
    requireRole(req.ctx, "editor");
    const body = req.body as { card?: MarketCard };
    if (!body.card) throw badRequest("body.card required");
    const out = await importCard(db, req.ctx, body.card);
    return { ...out, importedAt: req.ctx.clock.now().toISOString() };
  });

  app.get("/api/markets/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getMarket(db, req.ctx, id);
  });

  app.post("/api/markets/:id/bindings", async (req) => {
    requireRole(req.ctx, "editor");
    const { id } = req.params as { id: string };
    return createBinding(db, req.ctx, id, (req.body ?? {}) as BindingInput);
  });

  app.post("/api/bindings/:id/verify", async (req) => {
    requireRole(req.ctx, "editor");
    const { id } = req.params as { id: string };
    return verifyBinding(db, req.ctx, id);
  });

  // Read-only eligibility preview — same guard the outbox worker runs before sending.
  app.post("/api/dispatch-check", async (req) => {
    requireRole(req.ctx, "auditor");
    const body = (req.body ?? {}) as { marketVersionId?: string; bindingId?: string };
    return checkDispatchEligibility(db, req.ctx, body);
  });
}
