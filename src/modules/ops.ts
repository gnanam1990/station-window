/**
 * M09 operations: redacted audit export, desk backup/restore, and a doctor
 * report of connector lag, clock skew, outbox age and quota exhaustion.
 * Exports never carry secrets (key hashes, session tokens) or source bytes a
 * policy forbids exporting (T-027); the doctor never emits draft notes (NFR-09).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type pg from "pg";
import type { RequestContext } from "../auth.ts";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import { conflict, forbidden, notFound } from "../core/errors.ts";
import { uuid } from "../core/ids.ts";

type Db = Pick<pg.Pool, "query">;

// desk-scoped tables in FK-safe export order (child rows reference earlier ids)
const DESK_TABLES: {
  table: string;
  /** false → table has no desk_id column; `select` scopes it through a parent */
  deskColumn?: boolean;
  select?: string;
  /** columns omitted on restore insert (e.g. GENERATED ALWAYS identities) */
  skipInsertColumns?: string[];
  redact?: (row: Record<string, unknown>) => Record<string, unknown>;
}[] = [
  { table: "desk_settings" },
  { table: "market_versions" },
  {
    table: "stations", deskColumn: false,
    // stations a desk uses include unbound source stations — referenced by a
    // source policy or observations only, never by a rule binding
    select: `SELECT DISTINCT s.* FROM stations s WHERE s.id IN (
               SELECT station_id FROM rule_bindings WHERE desk_id=$1 AND station_id IS NOT NULL
               UNION SELECT station_id FROM source_policies WHERE desk_id=$1
               UNION SELECT station_id FROM observations WHERE desk_id=$1)`,
  },
  {
    table: "station_aliases", deskColumn: false,
    select: `SELECT sa.* FROM station_aliases sa WHERE sa.station_id IN (
               SELECT station_id FROM rule_bindings WHERE desk_id=$1 AND station_id IS NOT NULL
               UNION SELECT station_id FROM source_policies WHERE desk_id=$1
               UNION SELECT station_id FROM observations WHERE desk_id=$1)`,
  },
  { table: "rule_bindings" },
  { table: "source_policies" },
  { table: "snapshots" }, // byte handling lives in exportDesk (policy-selective)
  { table: "observations" },
  { table: "observation_sources" },
  {
    table: "ingest_checkpoints", deskColumn: false,
    select: `SELECT cp.* FROM ingest_checkpoints cp
             JOIN source_policies sp ON sp.id=cp.source_policy_id WHERE sp.desk_id=$1`,
  },
  { table: "connector_health" },
  { table: "provider_quota" },
  { table: "evaluations" },
  {
    table: "candidates",
    // audit needs identity+status, not the draft prose — digests still verify bytes
    redact: (r) => ({ ...r, note_text: undefined, note_text_sha: r.note_digest }),
  },
  { table: "review_events" },
  { table: "approvals" },
  { table: "intents" },
  { table: "attempts" },
  { table: "receipts" },
  { table: "quota_reservations" },
  { table: "rewards" },
  {
    table: "reward_history", deskColumn: false, skipInsertColumns: ["id"],
    select: `SELECT rh.* FROM reward_history rh
             JOIN rewards r ON r.id=rh.reward_id WHERE r.desk_id=$1`,
  },
  {
    table: "retry_schedule", deskColumn: false,
    select: `SELECT rs.* FROM retry_schedule rs
             JOIN intents i ON i.id=rs.intent_id WHERE i.desk_id=$1`,
  },
  { table: "reconciliation_cases" },
  { table: "audit_log", skipInsertColumns: ["id"] }, // identity re-assigns on restore
];

// tables wiped+rewritten by restoreDesk; sessions carry token material and are
// never backed up — they're wiped separately, never restored
const GLOBAL_JOINED = new Set(
  ["stations", "station_aliases", "reward_history", "retry_schedule", "ingest_checkpoints"]);
const DESK_SCOPED = DESK_TABLES.map((t) => t.table).filter((t) => !GLOBAL_JOINED.has(t));

async function deskBySlug(db: Db, slug: string) {
  const { rows } = await db.query("SELECT * FROM desks WHERE slug=$1", [slug]);
  if (rows.length === 0) throw notFound(`desk ${slug}`);
  return rows[0] as Record<string, unknown>;
}

/** Redacted, desk-scoped audit export (auditor role only — not a rank check). */
export async function exportDesk(pool: pg.Pool, ctx: RequestContext) {
  // ROLE_RANK puts auditor at the bottom, so requireRole would admit everyone;
  // the export carries desk internals and is deliberately auditor-only
  if (ctx.role !== "auditor") throw forbidden("auditor_only", "An auditor credential is required to export this desk.");
  const desk = (await pool.query("SELECT * FROM desks WHERE id=$1", [ctx.deskId]))
    .rows[0] as Record<string, unknown>;
  // which source policies forbid exporting their raw bytes?
  const { rows: noExport } = await pool.query(
    "SELECT id, endpoint_url FROM source_policies WHERE desk_id=$1 AND NOT can_export",
    [ctx.deskId]);
  const restrictedPolicy = new Set(noExport.map((p) => p.id as string));
  const restrictedEndpoints = noExport.map((p) => p.endpoint_url as string);

  const out: Record<string, unknown[]> = {};
  for (const { table, select, redact } of DESK_TABLES) {
    const { rows } = await pool.query(
      select ?? `SELECT * FROM ${table} WHERE desk_id=$1`, [ctx.deskId]);
    out[table] = rows.map((r) => {
      if (redact) r = redact(r);
      if (table === "snapshots") {
        // raw source bytes leave the export only where the policy granted
        // export; otherwise digest+byte_length still prove what was fetched
        const allowed = r.content != null && !restrictedPolicy.has(r.source_policy_id as string);
        r = {
          ...r,
          content: allowed ? (r.content as Buffer).toString("base64") : undefined,
          content_withheld: r.content != null && !allowed,
        };
      }
      return r;
    });
  }
  // principals, sessions and memberships are absent from DESK_TABLES entirely —
  // no key material or tokens can appear. candidate note prose is digested only.
  return {
    exportedAt: ctx.clock.now().toISOString(),
    desk: { id: desk.id, slug: desk.slug, display_name: desk.display_name },
    restrictedSourceEndpoints: restrictedEndpoints,
    tables: out,
  };
}

interface BackupFile {
  format: "station-window-backup";
  version: 1;
  exportedAt: string;
  desk: Record<string, unknown>;
  principals: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * Full desk backup (local operator/CLI path): enough to rebuild source+outbox
 * state. Reads run inside one REPEATABLE READ snapshot so concurrent writes
 * can't produce a torn backup; the file may contain credential material so it
 * is written owner-only.
 */
export async function backupDesk(pool: pg.Pool, slug: string, outFile: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const desk = await deskBySlug(client, slug);
    const deskId = desk.id as string;
    const { rows: principals } = await client.query(
      "SELECT * FROM principals WHERE desk_id=$1", [deskId]);
    const { rows: memberships } = await client.query(
      "SELECT * FROM memberships WHERE desk_id=$1", [deskId]);
    const tables: BackupFile["tables"] = {};
    for (const { table, select } of DESK_TABLES) {
      const { rows } = await client.query(
        select ?? `SELECT * FROM ${table} WHERE desk_id=$1`, [deskId]);
      tables[table] = rows.map((r) =>
        table === "snapshots" && r.content != null
          ? { ...r, content: `\\x${(r.content as Buffer).toString("hex")}` }
          : r);
    }
    const backup: BackupFile = {
      format: "station-window-backup", version: 1,
      exportedAt: new Date().toISOString(), desk, principals, memberships, tables,
    };
    await client.query("COMMIT");
    await mkdir(dirname(outFile), { recursive: true, mode: 0o700 });
    await writeFile(outFile, JSON.stringify(backup, null, 2), { mode: 0o600 });
    return {
      file: outFile,
      counts: Object.fromEntries(
        Object.entries({ principals, memberships, ...tables })
          .map(([k, v]) => [k, (v as unknown[]).length])),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Restore a desk backup verbatim (ids preserved). If the desk already exists
 * its desk-scoped rows are replaced — a deliberate operator action, so callers
 * must pass `replace: true`. Restored intents with an unresolved external
 * effect (SENT_UNKNOWN / REMOTE_KNOWN) are held and a reconciliation case is
 * opened: recovery reads remote state before classifying or resending (INV-09).
 */
export async function restoreDesk(
  pool: pg.Pool, file: string, slug?: string, opts: { replace?: boolean } = {},
) {
  const backup = JSON.parse(await readFile(file, "utf8")) as BackupFile;
  if (backup.format !== "station-window-backup" || backup.version !== 1)
    throw conflict("bad_backup", "unrecognised backup format");
  const targetSlug = slug ?? (backup.desk.slug as string);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      "SELECT id FROM desks WHERE slug=$1 OR id=$2", [targetSlug, backup.desk.id]);
    let deskId: string;
    if (existing.length > 0) {
      if (!opts.replace) {
        await client.query("ROLLBACK");
        throw conflict("desk_exists", `desk ${targetSlug} exists; pass replace to overwrite`);
      }
      deskId = existing[0].id as string;
      // sessions carry token material — wiped, never restored
      await client.query("DELETE FROM sessions WHERE desk_id=$1", [deskId]);
      // join-scoped children (no desk_id) go before their parents
      await client.query(
        "DELETE FROM retry_schedule WHERE intent_id IN (SELECT id FROM intents WHERE desk_id=$1)", [deskId]);
      await client.query(
        "DELETE FROM reward_history WHERE reward_id IN (SELECT id FROM rewards WHERE desk_id=$1)", [deskId]);
      await client.query(
        "DELETE FROM ingest_checkpoints WHERE source_policy_id IN (SELECT id FROM source_policies WHERE desk_id=$1)", [deskId]);
      // wipe desk-scoped state in reverse dependency order, keep the desk row
      for (const t of [...DESK_SCOPED].reverse())
        await client.query(`DELETE FROM ${t} WHERE desk_id=$1`, [deskId]);
      await client.query("DELETE FROM memberships WHERE desk_id=$1", [deskId]);
      await client.query("DELETE FROM principals WHERE desk_id=$1", [deskId]);
      await client.query("UPDATE desks SET slug=$2 WHERE id=$1", [deskId, targetSlug]);
    } else {
      deskId = backup.desk.id as string;
      await client.query(
        "INSERT INTO desks(id, slug, display_name, deployment_mode) VALUES ($1,$2,$3,$4)",
        [deskId, targetSlug, backup.desk.display_name, backup.desk.deployment_mode ?? "dev"]);
    }

    // stations are global — reuse the row for (authority, external_id), remap id
    const stationIdMap = new Map<string, string>();
    for (const s of backup.tables.stations ?? []) {
      const { rows: ex } = await client.query(
        "SELECT id FROM stations WHERE authority=$1 AND external_id=$2",
        [s.authority, s.external_id]);
      if (ex.length > 0) stationIdMap.set(s.id as string, ex[0].id as string);
      else {
        await client.query(
          "INSERT INTO stations(id, authority, external_id, city_label, local_zone, kind) VALUES ($1,$2,$3,$4,$5,$6)",
          [s.id, s.authority, s.external_id, s.city_label, s.local_zone, s.kind ?? "station"]);
        stationIdMap.set(s.id as string, s.id as string);
      }
    }
    const remapStation = (v: unknown) =>
      v == null ? v : stationIdMap.get(v as string) ?? v;

    for (const p of backup.principals)
      await insertRow(client, "principals", p, { desk_id: deskId });
    for (const m of backup.memberships)
      await insertRow(client, "memberships", m, { desk_id: deskId });
    // column types drive value encoding: bytea comes back as hex, jsonb
    // columns may hold JSON *arrays* (citation_set) which pg would otherwise
    // write as a postgres array literal, and uuid[] needs pg array encoding
    const { rows: colTypes } = await client.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name = ANY($1)`,
      [DESK_TABLES.map((t) => t.table)]);
    const types = new Map(colTypes.map((c) => [`${c.table_name}.${c.column_name}`, c.data_type as string]));

    for (const { table, deskColumn, skipInsertColumns } of DESK_TABLES) {
      if (table === "stations") continue;
      // A backup can enumerate revisions before their parents. Reattach the
      // two nullable self-references once all rows of their table exist.
      const parentColumn = table === "candidates" ? "parent_id" : table === "observations" ? "supersedes" : null;
      const rows = backup.tables[table] ?? [];
      for (const row of rows) {
        const r: Record<string, unknown> =
          deskColumn === false ? { ...row } : { ...row, desk_id: deskId };
        if ("station_id" in r) r.station_id = remapStation(r.station_id);
        if ("source_station_id" in r) r.source_station_id = remapStation(r.source_station_id);
        if (parentColumn) r[parentColumn] = null;
        for (const k of skipInsertColumns ?? []) delete r[k];
        await insertRow(client, table, r, {}, types);
      }
      if (parentColumn) {
        for (const row of rows) {
          if (row[parentColumn] != null) {
            await client.query(`UPDATE ${table} SET ${parentColumn}=$1 WHERE id=$2 AND desk_id=$3`,
              [row[parentColumn], row.id, deskId]);
          }
        }
      }
    }

    // hold unresolved remote effects + open reconciliation (INV-09). LEASED is
    // included: the lease may have been mid-send when the backup was taken, so
    // the submission is possibly-sent — it must reconcile, not resend.
    const { rows: held } = await client.query(
      `UPDATE intents SET state='HOLD', block_reason='restored_pending_reconciliation', updated_at=now()
       WHERE desk_id=$1 AND state IN ('LEASED','SENT_UNKNOWN','REMOTE_KNOWN') RETURNING id`,
      [deskId]);
    for (const h of held)
      await client.query(
        `INSERT INTO reconciliation_cases(id, desk_id, intent_id, opened_at, detail)
         VALUES ($1,$2,$3,now(),$4)`,
        [uuid(), deskId, h.id,
         JSON.stringify({ kind: "restored_unresolved", note: "restored with unresolved remote effect — read remote state before classifying or resending" })],
      );
    await client.query("COMMIT");
    return { deskId, slug: targetSlug, heldIntents: held.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function insertRow(
  client: pg.PoolClient, table: string, row: Record<string, unknown>,
  override: Record<string, unknown> = {},
  types?: Map<string, string>,
) {
  const r = { ...row, ...override };
  const cols = Object.keys(r).filter((k) => r[k] !== undefined);
  const vals: unknown[] = [];
  const placeholders = cols.map((k, i) => {
    const dt = types?.get(`${table}.${k}`);
    const v = r[k];
    if (v === null) { vals.push(null); return `$${i + 1}`; }
    if (dt === "bytea" && typeof v === "string" && v.startsWith("\\x")) {
      vals.push(v.slice(2));
      return `decode($${i + 1},'hex')`;
    }
    if (dt === "jsonb") {
      // arrays/objects both land correctly; pg's own array-literal encoding
      // would corrupt JSON-array values, so stringify explicitly
      vals.push(JSON.stringify(v));
      return `$${i + 1}::jsonb`;
    }
    vals.push(v);
    return `$${i + 1}`;
  });
  await client.query(
    `INSERT INTO ${table}(${cols.join(",")}) VALUES (${placeholders.join(",")})`,
    vals,
  );
}

/**
 * NFR-09 ops report: lag, skew, oldest pending intent, quota. No tokens/notes.
 * Pass deskId to scope to one desk (HTTP callers are always scoped); omit it
 * only from the operator CLI for a global view.
 */
export async function doctor(
  pool: pg.Pool, config: AppConfig, clock: Clock, deskId?: string,
) {
  // $1 is deskId when scoping; the IS NULL form keeps one query for both paths
  const params = [deskId ?? null];
  const now = clock.now();
  const { rows: dbNow } = await pool.query("SELECT now() AS t");
  const skewMs = Math.abs(new Date(dbNow[0].t as string).getTime() - now.getTime());

  const { rows: connectors } = await pool.query(
    `SELECT sp.id AS source_policy_id, sp.endpoint_url, cp.state, cp.failure_reason,
            cp.last_completed_at, cp.updated_at
     FROM source_policies sp
     LEFT JOIN ingest_checkpoints cp ON cp.source_policy_id=sp.id
     WHERE ($1::uuid IS NULL OR sp.desk_id=$1)
     ORDER BY cp.last_completed_at NULLS FIRST`, params);
  const { rows: health } = await pool.query(
    `SELECT DISTINCT ON (source_policy_id) source_policy_id, ok, checked_at, latency_ms
     FROM connector_health WHERE ($1::uuid IS NULL OR desk_id=$1)
     ORDER BY source_policy_id, checked_at DESC`, params);
  const healthByPolicy = new Map(health.map((h) => [h.source_policy_id, h]));

  const { rows: intents } = await pool.query(
    `SELECT state, count(*)::int AS n, min(created_at) AS oldest
     FROM intents WHERE ($1::uuid IS NULL OR desk_id=$1) GROUP BY state`, params);
  const oldestPending = intents
    .filter((i) => ["READY", "LEASED", "SENT_UNKNOWN"].includes(i.state as string))
    .map((i) => new Date(i.oldest as string).getTime())
    .sort((a, b) => a - b)[0];

  const { rows: quota } = await pool.query(
    `SELECT provider_account, market_address,
            count(*) FILTER (WHERE state <> 'released')::int AS used
     FROM quota_reservations WHERE ($1::uuid IS NULL OR desk_id=$1)
     GROUP BY provider_account, market_address`, params);

  const { rows: cases } = await pool.query(
    `SELECT count(*)::int AS open FROM reconciliation_cases
     WHERE resolved_at IS NULL AND ($1::uuid IS NULL OR desk_id=$1)`, params);

  return {
    ok: skewMs < 5_000,
    serverTime: now.toISOString(),
    dbTime: new Date(dbNow[0].t as string).toISOString(),
    clockSkewMs: skewMs,
    liveSubmissions: config.liveSubmissionsEnabled,
    connectors: connectors.map((c) => ({
      sourcePolicyId: c.source_policy_id,
      endpoint: c.endpoint_url,
      state: c.state ?? "never_ingested",
      failureReason: c.failure_reason,
      lastCompletedAt: c.last_completed_at,
      lagSeconds: c.last_completed_at
        ? Math.floor((now.getTime() - new Date(c.last_completed_at as string).getTime()) / 1000)
        : null,
      lastProbeOk: healthByPolicy.get(c.source_policy_id)?.ok ?? null,
    })),
    outbox: {
      perState: Object.fromEntries(intents.map((i) => [i.state, i.n])),
      oldestPendingIntentAgeSeconds: oldestPending
        ? Math.floor((now.getTime() - oldestPending) / 1000) : null,
    },
    quota: quota.map((q) => ({
      providerAccount: q.provider_account, marketAddress: q.market_address,
      used: q.used, max: 3, exhausted: Number(q.used) >= 3,
    })),
    reconciliation: { openCases: Number(cases[0].open) },
  };
}
