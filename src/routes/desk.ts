import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  deskBindingDetail, deskInbox, deskQueue, deskReceipts,
} from "../modules/projections.ts";

/** Server projections backing the analyst workbench (M08). */
export function registerDeskRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/desk/inbox", async (req) => deskInbox(pool, req.ctx));
  app.get("/api/desk/bindings/:id", async (req) =>
    deskBindingDetail(pool, req.ctx, (req.params as { id: string }).id));
  app.get("/api/desk/queue", async (req) => deskQueue(pool, req.ctx));
  app.get("/api/desk/receipts", async (req) => deskReceipts(pool, req.ctx));
}
