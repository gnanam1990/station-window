/**
 * Read-side projections for the analyst workbench (M08, INV-08): every view is
 * computed from persisted state at request time and stamped with the desk's
 * as-of time, so the UI can label staleness instead of guessing.
 */
import type pg from "pg";
import type { RequestContext } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { notFound } from "../core/errors.ts";
import { convertUnit } from "../core/units.ts";
import { SLOT_MAX } from "./outbox.ts";

export interface InboxItem {
  marketVersionId: string;
  marketAddress: string;
  question: string;
  competitionId: string;
  evidenceCutoffAtUtc: string;
  localZone: string | null;
  cutoffLocal: string | null;
  remainingMs: number;
  stationExternalId: string | null;
  stationAuthority: string | null;
  stationLabel: string | null;
  bindingId: string | null;
  bindingStatus: string | null;
  latestObservation: {
    observedAtUtc: string; firstSeenAtUtc: string;
    value: string | null; unit: string; variable: string;
  } | null;
  evidenceState: string;
  permittedAction: { kind: string; label: string; reason?: string };
}

interface PolicyRow { can_browse: boolean; can_submit: boolean }

export async function deskInbox(db: Db, ctx: RequestContext) {
  const { rows: bindings } = await db.query(
    `SELECT rb.id AS binding_id, rb.status AS binding_status, rb.local_zone, rb.local_date,
            rb.station_id, rb.dataset, rb.variable, rb.aggregate_policy,
            mv.id AS market_version_id, mv.market_address, mv.source_wording, mv.competition_id,
            mv.cutoff_at, s.external_id, s.authority, s.city_label
     FROM rule_bindings rb
     JOIN market_versions mv ON mv.id = rb.market_version_id
     LEFT JOIN stations s ON s.id = rb.station_id
     WHERE rb.desk_id = $1 AND rb.status <> 'superseded'`,
    [ctx.deskId],
  );
  const now = ctx.clock.now();
  const items: InboxItem[] = [];
  for (const b of bindings) {
    const { rows: obs } = await db.query(
      `SELECT observed_at, first_seen_at, value_text, value_num, unit, variable
       FROM observations
       WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4 AND NOT quarantined
       ORDER BY observed_at DESC LIMIT 1`,
      [ctx.deskId, b.station_id, b.dataset, b.variable],
    );
    const { rows: pols } = await db.query(
      `SELECT can_browse, can_submit FROM source_policies
       WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4`,
      [ctx.deskId, b.station_id, b.dataset, b.variable],
    );
    const { rows: cands } = await db.query(
      `SELECT status FROM candidates WHERE desk_id=$1 AND rule_binding_id=$2
       ORDER BY version DESC LIMIT 1`,
      [ctx.deskId, b.binding_id],
    );
    const { rows: intents } = await db.query(
      `SELECT i.state, i.block_reason FROM intents i
       WHERE i.desk_id=$1 AND i.market_address=$2
       ORDER BY i.created_at DESC LIMIT 1`,
      [ctx.deskId, b.market_address],
    );
    const { rows: evals } = await db.query(
      `SELECT id FROM evaluations WHERE desk_id=$1 AND rule_binding_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [ctx.deskId, b.binding_id],
    );

    const latest = obs[0];
    const canSubmit = (pols as PolicyRow[]).some((p) => p.can_submit);
    const canBrowse = (pols as PolicyRow[]).some((p) => p.can_browse);
    const cand = cands[0];
    const intent = intents[0];
    const cutoff = new Date(b.cutoff_at as string);
    const localZone = (b.local_zone as string | null) ?? null;

    let evidenceState: string;
    let action: InboxItem["permittedAction"];
    if (b.binding_status !== "verified") {
      evidenceState = "binding_unverified";
      action = { kind: "verify_binding", label: "Verify binding", reason: "rule reading not yet verified" };
    } else if (pols.length === 0) {
      evidenceState = "no_authorized_source";
      action = { kind: "register_source", label: "Register source", reason: "no authorized source for this station/variable" };
    } else if (!latest) {
      evidenceState = "awaiting_observations";
      action = { kind: "ingest", label: "Ingest observations", reason: "no retained observations yet" };
    } else if (evals.length === 0) {
      evidenceState = "ready_to_evaluate";
      action = { kind: "evaluate", label: "Evaluate window" };
    } else if (!cand) {
      evidenceState = "ready_for_research";
      action = { kind: "research", label: "Run research" };
    } else if (cand.status === "draft" || cand.status === "correction_requested") {
      evidenceState = "draft_in_progress";
      action = { kind: "edit", label: "Edit draft" };
    } else if (cand.status === "pending_review") {
      evidenceState = "in_review";
      action = { kind: "review", label: "Review draft" };
    } else if (cand.status === "approved" && !intent) {
      evidenceState = canSubmit ? "ready_to_dispatch" : "read_only_no_submit";
      action = canSubmit
        ? { kind: "dispatch", label: "Queue dispatch" }
        : { kind: "view", label: "View only", reason: "source policy restricts submission" };
    } else if (intent) {
      const map: Record<string, [string, InboxItem["permittedAction"]]> = {
        READY: ["dispatch_queued", { kind: "view", label: "View intent" }],
        LEASED: ["dispatch_in_flight", { kind: "view", label: "View intent" }],
        SENT_UNKNOWN: ["transport_uncertain", { kind: "reconcile", label: "Reconcile first" }],
        REMOTE_KNOWN: ["awaiting_remote_judgment", { kind: "view", label: "Poll status" }],
        HOLD: ["held", { kind: "view", label: "Review hold", reason: intent.block_reason ?? undefined }],
        BLOCKED: [`blocked`, { kind: "view", label: "See reason", reason: intent.block_reason ?? "blocked" }],
        DONE: ["remote_result", { kind: "view", label: "View receipt" }],
      };
      [evidenceState, action] = map[intent.state as string] ?? ["unknown", { kind: "view", label: "Inspect" }];
    } else {
      evidenceState = "closed";
      action = { kind: "view", label: "View" };
    }
    if (!canBrowse && pols.length > 0) action = { kind: "view", label: "No browse right", reason: "policy restricts browsing" };

    items.push({
      marketVersionId: b.market_version_id,
      marketAddress: b.market_address,
      question: b.source_wording,
      competitionId: b.competition_id,
      evidenceCutoffAtUtc: cutoff.toISOString(),
      localZone,
      cutoffLocal: localZone ? cutoff.toLocaleString("en-CA", { timeZone: localZone, hour12: false }) : null,
      remainingMs: cutoff.getTime() - now.getTime(),
      stationExternalId: b.external_id,
      stationAuthority: b.authority,
      stationLabel: b.city_label,
      bindingId: b.binding_id,
      bindingStatus: b.binding_status,
      latestObservation: latest
        ? {
            observedAtUtc: new Date(latest.observed_at).toISOString(),
            firstSeenAtUtc: new Date(latest.first_seen_at).toISOString(),
            value: latest.value_text,
            unit: latest.unit,
            variable: latest.variable,
          }
        : null,
      evidenceState,
      permittedAction: action,
    });
  }
  items.sort((a, b) => a.remainingMs - b.remainingMs);
  return { asOf: now.toISOString(), items };
}

export async function deskBindingDetail(db: Db, ctx: RequestContext, bindingId: string) {
  const { rows } = await db.query(
    `SELECT rb.*, mv.market_address, mv.source_wording, mv.competition_id, mv.cutoff_at,
            mv.is_competition_entry,
            s.external_id, s.authority AS station_authority, s.city_label
     FROM rule_bindings rb
     JOIN market_versions mv ON mv.id = rb.market_version_id
     LEFT JOIN stations s ON s.id = rb.station_id
     WHERE rb.id=$1 AND rb.desk_id=$2`,
    [bindingId, ctx.deskId],
  );
  const b = rows[0];
  if (!b) throw notFound("rule binding");

  const { rows: obs } = await db.query(
    `SELECT id, observed_at, first_seen_at, value_text, value_num, unit,
            canonical_value, canonical_unit, quality, line_locator, seq
     FROM observations
     WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4 AND NOT quarantined
     ORDER BY observed_at, seq`,
    [ctx.deskId, b.station_id, b.dataset, b.variable],
  );
  const pol = (b.aggregate_policy ?? {}) as { cadenceMinutes?: number };
  const cadenceMs = (pol.cadenceMinutes ?? 60) * 60_000;
  let prev: number | null = null;
  const series = obs.map((o) => {
    const t = new Date(o.observed_at).getTime();
    const gap = prev !== null && t - prev > cadenceMs * 1.5;
    prev = t;
    const inUnit = o.canonical_value != null && b.unit
      ? convertUnit(String(o.canonical_value), String(o.canonical_unit), String(b.unit))
      : null;
    return {
      observationId: o.id,
      observedAtUtc: new Date(o.observed_at).toISOString(),
      firstSeenAtUtc: new Date(o.first_seen_at).toISOString(),
      value: o.value_text, unit: o.unit,
      bindingValue: inUnit, bindingUnit: b.unit,
      quality: o.quality, lineLocator: o.line_locator,
      gapBefore: gap,
    };
  });

  const { rows: evals } = await db.query(
    `SELECT id, verdict, result, created_at FROM evaluations
     WHERE desk_id=$1 AND rule_binding_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [ctx.deskId, bindingId],
  );
  const { rows: cands } = await db.query(
    `SELECT c.id, c.version, c.status, c.block_reason, c.note_text, c.citation_set,
            c.observation_ids, c.parent_id, c.created_at,
            (SELECT a.id FROM approvals a WHERE a.candidate_id=c.id ORDER BY a.approved_at DESC LIMIT 1) AS approval_id,
            (SELECT a.status FROM approvals a WHERE a.candidate_id=c.id ORDER BY a.approved_at DESC LIMIT 1) AS approval_status
     FROM candidates c WHERE c.desk_id=$1 AND c.rule_binding_id=$2 ORDER BY c.version`,
    [ctx.deskId, bindingId],
  );
  const { rows: pols } = await db.query(
    `SELECT endpoint_url, can_browse, can_retain, can_submit, can_export
     FROM source_policies
     WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4`,
    [ctx.deskId, b.station_id, b.dataset, b.variable],
  );
  const { rows: slots } = await db.query(
    `SELECT count(*)::int AS used FROM quota_reservations
     WHERE desk_id=$1 AND market_address=$2 AND state <> 'released'`,
    [ctx.deskId, b.market_address],
  );
  const current = cands[cands.length - 1];
  return {
    asOf: ctx.clock.now().toISOString(),
    market: {
      marketVersionId: b.market_version_id, address: b.market_address,
      competitionId: b.competition_id, isCompetitionEntry: b.is_competition_entry,
      evidenceCutoffAtUtc: new Date(b.cutoff_at).toISOString(),
    },
    rule: {
      verbatim: b.source_wording,
      structured: {
        variable: b.variable, operator: b.operator, threshold: b.threshold_text,
        unit: b.unit, localZone: b.local_zone, localDate: String(b.local_date),
        dayDefinition: b.day_definition, aggregatePolicy: b.aggregate_policy,
      },
      status: b.status,
    },
    station: {
      externalId: b.external_id, authority: b.station_authority, cityLabel: b.city_label,
    },
    series: { cadenceMinutes: pol.cadenceMinutes ?? null, points: series },
    latestEvaluation: evals[0] ?? null,
    candidates: cands,
    currentCandidate: current ?? null,
    editorPreview: current
      ? {
          note: current.note_text, candidateVersion: current.version,
          authorityUrls: pols.map((p) => p.endpoint_url),
          marketAddress: b.market_address,
          evidenceCutoffAtUtc: new Date(b.cutoff_at).toISOString(),
          slotConsequence: `uses one of ${SLOT_MAX} submission slots on this market (${slots[0].used} in use)`,
          canSubmit: pols.some((p) => p.can_submit),
        }
      : null,
    sourcePolicies: pols,
  };
}

export async function deskQueue(db: Db, ctx: RequestContext) {
  const { rows } = await db.query(
    `SELECT c.id, c.version, c.status, c.block_reason, c.note_text, c.citation_set,
            c.rule_binding_id, c.created_at,
            mv.source_wording AS question, mv.market_address, mv.cutoff_at,
            s.external_id AS station_external_id
     FROM candidates c
     JOIN rule_bindings rb ON rb.id=c.rule_binding_id
     JOIN market_versions mv ON mv.id=rb.market_version_id
     LEFT JOIN stations s ON s.id=rb.station_id
     WHERE c.desk_id=$1 AND c.status IN ('draft','pending_review','correction_requested','approved')
     ORDER BY mv.cutoff_at, c.rank DESC`,
    [ctx.deskId],
  );
  return { asOf: ctx.clock.now().toISOString(), items: rows };
}

export async function deskReceipts(db: Db, ctx: RequestContext) {
  const { rows: intents } = await db.query(
    `SELECT i.id, i.state, i.block_reason, i.market_address, i.created_at, i.updated_at,
            (SELECT count(*)::int FROM attempts a WHERE a.intent_id=i.id) AS attempts
     FROM intents i WHERE i.desk_id=$1 ORDER BY i.created_at DESC`,
    [ctx.deskId],
  );
  const { rows: receipts } = await db.query(
    `SELECT r.intent_id, r.kind, r.remote_id, r.remote_status, r.received_at
     FROM receipts r JOIN intents i ON i.id=r.intent_id WHERE i.desk_id=$1
     ORDER BY r.received_at DESC`,
    [ctx.deskId],
  );
  const { rows: rewards } = await db.query(
    `SELECT r.intent_id, r.remote_status, r.verdict, r.bounty_amount_raw,
            r.bounty_state, r.zero_pay_reason, r.last_poll_at
     FROM rewards r WHERE r.desk_id=$1`,
    [ctx.deskId],
  );
  const { rows: cases } = await db.query(
    `SELECT id, intent_id, opened_at, resolved_at, resolution, detail
     FROM reconciliation_cases WHERE desk_id=$1 ORDER BY opened_at DESC`,
    [ctx.deskId],
  );
  const byState = (st: string[]) => intents.filter((i) => st.includes(i.state as string));
  return {
    asOf: ctx.clock.now().toISOString(),
    localPreparation: byState(["READY", "LEASED", "BLOCKED", "HOLD"]),
    transportUncertainty: byState(["SENT_UNKNOWN"]),
    remoteJudgment: {
      intents: byState(["REMOTE_KNOWN", "DONE"]),
      receipts,
      rewards,
    },
    money: rewards.filter((r) => r.bounty_amount_raw != null || r.bounty_state != null),
    alerts: cases
      .filter((c) => !c.resolved_at)
      .map((c) => ({
        caseId: c.id, intentId: c.intent_id, openedAt: c.opened_at,
        action: "reconcile", detail: c.detail,
      })),
  };
}
