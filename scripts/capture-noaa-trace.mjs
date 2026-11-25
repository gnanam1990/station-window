/**
 * T-028 real source trace: fetches the live NOAA/NDBC realtime2 feed for
 * station 46002 through the normal ingest path, replays the retained sample,
 * demonstrates an accepted vs rejected station binding, and records the
 * evidence-class labels — all written to evidence/t028-noaa-trace.json.
 *
 *   node --import tsx scripts/capture-noaa-trace.mjs
 *
 * Requires: compose postgres up, `npm run migrate`, `npm run cli -- seed --desk demo`,
 *           `npm run cli -- catalog`. Read-only public GET; no credentials.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { SystemClock } from "../src/core/clock.ts";
import { seedDesk } from "../src/seed.ts";
import { seedCatalog } from "../src/modules/catalog.ts";
import { registerSourcePolicy } from "../src/modules/sources.ts";
import { ingestSource, ingestBody, loadPolicy } from "../src/modules/ingest.ts";
import { evaluate } from "../src/modules/evaluate.ts";
import { importCard, createBinding, verifyBinding } from "../src/modules/markets.ts";
import { contentDigest, sha256 } from "../src/core/ids.ts";

const clock = new SystemClock();
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const commit = execSync("git rev-parse --short HEAD").toString().trim();
const evidence = { generatedAt: null, commit, steps: {} };

async function ctx(role) {
  const { rows } = await pool.query(
    `SELECT d.id AS desk_id, p.id AS principal_id, m.role
     FROM desks d JOIN principals p ON p.desk_id=d.id
     JOIN memberships m ON m.principal_id=p.id AND m.desk_id=d.id
     WHERE d.slug='noaa-trace' AND m.role=$1 AND p.active AND m.active LIMIT 1`,
    [role]);
  return { deskId: rows[0].desk_id, deskSlug: "noaa-trace",
    principalId: rows[0].principal_id, role: rows[0].role,
    authKind: "api_key", clock };
}

const NDBC_STATION = "46002";
const NDBC_URL = `https://www.ndbc.noaa.gov/data/realtime2/${NDBC_STATION}.txt`;

try {
  await migrate(pool);
  await seedDesk(pool, "noaa-trace", config.mode);
  await seedCatalog(pool);
  const { rows: st } = await pool.query(
    "SELECT id FROM stations WHERE external_id=$1", [NDBC_STATION]);
  const stationId = st[0].id;
  const { rows: stWrong } = await pool.query(
    "SELECT id FROM stations WHERE external_id='46050'");
  const editor = await ctx("editor");
  const analyst = await ctx("analyst");

  // 1. accepted vs rejected station binding at source-policy level (INV-03)
  const accepted = await registerSourcePolicy(pool, editor, {
    stationId, dataset: "realtime2", variable: "WVHT",
    endpointUrl: NDBC_URL, canSubmit: false, canRetain: true,
  });
  let rejected;
  try {
    await registerSourcePolicy(pool, editor, {
      stationId: stWrong[0].id, dataset: "realtime2", variable: "WVHT",
      endpointUrl: NDBC_URL,
    });
    rejected = { status: "ERROR-ACCEPTED" };
  } catch (e) {
    rejected = { status: "rejected", code: e.code ?? "unknown", station: "46050", endpoint: NDBC_URL };
  }
  assert.equal(rejected.code, "station_endpoint_mismatch");
  evidence.steps.stationBinding = {
    accepted: { station: NDBC_STATION, endpoint: NDBC_URL, policyId: accepted.id },
    rejected,
  };

  // 2. live capture: real read-only fetch of the current NOAA feed
  const live = await ingestSource(pool, config, clock, accepted.id);
  const { rows: snap } = await pool.query(
    `SELECT url, fetched_at, digest, byte_length, http_status, parser_version, evidence_class
     FROM snapshots WHERE id=$1`,
    [live.snapshotId]);
  assert.equal(snap[0].evidence_class, "live");
  evidence.steps.liveCapture = {
    ...snap[0], inserted: live.inserted, deduplicated: live.deduped,
    note: "real remote fetch — evidence_class=live",
  };

  // 3. historical replay: the SAME bytes replayed as a retained sample are a
  //    different class — the two labels can never merge (INV-10)
  const { rows: raw } = await pool.query(
    "SELECT content FROM snapshots WHERE id=$1", [live.snapshotId]);
  const body = raw[0].content.toString();
  const policy = await loadPolicy(pool, accepted.id);
  const replay = await ingestBody(pool, clock, policy, body, {
    url: `replay://${live.snapshotId}`, httpStatus: 200, headers: {},
    fetchedAt: clock.now(), evidenceClass: "historical_replay",
  });
  const { rows: [retained] } = await pool.query(
    "SELECT evidence_class, digest, content FROM snapshots WHERE id=$1", [replay.snapshotId]);
  const digestMatches = retained.digest === sha256(retained.content) &&
    retained.digest === snap[0].digest && retained.digest === sha256(raw[0].content);
  assert.ok(digestMatches);
  assert.equal(retained.evidence_class, "historical_replay");
  assert.notEqual(live.snapshotId, replay.snapshotId);
  assert.equal(replay.inserted, 0);
  evidence.steps.historicalReplay = {
    fromSnapshot: live.snapshotId, replaySnapshot: replay.snapshotId,
    evidenceClass: retained.evidence_class, digest: retained.digest, digestMatches,
    inserted: replay.inserted, deduplicated: replay.deduped,
    note: "retained bytes re-fed as a dated sample — evidence_class=historical_replay",
  };

  // 4. deterministic replay of evaluation at one asOf boundary
  const { marketVersionId } = await importCard(pool, editor, {
    address: `0xT028-TRACE-${commit}`,
    question: "Will 46002 significant wave height exceed 4 m on the card date?",
    competitionId: "trace",
    evidenceCutoffAt: "2999-01-01T00:00:00Z",
    network: "local-practice",
  });
  const { rows: [latest] } = await pool.query(
    "SELECT max(observed_at) AS at FROM observations WHERE desk_id=$1 AND station_id=$2 AND dataset=$3 AND variable=$4 AND value_num IS NOT NULL",
    [editor.deskId, stationId, "realtime2", "WVHT"]);
  assert.ok(latest.at, "NOAA feed contained no usable wave height");
  const binding = await createBinding(pool, editor, marketVersionId, {
    stationId, authority: "NOAA/NDBC",
    dataset: "realtime2", variable: "WVHT",
    operator: "gt", threshold: "4.0", unit: "m",
    localZone: "UTC", localDate: latest.at.toISOString().slice(0, 10),
    dayDefinition: { type: "civil" },
  });
  await verifyBinding(pool, editor, binding.bindingId);
  const asOf = clock.now();
  const e1 = await evaluate(pool, analyst, { ruleBindingId: binding.bindingId, asOf });
  const e2 = await evaluate(pool, analyst, { ruleBindingId: binding.bindingId, asOf });
  function evaluationSummary({ evaluationId, ...decision }) {
    assert.ok(evaluationId && decision.inputsDigest && decision.samples.some(sample => sample.value !== null));
    return { verdict: decision.verdict, sampleCount: decision.samples.length,
      inputsDigest: decision.inputsDigest, digest: contentDigest(decision) };
  }
  const first = evaluationSummary(e1);
  const second = evaluationSummary(e2);
  assert.deepEqual(first, second);
  evidence.steps.evaluationReplay = {
    asOf: asOf.toISOString(), first, second, identical: first.digest === second.digest,
  };

  evidence.generatedAt = new Date().toISOString();
  evidence.note = "T-028: live NOAA capture + historical replay + binding accept/reject. "
    + "Not a live competition judgment — see liveCompetition block in the integration report.";
  mkdirSync(join(process.cwd(), "evidence"), { recursive: true });
  writeFileSync(join(process.cwd(), "evidence/t028-noaa-trace.json"),
    JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ written: "evidence/t028-noaa-trace.json",
    rejectedBinding: evidence.steps.stationBinding.rejected,
    liveInserted: live.inserted, replayIdentical: evidence.steps.evaluationReplay.identical }, null, 2));
} finally {
  await pool.end();
}
