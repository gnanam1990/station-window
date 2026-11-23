import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeTestEnv, seed, type TestEnv } from "../helpers.ts";
import { localDayWindow } from "../../src/core/tz.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
  const { seedCatalog } = await import("../../src/modules/catalog.ts");
  await seedCatalog(env.pool);
});
afterAll(async () => {
  await env.close();
});

async function stationId(externalId: string): Promise<string> {
  const { rows } = await env.pool.query("SELECT id FROM stations WHERE external_id=$1", [externalId]);
  return rows[0].id as string;
}

async function setupBinding(
  keys: Awaited<ReturnType<typeof seed>>,
  opts: {
    address: string; stationExternal: string; variable?: string; operator?: string;
    threshold?: string; unit?: string; zone?: string; localDate: string;
    dayDefinition?: Record<string, unknown>; aggregatePolicy?: Record<string, unknown>;
  },
) {
  const imp = await api(env, "POST", "/api/markets/import", {
    key: keys.keys.editor,
    payload: {
      card: {
        address: opts.address, question: "practice question?", competitionId: "arena-1",
        evidenceCutoffAt: "2999-01-01T00:00:00Z", entryState: { canSubmit: true },
      },
    },
  });
  const mvId = (imp.body as { marketVersionId: string }).marketVersionId;
  const stId = await stationId(opts.stationExternal);
  const bind = await api(env, "POST", `/api/markets/${mvId}/bindings`, {
    key: keys.keys.editor,
    payload: {
      stationId: stId, authority: "training-source", dataset: "synthetic",
      variable: opts.variable ?? "air_temperature",
      operator: opts.operator ?? "lt", threshold: opts.threshold ?? "0.0",
      unit: opts.unit ?? "degC", localZone: opts.zone ?? "Asia/Shanghai",
      localDate: opts.localDate,
      dayDefinition: opts.dayDefinition ?? { type: "civil" },
      aggregatePolicy: opts.aggregatePolicy,
    },
  });
  const bindingId = (bind.body as { bindingId: string }).bindingId;
  await api(env, "POST", `/api/bindings/${bindingId}/verify`, { key: keys.keys.editor });
  const reg = await api(env, "POST", "/api/sources", {
    key: keys.keys.editor,
    payload: {
      stationId: stId, dataset: "synthetic", variable: opts.variable ?? "air_temperature",
      endpointUrl: "https://training.example/feed",
    },
  });
  return { bindingId, policyId: (reg.body as { id: string }).id, stationUuid: stId };
}

const synthLine = (observedAt: string, value: string, variable = "air_temperature") =>
  JSON.stringify({ observedAt, fields: { [variable]: value } });

async function ingest(keys: Awaited<ReturnType<typeof seed>>, policyId: string, lines: string[]) {
  const r = await api(env, "POST", "/api/observations/import", {
    key: keys.keys.worker,
    payload: { sourcePolicyId: policyId, content: lines.join("\n") },
  });
  return r.body as { inserted: number };
}

describe("T-013 zero reading, strict subzero claim, wrong station", () => {
  it("evaluates the rule-cases vector exactly", async () => {
    const keys = await seed(env, "desk-t013");
    const { bindingId, policyId } = await setupBinding(keys, {
      address: "0xMKT-T013", stationExternal: "EXAMPLE-A", localDate: "2026-11-30",
      aggregatePolicy: { method: "official_daily_publication" },
    });
    env.clock.set(new Date("2026-11-30T02:00:00Z"));
    await ingest(keys, policyId, [
      synthLine("2026-11-30T01:00:00Z", "0.0"),
      synthLine("2026-11-30T01:10:00Z", "-0.1"),
      synthLine("2026-11-30T16:00:00Z", "-1"),
    ]);
    // wrong station: EXAMPLE-B at -3.0 inside the window
    const bReg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: await stationId("EXAMPLE-B"), dataset: "synthetic",
        variable: "air_temperature", endpointUrl: "https://training.example/feed-b",
      },
    });
    await ingest(keys, (bReg.body as { id: string }).id, [
      synthLine("2026-11-30T02:00:00Z", "-3.0"),
    ]);
    // delayed first-seen: observed 12:30 but first known 2026-12-01 → excluded at replay as-of
    env.clock.set(new Date("2026-12-01T01:00:00Z"));
    await ingest(keys, policyId, [synthLine("2026-11-30T12:30:00Z", "-1.0")]);

    const res = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst,
      payload: { ruleBindingId: bindingId, asOf: "2026-11-30T13:00:00Z" },
    });
    expect(res.status).toBe(200);
    const r = res.body as {
      verdict: string;
      window: { startUtc: string; endUtc: string };
      samples: { observedAt: string; value: string; comparison: boolean | null; interimFact: boolean }[];
      excluded: { reason: string }[];
      claimSupported: boolean | null;
    };
    expect(r.window.startUtc).toBe("2026-11-29T16:00:00.000Z");
    expect(r.window.endUtc).toBe("2026-11-30T16:00:00.000Z");
    const at = (iso: string) => r.samples.find((s) => s.observedAt.startsWith(iso));
    // 0.0 is a timely factual reading but the strict below-zero claim is false for it
    expect(at("2026-11-30T01:00")?.interimFact).toBe(true);
    expect(at("2026-11-30T01:00")?.comparison).toBe(false);
    // -0.1 is strictly below zero
    expect(at("2026-11-30T01:10")?.comparison).toBe(true);
    // end-exclusive boundary
    expect(r.excluded.map((e) => e.reason)).toContain("outside_day_window");
    // wrong station reported but never counted
    expect(r.excluded.some((e) => e.reason === "wrong_station:EXAMPLE-B")).toBe(true);
    // delayed first-seen excluded from desk-known replay (absent, not flagged)
    expect(at("2026-11-30T12:30")).toBeUndefined();
    expect(r.excluded.filter((e) => e.reason === "outside_day_window").length).toBe(1);
    // strict claim supported by the -0.1 interim reading; no official final → incomplete
    expect(r.claimSupported).toBe(true);
    expect(r.verdict).toBe("incomplete");
  });
});

describe("T-014 DST 23/25-hour windows and excluded upper bound", () => {
  it("resolves spring-forward 23h and fall-back 25h days", () => {
    const spring = localDayWindow("America/New_York", "2026-03-08", { type: "civil" })!;
    expect((spring.endUtc.getTime() - spring.startUtc.getTime()) / 3600_000).toBe(23);
    const fall = localDayWindow("America/New_York", "2026-11-01", { type: "civil" })!;
    expect((fall.endUtc.getTime() - fall.startUtc.getTime()) / 3600_000).toBe(25);
    expect(fall.startUtc.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fall.endUtc.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    // climatological day also resolves; unknown definitions are UNRESOLVED
    const climo = localDayWindow("Asia/Shanghai", "2026-11-30", { type: "climatological", endTime: "07:00" })!;
    // 07:00 local on 11-30 in Asia/Shanghai (UTC+8) = 23:00Z on 11-29
    expect(climo.endUtc.toISOString()).toBe("2026-11-29T23:00:00.000Z");
    expect(localDayWindow("Asia/Shanghai", "2026-11-30", { type: "martian_sol" })).toBeNull();
  });

  it("rejects a value on the excluded upper boundary of the 25h day", async () => {
    const keys = await seed(env, "desk-t014");
    const { bindingId, policyId } = await setupBinding(keys, {
      address: "0xMKT-T014", stationExternal: "EXAMPLE-A", localDate: "2026-11-01",
      zone: "America/New_York",
    });
    env.clock.set(new Date("2026-11-02T12:00:00Z"));
    await ingest(keys, policyId, [
      synthLine("2026-11-01T12:00:00Z", "-2.0"),          // inside 25h day
      synthLine("2026-11-02T05:00:00Z", "-9.0"),          // exactly at excluded end
    ]);
    const res = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst,
      payload: { ruleBindingId: bindingId, asOf: "2026-11-02T12:00:00Z" },
    });
    const r = res.body as {
      window: { startUtc: string; endUtc: string };
      samples: { observedAt: string }[];
      excluded: { reason: string; observationId: string }[];
    };
    expect(r.window.endUtc).toBe("2026-11-02T05:00:00.000Z");
    expect(r.samples.length).toBe(1);
    expect(r.samples[0]!.observedAt).toBe("2026-11-01T12:00:00.000Z");
    expect(r.excluded.map((e) => e.reason)).toContain("outside_day_window");
  });
});

describe("T-015 incomplete vs verified official aggregate", () => {
  it("missing block + no final → incomplete; official final publication → final", async () => {
    const keys = await seed(env, "desk-t015");
    const { bindingId, policyId, stationUuid } = await setupBinding(keys, {
      address: "0xMKT-T015", stationExternal: "EXAMPLE-A", localDate: "2026-11-30",
      aggregatePolicy: { method: "official_daily_publication" },
    });
    env.clock.set(new Date("2026-12-01T00:00:00Z"));
    await ingest(keys, policyId, [
      synthLine("2026-11-30T00:30:00Z", "1.0"),
      // 04:00–12:00 missing block
      synthLine("2026-11-30T13:00:00Z", "-1.0"),
      synthLine("2026-11-30T14:00:00Z", "-0.5"),
    ]);
    const res = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst,
      payload: { ruleBindingId: bindingId, asOf: "2026-12-01T00:00:00Z" },
    });
    const r = res.body as { verdict: string; reasons: string[] };
    expect(r.verdict).toBe("incomplete");
    expect(r.reasons).toContain("no_official_final");

    // the authority publishes its official daily aggregate → final even with desk gaps
    await env.pool.query(
      `UPDATE observations SET is_official_final=true, published_at='2026-11-30T23:30:00Z'
       WHERE desk_id=$1 AND station_id=$2 AND observed_at='2026-11-30T14:00:00Z'`,
      [keys.deskId, stationUuid],
    );
    const res2 = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst,
      payload: { ruleBindingId: bindingId, asOf: "2026-12-01T00:00:00Z" },
    });
    const r2 = res2.body as { verdict: string; finalAggregate: { method: string } | null };
    expect(r2.verdict).toBe("final");
    expect(r2.finalAggregate?.method).toBe("official_daily_publication");
  });

  it("evaluation is reproducible: same inputs + as_of → identical result digest", async () => {
    const keys = await seed(env, "desk-repro");
    const { bindingId } = await setupBinding(keys, {
      address: "0xMKT-REPRO", stationExternal: "EXAMPLE-A", localDate: "2026-11-30",
    });
    const res = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst,
      payload: { ruleBindingId: bindingId, asOf: "2026-12-01T00:00:00Z" },
    });
    const res2 = await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst,
      payload: { ruleBindingId: bindingId, asOf: "2026-12-01T00:00:00Z" },
    });
    const a = res.body as { verdict: string; inputsDigest: string };
    const b = res2.body as { verdict: string; inputsDigest: string };
    expect(a.inputsDigest).toBe(b.inputsDigest);
    expect(a.verdict).toBe(b.verdict);
  });
});
