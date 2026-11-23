import type pg from "pg";
import { contentDigest, sha256, uuid } from "../core/ids.ts";
import { badRequest, conflict, notFound } from "../core/errors.ts";
import { convertUnit, dimensionOf } from "../core/units.ts";
import { compareDecimal } from "../core/decimal.ts";
import type { RequestContext } from "../auth.ts";
import { requireRole } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { withTx } from "../db/pool.ts";

/**
 * M06 — research agent and editorial review (FR-06, NFR-06, INV-06).
 *
 * The deterministic path is fully offline: facts are extracted from typed
 * observations, a proposed note's numeric claims are validated against the
 * canonical unit/value on the observation row, and the note is drafted from a
 * bounded template. A model proposal is just untrusted JSON input — it can
 * never mark a candidate sendable; only an editor approval over the exact
 * note bytes + citation set + rule version + observation versions can.
 */

export const NOTE_MAX_CHARS = 480;

export interface Claim {
  observationId: string;
  value: string;       // proposed numeric value as text
  unit: string;        // proposed unit label
}

export interface ClaimValidation {
  ok: boolean;
  reason?: string;     // unit_mismatch | value_mismatch | unknown_observation | unknown_unit | missing_value
  detail?: Record<string, unknown>;
}

interface ObsRow {
  id: string;
  station_id: string;
  dataset: string;
  variable: string;
  observed_at: Date;
  value_text: string | null;
  value_num: string | null;
  unit: string;
  canonical_value: string | null;
  canonical_unit: string | null;
  quality: string;
  body_digest: string;
  line_locator: string | null;
  station_external_id: string;
  station_authority: string;
}

/** Offline numeric validator: is this claim faithful to the typed observation? */
export function validateClaim(claim: Claim, obs: ObsRow): ClaimValidation {
  if (!obs) return { ok: false, reason: "unknown_observation" };
  if (obs.value_num === null || obs.canonical_value === null)
    return { ok: false, reason: "missing_value", detail: { quality: obs.quality } };
  if (dimensionOf(claim.unit) === null)
    return { ok: false, reason: "unknown_unit", detail: { unit: claim.unit } };
  const target = obs.canonical_unit ?? obs.unit;
  const converted = convertUnit(claim.value, claim.unit, target);
  if (converted === null) {
    return { ok: false, reason: "unknown_unit", detail: { unit: claim.unit } };
  }
  const eq = compareDecimal(converted, String(obs.canonical_value ?? obs.value_num));
  if (eq === null) return { ok: false, reason: "value_mismatch" };
  if (eq !== 0) {
    const reason = claim.unit !== (obs.unit ?? target) ? "unit_mismatch" : "value_mismatch";
    return {
      ok: false,
      reason,
      detail: { claimed: `${claim.value} ${claim.unit}`, actual: `${obs.value_text} ${obs.unit}` },
    };
  }
  return { ok: true };
}

/** Deterministic fact line for one usable sample. Never asserts the strict claim — that is the evaluation's job. */
function factLine(obs: ObsRow): string {
  return `${obs.station_authority} ${obs.station_external_id} ${obs.variable} was ` +
    `${obs.value_text} ${obs.unit} at ${obs.observed_at.toISOString().replace("T", " ").slice(0, 16)} UTC ` +
    `[${obs.line_locator ?? "row"}].`;
}

/** Deterministic proposer — the honest default. A model can replace it; it gets validated the same way. */
export function defaultProposer(samples: ObsRow[]): Claim[] {
  return samples
    .filter((o) => o.value_num !== null)
    .map((o) => ({ observationId: o.id, value: String(o.value_num), unit: o.unit }));
}

interface Citation {
  url: string;
  locator: string;
  digest: string;
}

async function citationsFor(db: Db, deskId: string, observationIds: string[]): Promise<Citation[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT os.endpoint_url, os.line_locator, o.body_digest
     FROM observation_sources os JOIN observations o ON o.id = os.observation_id
     WHERE os.desk_id=$1 AND os.observation_id = ANY($2)
     ORDER BY os.endpoint_url, os.line_locator`,
    [deskId, observationIds],
  );
  return rows.map((r) => ({
    url: r.endpoint_url as string,
    locator: (r.line_locator as string) ?? "",
    digest: r.body_digest as string,
  }));
}

export const citationsHash = (c: Citation[]) => contentDigest(c);

/**
 * Origin grouping is deterministic: samples whose claim bytes are identical
 * (same station + variable + instant + value text) form one group. Multiple
 * distinct endpoint paths inside a group mean the paths are mirrors of one
 * origin — independence is unproven, so uncertain=true.
 */
export function originGroupKey(o: ObsRow): string {
  return sha256(`${o.station_external_id}|${o.variable}|${o.observed_at.toISOString()}|${o.value_text ?? "∅"}`).slice(0, 16);
}

export interface ResearchResult {
  candidate: Record<string, unknown>;
  validation: ClaimValidation;
  originGroup: { key: string; citationPaths: string[]; independenceUncertain: boolean };
  manualEditAvailable: boolean;
}

/** Rank: claim-changing readings first, then recency. Deterministic for replay. */
function materialityRank(samples: { comparison: boolean | null; observedAt: string; observationId: string }[]): number {
  let best = 0;
  for (const s of samples) {
    const r = (s.comparison === true ? 3 : s.comparison === false ? 1 : 0) * 1e12 + Date.parse(s.observedAt) / 1e3;
    if (r > best) best = r;
  }
  return best;
}

export async function runResearch(
  pool: pg.Pool,
  ctx: RequestContext,
  input: { ruleBindingId: string; evaluationId?: string; proposedClaims?: Claim[] },
): Promise<ResearchResult> {
  requireRole(ctx, "analyst");
  const evalRes = input.evaluationId
    ? await pool.query("SELECT * FROM evaluations WHERE id=$1 AND desk_id=$2", [input.evaluationId, ctx.deskId])
    : await pool.query(
        "SELECT * FROM evaluations WHERE rule_binding_id=$1 AND desk_id=$2 ORDER BY created_at DESC LIMIT 1",
        [input.ruleBindingId, ctx.deskId],
      );
  if (evalRes.rows.length === 0) throw notFound("evaluation");
  const ev = evalRes.rows[0];
  // an evaluation is evidence only for its own binding — never borrow one
  if (ev.rule_binding_id !== input.ruleBindingId)
    throw badRequest("evaluation does not belong to this rule binding");
  const result = ev.result as {
    samples: { observationId: string; comparison: boolean | null; observedAt: string }[];
    verdict: string;
  };
  const sampleIds = result.samples.map((s) => s.observationId);
  if (sampleIds.length === 0) throw badRequest("evaluation has no usable samples");

  const { rows: obs } = await pool.query(
    `SELECT o.*, s.external_id AS station_external_id, s.authority AS station_authority
     FROM observations o JOIN stations s ON s.id=o.station_id
     WHERE o.desk_id=$1 AND o.id = ANY($2)`,
    [ctx.deskId, sampleIds],
  );
  const byId = new Map(obs.map((o) => [o.id as string, o as ObsRow]));

  // the grounded note cites the freshest material observation (latest sample
  // that satisfies the strict predicate); with none, the freshest usable one.
  const material = result.samples.filter((s) => s.comparison === true);
  const ranked = material.length > 0 ? material : result.samples;
  const freshest = ranked.reduce((a, s) => (s.observedAt > a.observedAt ? s : a), ranked[0]!);
  const noteBody = factLine(byId.get(freshest.observationId)!);
  const noteText = noteBody.length > NOTE_MAX_CHARS ? noteBody.slice(0, NOTE_MAX_CHARS - 1) + "…" : noteBody;

  // approved scope = exactly the sentence printed: the cited observation only.
  // Mirrors of that same row keep every endpoint path; the wider research input
  // set lives in material_delta / the evaluation's inputs manifest, not here.
  const scopedIds = [freshest.observationId];
  const citations = await citationsFor(pool, ctx.deskId, scopedIds);
  const urls = [...new Set(citations.map((c) => c.url))].sort();
  const originGroup = {
    key: originGroupKey(byId.get(freshest.observationId)!),
    citationPaths: urls,
    independenceUncertain: urls.length > 1,
  };

  // untrusted proposal → typed validation (NFR-06); claims may only cite the
  // scoped observation — the note asserts exactly that sentence.
  const claims = input.proposedClaims ?? defaultProposer(
    [byId.get(freshest.observationId)!] as ObsRow[]);
  let validation: ClaimValidation = { ok: true };
  for (const c of claims) {
    if (!scopedIds.includes(c.observationId)) {
      validation = { ok: false, reason: "unknown_observation", detail: { observationId: c.observationId } };
      break;
    }
    validation = validateClaim(c, byId.get(c.observationId) as ObsRow);
    if (!validation.ok) break;
  }

  const candidate = {
    id: uuid(),
    desk_id: ctx.deskId,
    rule_binding_id: input.ruleBindingId,
    evaluation_id: ev.id,
    origin_group: originGroup.key,
    origin_group_uncertain: originGroup.independenceUncertain,
    material_delta: {
      claims, verdict: ev.verdict,
      evaluationId: ev.id, fullSampleIds: sampleIds, citedObservationIds: scopedIds,
    },
    rank: materialityRank(result.samples),
    observation_ids: scopedIds,
    citation_set: citations,
    note_text: noteText,
    note_digest: sha256(noteText),
    status: validation.ok ? "pending_review" : "draft",
    block_reason: validation.ok ? null : `model_claim_rejected:${validation.reason}`,
    created_by: ctx.principalId,
  };
  const { rows } = await pool.query(
    `INSERT INTO candidates(id, desk_id, rule_binding_id, evaluation_id, origin_group,
       origin_group_uncertain, material_delta, rank, observation_ids, citation_set,
       note_text, note_digest, status, block_reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (rule_binding_id, origin_group, note_digest, version)
     DO UPDATE SET rank=candidates.rank
     RETURNING *`,
    [
      candidate.id, ctx.deskId, input.ruleBindingId, ev.id, candidate.origin_group,
      candidate.origin_group_uncertain, JSON.stringify(candidate.material_delta),
      candidate.rank, scopedIds, JSON.stringify(citations), noteText, candidate.note_digest,
      candidate.status, candidate.block_reason, ctx.principalId,
    ],
  );
  return { candidate: rows[0], validation, originGroup, manualEditAvailable: !validation.ok };
}

async function loadCandidate(db: Db, ctx: RequestContext, id: string) {
  const { rows } = await db.query(
    "SELECT * FROM candidates WHERE id=$1 AND desk_id=$2", [id, ctx.deskId]);
  if (rows.length === 0) throw notFound("candidate");
  return rows[0];
}

/** Editor approval covers exact note bytes + citation set + rule binding + observation versions (INV-06). */
export async function approveCandidate(db: Db, ctx: RequestContext, candidateId: string) {
  requireRole(ctx, "editor");
  return withTx(db as pg.Pool, async (tx) => {
    const c = await loadCandidate(tx, ctx, candidateId);
    if (c.status !== "pending_review") throw conflict("not_reviewable", `candidate is ${c.status}`);
    const cits = c.citation_set as Citation[];
    const { rows } = await tx.query(
      `INSERT INTO approvals(id, desk_id, candidate_id, candidate_version, note_digest, citations_hash,
         rule_binding_id, observation_ids, editor_id, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uuid(), ctx.deskId, c.id, c.version, c.note_digest, citationsHash(cits),
       c.rule_binding_id, c.observation_ids, ctx.principalId, ctx.clock.now()],
    );
    await tx.query("UPDATE candidates SET status='approved' WHERE id=$1", [c.id]);
    await tx.query(
      `INSERT INTO review_events(id, desk_id, candidate_id, actor_id, action, detail)
       VALUES ($1,$2,$3,$4,'approve',$5)`,
      [uuid(), ctx.deskId, c.id, ctx.principalId,
       JSON.stringify({ note_digest: c.note_digest, citations_hash: citationsHash(cits) })],
    );
    return rows[0];
  });
}

export async function reviewCandidate(
  db: Db, ctx: RequestContext, candidateId: string,
  action: "reject" | "request_correction" | "submit_review",
) {
  const c = await loadCandidate(db, ctx, candidateId);
  if (action === "submit_review") {
    requireRole(ctx, "analyst");
    if (c.status !== "draft") throw conflict("not_draft", `candidate is ${c.status}`);
    if (c.block_reason) throw conflict("blocked", c.block_reason);
    await db.query("UPDATE candidates SET status='pending_review' WHERE id=$1", [c.id]);
  } else {
    requireRole(ctx, "editor");
    if (c.status !== "pending_review") throw conflict("not_reviewable", `candidate is ${c.status}`);
    const next = action === "reject" ? "rejected" : "correction_requested";
    await db.query("UPDATE candidates SET status=$2 WHERE id=$1", [c.id, next]);
  }
  await db.query(
    `INSERT INTO review_events(id, desk_id, candidate_id, actor_id, action) VALUES ($1,$2,$3,$4,$5)`,
    [uuid(), ctx.deskId, c.id, ctx.principalId, action],
  );
  return { id: c.id, status: action === "submit_review" ? "pending_review" : action === "reject" ? "rejected" : "correction_requested" };
}

/**
 * Any semantic or citation change forks a new candidate version and stales
 * every approval issued for the old bytes — even when the note text is kept
 * verbatim (INV-06, T-018).
 */
export async function editCandidate(
  db: Db, ctx: RequestContext, candidateId: string,
  edit: { noteText?: string; citationSet?: Citation[] },
) {
  requireRole(ctx, "analyst");
  return withTx(db as pg.Pool, async (tx) => {
    const c = await loadCandidate(tx, ctx, candidateId);
    const noteText = edit.noteText ?? (c.note_text as string);
    const citationSet = edit.citationSet ?? (c.citation_set as Citation[]);
    if (noteText.length > NOTE_MAX_CHARS) throw badRequest("note exceeds bound");
    const sameBytes = noteText === c.note_text &&
      citationsHash(citationSet) === citationsHash(c.citation_set as Citation[]);
    if (sameBytes) throw conflict("no_change", "edit must change bytes or citations");
    const id = uuid();
    const { rows } = await tx.query(
      `INSERT INTO candidates(id, desk_id, rule_binding_id, evaluation_id, origin_group,
         origin_group_uncertain, material_delta, rank, observation_ids, citation_set,
         note_text, note_digest, version, parent_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_review',$15) RETURNING *`,
      [id, ctx.deskId, c.rule_binding_id, c.evaluation_id, c.origin_group,
       c.origin_group_uncertain, c.material_delta, c.rank, c.observation_ids,
       JSON.stringify(citationSet), noteText, sha256(noteText), Number(c.version) + 1,
       c.id, ctx.principalId],
    );
    await tx.query("UPDATE candidates SET status='superseded' WHERE id=$1", [c.id]);
    await tx.query(
      "UPDATE approvals SET status='stale' WHERE candidate_id=$1 AND status='valid'", [c.id]);
    await tx.query(
      `INSERT INTO review_events(id, desk_id, candidate_id, actor_id, action, detail)
       VALUES ($1,$2,$3,$4,'edit',$5)`,
      [uuid(), ctx.deskId, id, ctx.principalId,
       JSON.stringify({ parent: c.id, version: Number(c.version) + 1 })],
    );
    return rows[0];
  });
}

/**
 * The only door to M07: an approval is sendable iff it is still valid AND its
 * covered bytes/links/rule/observations are exactly the candidate's current
 * version. Anything else throws the stable code T-018 checks.
 */
export async function assertApprovalSendable(db: Db, ctx: RequestContext, approvalId: string) {
  const { rows } = await db.query(
    `SELECT a.*, c.note_digest AS cur_note, c.citation_set AS cur_cits, c.version AS cur_ver, c.status AS c_status
     FROM approvals a JOIN candidates c ON c.id=a.candidate_id
     WHERE a.id=$1 AND a.desk_id=$2`, [approvalId, ctx.deskId]);
  if (rows.length === 0) throw notFound("approval");
  const a = rows[0];
  if (a.status !== "valid") throw conflict("approval_stale", `approval is ${a.status}`);
  if (a.c_status !== "approved")
    throw conflict("approval_stale", `candidate is ${a.c_status}`);
  if (a.note_digest !== a.cur_note || a.candidate_version !== a.cur_ver)
    throw conflict("note_mismatch", "note bytes changed since approval");
  if (a.citations_hash !== citationsHash(a.cur_cits as Citation[]))
    throw conflict("citation_mismatch", "citation set changed since approval");
  return a;
}

export async function listCandidates(db: Db, ctx: RequestContext, ruleBindingId?: string) {
  const { rows } = await db.query(
    `SELECT id, rule_binding_id, origin_group, origin_group_uncertain, rank, status,
            block_reason, note_text, note_digest, citation_set, version, parent_id, created_at
     FROM candidates WHERE desk_id=$1 ${ruleBindingId ? "AND rule_binding_id=$2" : ""}
     ORDER BY rank DESC, created_at DESC`,
    ruleBindingId ? [ctx.deskId, ruleBindingId] : [ctx.deskId],
  );
  return rows;
}

export async function getCandidate(db: Db, ctx: RequestContext, id: string) {
  const c = await loadCandidate(db, ctx, id);
  const { rows: approvals } = await db.query(
    "SELECT id, candidate_version, note_digest, citations_hash, status, approved_at FROM approvals WHERE candidate_id=$1",
    [id]);
  const { rows: events } = await db.query(
    "SELECT action, detail, at FROM review_events WHERE candidate_id=$1 ORDER BY at", [id]);
  return { ...c, approvals, reviewEvents: events };
}
