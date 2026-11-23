import { contentDigest, uuid } from "../core/ids.ts";
import { badRequest, conflict, notFound, unprocessable } from "../core/errors.ts";
import type { Db } from "../db/pool.ts";
import type { RequestContext } from "../auth.ts";

/** Official competition card shape (Delphi markets.json entry plus competition fields). */
export interface MarketCard {
  address: string;
  question: string;
  status?: string;
  network?: string;
  competitionId?: string;
  evidenceCutoffAt: string;
  eligibilityOpensAt?: string;
  dataSources?: string[];
  /** Present only on cards that are actual competition entries. */
  entryState?: unknown;
  [k: string]: unknown;
}

function cardDigest(card: MarketCard): string {
  return contentDigest({
    address: card.address,
    question: card.question,
    evidenceCutoffAt: card.evidenceCutoffAt,
    competitionId: card.competitionId ?? "",
    network: card.network ?? "",
    dataSources: card.dataSources ?? [],
  });
}

export async function importCard(
  db: Db,
  ctx: RequestContext,
  card: MarketCard,
): Promise<{ marketVersionId: string; created: boolean }> {
  if (!card.address || !card.question || !card.evidenceCutoffAt)
    throw badRequest("card requires address, question and evidenceCutoffAt");
  const cutoff = new Date(card.evidenceCutoffAt);
  if (Number.isNaN(cutoff.getTime())) throw badRequest("evidenceCutoffAt is not a valid timestamp");
  const digest = cardDigest(card);
  const existing = await db.query(
    `SELECT id FROM market_versions
     WHERE desk_id=$1 AND competition_id=$2 AND market_address=$3 AND content_digest=$4`,
    [ctx.deskId, card.competitionId ?? "delphi", card.address, digest],
  );
  if (existing.rows.length > 0) return { marketVersionId: existing.rows[0].id as string, created: false };

  const prior = await db.query(
    `SELECT MAX(rule_revision) AS rev FROM market_versions
     WHERE desk_id=$1 AND competition_id=$2 AND market_address=$3`,
    [ctx.deskId, card.competitionId ?? "delphi", card.address],
  );
  const revision = Number(prior.rows[0].rev ?? 0) + 1;
  const id = uuid();
  const fieldProvenance = {
    question: "card.question",
    cutoff: "card.evidenceCutoffAt",
    address: "card.address",
    importedAt: ctx.clock.now().toISOString(),
  };
  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO market_versions
        (id, desk_id, network, competition_id, market_address, content_digest, rule_revision,
         source_wording, card_json, field_provenance, eligibility_opens_at, cutoff_at,
         terms_fetched_at, is_competition_entry, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, ctx.deskId, card.network ?? "delphi", card.competitionId ?? "delphi",
        card.address, digest, revision, card.question, JSON.stringify(card),
        JSON.stringify(fieldProvenance),
        card.eligibilityOpensAt ? new Date(card.eligibilityOpensAt) : null,
        cutoff, ctx.clock.now(), card.entryState !== undefined && card.entryState !== null,
        ctx.principalId,
      ],
    );
    if (revision > 1) {
      // INV-02: wording/eligibility change invalidates unsent approvals for prior versions.
      await db.query(
        `UPDATE approvals a SET status='stale'
         FROM rule_bindings rb
         JOIN market_versions mv ON mv.id = rb.market_version_id
         WHERE a.rule_binding_id = rb.id AND a.desk_id=$1
           AND mv.competition_id=$2 AND mv.market_address=$3 AND mv.id <> $4
           AND a.status='valid'
           AND NOT EXISTS (SELECT 1 FROM intents i WHERE i.approval_id=a.id)`,
        [ctx.deskId, card.competitionId ?? "delphi", card.address, id],
      );
      await db.query(
        `UPDATE rule_bindings rb SET status='superseded'
         FROM market_versions mv
         WHERE rb.market_version_id = mv.id AND rb.desk_id=$1
           AND mv.competition_id=$2 AND mv.market_address=$3 AND mv.id<>$4
           AND rb.status IN ('draft','verified')`,
        [ctx.deskId, card.competitionId ?? "delphi", card.address, id],
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
  return { marketVersionId: id, created: true };
}

export async function listMarkets(db: Db, ctx: RequestContext) {
  const { rows } = await db.query(
    `SELECT mv.id, mv.market_address, mv.competition_id, mv.source_wording, mv.cutoff_at,
            mv.rule_revision, mv.is_competition_entry, mv.created_at,
            rb.id AS binding_id, rb.status AS binding_status, rb.local_date, rb.local_zone,
            s.external_id AS station_external_id, s.authority AS station_authority
     FROM market_versions mv
     LEFT JOIN LATERAL (
       SELECT * FROM rule_bindings r WHERE r.market_version_id = mv.id
       ORDER BY r.version DESC LIMIT 1
     ) rb ON true
     LEFT JOIN stations s ON s.id = rb.station_id
     WHERE mv.desk_id=$1
     ORDER BY mv.cutoff_at ASC`,
    [ctx.deskId],
  );
  const now = ctx.clock.now();
  return rows.map((r) => ({
    id: r.id,
    marketAddress: r.market_address,
    competitionId: r.competition_id,
    question: r.source_wording,
    cutoffAt: r.cutoff_at,
    remainingMs: new Date(r.cutoff_at as string).getTime() - now.getTime(),
    ruleRevision: r.rule_revision,
    isCompetitionEntry: r.is_competition_entry,
    binding: r.binding_id
      ? {
          id: r.binding_id,
          status: r.binding_status,
          localDate: r.local_date,
          localZone: r.local_zone,
          stationExternalId: r.station_external_id,
          stationAuthority: r.station_authority,
        }
      : null,
    serverTime: now.toISOString(),
  }));
}

export async function getMarket(db: Db, ctx: RequestContext, id: string) {
  const { rows } = await db.query(
    `SELECT mv.*, rb.id AS binding_id FROM market_versions mv
     LEFT JOIN LATERAL (SELECT * FROM rule_bindings r WHERE r.market_version_id=mv.id
                        ORDER BY r.version DESC LIMIT 1) rb ON true
     WHERE mv.id=$1 AND mv.desk_id=$2`,
    [id, ctx.deskId],
  );
  if (rows.length === 0) throw notFound("market version");
  const mv = rows[0];
  const bindings = await db.query(
    `SELECT rb.*, s.external_id AS station_external_id, s.authority AS station_authority, s.city_label
     FROM rule_bindings rb LEFT JOIN stations s ON s.id=rb.station_id
     WHERE rb.market_version_id=$1 ORDER BY rb.version`,
    [id],
  );
  return { market: mv, bindings: bindings.rows };
}

export interface BindingInput {
  parentVersionId?: string;
  stationAlias?: string;
  stationId?: string;
  authority?: string;
  dataset?: string;
  variable?: string;
  operator?: string;
  threshold?: string;
  unit?: string;
  localZone?: string;
  localDate?: string;
  dayDefinition?: Record<string, unknown>;
  aggregatePolicy?: Record<string, unknown>;
  predicateDraft?: Record<string, unknown>;
  notes?: string;
}

export async function createBinding(
  db: Db,
  ctx: RequestContext,
  marketVersionId: string,
  input: BindingInput,
) {
  const mv = await db.query("SELECT * FROM market_versions WHERE id=$1 AND desk_id=$2", [
    marketVersionId, ctx.deskId,
  ]);
  if (mv.rows.length === 0) throw notFound("market version");

  if (input.parentVersionId) {
    const cur = await db.query(
      `SELECT id FROM rule_bindings WHERE market_version_id=$1 ORDER BY version DESC LIMIT 1`,
      [marketVersionId],
    );
    if (cur.rows.length > 0 && cur.rows[0].id !== input.parentVersionId)
      throw conflict("stale_parent", "binding parent version is not current", {
        currentVersionId: cur.rows[0].id,
      });
  }

  // resolve station: exact id, or a documented alias
  let stationId = input.stationId ?? null;
  let ambiguous = false;
  if (!stationId && input.stationAlias) {
    const { rows } = await db.query(
      `SELECT sa.station_id, s.external_id FROM station_aliases sa
       JOIN stations s ON s.id=sa.station_id WHERE sa.alias=$1 AND sa.documented`,
      [input.stationAlias],
    );
    if (rows.length === 0) {
      const any = await db.query("SELECT station_id FROM station_aliases WHERE alias=$1", [input.stationAlias]);
      ambiguous = true; // unknown or undocumented alias → unresolved
    } else if (rows.length > 1) {
      ambiguous = true;
    } else {
      stationId = rows[0].station_id as string;
    }
  }
  if (stationId) {
    const st = await db.query("SELECT id FROM stations WHERE id=$1", [stationId]);
    if (st.rows.length === 0) throw unprocessable("unknown_station", "station id not in catalogue");
  }

  const { rows: ver } = await db.query(
    "SELECT COALESCE(MAX(version),0)+1 AS v FROM rule_bindings WHERE market_version_id=$1",
    [marketVersionId],
  );
  const version = Number(ver[0].v);
  const id = uuid();
  const status = ambiguous ? "unresolved" : "draft";
  await db.query(
    `INSERT INTO rule_bindings
      (id, desk_id, market_version_id, version, status, authority, station_id, dataset, variable,
       operator, threshold_text, unit, local_zone, day_definition, local_date, aggregate_policy,
       predicate_draft, binding_notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      id, ctx.deskId, marketVersionId, version, status,
      input.authority ?? null, stationId, input.dataset ?? null, input.variable ?? null,
      input.operator ?? null, input.threshold ?? null, input.unit ?? null,
      input.localZone ?? null,
      input.dayDefinition ? JSON.stringify(input.dayDefinition) : null,
      input.localDate ?? null,
      input.aggregatePolicy ? JSON.stringify(input.aggregatePolicy) : null,
      JSON.stringify(input.predicateDraft ?? {}), input.notes ?? null, ctx.principalId,
    ],
  );
  return { bindingId: id, version, status };
}

/** Editor verifies a draft/unresolved binding against exact source wording. */
export async function verifyBinding(db: Db, ctx: RequestContext, bindingId: string) {
  const { rows } = await db.query("SELECT * FROM rule_bindings WHERE id=$1 AND desk_id=$2", [
    bindingId, ctx.deskId,
  ]);
  if (rows.length === 0) throw notFound("binding");
  const b = rows[0];
  if (b.status === "unresolved")
    throw unprocessable("unresolved_binding", "station alias unresolved; choose a documented station");
  const missing = ["authority", "station_id", "variable", "operator", "threshold_text", "unit", "local_zone", "day_definition", "local_date"].filter(
    (k) => b[k] === null || b[k] === undefined,
  );
  if (missing.length) throw unprocessable("incomplete_binding", "binding fields missing", { missing });
  await db.query(
    "UPDATE rule_bindings SET status='verified', verified_by=$2, verified_at=$3 WHERE id=$1",
    [bindingId, ctx.principalId, ctx.clock.now()],
  );
  return { bindingId, status: "verified" };
}
