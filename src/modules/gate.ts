import type { Db } from "../db/pool.ts";
import type { RequestContext } from "../auth.ts";

export interface GateResult {
  eligible: boolean;
  reasons: string[];
  /** The exact server timestamp the decision used. */
  timestampUsed: string;
  detail?: Record<string, unknown>;
}

/**
 * Dispatch eligibility gate, re-checked immediately before every send.
 * Fails closed: unknown terms/cutoffs, missing rights, or unsynchronized clocks block.
 */
export async function checkDispatchEligibility(
  db: Db,
  ctx: RequestContext,
  opts: { marketVersionId?: string; bindingId?: string; citationUrls?: string[] },
): Promise<GateResult> {
  const reasons: string[] = [];
  const now = ctx.clock.now();
  const timestampUsed = now.toISOString();

  const { rows } = await db.query(
    `SELECT mv.id AS mv_id, mv.cutoff_at, mv.eligibility_opens_at, mv.is_competition_entry,
            mv.market_address, mv.rule_revision, mv.competition_id, mv.card_json,
            rb.id AS rb_id, rb.status AS rb_status, rb.station_id, rb.dataset, rb.variable
     FROM market_versions mv
     LEFT JOIN LATERAL (SELECT * FROM rule_bindings r WHERE r.market_version_id=mv.id
                        ORDER BY r.version DESC LIMIT 1) rb ON true
     WHERE mv.desk_id=$1 AND ($2::uuid IS NULL OR mv.id=$2) AND ($3::uuid IS NULL OR rb.id=$3)
     LIMIT 1`,
    [ctx.deskId, opts.marketVersionId ?? null, opts.bindingId ?? null],
  );
  if (rows.length === 0) {
    return { eligible: false, reasons: ["market_not_found"], timestampUsed };
  }
  const r = rows[0];

  // current market revision: only the latest imported revision may dispatch
  const cur = await db.query(
    `SELECT MAX(rule_revision) AS rev FROM market_versions
     WHERE desk_id=$1 AND competition_id=$2 AND market_address=$3`,
    [ctx.deskId, r.competition_id, r.market_address],
  );
  if (Number(cur.rows[0].rev) > Number(r.rule_revision)) reasons.push("stale_market_revision");

  if (r.eligibility_opens_at && now.getTime() < new Date(r.eligibility_opens_at as string).getTime())
    reasons.push("not_yet_open");
  if (!r.is_competition_entry) reasons.push("not_competition_entry");
  else {
    // provider-reported entry state on the card can refuse submission
    const es = (r.card_json as { entryState?: { canSubmit?: boolean; remainingOnMarket?: number; reason?: string } })
      .entryState;
    if (es && (es.canSubmit === false || es.remainingOnMarket === 0))
      reasons.push("entry_not_submittable");
  }
  if (r.cutoff_at === null) {
    reasons.push("cutoff_unknown");
  } else if (now.getTime() >= new Date(r.cutoff_at as string).getTime()) {
    reasons.push("cutoff_passed");
  }
  if (!r.rb_id) reasons.push("no_binding");
  else if (r.rb_status !== "verified") reasons.push(`binding_${r.rb_status}`);

  // submission rights: a source policy for the bound station must allow can_submit
  if (r.station_id) {
    const { rows: policies } = await db.query(
      `SELECT endpoint_url, can_submit, expires_at, status FROM source_policies
       WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4`,
      [ctx.deskId, r.station_id, r.dataset, r.variable],
    );
    const permitted = (p: typeof policies[number]) =>
      p.status === "active" && p.can_submit && (!p.expires_at || new Date(p.expires_at) > now);
    const cited = opts.citationUrls;
    const missing = cited && (!cited.length || cited.some(url => !policies.some(p => p.endpoint_url === url)));
    if (!policies.length || missing) reasons.push("no_source_rights");
    else {
      const selected = cited ? policies.filter(p => cited.includes(p.endpoint_url)) : policies;
      const eligible = cited ? selected.every(permitted) : selected.some(permitted);
      if (!eligible) {
        if (selected.some(p => p.expires_at && new Date(p.expires_at) <= now)) reasons.push("rights_expired");
        if (selected.some(p => !p.can_submit || p.status !== "active")) reasons.push("submission_rights_withdrawn");
      }
    }
  }

  // recovery hold (restored backups hold sends until reconciliation resolves)
  const hold = await db.query(
    "SELECT value FROM desk_settings WHERE desk_id=$1 AND key='recovery.hold'",
    [ctx.deskId],
  );
  if (hold.rows.length > 0 && (hold.rows[0].value as { active?: boolean }).active)
    reasons.push("recovery_hold");

  return {
    eligible: reasons.length === 0,
    reasons,
    timestampUsed,
    detail: { marketAddress: r.market_address, cutoffAt: r.cutoff_at },
  };
}
