import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { badRequest } from "../core/errors.ts";
import {
  approveCandidate, assertApprovalSendable, editCandidate, getCandidate,
  listCandidates, reviewCandidate, runResearch, type Claim,
} from "../modules/research.ts";

export function registerResearchRoutes(app: FastifyInstance, db: pg.Pool) {
  app.post("/api/research/run", async (req) => {
    const body = (req.body ?? {}) as {
      ruleBindingId?: string; evaluationId?: string; proposedClaims?: Claim[];
    };
    if (!body.ruleBindingId) throw badRequest("ruleBindingId required");
    return runResearch(db, req.ctx, body as { ruleBindingId: string; proposedClaims?: Claim[] });
  });

  app.get("/api/candidates", async (req) => {
    const q = req.query as { ruleBindingId?: string };
    return { items: await listCandidates(db, req.ctx, q.ruleBindingId) };
  });

  app.get("/api/candidates/:id", async (req) =>
    getCandidate(db, req.ctx, (req.params as { id: string }).id));

  app.post("/api/candidates/:id/submit", async (req) =>
    reviewCandidate(db, req.ctx, (req.params as { id: string }).id, "submit_review"));

  app.post("/api/candidates/:id/approve", async (req) =>
    approveCandidate(db, req.ctx, (req.params as { id: string }).id));

  app.post("/api/candidates/:id/reject", async (req) =>
    reviewCandidate(db, req.ctx, (req.params as { id: string }).id, "reject"));

  app.post("/api/candidates/:id/request-correction", async (req) =>
    reviewCandidate(db, req.ctx, (req.params as { id: string }).id, "request_correction"));

  app.post("/api/candidates/:id/edit", async (req) => {
    const body = (req.body ?? {}) as { noteText?: string; citationSet?: unknown[] };
    return editCandidate(db, req.ctx, (req.params as { id: string }).id, {
      noteText: body.noteText,
      citationSet: body.citationSet as { url: string; locator: string; digest: string }[] | undefined,
    });
  });

  // used by tests and by the M07 outbox door — "is this approval still sendable?"
  app.get("/api/approvals/:id/sendable", async (req) => {
    const a = await assertApprovalSendable(db, req.ctx, (req.params as { id: string }).id);
    return { sendable: true, approvalId: a.id, noteDigest: a.note_digest };
  });
}
