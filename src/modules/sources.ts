import { uuid } from "../core/ids.ts";
import { badRequest, notFound, unprocessable } from "../core/errors.ts";
import type { Db } from "../db/pool.ts";
import type { RequestContext } from "../auth.ts";
import { NDBC_VARIABLES } from "./ndbc.ts";

export interface SourcePolicyInput {
  stationId: string;
  dataset: string;
  variable: string;
  endpointUrl: string;
  cadenceSeconds?: number;
  canBrowse?: boolean;
  canRetain?: boolean;
  canSubmit?: boolean;
  canExport?: boolean;
  retentionUntil?: string;
  expiresAt?: string;
  verificationEvidence?: string;
}

export async function registerSourcePolicy(db: Db, ctx: RequestContext, input: SourcePolicyInput) {
  const st = await db.query("SELECT id, external_id, authority FROM stations WHERE id=$1", [
    input.stationId,
  ]);
  if (st.rows.length === 0) throw unprocessable("unknown_station", "station id not in catalogue");
  let u: URL;
  try {
    u = new URL(input.endpointUrl);
  } catch {
    throw badRequest("endpointUrl is not a valid URL");
  }
  // INV-03: an NDBC policy must fetch the exact bound station — a neighbour's file is refused.
  if (input.dataset === "realtime2") {
    const expected = `/data/realtime2/${st.rows[0].external_id}.txt`;
    if (u.hostname !== "www.ndbc.noaa.gov" || !u.pathname.endsWith(expected))
      throw unprocessable(
        "station_endpoint_mismatch",
        `realtime2 policy endpoint must be ${expected} on www.ndbc.noaa.gov`,
        { stationExternalId: st.rows[0].external_id },
      );
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw badRequest("endpointUrl scheme must be http(s); fetcher still enforces https + allowlist");
  const id = uuid();
  await db.query(
    `INSERT INTO source_policies
      (id, desk_id, station_id, dataset, variable, endpoint_url, cadence_seconds,
       can_browse, can_retain, can_submit, can_export, retention_until, expires_at,
       verification_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (desk_id, station_id, dataset, variable)
     DO UPDATE SET endpoint_url=EXCLUDED.endpoint_url, can_browse=EXCLUDED.can_browse,
       can_retain=EXCLUDED.can_retain, can_submit=EXCLUDED.can_submit,
       can_export=EXCLUDED.can_export, retention_until=EXCLUDED.retention_until,
       expires_at=EXCLUDED.expires_at, verification_evidence=EXCLUDED.verification_evidence,
       policy_version=source_policies.policy_version+1
     RETURNING id, policy_version`,
    [
      id, ctx.deskId, input.stationId, input.dataset, input.variable, input.endpointUrl,
      input.cadenceSeconds ?? 3600,
      input.canBrowse ?? true, input.canRetain ?? true, input.canSubmit ?? false,
      input.canExport ?? false,
      input.retentionUntil ? new Date(input.retentionUntil) : null,
      input.expiresAt ? new Date(input.expiresAt) : null,
      input.verificationEvidence ?? null,
    ],
  );
  const { rows } = await db.query("SELECT id, policy_version FROM source_policies WHERE id=$1", [id]);
  return rows[0];
}

export async function listSourcePolicies(db: Db, ctx: RequestContext) {
  const { rows } = await db.query(
    `SELECT sp.*, s.external_id AS station_external_id, s.authority
     FROM source_policies sp JOIN stations s ON s.id=sp.station_id
     WHERE sp.desk_id=$1 ORDER BY sp.created_at`,
    [ctx.deskId],
  );
  return rows;
}

export async function updateSourcePermissions(
  db: Db,
  ctx: RequestContext,
  policyId: string,
  perms: Partial<Pick<SourcePolicyInput, "canBrowse" | "canRetain" | "canSubmit" | "canExport">> & {
    status?: string;
  },
) {
  const { rows } = await db.query("SELECT * FROM source_policies WHERE id=$1 AND desk_id=$2", [
    policyId, ctx.deskId,
  ]);
  if (rows.length === 0) throw notFound("source policy");
  const cur = rows[0];
  await db.query(
    `UPDATE source_policies SET can_browse=$2, can_retain=$3, can_submit=$4, can_export=$5,
       status=$6, policy_version=policy_version+1
     WHERE id=$1`,
    [
      policyId,
      perms.canBrowse ?? cur.can_browse,
      perms.canRetain ?? cur.can_retain,
      perms.canSubmit ?? cur.can_submit,
      perms.canExport ?? cur.can_export,
      perms.status ?? cur.status,
    ],
  );
  return { policyId, policyVersion: Number(cur.policy_version) + 1 };
}

/** Adapter capability registry — new providers must be declared here, not invented. */
export function adapterCapabilities(name: string) {
  if (name === "ndbc-realtime2")
    return {
      supported: true,
      name,
      variables: Object.keys(NDBC_VARIABLES),
      cadenceSeconds: 3600,
      endpoints: ["https://www.ndbc.noaa.gov/data/realtime2/{station}.txt"],
      retentionNote: "public NOAA feed; store bytes only while policy permits",
    };
  if (name === "training-synthetic")
    return { supported: true, name, variables: ["air_temperature", "wave_height"], synthetic: true };
  return { supported: false, name };
}

export async function listStations(db: Db, ctx: RequestContext, q?: string) {
  const like = q ? `%${q.toLowerCase()}%` : "%";
  const { rows } = await db.query(
    `SELECT s.*, (SELECT array_agg(a.alias) FROM station_aliases a WHERE a.station_id=s.id) AS aliases
     FROM stations s
     WHERE lower(s.external_id) LIKE $1 OR lower(COALESCE(s.city_label,'')) LIKE $1
        OR EXISTS (SELECT 1 FROM station_aliases a WHERE a.station_id=s.id AND a.alias LIKE $1)
     ORDER BY s.authority, s.external_id`,
    [like],
  );
  return rows;
}
