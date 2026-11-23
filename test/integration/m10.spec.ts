import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeTestEnv, seed, type TestEnv } from "../helpers.ts";
import { makeFixtureTransport } from "../../src/modules/delphi.ts";
import type { EvalResult } from "../../src/modules/evaluate.ts";
import { integrationReport, liveProofStatus } from "../../src/modules/report.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv({
    config: { transportOverride: makeFixtureTransport(), liveSubmissionsEnabled: true },
  });
  const { seedCatalog } = await import("../../src/modules/catalog.ts");
  await seedCatalog(env.pool);
});
afterAll(async () => env.close());

const NDBC_FEED = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 30 01 50 180 18.0 24.0   7.5    11   8.7 200  999.0    MM    MM    MM   MM   MM    MM
2026 11 30 01 40 180 19.0 24.0   7.5    MM   8.7 200  995.7    MM    MM    MM   MM   MM    MM
2026 11 30 01 30 180 18.0 23.0    MM    MM    MM  MM  995.5    MM    MM    MM   MM   MM    MM
`;

async function stationId(externalId: string) {
  const { rows } = await env.pool.query("SELECT id FROM stations WHERE external_id=$1", [externalId]);
  return rows[0].id as string;
}

async function boundNoaaDesk(keys: Awaited<ReturnType<typeof seed>>, address: string) {
  const s46002 = await stationId("46002");
  const imp = await api(env, "POST", "/api/markets/import", {
    key: keys.keys.editor,
    payload: {
      card: {
        address, question: "wave height?", competitionId: "arena-1",
        evidenceCutoffAt: "2999-01-01T00:00:00Z",
        entryState: { canSubmit: true, remainingOnMarket: 3 },
      },
    },
  });
  const mvId = (imp.body as { marketVersionId: string }).marketVersionId;
  const bind = await api(env, "POST", `/api/markets/${mvId}/bindings`, {
    key: keys.keys.editor,
    payload: {
      stationId: s46002, authority: "NOAA/NDBC", dataset: "realtime2", variable: "WVHT",
      operator: "gt", threshold: "4.0", unit: "m",
      localZone: "UTC", localDate: "2026-11-30", dayDefinition: { type: "civil" },
    },
  });
  const bindingId = (bind.body as { bindingId: string }).bindingId;
  await api(env, "POST", `/api/bindings/${bindingId}/verify`, { key: keys.keys.editor });
  const pol = await api(env, "POST", "/api/sources", {
    key: keys.keys.editor,
    payload: {
      stationId: s46002, dataset: "realtime2", variable: "WVHT",
      endpointUrl: `https://www.ndbc.noaa.gov/data/realtime2/46002.txt?mkt=${address}`,
      canSubmit: true,
    },
  });
  return { bindingId, policyId: (pol.body as { id: string }).id };
}

describe("T-028 retained NOAA sample replays deterministically; evidence labelled", () => {
  it("imported bytes land as historical_replay; two evaluations at one asOf agree", async () => {
    const keys = await seed(env, "desk-t028");
    const { bindingId, policyId } = await boundNoaaDesk(keys, "0xMKT-T028");
    const ing = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: NDBC_FEED },
    });
    expect(ing.status).toBe(200);

    // historical and live captures must never share a label (INV-10)
    const { rows: cls } = await env.pool.query(
      "SELECT DISTINCT evidence_class FROM snapshots WHERE desk_id=$1", [keys.deskId]);
    expect(cls.map((c) => c.evidence_class)).toEqual(["historical_replay"]);

    // replay: same binding, same asOf → identical verdict and result manifest
    const e1 = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const e2 = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    expect([e1.status, e2.status]).toEqual([200, 200]);
    const { evaluationId: firstId, ...first } = e1.body as EvalResult;
    const { evaluationId: secondId, ...second } = e2.body as EvalResult;
    expect(firstId).not.toEqual(secondId);
    expect(first.samples.some(sample => sample.value !== null)).toBe(true);
    expect(first.inputsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
  });
});

describe("T-029 live competition proof is BLOCKED without authorized account", () => {
  it("dev-mode + fixture transport reports BLOCKED with exact missing dependencies", async () => {
    const status = liveProofStatus(env.config);
    expect(status.status).toBe("blocked");
    // a fixture transport override is not live authority — mode still blocks
    expect(status.missing.join(" ")).toContain("competition");
    expect(status.missing.join(" ")).toContain("authorized account");

    const keys = await seed(env, "desk-t029");
    const rep = await api(env, "GET", "/api/ops/report", { key: keys.keys.auditor });
    expect(rep.status).toBe(200);
    const ev = (rep.body as { evidence: { liveCompetition: { status: string; missing: string[]; note?: string } } })
      .evidence.liveCompetition;
    expect(ev.status).toBe("BLOCKED");
    expect(ev.missing.length).toBeGreaterThan(0);
    expect(JSON.stringify(rep.body)).not.toMatch(/judged.*live|live.*judged/i);
  });
});

describe("T-030 redacted integration report: versions, times, outcomes, no secrets", () => {
  it("report carries versions+times+outcomes and leaks no keys or prose", async () => {
    const keys = await seed(env, "desk-t030");
    const { bindingId, policyId } = await boundNoaaDesk(keys, "0xMKT-T030");
    const ing = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: NDBC_FEED },
    });
    expect(ing.status).toBe(200);
    await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const run = await api(env, "POST", "/api/research/run", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const noteText = (run.body as { candidate: { note_text: string } }).candidate.note_text;

    const rep = await api(env, "GET", "/api/ops/report", { key: keys.keys.auditor });
    expect(rep.status).toBe(200);
    const r = rep.body as {
      versions: Record<string, unknown>; times: Record<string, unknown>;
      outcomes: { observations: { total: number }; snapshotsByEvidenceClass: Record<string, number> };
      evidence: { historicalReplay: { snapshots: number } };
    };
    expect(r.versions.app).toBeTruthy();
    expect(r.versions.node).toBe(process.version);
    expect(r.versions.ndbcParser).toBeTruthy();
    expect(Number(r.versions.schema)).toBeGreaterThanOrEqual(9);
    expect(r.times.generatedAt).toBeTruthy();
    expect(r.outcomes.observations.total).toBeGreaterThan(0);
    expect(r.outcomes.snapshotsByEvidenceClass.historical_replay).toBe(1);
    expect(r.evidence.historicalReplay.snapshots).toBe(1);

    const json = JSON.stringify(rep.body);
    for (const k of Object.values(keys.keys)) expect(json).not.toContain(k as string);
    expect(json).not.toContain("api_key_hash");
    expect(json).not.toContain(noteText);
    // auditor-only, like export
    const denied = await api(env, "GET", "/api/ops/report", { key: keys.keys.worker });
    expect(denied.status).toBe(403);
  });
});
