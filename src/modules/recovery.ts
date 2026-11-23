/**
 * M09 reconciliation pass (INV-09): an unresolved external effect stays
 * uncertain across restart; recovery reads remote state first, then classifies.
 * - expired worker leases return their intent to READY
 * - open reconciliation cases are resolved only from provider state, never guessed
 */
import type pg from "pg";
import type { AppConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import { uuid } from "../core/ids.ts";
import { resolveTransport } from "./outbox.ts";
import { classifyError } from "./delphi.ts";

export async function reconcileTick(
  pool: pg.Pool, config: AppConfig, clock: Clock, deskId?: string,
): Promise<{ leasesRecovered: number; casesResolved: number; casesOpen: number }> {
  // 1. a crashed worker's expired lease must not strand the intent forever.
  //    Only the LATEST attempt's expiry recovers — an older expired attempt
  //    may not pull the intent out from under a live newer worker. The same
  //    CTE drives both writes atomically: the intent returns to READY and its
  //    stale attempt is closed, jointly desk-scoped, so a recovery can never
  //    fire twice or touch another desk's attempts.
  const { rowCount: leasesRecovered } = await pool.query(
    `WITH stale AS (
       SELECT a.id AS attempt_id, a.intent_id
       FROM attempts a
       WHERE a.finished_at IS NULL AND a.lease_expires_at < $1
         AND a.epoch = (SELECT MAX(epoch) FROM attempts WHERE intent_id = a.intent_id)
         AND EXISTS (SELECT 1 FROM intents i WHERE i.id = a.intent_id AND i.state='LEASED'
                     AND ($2::uuid IS NULL OR i.desk_id=$2))
     ),
     recovered AS (
       UPDATE intents SET state='READY', updated_at=now()
       WHERE id IN (SELECT intent_id FROM stale)
       RETURNING id
     )
     UPDATE attempts SET finished_at=now(), result='lease_expired'
     WHERE id IN (SELECT attempt_id FROM stale)`,
    [clock.now(), deskId ?? null],
  );

  // 2. resolve open cases by reading provider state for the known remote id
  const { rows: cases } = await pool.query(
    `SELECT rc.id AS case_id, rc.intent_id, r.remote_id, i.market_address, i.desk_id
     FROM reconciliation_cases rc
     JOIN intents i ON i.id = rc.intent_id
     LEFT JOIN LATERAL (
       SELECT remote_id FROM receipts
       WHERE intent_id = rc.intent_id ORDER BY observed_at DESC LIMIT 1
     ) r ON true
     WHERE rc.resolved_at IS NULL AND ($1::uuid IS NULL OR rc.desk_id=$1)
     ORDER BY rc.opened_at LIMIT 25`, [deskId ?? null],
  );
  const transport = resolveTransport(config);
  let resolved = 0;
  for (const c of cases) {
    // every resolution path below requires reading (or re-asking) the
    // provider; with no transport the effect stays uncertain and the case
    // stays open — closing it would lose the only record that needs review
    if (!transport) break;
    if (c.remote_id == null) {
      // the response was lost before a remote id existed — reconcile by
      // resubmitting the SAME idempotency key (provider collapses dupes)
      await pool.query(
        `UPDATE intents SET state='SENT_UNKNOWN', block_reason=NULL, updated_at=now()
         WHERE id=$1 AND state='HOLD'`,
        [c.intent_id]);
      await pool.query(
        `UPDATE reconciliation_cases SET resolved_at=now(), resolution='resubmit_idempotent'
         WHERE id=$1`,
        [c.case_id]);
      resolved++;
      continue;
    }
    try {
      const st = await transport.getSubmission(c.remote_id, c.market_address);
      const matched = st.marketMatched ? st.status : "unmatched";
      await pool.query(
        `UPDATE rewards SET remote_status=$2,
           verdict=$3, bounty_amount_raw=$4, bounty_state=$5,
           last_poll_at=$6, updated_at=now()
         WHERE intent_id=$1`,
        [c.intent_id, matched,
         st.marketMatched ? st.verdict : null,
         st.marketMatched ? st.bounty?.amount ?? null : null,
         st.marketMatched ? st.bounty?.state ?? null : null,
         clock.now()],
      );
      await pool.query(
        `UPDATE reconciliation_cases SET resolved_at=now(), resolution='remote_state_read'
         WHERE id=$1`,
        [c.case_id],
      );
      if (st.marketMatched && ["judged", "rejected", "failed"].includes(st.status)) {
        await pool.query(
          "UPDATE intents SET state='DONE', block_reason=NULL, updated_at=now() WHERE id=$1",
          [c.intent_id]);
        // terminal remote truth frees any held slot bookkeeping accuracy
        await pool.query(
          "UPDATE quota_reservations SET state='consumed' WHERE intent_id=$1 AND state='reserved'",
          [c.intent_id]);
      } else {
        // remote knows the submission but it isn't terminal — release hold to
        // REMOTE_KNOWN so normal polling continues tracking it
        await pool.query(
          `UPDATE intents SET state='REMOTE_KNOWN', block_reason=NULL, updated_at=now()
           WHERE id=$1 AND state='HOLD'`,
          [c.intent_id]);
      }
      resolved++;
    } catch (err) {
      const f = classifyError(err);
      if (f.code === "not_found") {
        await pool.query(
          `UPDATE reconciliation_cases SET resolved_at=now(), resolution='remote_absent',
             detail=$2 WHERE id=$1`,
          [c.case_id, JSON.stringify({ kind: "remote_id_unmatched", remoteId: c.remote_id })]);
        // provider lost the submission entirely — hold for operator decision,
        // never silently resend (a second send would double-spend a slot)
        await pool.query(
          "UPDATE intents SET state='HOLD', block_reason='remote_absent', updated_at=now() WHERE id=$1",
          [c.intent_id]);
        resolved++;
      }
      // transient transport fault → leave open; INV-09 keeps the effect uncertain
    }
  }
  const { rows: open } = await pool.query(
    "SELECT count(*)::int AS n FROM reconciliation_cases WHERE resolved_at IS NULL AND ($1::uuid IS NULL OR desk_id=$1)", [deskId ?? null]);
  return {
    leasesRecovered: leasesRecovered ?? 0,
    casesResolved: resolved,
    casesOpen: Number(open[0].n),
  };
}

/** Operator helper: a backup restore marker so audits show recovery events. */
export async function noteRecoveryEvent(
  pool: pg.Pool, deskId: string, detail: Record<string, unknown>,
) {
  await pool.query(
    `INSERT INTO reconciliation_cases(id, desk_id, intent_id, opened_at, resolved_at, resolution, detail)
     VALUES ($1,$2,NULL,now(),now(),'recovery_event',$3)`,
    [uuid(), deskId, JSON.stringify(detail)],
  );
}
