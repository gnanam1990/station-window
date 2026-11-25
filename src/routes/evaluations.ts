import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireRole } from "../auth.ts";
import { badRequest, notFound } from "../core/errors.ts";
import { evaluate } from "../modules/evaluate.ts";

export function registerEvaluationRoutes(app: FastifyInstance, db: pg.Pool) {
  app.post("/api/evaluations", async (req) => {
    requireRole(req.ctx, "analyst");
    const body = (req.body ?? {}) as { ruleBindingId?: string; asOf?: string };
    if (!body.ruleBindingId) throw badRequest("ruleBindingId required");
    return evaluate(db, req.ctx, {
      ruleBindingId: body.ruleBindingId,
      asOf: body.asOf ? new Date(body.asOf) : undefined,
    });
  });

  app.get("/api/evaluations", async (req) => {
    const q = req.query as { ruleBindingId?: string };
    const { rows } = await db.query(
      `SELECT id, rule_binding_id, as_of, verdict, result, created_at
       FROM evaluations WHERE desk_id=$1 ${q.ruleBindingId ? "AND rule_binding_id=$2" : ""}
       ORDER BY created_at DESC LIMIT 100`,
      q.ruleBindingId ? [req.ctx.deskId, q.ruleBindingId] : [req.ctx.deskId],
    );
    return { items: rows };
  });

  app.get("/api/evaluations/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await db.query(
      "SELECT * FROM evaluations WHERE id=$1 AND desk_id=$2",
      [id, req.ctx.deskId],
    );
    if (rows.length === 0) throw notFound("evaluation");
    return rows[0];
  });
}
