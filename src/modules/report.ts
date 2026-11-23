/**
 * M10 integration report (T-029/T-030): machine-readable versions, times and
 * outcomes for one desk. Deliberately redacted — no API keys, session tokens,
 * draft note prose or raw source bytes. Live-competition evidence is a
 * separate gated block: a local/fixture run is never labelled live (INV-10).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { RequestContext } from "../auth.ts";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import { forbidden } from "../core/errors.ts";
import { NDBC_PARSER_VERSION } from "./ndbc.ts";
import { resolveTransport } from "./outbox.ts";

function pkgVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function sdkVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(
      join(process.cwd(), "node_modules/@gensyn-ai/gensyn-delphi-sdk/package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Exact external dependencies still missing for a live competition proof. */
export function liveProofStatus(config: AppConfig) {
  const missing: string[] = [];
  if (config.mode !== "competition") missing.push("SW_MODE=competition deployment");
  if (!config.liveSubmissionsEnabled) missing.push("SW_LIVE_SUBMISSIONS=yes opt-in");
  if (!config.delphiBaseUrl) missing.push("DELPHI_BASE_URL evidence API endpoint");
  if (!config.delphiApiKey) missing.push("DELPHI_API_KEY authorized account credential");
  if (!resolveTransport(config)) missing.push("live Delphi transport (SDK client not established)");
  // even fully configured, the proof needs an eligible current market card —
  // asserted at run time, listed here so BLOCKED never looks like a code gap
  missing.push("authorized account + eligible current competition market card (external authority)");
  return missing.length === 1 && missing[0]?.startsWith("authorized account")
    ? { status: "ready_except_market", missing }
    : { status: "blocked", missing };
}

export async function integrationReport(
  pool: pg.Pool, ctx: RequestContext, config: AppConfig, clock: Clock,
) {
  if (ctx.role !== "auditor") throw forbidden("auditor_only", "integration report is auditor-scoped");
  const deskId = ctx.deskId;
  const { rows: mig } = await pool.query(
    "SELECT max(version) AS latest, count(*)::int AS applied FROM schema_migrations");

  const counts = async (q: string) =>
    (await pool.query(q, [deskId])).rows as Record<string, unknown>[];

  const byState = (rows: Record<string, unknown>[], col: string) =>
    Object.fromEntries(rows.map((r) => [r[col], Number(r.n)]));

  const [snapByClass, obs, evals, cand, appr, intents, remote, recon] = await Promise.all([
    counts("SELECT evidence_class, count(*)::int AS n FROM snapshots WHERE desk_id=$1 GROUP BY evidence_class"),
    counts(`SELECT variable, count(*)::int AS n, min(observed_at) AS earliest, max(observed_at) AS latest
            FROM observations WHERE desk_id=$1 GROUP BY variable`),
    counts("SELECT count(*)::int AS n, max(created_at) AS latest FROM evaluations WHERE desk_id=$1"),
    counts("SELECT status, count(*)::int AS n FROM candidates WHERE desk_id=$1 GROUP BY status"),
    counts("SELECT status, count(*)::int AS n FROM approvals WHERE desk_id=$1 GROUP BY status"),
    counts("SELECT state, count(*)::int AS n FROM intents WHERE desk_id=$1 GROUP BY state"),
    counts("SELECT remote_status, count(*)::int AS n FROM rewards WHERE desk_id=$1 GROUP BY remote_status"),
    counts(`SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
            FROM reconciliation_cases WHERE desk_id=$1`),
  ]);

  const live = liveProofStatus(config);
  return {
    format: "station-window-integration-report",
    version: 1,
    generatedAt: clock.now().toISOString(),
    desk: { id: deskId, slug: ctx.deskSlug },
    versions: {
      app: pkgVersion(),
      node: process.version,
      schema: mig[0]?.latest != null ? String(mig[0].latest).padStart(4, "0") : "none",
      migrationsApplied: mig[0]?.applied ?? 0,
      ndbcParser: NDBC_PARSER_VERSION,
      delphiSdk: sdkVersion(),
      deploymentMode: config.mode,
    },
    times: {
      generatedAt: clock.now().toISOString(),
      observationRange: {
        earliest: obs.map((o) => (o.earliest as Date).toISOString()).sort()[0] ?? null,
        latest: obs.map((o) => (o.latest as Date).toISOString()).sort().at(-1) ?? null,
      },
      lastEvaluationAt: evals[0]?.latest ?? null,
    },
    outcomes: {
      snapshotsByEvidenceClass: byState(snapByClass, "evidence_class"),
      observations: {
        total: obs.reduce((a, o) => a + Number(o.n), 0),
        byVariable: Object.fromEntries(obs.map((o) => [o.variable, Number(o.n)])),
      },
      evaluations: Number(evals[0]?.n ?? 0),
      candidates: byState(cand, "status"),
      approvals: byState(appr, "status"),
      intents: byState(intents, "state"),
      remoteJudgments: byState(remote, "remote_status"),
      reconciliation: { open: Number(recon[0]?.open ?? 0), total: Number(recon[0]?.total ?? 0) },
    },
    evidence: {
      // INV-10: fixture/local runs are evidence of code, never of competition
      historicalReplay: {
        class: "historical_replay",
        snapshots: Number(snapByClass.find((s) => s.evidence_class === "historical_replay")?.n ?? 0),
      },
      liveCapture: {
        class: "live",
        snapshots: Number(snapByClass.find((s) => s.evidence_class === "live")?.n ?? 0),
      },
      liveCompetition: live.status === "blocked"
        ? {
            status: "BLOCKED",
            missing: live.missing,
            note: "no authorized account/credential or eligible card configured — "
              + "fixture and replay evidence above is NOT a live judgment",
          }
        : { status: live.status, missing: live.missing },
    },
    redaction: "no API keys, session tokens, draft note prose or raw source bytes are included",
  };
}
