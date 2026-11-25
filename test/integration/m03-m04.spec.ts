import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeTestEnv, seed, type TestEnv } from "../helpers.ts";
import { safeFetch, FetchPolicyError } from "../../src/core/safeFetch.ts";
import { parseNdbcRealtime2, extractVariable } from "../../src/modules/ndbc.ts";
import { ingestSource, loadPolicy, persistSnapshot, parseIntoObservations } from "../../src/modules/ingest.ts";

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

// fixture derived from the real 46002 realtime2 feed (header + row shapes incl. WDIR/PTDY)
const NDBC_FIXTURE = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 23 15 50 180 18.0 24.0   7.5    11   8.7 200  999.0    MM    MM    MM   MM   MM    MM
2026 11 23 15 40 180 19.0 24.0   7.5    MM   8.7 200  995.7    MM    MM    MM   MM   MM    MM
2026 11 23 15 30 180 18.0 23.0    MM    MM    MM  MM  995.5    MM    MM    MM   MM   MM    MM
2026 11 23 15 20 180 19.0 24.0   6.7    10   8.5 196  995.6    MM    MM    MM   MM   MM    MM
`;

describe("T-007 NDBC 46002 WVHT resolves; different station refused", () => {
  it("registers a realtime2 policy for 46002 WVHT and refuses a mismatched station endpoint", async () => {
    const keys = await seed(env, "desk-t007");
    const caps = await api(env, "GET", "/api/sources/adapters?provider=ndbc-realtime2", {
      key: keys.keys.analyst,
    });
    expect((caps.body as { supported: boolean }).supported).toBe(true);
    expect((caps.body as { variables: string[] }).variables).toContain("WVHT");
    const bogus = await api(env, "GET", "/api/sources/adapters?provider=made-up-provider", {
      key: keys.keys.analyst,
    });
    expect((bogus.body as { supported: boolean }).supported).toBe(false);
    const s46002 = await stationId("46002");
    const reg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46002,
        dataset: "realtime2",
        variable: "WVHT",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt",
        canSubmit: true,
      },
    });
    expect(reg.status).toBe(200);

    // a 46050 policy pointing at the 46002 file is refused — a different station ID
    // cannot silently satisfy the binding (INV-03)
    const s46050 = await stationId("46050");
    const wrong = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46050,
        dataset: "realtime2",
        variable: "WVHT",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt",
      },
    });
    expect(wrong.status).toBe(422);
    expect((wrong.body as { error: { code: string } }).error.code).toBe("station_endpoint_mismatch");
  });

  it("input-derived regression: real-feed-shaped rows parse WVHT 7.5 m and keep 999.0 hPa valid", async () => {
    const parsed = parseNdbcRealtime2(NDBC_FIXTURE);
    expect(parsed.fieldNames).toContain("WDIR");
    expect(parsed.fieldNames).toContain("PTDY");
    expect(parsed.units["WVHT"]).toBe("m");
    expect(parsed.units["PRES"]).toBe("hPa");
    const wvht = extractVariable(parsed.rows[0]!, "WVHT", parsed.units);
    expect(wvht?.valueNum).toBe("7.5");
    expect(wvht?.unit).toBe("m");
    // 999.0 is a valid pressure reading, NOT the documented MM sentinel
    const pres = extractVariable(parsed.rows[0]!, "PRES", parsed.units);
    expect(pres?.quality).toBe("good");
    expect(pres?.valueNum).toBe("999.0");
    const missing = extractVariable(parsed.rows[0]!, "ATMP", parsed.units);
    expect(missing?.quality).toBe("missing");
    expect(missing?.valueNum).toBeNull();
  });
});

describe("T-008 withdrawn submission rights", () => {
  it("blocks dispatch while browse/retention stay allowed", async () => {
    const keys = await seed(env, "desk-t008");
    const s46002 = await stationId("46002");
    const reg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46002, dataset: "realtime2", variable: "WVHT",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt",
        canSubmit: true,
      },
    });
    const policyId = (reg.body as { id: string }).id;

    // ingest one row (fixture content allowed outside competition mode)
    const ing = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: NDBC_FIXTURE },
    });
    expect(ing.status).toBe(200);
    expect((ing.body as { inserted: number }).inserted).toBeGreaterThan(0);

    // withdraw submission rights only
    const patch = await api(env, "PATCH", `/api/sources/${policyId}`, {
      key: keys.keys.editor,
      payload: { canSubmit: false },
    });
    expect(patch.status).toBe(200);

    // browsing still allowed: observations readable
    const obs = await api(env, "GET", `/api/observations?stationId=${s46002}`, { key: keys.keys.analyst });
    expect(obs.status).toBe(200);
    expect((obs.body as { items: unknown[] }).items.length).toBeGreaterThan(0);

    // gate reports withdrawn rights
    const imp = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: {
        card: {
          address: "0xMKT-T008",
          question: "q?",
          competitionId: "arena-1",
          evidenceCutoffAt: "2999-01-01T00:00:00Z",
          entryState: { canSubmit: true },
        },
      },
    });
    const mvId = (imp.body as { marketVersionId: string }).marketVersionId;
    const bind = await api(env, "POST", `/api/markets/${mvId}/bindings`, {
      key: keys.keys.editor,
      payload: {
        stationId: s46002, authority: "NOAA/NDBC", dataset: "realtime2", variable: "WVHT",
        operator: "gt", threshold: "4.0", unit: "m", localZone: "America/Los_Angeles",
        localDate: "2026-11-23", dayDefinition: { type: "civil" },
      },
    });
    await api(env, "POST", `/api/bindings/${(bind.body as { bindingId: string }).bindingId}/verify`, {
      key: keys.keys.editor,
    });
    const gate = await api(env, "POST", "/api/dispatch-check", {
      key: keys.keys.analyst,
      payload: { marketVersionId: mvId },
    });
    expect((gate.body as { reasons: string[] }).reasons).toContain("submission_rights_withdrawn");
  });
});

describe("T-009 SSRF defenses", () => {
  it("refuses private IPs, disallowed hosts, non-https schemes and redirects, logging only redacted reasons", async () => {
    const base = { allowedHosts: ["example.com"], maxBytes: 1000, timeoutMs: 1000 };
    await expect(
      safeFetch("http://example.com/x", base),
    ).rejects.toMatchObject({ code: "scheme" });
    await expect(
      safeFetch("https://evil.com/x", base),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(
      safeFetch("https://example.com/x", { ...base, resolve: async () => ["10.0.0.5"] }),
    ).rejects.toMatchObject({ code: "private_ip" });
    await expect(
      safeFetch("https://example.com/x", { ...base, resolve: async () => ["169.254.169.254"] }),
    ).rejects.toMatchObject({ code: "private_ip" });
    await expect(
      safeFetch("https://example.com/x", {
        ...base,
        resolve: async () => ["93.184.216.34"],
        fetchImpl: (async () => new Response("", { status: 302, headers: { location: "https://elsewhere/" } })) as never,
      }),
    ).rejects.toMatchObject({ code: "redirect" });

    // literal private IP as host is checked without DNS
    await expect(
      safeFetch("https://169.254.169.254/latest/meta-data", {
        allowedHosts: ["169.254.169.254"], maxBytes: 1000, timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "private_ip" });

    // end-to-end: a registered policy on a private host fails ingest with a redacted health record
    const keys = await seed(env, "desk-t009");
    const s = await stationId("EXAMPLE-A");
    const reg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s, dataset: "synthetic", variable: "air_temperature",
        endpointUrl: "https://169.254.169.254/feed",
      },
    });
    const policyId = (reg.body as { id: string }).id;
    const { ingestTick } = await import("../../src/modules/ingest.ts");
    await ingestTick(env.pool, env.config, env.clock);
    const health = await env.pool.query(
      "SELECT ok, detail FROM connector_health WHERE source_policy_id=$1 ORDER BY checked_at DESC LIMIT 1",
      [policyId],
    );
    expect(health.rows[0].ok).toBe(false);
    const detail = JSON.stringify(health.rows[0].detail);
    expect(detail).toContain("fetch_policy:");
    expect(detail).not.toContain("169.254");
  });
});

describe("T-010 dedup and ordered revisions", () => {
  it("re-ingesting the same row keeps one version; a changed value appends seq 2", async () => {
    const keys = await seed(env, "desk-t010");
    const s46002 = await stationId("46002");
    const reg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46002, dataset: "realtime2", variable: "WVHT",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt",
      },
    });
    const policyId = (reg.body as { id: string }).id;
    const one = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 23 15 50 180 18.0 24.0   7.5    11   8.7 200  999.0    MM    MM    MM   MM   MM    MM
`;
    const r1 = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: one },
    });
    expect((r1.body as { inserted: number }).inserted).toBe(1);
    const r2 = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: one },
    });
    expect((r2.body as { inserted: number }).inserted).toBe(0);
    expect((r2.body as { deduped: number }).deduped).toBe(1);
    let { rows } = await env.pool.query(
      "SELECT seq, value_num FROM observations WHERE desk_id=$2 AND station_id=$1 ORDER BY seq",
      [s46002, keys.deskId],
    );
    expect(rows.length).toBe(1);

    const changed = one.replace("7.5", "8.2");
    const r3 = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: changed },
    });
    expect((r3.body as { newVersions: number }).newVersions).toBe(1);
    ({ rows } = await env.pool.query(
      "SELECT seq, value_num, supersedes, id FROM observations WHERE desk_id=$2 AND station_id=$1 ORDER BY seq",
      [s46002, keys.deskId],
    ));
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(String(rows[0].value_num)).toBe("7.5"); // original preserved
    expect(String(rows[1].value_num)).toBe("8.2");
    expect(rows[1].supersedes).toBe(rows[0].id);
  });
});

describe("T-011 resume after mid-ingest timeout", () => {
  it("persists the snapshot, simulates the interruption, then resumes from the checkpoint", async () => {
    const keys = await seed(env, "desk-t011");
    const s46002 = await stationId("46002");
    const reg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46002, dataset: "realtime2", variable: "WVHT",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt",
      },
    });
    const policyId = (reg.body as { id: string }).id;
    const p = (await loadPolicy(env.pool, policyId))!;
    const meta = {
      url: p.endpoint_url, httpStatus: 200, headers: {},
      fetchedAt: env.clock.now(),
    };
    // phase 1 completes, then the worker "times out" — checkpoint left at 'parsing'
    const snap = await persistSnapshot(env.pool, p, NDBC_FIXTURE, meta);
    const cp = await env.pool.query(
      "SELECT state, last_snapshot_id FROM ingest_checkpoints WHERE source_policy_id=$1",
      [policyId],
    );
    expect(cp.rows[0].state).toBe("parsing");
    expect(cp.rows[0].last_snapshot_id).toBe(snap.snapshotId);
    expect(
      (await env.pool.query(
        "SELECT COUNT(*)::int AS n FROM observations WHERE desk_id=$2 AND station_id=$1",
        [s46002, keys.deskId],
      )).rows[0].n,
    ).toBe(0);

    // rerun from the checkpoint: same snapshot, observations now linked
    const counts = await parseIntoObservations(
      env.pool, env.clock, p, NDBC_FIXTURE, meta, snap.snapshotId, snap.parserVersion,
    );
    expect(counts.inserted).toBe(4);
    const obs = await env.pool.query(
      "SELECT snapshot_id, parser_version, body_digest FROM observations WHERE desk_id=$2 AND station_id=$1",
      [s46002, keys.deskId],
    );
    expect(obs.rows.every((r) => r.snapshot_id === snap.snapshotId)).toBe(true);
    expect(obs.rows.every((r) => r.parser_version === "ndbc-realtime2/1")).toBe(true);
    const snapRow = await env.pool.query("SELECT digest FROM snapshots WHERE id=$1", [snap.snapshotId]);
    expect(snapRow.rows[0].digest).toBe(snap.digest);
  });
});

describe("T-012 missing token and bad quality never become zero", () => {
  it("MM and a non-numeric flag yield missing/bad rows with a visible gap", async () => {
    const keys = await seed(env, "desk-t012");
    const s46002 = await stationId("46002");
    const reg = await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46002, dataset: "realtime2", variable: "ATMP",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt",
      },
    });
    const policyId = (reg.body as { id: string }).id;
    const feed = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 23 15 50 180 18.0 24.0   7.5    11   8.7 200  999.0    MM    MM    MM   MM   MM    MM
2026 11 23 15 40 180 19.0 24.0   7.5    MM   8.7 200  995.7  XX      MM    MM   MM   MM    MM
2026 11 23 15 30 180 18.0 23.0    MM    MM    MM  MM  995.5   -0.1    MM    MM   MM   MM    MM
`;
    const r = await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: { sourcePolicyId: policyId, content: feed },
    });
    expect((r.body as { inserted: number }).inserted).toBe(3);
    const { rows } = await env.pool.query(
      "SELECT value_text, value_num, quality FROM observations WHERE desk_id=$2 AND station_id=$1 ORDER BY observed_at",
      [s46002, keys.deskId],
    );
    const byTime = rows.map((r) => [r.value_text, r.value_num, r.quality]);
    expect(byTime).toEqual([
      ["-0.1", "-0.1", "good"],
      ["XX", null, "bad"],
      ["MM", null, "missing"],
    ]);
    // the missing/bad rows are retained as a visible gap — never coerced to 0
    expect(rows.filter((r) => r.value_num === "0" || r.value_num === 0).length).toBe(0);
  });
});
