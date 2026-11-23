import type pg from "pg";
import { sha256, stableJson, uuid } from "../core/ids.ts";
import { conflict, notFound } from "../core/errors.ts";
import type { Clock } from "../core/clock.ts";
import type { AppConfig } from "../config.ts";
import type { RequestContext } from "../auth.ts";
import { requireRole } from "../auth.ts";
import { withTx } from "../db/pool.ts";
import { assertApprovalSendable } from "./research.ts";
import { checkDispatchEligibility } from "./gate.ts";
import {
  classifyError, createSdkTransport, type DelphiTransport, TransportFault,
} from "./delphi.ts";

/**
 * M07 — Delphi dispatch outbox (FR-07, NFR-07, INV-07).
 *
 * One approval + provider account + market = one intent = one stable
 * idempotency key = at most one remote submission and one consumed slot.
 * Transmission is re-gated immediately before the bytes leave; an ambiguous
 * (lost) response is SENT_UNKNOWN and reconciled by resubmitting the same
 * idempotency key, which the provider collapses to the original submission.
 */

const SLOT_MAX = 3;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;

interface IntentRow {
  id: string;
  desk_id: string;
  approval_id: string;
  provider_account: string;
  market_address: string;
  payload: { note: string; links: string[]; marketAddress: string };
  payload_digest: string;
  idempotency_key: string;
  state: string;
  block_reason: string | null;
}

export async function createIntent(
  pool: pg.Pool, ctx: RequestContext,
  input: { approvalId: string; providerAccount?: string },
) {
  requireRole(ctx, "editor");
  const approval = await assertApprovalSendable(pool, ctx, input.approvalId);
  const providerAccount = input.providerAccount ?? "default";

  // resolve the market address through the approval's binding
  const { rows: mrows } = await pool.query(
    `SELECT mv.market_address, mv.id AS market_version_id
     FROM rule_bindings rb JOIN market_versions mv ON mv.id=rb.market_version_id
     WHERE rb.id=$1 AND rb.desk_id=$2`,
    [approval.rule_binding_id, ctx.deskId],
  );
  if (mrows.length === 0) throw notFound("market for approval binding");
  const marketAddress = mrows[0].market_address as string;

  const { rows: crows } = await pool.query(
    "SELECT note_text, citation_set FROM candidates WHERE id=$1 AND desk_id=$2",
    [approval.candidate_id, ctx.deskId],
  );
  const cand = crows[0];
  const links = (cand.citation_set as { url: string }[]).map((c) => c.url);
  const payload = {
    note: cand.note_text as string,
    links,
    marketAddress,
  };
  const payloadDigest = sha256(stableJson(payload));

  return withTx(pool, async (tx) => {
    // serialize concurrent creators for the same (account, market, approval)
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`intent:${providerAccount}:${marketAddress}:${input.approvalId}`],
    );
    const existing = await tx.query(
      `SELECT * FROM intents WHERE provider_account=$1 AND market_address=$2 AND approval_id=$3`,
      [providerAccount, marketAddress, input.approvalId],
    );
    if (existing.rows.length > 0)
      return { intent: existing.rows[0], created: false };
    // one quota slot per (account, market) out of SLOT_MAX, taken atomically
    const slot = await tx.query(
      `SELECT slot_index FROM generate_series(1,$2) g(slot_index)
       WHERE NOT EXISTS (
         SELECT 1 FROM quota_reservations q
         WHERE q.provider_account=$1 AND q.market_address=$3 AND q.slot_index=g.slot_index
           AND q.state <> 'released')
       ORDER BY slot_index LIMIT 1 FOR UPDATE`,
      [providerAccount, SLOT_MAX, marketAddress],
    );
    if (slot.rows.length === 0) throw conflict("quota_exhausted", "no free submission slot on market");
    const intentId = uuid();
    await tx.query(
      `INSERT INTO intents(id, desk_id, approval_id, provider_account, market_address,
         payload, payload_digest, idempotency_key, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'READY')`,
      [intentId, ctx.deskId, input.approvalId, providerAccount, marketAddress,
       JSON.stringify(payload), payloadDigest, uuid()],
    );
    await tx.query(
      `INSERT INTO quota_reservations(id, desk_id, intent_id, market_address, slot_index, provider_account)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), ctx.deskId, intentId, marketAddress, slot.rows[0].slot_index, providerAccount],
    );
    const { rows } = await tx.query("SELECT * FROM intents WHERE id=$1", [intentId]);
    return { intent: rows[0], created: true };
  });
}

export function resolveTransport(config: AppConfig): DelphiTransport | null {
  if (config.transportOverride) return config.transportOverride;
  if (config.liveSubmissionsEnabled && config.delphiBaseUrl && config.delphiApiKey)
    return createSdkTransport(config);
  return null;
}

async function blockIntent(
  db: pg.Pool, intent: IntentRow, reason: string, detail?: Record<string, unknown>,
) {
  await db.query(
    "UPDATE intents SET state='BLOCKED', block_reason=$2, updated_at=now() WHERE id=$1",
    [intent.id, reason],
  );
  await db.query(
    "UPDATE quota_reservations SET state='released', released_at=now() WHERE intent_id=$1",
    [intent.id],
  );
  await db.query(
    `INSERT INTO reconciliation_cases(id, desk_id, intent_id, opened_at, resolved_at, resolution, detail)
     VALUES ($1,$2,$3,now(),now(),'remote_absent',$4)`,
    [uuid(), intent.desk_id, intent.id, JSON.stringify(detail ?? {})],
  );
}

function workerCtx(intent: IntentRow, clock: Clock): RequestContext {
  return {
    deskId: intent.desk_id, deskSlug: "", principalId: "",
    role: "worker", authKind: "api_key", clock,
  };
}

async function scheduleRetry(db: pg.Pool, intentId: string, nextAt: Date) {
  await db.query(
    `INSERT INTO retry_schedule(intent_id, next_at, attempts, updated_at)
     VALUES ($1,$2,1,now())
     ON CONFLICT (intent_id) DO UPDATE SET next_at=$2, attempts=retry_schedule.attempts+1, updated_at=now()`,
    [intentId, nextAt],
  );
  await db.query("UPDATE intents SET state='READY', updated_at=now() WHERE id=$1", [intentId]);
}

/**
 * One worker pass: lease eligible intents, re-gate immediately before send,
 * submit with the stable idempotency key, classify the outcome.
 */
export async function dispatchTick(
  pool: pg.Pool, config: AppConfig, clock: Clock,
  opts: { workerId: string; transport?: DelphiTransport; limit?: number },
): Promise<{ processed: number }> {
  const transport = opts.transport ?? resolveTransport(config);
  const { rows: intents } = await pool.query(
    `SELECT i.* FROM intents i
     LEFT JOIN retry_schedule rs ON rs.intent_id=i.id
     WHERE i.state IN ('READY','SENT_UNKNOWN')
       AND (rs.next_at IS NULL OR rs.next_at <= $1)
     ORDER BY i.created_at LIMIT $2`,
    [clock.now(), opts.limit ?? 10],
  );
  let processed = 0;
  for (const intent of intents as IntentRow[]) {
    // lease: exactly one worker may hold this intent
    const leased = await pool.query(
      "UPDATE intents SET state='LEASED', updated_at=now() WHERE id=$1 AND state IN ('READY','SENT_UNKNOWN') RETURNING id",
      [intent.id],
    );
    if (leased.rows.length === 0) continue; // fenced — another worker holds it
    const epoch = await pool.query(
      "SELECT COALESCE(MAX(epoch),0)+1 AS e FROM attempts WHERE intent_id=$1", [intent.id]);
    if (Number(epoch.rows[0].e) > MAX_ATTEMPTS) {
      await blockIntent(pool, intent, "attempts_exhausted");
      continue;
    }
    const attemptId = uuid();
    await pool.query(
      `INSERT INTO attempts(id, desk_id, intent_id, epoch, worker_id, leased_at, lease_expires_at, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6)`,
      [attemptId, intent.desk_id, intent.id, epoch.rows[0].e, opts.workerId,
       clock.now(), new Date(clock.now().getTime() + LEASE_MS)],
    );
    processed++;
    const finish = async (result: string, httpStatus?: number) => {
      // stale-worker fence: only write while this attempt is still the latest epoch
      await pool.query(
        `UPDATE attempts SET finished_at=$2, result=$3, http_status=$4
         WHERE id=$1 AND epoch=(SELECT MAX(epoch) FROM attempts WHERE intent_id=$5)`,
        [attemptId, clock.now(), result, httpStatus ?? null, intent.id],
      );
    };

    // ── re-gate immediately before transmission (INV-07) ──
    const ctx = workerCtx(intent, clock);
    const sendable = await assertApprovalSendable(pool, ctx, intent.approval_id)
      .then(() => null as string | null)
      .catch((e) => (e as { code?: string }).code ?? "approval_invalid");
    if (sendable) { await finish(`refused:${sendable}`); await blockIntent(pool, intent, sendable); continue; }

    const gateMv = await pool.query(
      `SELECT rb.market_version_id FROM approvals a JOIN rule_bindings rb ON rb.id=a.rule_binding_id
       WHERE a.id=$1`, [intent.approval_id]);
    const gv = gateMv.rows[0]
      ? await checkDispatchEligibility(pool, ctx, { marketVersionId: gateMv.rows[0].market_version_id })
      : null;
    if (!gv?.eligible) {
      const reasons = gv?.reasons ?? ["gate_unavailable"];
      await finish(`refused:${reasons[0]}`);
      await blockIntent(pool, intent, reasons.join(","));
      continue;
    }

    if (!transport) {
      await finish("refused:no_transport");
      await pool.query(
        "UPDATE intents SET state='HOLD', block_reason='live_transport_unavailable', updated_at=now() WHERE id=$1",
        [intent.id]);
      continue;
    }
    try {
      const terms = await transport.getTerms();
      if (!terms.acceptedAt) {
        await finish("refused:terms_not_accepted");
        await blockIntent(pool, intent, "terms_not_accepted");
        continue;
      }
      const entry = await transport.getEntryState(intent.market_address);
      if (!entry.canSubmit) {
        await finish("refused:entry_not_submittable");
        await blockIntent(pool, intent, `entry_not_submittable:${entry.reason ?? "provider"}`);
        continue;
      }
      const limits = await transport.getLimits();
      if (limits.submitsLeftThisHour <= 0) {
        await finish("refused:hourly_cap");
        await scheduleRetry(pool, intent.id,
          limits.hourEndsAt ? new Date(limits.hourEndsAt) : new Date(clock.now().getTime() + 300_000));
        continue;
      }
    } catch (err) {
      const f = classifyError(err);
      await finish(`error:${f.code}`, f.status || undefined);
      await scheduleRetry(pool, intent.id, backoff(clock, f));
      continue;
    }

    // ── transmit with the stable per-intent key ──
    try {
      const res = await transport.submit({
        note: intent.payload.note, links: intent.payload.links,
        marketAddress: intent.market_address, idempotencyKey: intent.idempotency_key,
      });
      await finish("sent");
      await recordRemote(pool, intent, res.remoteId, res.status, res.raw, clock);
    } catch (err) {
      const f = classifyError(err);
      if (f.kind === "timeout" || f.kind === "network") {
        // ambiguous: remote state is unknown — reconcile before any retry verdict
        await finish(`sent_unknown:${f.code}`);
        await pool.query(
          "UPDATE intents SET state='SENT_UNKNOWN', updated_at=now() WHERE id=$1", [intent.id]);
        await pool.query(
          `INSERT INTO reconciliation_cases(id, desk_id, intent_id, opened_at, detail)
           VALUES ($1,$2,$3,now(),$4)`,
          [uuid(), intent.desk_id, intent.id,
           JSON.stringify({ kind: f.kind, idempotencyKey: intent.idempotency_key })],
        );
      } else if (f.code === "rate_limited" || f.retryAfterSeconds) {
        await finish(`refused:${f.code}`, f.status);
        await scheduleRetry(pool, intent.id, backoff(clock, f));
      } else if (f.code === "terms_not_accepted") {
        await finish(`refused:${f.code}`, f.status);
        await blockIntent(pool, intent, "terms_not_accepted");
      } else {
        await finish(`error:${f.code}`, f.status);
        await scheduleRetry(pool, intent.id, backoff(clock, f));
      }
    }
  }
  return { processed };
}

function backoff(clock: Clock, f: TransportFault): Date {
  const wait = f.retryAfterSeconds ? f.retryAfterSeconds * 1000 : 30_000;
  return new Date(clock.now().getTime() + Math.min(wait, 300_000));
}

/** Record the remote submission: receipt + slot consumption + REMOTE_KNOWN. */
async function recordRemote(
  pool: pg.Pool, intent: IntentRow, remoteId: string, status: string,
  raw: unknown, clock: Clock,
) {
  await withTx(pool, async (tx) => {
    // UNIQUE(provider_account, remote_id) collapses double-observation
    await tx.query(
      `INSERT INTO receipts(id, desk_id, intent_id, provider_account, remote_id, raw_status, payload, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider_account, remote_id) DO NOTHING`,
      [uuid(), intent.desk_id, intent.id, intent.provider_account, remoteId,
       status, JSON.stringify(raw ?? {}), clock.now()],
    );
    await tx.query(
      "UPDATE quota_reservations SET state='consumed' WHERE intent_id=$1", [intent.id]);
    await tx.query(
      "UPDATE approvals SET status='consumed' WHERE id=$1 AND status='valid'", [intent.approval_id]);
    await tx.query(
      "UPDATE intents SET state='REMOTE_KNOWN', block_reason=NULL, updated_at=now() WHERE id=$1",
      [intent.id]);
    await tx.query(
      `INSERT INTO rewards(id, desk_id, intent_id, market_address, remote_status, bounty_amount_raw, bounty_state, last_poll_at)
       VALUES ($1,$2,$3,$4,$5,NULL,'none',$6)
       ON CONFLICT (intent_id, market_address) DO NOTHING`,
      [uuid(), intent.desk_id, intent.id, intent.market_address, status, clock.now()],
    );
    await tx.query(
      `UPDATE reconciliation_cases SET resolved_at=now(), resolution='remote_known'
       WHERE intent_id=$1 AND resolved_at IS NULL`,
      [intent.id],
    );
  });
}

/** Poll remote state: judgment and bounty stay separate from the local verdict. */
export async function pollTick(
  pool: pg.Pool, config: AppConfig, clock: Clock,
  opts: { transport?: DelphiTransport } = {},
): Promise<{ polled: number }> {
  const transport = opts.transport ?? resolveTransport(config);
  if (!transport) return { polled: 0 };
  const { rows } = await pool.query(
    `SELECT i.*, r.remote_id FROM intents i
     JOIN receipts r ON r.intent_id=i.id AND r.provider_account=i.provider_account
     WHERE i.state='REMOTE_KNOWN'`,
    [],
  );
  let polled = 0;
  for (const intent of rows as (IntentRow & { remote_id: string })[]) {
    const rs = await pool.query(
      "SELECT next_at FROM retry_schedule WHERE intent_id=$1", [intent.id]);
    if (rs.rows.length > 0 && new Date(rs.rows[0].next_at) > clock.now()) continue;
    try {
      const st = await transport.getSubmission(intent.remote_id, intent.market_address);
      polled++;
      const bountyCurrency = null; // denomination unverified until provider schema declares it
      // an absent target-market row is unresolved, never another market's win
      const recordedStatus = st.marketMatched ? st.status : "unmatched";
      const { rows: cur } = await pool.query(
        "SELECT id, remote_status, bounty_state, bounty_amount_raw FROM rewards WHERE intent_id=$1",
        [intent.id]);
      await pool.query(
        `UPDATE rewards SET remote_status=$2, verdict=$3, reason=$4,
           bounty_amount_raw=$5, bounty_currency=$6, bounty_state=$7,
           zero_pay_reason=$8, last_poll_at=$9, updated_at=now()
         WHERE intent_id=$1`,
        [intent.id, recordedStatus,
         st.marketMatched ? st.verdict : null, st.marketMatched ? st.reason : null,
         st.marketMatched ? st.bounty?.amount ?? null : null, bountyCurrency,
         st.marketMatched ? st.bounty?.state ?? null : null,
         st.marketMatched ? st.zeroPayReason ?? null : null, clock.now()],
      );
      if (cur.length > 0) {
        const c = cur[0];
        if (c.remote_status !== recordedStatus
            || c.bounty_state !== (st.marketMatched ? st.bounty?.state ?? null : null)
            || c.bounty_amount_raw !== (st.marketMatched ? st.bounty?.amount ?? null : null)) {
          await pool.query(
            `INSERT INTO reward_history(reward_id, remote_status, bounty_state, bounty_amount_raw, observed_at, raw)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [c.id, recordedStatus, st.marketMatched ? st.bounty?.state ?? null : null,
             st.marketMatched ? st.bounty?.amount ?? null : null,
             clock.now(), JSON.stringify(st.raw ?? {})],
          );
        }
      }
      if (st.retryAfterSeconds)
        await pool.query(
          `INSERT INTO retry_schedule(intent_id, next_at, updated_at) VALUES ($1,$2,now())
           ON CONFLICT (intent_id) DO UPDATE SET next_at=$2, updated_at=now()`,
          [intent.id, new Date(clock.now().getTime() + st.retryAfterSeconds * 1000)],
        );
      if (st.marketMatched && ["judged", "rejected", "failed"].includes(st.status))
        await pool.query(
          "UPDATE intents SET state='DONE', updated_at=now() WHERE id=$1", [intent.id]);
    } catch (err) {
      const f = classifyError(err);
      if (f.code === "not_found") {
        await pool.query(
          `INSERT INTO reconciliation_cases(id, desk_id, intent_id, opened_at, detail)
           VALUES ($1,$2,$3,now(),$4)`,
          [uuid(), intent.desk_id, intent.id,
           JSON.stringify({ kind: "remote_id_unmatched", remoteId: intent.remote_id })],
        );
        continue;
      }
      if (!(err instanceof TransportFault)) throw err; // local faults must surface
      // transport faults (network/timeout/rate-limit): leave REMOTE_KNOWN, retry next poll
    }
  }
  return { polled };
}
