import pg from "pg";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import { redactFetchReason, safeFetch } from "../core/safeFetch.ts";
import { sha256, uuid } from "../core/ids.ts";
import { badRequest, forbidden, notFound } from "../core/errors.ts";
import { extractVariable, parseNdbcRealtime2, NDBC_PARSER_VERSION } from "./ndbc.ts";
import { convertUnit } from "../core/units.ts";

export interface IngestResult {
  sourcePolicyId: string;
  snapshotId: string;
  snapshotDigest: string;
  fetchedAt: string;
  inserted: number;
  deduped: number;
  newVersions: number;
  quarantined: number;
  parserVersion: string;
}

const MAX_FUTURE_SKEW_MS = 24 * 3600_000; // quarantine implausible future observed times

export interface PolicyRow {
  id: string;
  desk_id: string;
  station_id: string;
  dataset: string;
  variable: string;
  endpoint_url: string;
  can_retain: boolean;
  can_browse: boolean;
  status: string;
}

export async function loadPolicy(pool: pg.Pool, policyId: string) {
  const { rows } = await pool.query<PolicyRow & { desk_slug: string }>(
    `SELECT sp.*, d.slug AS desk_slug FROM source_policies sp
     JOIN desks d ON d.id=sp.desk_id WHERE sp.id=$1`,
    [policyId],
  );
  return (rows[0] as (PolicyRow & { desk_slug: string }) | undefined) ?? null;
}

export async function ingestSource(
  pool: pg.Pool,
  config: AppConfig,
  clock: Clock,
  policyId: string,
  opts: { content?: string; fetchImpl?: typeof fetch; skipDnsCheck?: boolean } = {},
): Promise<IngestResult> {
  const p = await loadPolicy(pool, policyId);
  if (!p) throw notFound("source policy");
  if (p.status !== "active") throw forbidden("source_inactive", `source policy is ${p.status}`);
  if (!p.can_browse) throw forbidden("browse_withdrawn", "source browsing right withdrawn");

  let body: string;
  let httpStatus = 200;
  let headers: Record<string, string> = {};
  let fetchedUrl = p.endpoint_url;
  if (opts.content !== undefined) {
    if (config.mode === "competition")
      throw badRequest("inline content only permitted outside competition mode");
    body = opts.content;
    fetchedUrl = `inline://${p.dataset}`;
  } else {
    const fetched = await safeFetch(p.endpoint_url, {
      allowedHosts: [new URL(p.endpoint_url).hostname],
      maxBytes: config.fetchMaxBytes,
      timeoutMs: config.fetchTimeoutMs,
      fetchImpl: opts.fetchImpl,
      skipDnsCheck: opts.skipDnsCheck,
    });
    body = fetched.body;
    httpStatus = fetched.status;
    headers = fetched.headers;
  }
  return ingestBody(pool, clock, p, body, {
    url: fetchedUrl,
    httpStatus,
    headers,
    fetchedAt: clock.now(),
  });
}

/**
 * Persist snapshot then parse into immutable observation versions.
 * Snapshot and versions are deduplicated so a rerun after interruption is a no-op
 * or appends ordered revisions — never duplicates, never overwrites.
 */
export async function ingestBody(
  pool: pg.Pool,
  clock: Clock,
  p: PolicyRow & { desk_slug?: string },
  body: string,
  meta: { url: string; httpStatus: number; headers: Record<string, string>; fetchedAt: Date },
): Promise<IngestResult> {
  const { snapshotId, digest, parserVersion } = await persistSnapshot(pool, p, body, meta);
  const counts = await parseIntoObservations(pool, clock, p, body, meta, snapshotId, parserVersion);
  return {
    sourcePolicyId: p.id,
    snapshotId,
    snapshotDigest: digest,
    fetchedAt: meta.fetchedAt.toISOString(),
    parserVersion,
    ...counts,
  };
}

interface SnapMeta { url: string; httpStatus: number; headers: Record<string, string>; fetchedAt: Date }

/** Phase 1: durable snapshot + checkpoint. A crash after this resumes from the row. */
export async function persistSnapshot(
  pool: pg.Pool,
  p: PolicyRow & { desk_slug?: string },
  body: string,
  meta: SnapMeta,
): Promise<{ snapshotId: string; digest: string; parserVersion: string }> {
  const digest = sha256(body);
  const parserVersion = p.dataset === "realtime2" ? NDBC_PARSER_VERSION : `${p.dataset}/1`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ingest_checkpoints(source_policy_id, state, updated_at)
       VALUES ($1,'fetching',$2)
       ON CONFLICT (source_policy_id) DO UPDATE SET state='fetching', updated_at=$2`,
      [p.id, meta.fetchedAt],
    );
    const snap = await client.query(
      `INSERT INTO snapshots
         (id, desk_id, source_policy_id, url, fetched_at, digest, byte_length, content,
          redacted, http_status, parser_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (source_policy_id, digest) DO UPDATE SET digest=EXCLUDED.digest
       RETURNING id`,
      [
        uuid(), p.desk_id, p.id, meta.url, meta.fetchedAt, digest, Buffer.byteLength(body),
        p.can_retain ? Buffer.from(body) : null, !p.can_retain, meta.httpStatus, parserVersion,
      ],
    );
    const snapshotId = snap.rows[0].id as string;
    await client.query(
      "UPDATE ingest_checkpoints SET state='parsing', last_snapshot_id=$2, updated_at=$3 WHERE source_policy_id=$1",
      [p.id, snapshotId, meta.fetchedAt],
    );
    await client.query("COMMIT");
    return { snapshotId, digest, parserVersion };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface ParseCounts { inserted: number; deduped: number; newVersions: number; quarantined: number }

/** Phase 2: parse the persisted snapshot into observation versions; safe to rerun. */
export async function parseIntoObservations(
  pool: pg.Pool,
  clock: Clock,
  p: PolicyRow & { desk_slug?: string },
  body: string,
  meta: SnapMeta,
  snapshotId: string,
  parserVersion: string,
): Promise<ParseCounts> {
  if (p.dataset !== "realtime2" && !p.dataset.startsWith("synthetic"))
    throw badRequest(`unsupported dataset ${p.dataset}`);

  const parsed =
    p.dataset === "realtime2"
      ? parseNdbcRealtime2(body)
      : parseSynthetic(body);

  let inserted = 0, deduped = 0, newVersions = 0, quarantined = 0;
  const client2 = await pool.connect();
  try {
    await client2.query("BEGIN");
    for (const row of parsed.rows) {
      const ext =
        p.dataset === "realtime2"
          ? extractVariable(row, p.variable, (parsed as { units?: Record<string, string> }).units)
          : extractSynthetic(row, p.variable);
      if (!ext) continue;
      const quarantine =
        row.observedAt.getTime() > meta.fetchedAt.getTime() + MAX_FUTURE_SKEW_MS;
      const canonical =
        ext.valueNum !== null ? convertUnit(ext.valueNum, ext.unit, ext.canonicalUnit) : null;
      const rowDigest = sha256(`${p.desk_id}|${p.station_id}|${p.dataset}|${p.variable}|${row.observedAt.toISOString()}|${ext.valueText}`);
      const officialFinal = (row as { officialFinal?: boolean }).officialFinal === true;
      const publishedAt = (row as { publishedAt?: Date | null }).publishedAt ?? null;
      const latest = await client2.query(
        `SELECT id, seq, value_num, body_digest, is_official_final, published_at FROM observations
         WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4 AND observed_at=$5
         ORDER BY seq DESC LIMIT 1`,
        [p.desk_id, p.station_id, p.dataset, p.variable, row.observedAt],
      );
      if (latest.rows.length > 0) {
        const prev = latest.rows[0];
        const sameValue =
          (prev.value_num === null && ext.valueNum === null) ||
          (prev.value_num !== null && ext.valueNum !== null && String(prev.value_num) === ext.valueNum);
        const sameFlags =
          Boolean(prev.is_official_final) === officialFinal &&
          (prev.published_at === null ? null : new Date(prev.published_at).toISOString()) ===
            (publishedAt === null ? null : publishedAt.toISOString());
        if (sameValue && prev.body_digest === rowDigest && !quarantine && sameFlags) {
          // identical re-ingest → value no-op, but a different policy is a new
          // citation path for the same bytes (mirror provenance)
          await client2.query(
            `INSERT INTO observation_sources(id, desk_id, observation_id, source_policy_id, snapshot_id, endpoint_url, line_locator, first_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (observation_id, source_policy_id) DO NOTHING`,
            [uuid(), p.desk_id, prev.id, p.id, snapshotId, p.endpoint_url, row.lineLocator, meta.fetchedAt],
          );
          deduped++;
          continue;
        }
        // changed value or changed publication state (e.g. authority declaring
        // the same value its official final) → ordered new version, original kept
        const newId = uuid();
        await client2.query(
          `INSERT INTO observations
            (id, desk_id, station_id, dataset, variable, observed_at, published_at, first_seen_at,
             value_text, value_num, unit, canonical_value, canonical_unit, quality, qc_flag,
             parser_version, snapshot_id, line_locator, body_digest, seq, supersedes,
             is_official_final, quarantined, quarantine_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
          [
            newId, p.desk_id, p.station_id, p.dataset, p.variable, row.observedAt, publishedAt,
            meta.fetchedAt, ext.valueText, ext.valueNum, ext.unit, canonical, ext.canonicalUnit,
            ext.quality, ext.qcFlag, parserVersion, snapshotId, row.lineLocator, rowDigest,
            Number(prev.seq) + 1, prev.id, officialFinal,
            quarantine, quarantine ? "future_observed_time" : null,
          ],
        );
        await client2.query(
          `INSERT INTO observation_sources(id, desk_id, observation_id, source_policy_id, snapshot_id, endpoint_url, line_locator, first_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (observation_id, source_policy_id) DO NOTHING`,
          [uuid(), p.desk_id, newId, p.id, snapshotId, p.endpoint_url, row.lineLocator, meta.fetchedAt],
        );
        newVersions++;
        if (quarantine) quarantined++;
        continue;
      }
      const newId = uuid();
      await client2.query(
        `INSERT INTO observations
          (id, desk_id, station_id, dataset, variable, observed_at, published_at, first_seen_at,
           value_text, value_num, unit, canonical_value, canonical_unit, quality, qc_flag,
           parser_version, snapshot_id, line_locator, body_digest, seq, is_official_final,
           quarantined, quarantine_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,$20,$21,$22)`,
        [
          newId, p.desk_id, p.station_id, p.dataset, p.variable, row.observedAt, publishedAt,
          meta.fetchedAt, ext.valueText, ext.valueNum, ext.unit, canonical, ext.canonicalUnit,
          ext.quality, ext.qcFlag, parserVersion, snapshotId, row.lineLocator, rowDigest,
          officialFinal, quarantine, quarantine ? "future_observed_time" : null,
        ],
      );
      await client2.query(
        `INSERT INTO observation_sources(id, desk_id, observation_id, source_policy_id, snapshot_id, endpoint_url, line_locator, first_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (observation_id, source_policy_id) DO NOTHING`,
        [uuid(), p.desk_id, newId, p.id, snapshotId, p.endpoint_url, row.lineLocator, meta.fetchedAt],
      );
      inserted++;
      if (quarantine) quarantined++;
    }
    await client2.query(
      "UPDATE ingest_checkpoints SET state='idle', last_completed_at=$2, failure_reason=NULL, updated_at=$2 WHERE source_policy_id=$1",
      [p.id, clock.now()],
    );
    await client2.query("COMMIT");
  } catch (err) {
    await client2.query("ROLLBACK").catch(() => {});
    await pool.query(
      "UPDATE ingest_checkpoints SET state='failed', failure_reason=$2, updated_at=$3 WHERE source_policy_id=$1",
      [p.id, (err as Error).message.slice(0, 200), clock.now()],
    );
    throw err;
  } finally {
    client2.release();
  }

  return { inserted, deduped, newVersions, quarantined };
}

interface SyntheticRow {
  observedAt: Date;
  fields: Record<string, string>;
  lineLocator: string;
  /** authority-declared finality + publication instant, carried as source data */
  officialFinal?: boolean;
  publishedAt?: Date | null;
}

function parseSynthetic(body: string): { rows: SyntheticRow[] } {
  // synthetic fixture format: JSON lines {observedAt, fields:{VAR:"1.2"},
  //   officialFinal?:bool, publishedAt?:iso}
  const rows: SyntheticRow[] = [];
  body.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const j = JSON.parse(t) as {
      observedAt: string; fields: Record<string, string>;
      officialFinal?: boolean; publishedAt?: string;
    };
    rows.push({
      observedAt: new Date(j.observedAt), fields: j.fields, lineLocator: `line:${i + 1}`,
      officialFinal: j.officialFinal === true,
      publishedAt: j.publishedAt ? new Date(j.publishedAt) : null,
    });
  });
  return { rows };
}

function extractSynthetic(row: SyntheticRow, variable: string) {
  const raw = row.fields[variable];
  if (raw === undefined || raw === "MM" || raw === "")
    return { valueText: raw ?? "MM", valueNum: null, unit: "degC", canonicalUnit: "degC", quality: "missing" as const, qcFlag: null };
  if (!/^[+-]?\d+(\.\d+)?$/.test(raw))
    return { valueText: raw, valueNum: null, unit: "degC", canonicalUnit: "degC", quality: "bad" as const, qcFlag: "non_numeric" };
  return { valueText: raw, valueNum: raw, unit: "degC", canonicalUnit: "degC", quality: "good" as const, qcFlag: null };
}

/** Poll due source policies; record redacted connector health. */
export async function ingestTick(pool: pg.Pool, config: AppConfig, clock: Clock): Promise<void> {
  const { rows } = await pool.query(
    `SELECT sp.id, sp.desk_id, sp.cadence_seconds,
            c.last_completed_at, s.external_id
     FROM source_policies sp
     JOIN stations s ON s.id=sp.station_id
     LEFT JOIN ingest_checkpoints c ON c.source_policy_id=sp.id
     WHERE sp.status='active' AND sp.can_browse
       AND (c.last_completed_at IS NULL OR c.last_completed_at + (sp.cadence_seconds||' seconds')::interval <= $1)`,
    [clock.now()],
  );
  for (const r of rows) {
    const t0 = Date.now();
    try {
      await ingestSource(pool, config, clock, r.id as string);
      await pool.query(
        `INSERT INTO connector_health(id, desk_id, source_policy_id, checked_at, ok, latency_ms)
         VALUES ($5,$1,$2,$3,true,$4)`,
        [r.desk_id, r.id, clock.now(), Date.now() - t0, uuid()],
      );
    } catch (err) {
      await pool.query(
        `INSERT INTO connector_health(id, desk_id, source_policy_id, checked_at, ok, latency_ms, detail)
         VALUES ($6,$1,$2,$3,false,$4,$5)`,
        [r.desk_id, r.id, clock.now(), Date.now() - t0, JSON.stringify({ reason: redactFetchReason(err) }), uuid()],
      );
    }
  }
}
