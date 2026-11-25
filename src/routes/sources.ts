import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireRole, requireWorker } from "../auth.ts";
import { badRequest, notFound } from "../core/errors.ts";
import {
  adapterCapabilities,
  listSourcePolicies,
  listStations,
  registerSourcePolicy,
  updateSourcePermissions,
  type SourcePolicyInput,
} from "../modules/sources.ts";
import { ingestSource } from "../modules/ingest.ts";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";

export function registerSourceRoutes(app: FastifyInstance, db: pg.Pool, config: AppConfig, clock: Clock) {
  app.get("/api/stations", async (req) => {
    const { q } = req.query as { q?: string };
    return { items: await listStations(db, req.ctx, q) };
  });

  app.get("/api/sources", async (req) => ({ items: await listSourcePolicies(db, req.ctx) }));

  app.post("/api/sources", async (req) => {
    requireRole(req.ctx, "editor");
    return registerSourcePolicy(db, req.ctx, (req.body ?? {}) as SourcePolicyInput);
  });

  app.patch("/api/sources/:id", async (req) => {
    requireRole(req.ctx, "editor");
    const { id } = req.params as { id: string };
    return updateSourcePermissions(db, req.ctx, id, (req.body ?? {}) as never);
  });

  app.get("/api/sources/adapters", async (req) => {
    const { provider } = req.query as { provider?: string };
    if (!provider)
      return { items: [adapterCapabilities("ndbc-realtime2"), adapterCapabilities("training-synthetic")] };
    return adapterCapabilities(provider);
  });

  app.post("/api/observations/import", async (req) => {
    requireWorker(req.ctx);
    const body = (req.body ?? {}) as { sourcePolicyId?: string; content?: string };
    if (!body.sourcePolicyId) throw badRequest("sourcePolicyId required");
    return ingestSource(db, config, clock, body.sourcePolicyId, { content: body.content });
  });

  app.get("/api/observations", async (req) => {
    const q = req.query as { stationId?: string; variable?: string; asOf?: string; latestOnly?: string };
    const params: unknown[] = [req.ctx.deskId];
    let sql = `SELECT o.*, s.external_id AS station_external_id, s.authority
               FROM observations o JOIN stations s ON s.id=o.station_id
               WHERE o.desk_id=$1`;
    if (q.stationId) {
      params.push(q.stationId);
      sql += ` AND o.station_id=$${params.length}`;
    }
    if (q.variable) {
      params.push(q.variable);
      sql += ` AND o.variable=$${params.length}`;
    }
    if (q.asOf) {
      params.push(new Date(q.asOf));
      sql += ` AND o.first_seen_at <= $${params.length}`; // desk-known replay boundary (INV-04)
    }
    sql += " ORDER BY o.observed_at, o.seq";
    const { rows } = await db.query(sql, params);
    return { items: rows, asOf: q.asOf ?? req.ctx.clock.now().toISOString() };
  });

  app.get("/api/snapshots/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await db.query(
      `SELECT sn.id, sn.url, sn.fetched_at, sn.digest, sn.byte_length, sn.redacted, sn.http_status,
              sn.parser_version, sp.can_retain, sp.can_export
       FROM snapshots sn JOIN source_policies sp ON sp.id=sn.source_policy_id
       WHERE sn.id=$1 AND sn.desk_id=$2`,
      [id, req.ctx.deskId],
    );
    if (rows.length === 0) throw notFound("snapshot");
    const s = rows[0];
    let content: string | null = null;
    if (s.can_export && !s.redacted) {
      const c = await db.query("SELECT content FROM snapshots WHERE id=$1", [id]);
      content = c.rows[0].content ? Buffer.from(c.rows[0].content).toString("utf8") : null;
    }
    return { ...s, content };
  });
}
