import { applyOperator, type Operator } from "../core/decimal.ts";
import { contentDigest, uuid } from "../core/ids.ts";
import { localDayWindow, type DayDefinition } from "../core/tz.ts";
import { convertUnit } from "../core/units.ts";
import { notFound, unprocessable } from "../core/errors.ts";
import type { Db } from "../db/pool.ts";
import type { RequestContext } from "../auth.ts";

export interface EvalInput {
  ruleBindingId: string;
  asOf?: Date;
}

export interface EvaluatedSample {
  observationId: string;
  observedAt: string;
  firstSeenAt: string;
  publishedAt: string | null;
  value: string | null;
  unit: string;
  quality: string;
  comparison: boolean | null; // operator(value, threshold); null = not computable
  interimFact: boolean;
  reason?: string;
}

export interface EvalResult {
  evaluationId: string;
  verdict:
    | "interim_fact"   // at least one eligible dated sample
    | "final"          // authority's declared final aggregate
    | "incomplete"     // window evidence insufficient; no official final
    | "unresolved"     // rule cannot be evaluated (unsupported definition etc.)
    | "no_evidence";
  window: { startUtc: string; endUtc: string; kind: string; localDate: string; zone: string } | null;
  samples: EvaluatedSample[];
  excluded: { observationId: string | null; reason: string }[];
  claim: { operator: string; threshold: string; unit: string; variable: string } | null;
  claimSupported: boolean | null; // strict predicate over interim samples
  finalAggregate: { method: string; value: string | null; coverage: number | null } | null;
  reasons: string[];
  asOf: string;
  inputsDigest: string;
}

/**
 * Typed window evaluation over immutable inputs at a declared as-of instant.
 * Replay is reproducible: same rule + input set + as_of → same result (INV-04/05).
 */
export async function evaluate(db: Db, ctx: RequestContext, input: EvalInput): Promise<EvalResult> {
  const asOf = input.asOf ?? ctx.clock.now();
  const { rows } = await db.query(
    `SELECT rb.*, rb.local_date::text AS local_date_text,
            s.external_id AS station_external_id, s.authority AS station_authority
     FROM rule_bindings rb LEFT JOIN stations s ON s.id=rb.station_id
     WHERE rb.id=$1 AND rb.desk_id=$2`,
    [input.ruleBindingId, ctx.deskId],
  );
  if (rows.length === 0) throw notFound("rule binding");
  const b = rows[0];
  const reasons: string[] = [];
  const excluded: EvalResult["excluded"] = [];

  if (!b.station_id || !b.variable || !b.local_zone || !b.local_date || !b.day_definition) {
    const unresolved: EvalResult = {
      evaluationId: "", verdict: "unresolved", window: null, samples: [], excluded,
      claim: null, claimSupported: null, finalAggregate: null,
      reasons: ["binding_incomplete"], asOf: asOf.toISOString(), inputsDigest: "",
    };
    return unresolved;
  }

  const win = localDayWindow(
    b.local_zone as string,
    b.local_date_text as string,
    b.day_definition as DayDefinition,
  );
  if (!win) {
    return {
      evaluationId: "", verdict: "unresolved", window: null, samples: [], excluded,
      claim: null, claimSupported: null, finalAggregate: null,
      reasons: ["unsupported_day_definition"], asOf: asOf.toISOString(), inputsDigest: "",
    };
  }
  const window = {
    startUtc: win.startUtc.toISOString(),
    endUtc: win.endUtc.toISOString(),
    kind: win.kind,
    localDate: b.local_date_text as string,
    zone: b.local_zone as string,
  };

  // latest immutable version per observed time, known by as_of, bound station ONLY (INV-03/04)
  const obs = await db.query(
    `SELECT DISTINCT ON (o.observed_at) o.*
     FROM observations o
     WHERE o.desk_id=$1 AND o.station_id=$2 AND o.dataset=$3 AND o.variable=$4
       AND o.first_seen_at <= $5 AND NOT o.quarantined
     ORDER BY o.observed_at, o.seq DESC`,
    [ctx.deskId, b.station_id, b.dataset, b.variable, asOf],
  );

  const samples: EvaluatedSample[] = [];
  let officialFinal: EvaluatedSample | null = null;
  for (const o of obs.rows) {
    const inWindow = new Date(o.observed_at) >= win.startUtc && new Date(o.observed_at) < win.endUtc;
    if (!inWindow) {
      excluded.push({ observationId: o.id, reason: "outside_day_window" });
      continue;
    }
    let value: string | null = null;
    if (o.canonical_value !== null) {
      value = String(o.canonical_value);
    } else if (o.value_num !== null) {
      const c = convertUnit(String(o.value_num), o.unit as string, b.unit as string);
      if (c === null) {
        excluded.push({ observationId: o.id, reason: "unsupported_unit_conversion" });
        continue;
      }
      value = c;
    }
    const comparison =
      value !== null && b.operator && b.threshold_text !== null
        ? applyOperator(b.operator as Operator, value, String(b.threshold_text))
        : null;
    const usable = o.quality === "good" && value !== null;
    if (!usable)
      excluded.push({ observationId: o.id, reason: `not_usable:${o.quality}` });
    const s: EvaluatedSample = {
      observationId: o.id,
      observedAt: new Date(o.observed_at).toISOString(),
      firstSeenAt: new Date(o.first_seen_at).toISOString(),
      publishedAt: o.published_at ? new Date(o.published_at).toISOString() : null,
      value,
      unit: b.unit as string,
      quality: o.quality,
      comparison,
      interimFact: usable,
      reason: usable ? undefined : `not_usable:${o.quality}`,
    };
    if (o.is_official_final && usable) officialFinal = s;
    samples.push(s);
  }

  // wrong-station observations are reported, never considered (INV-03)
  const foreign = await db.query(
    `SELECT o.id, s.external_id FROM observations o JOIN stations s ON s.id=o.station_id
     WHERE o.desk_id=$1 AND o.station_id<>$2 AND o.dataset=$3 AND o.variable=$4
       AND o.observed_at >= $5 AND o.observed_at < $6 AND o.first_seen_at <= $7`,
    [ctx.deskId, b.station_id, b.dataset, b.variable, win.startUtc, win.endUtc, asOf],
  );
  for (const f of foreign.rows)
    excluded.push({ observationId: f.id, reason: `wrong_station:${f.external_id}` });

  const usable = samples.filter((s) => s.interimFact);
  const claim = b.operator && b.threshold_text !== null
    ? { operator: b.operator, threshold: String(b.threshold_text), unit: b.unit, variable: b.variable }
    : null;

  // strict claim evaluation over interim samples: any usable sample proving the
  // predicate supports the dated claim; falsity never "supports".
  const claimSupported = claim
    ? usable.length > 0
      ? usable.some((s) => s.comparison === true)
      : null
    : null;

  // official aggregate path (INV-05)
  const pol = (b.aggregate_policy ?? {}) as {
    method?: string;
    aggregate?: "max" | "min" | "mean";
    cadenceMinutes?: number;
    minCoverage?: number;
  };
  let finalAggregate: EvalResult["finalAggregate"] = null;
  let verdict: EvalResult["verdict"];
  if (pol.method === "official_daily_publication") {
    if (officialFinal) {
      finalAggregate = { method: pol.method, value: officialFinal.value, coverage: 1 };
      verdict = "final";
    } else {
      verdict = usable.length > 0 ? "incomplete" : "no_evidence";
      reasons.push("no_official_final");
    }
  } else if (pol.method === "sample_aggregate" && pol.aggregate && pol.cadenceMinutes) {
    const expected = Math.max(
      1,
      Math.floor((win.endUtc.getTime() - win.startUtc.getTime()) / (pol.cadenceMinutes * 60_000)),
    );
    const coverage = usable.length / expected;
    if (coverage >= (pol.minCoverage ?? 1)) {
      const vals = usable.map((s) => Number(s.value));
      const agg =
        pol.aggregate === "max" ? Math.max(...vals)
        : pol.aggregate === "min" ? Math.min(...vals)
        : vals.reduce((a, c) => a + c, 0) / vals.length;
      finalAggregate = { method: `${pol.method}:${pol.aggregate}`, value: String(agg), coverage };
      verdict = "final";
    } else {
      verdict = usable.length > 0 ? "incomplete" : "no_evidence";
      reasons.push(`insufficient_coverage:${coverage.toFixed(3)}`);
    }
  } else {
    // no declared aggregate method → interim only
    verdict = usable.length > 0 ? "interim_fact" : "no_evidence";
    if (usable.length > 0) reasons.push("interim_only_no_final_method");
  }
  if (verdict === "no_evidence") reasons.push("no_usable_observations");

  const inputsManifest = {
    ruleBindingId: b.id,
    bindingVersion: b.version,
    asOf: asOf.toISOString(),
    window,
    observationIds: samples.map((s) => s.observationId),
    digests: obs.rows.map((o) => o.body_digest),
  };
  const id = uuid();
  const result: EvalResult = {
    evaluationId: id,
    verdict, window, samples, excluded, claim, claimSupported, finalAggregate,
    reasons, asOf: asOf.toISOString(), inputsDigest: contentDigest(inputsManifest),
  };
  await db.query(
    `INSERT INTO evaluations(id, desk_id, rule_binding_id, as_of, inputs_manifest, result, verdict, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, ctx.deskId, b.id, asOf, JSON.stringify(inputsManifest), JSON.stringify(result), verdict, ctx.principalId],
  );
  return result;
}
