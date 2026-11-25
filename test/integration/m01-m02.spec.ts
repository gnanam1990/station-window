import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, login, makeTestEnv, seed, type TestEnv } from "../helpers.ts";
import { uuid } from "../../src/core/ids.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv();
  const { seedCatalog } = await import("../../src/modules/catalog.ts");
  await seedCatalog(env.pool);
});
afterAll(async () => {
  await env.close();
});

const CARD = {
  address: "0xMKT-WAVE-1",
  question: "Will buoy 46002 significant wave height exceed 4.0 m on 2026-11-30?",
  competitionId: "arena-1",
  network: "delphi",
  evidenceCutoffAt: "2026-12-01T00:00:00Z",
  entryState: { canSubmit: true },
  dataSources: ["https://www.ndbc.noaa.gov/data/realtime2/46002.txt"],
};

describe("T-001 migrate, inbox, restart persistence, auditor 403", () => {
  it("migrates an empty database, serves an inbox, keeps the desk across an app restart, and forbids auditor mutations", async () => {
    const keys = await seed(env, "desk-t001");
    // empty analyst inbox
    const inbox = await api(env, "GET", "/api/markets", { key: keys.keys.analyst });
    expect(inbox.status).toBe(200);
    expect((inbox.body as { items: unknown[] }).items).toEqual([]);

    // import a card as editor, then restart the app: the desk and data persist
    const imp = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: CARD },
    });
    expect(imp.status).toBe(200);

    await env.app.close();
    const { buildApp } = await import("../../src/app.ts");
    env.app = await buildApp({ config: env.config, pool: env.pool, clock: env.clock });

    const me = await api(env, "GET", "/api/me", { key: keys.keys.analyst });
    expect(me.status).toBe(200);
    expect((me.body as { deskSlug: string }).deskSlug).toBe("desk-t001");
    const inbox2 = await api(env, "GET", "/api/markets", { key: keys.keys.analyst });
    expect((inbox2.body as { items: unknown[] }).items.length).toBe(1);

    // auditor reads but cannot mutate
    const read = await api(env, "GET", "/api/markets", { key: keys.keys.auditor });
    expect(read.status).toBe(200);
    const write = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.auditor,
      payload: { card: CARD },
    });
    expect(write.status).toBe(403);
    expect((write.body as { error: { code: string } }).error.code).toBe("forbidden_role");
  });
});

describe("T-002 tenant isolation property check", () => {
  it("generated desk pairs share an external market key without cross-desk leakage by id, list or export", async () => {
    for (let pair = 0; pair < 5; pair++) {
      const a = await seed(env, `gen-a-${pair}`);
      const b = await seed(env, `gen-b-${pair}`);
      const card = { ...CARD, address: `0xMKT-PAIR-${pair}` };
      for (const k of [a.keys.editor, b.keys.editor]) {
        const r = await api(env, "POST", "/api/markets/import", { key: k, payload: { card } });
        expect(r.status).toBe(200);
      }
      const listA = (await api(env, "GET", "/api/markets", { key: a.keys.analyst })).body as {
        items: { id: string; marketAddress: string }[];
      };
      const listB = (await api(env, "GET", "/api/markets", { key: b.keys.analyst })).body as {
        items: { id: string; marketAddress: string }[];
      };
      const inA = listA.items.filter((i) => i.marketAddress === card.address);
      const inB = listB.items.filter((i) => i.marketAddress === card.address);
      expect(inA.length).toBe(1);
      expect(inB.length).toBe(1);
      expect(inA[0]!.id).not.toBe(inB[0]!.id);
      // cross-desk read by id → 404 (no existence leak), in both directions and both roles
      for (const [k, id] of [
        [b.keys.analyst, inA[0]!.id],
        [a.keys.analyst, inB[0]!.id],
        [b.keys.auditor, inA[0]!.id],
      ] as const) {
        const cross = await api(env, "GET", `/api/markets/${id}`, { key: k });
        expect(cross.status).toBe(404);
      }
      // desk scoping cannot be overridden by posting a desk id
      const spoof = await api(env, "POST", "/api/markets/import", {
        key: b.keys.editor,
        payload: { card, deskId: a.deskId } as never,
      });
      expect(spoof.status).toBe(200); // idempotent under desk B, NOT desk A
      const listA2 = (await api(env, "GET", "/api/markets", { key: a.keys.analyst })).body as {
        items: { marketAddress: string }[];
      };
      expect(listA2.items.filter((i) => i.marketAddress === card.address).length).toBe(1);
      // export isolation (endpoint lands with M09): cross-desk export must not contain A's ids
      const exp = await api(env, "GET", "/api/ops/export", { key: b.keys.auditor });
      if (exp.status === 200) {
        expect(JSON.stringify(exp.body)).not.toContain(inA[0]!.id);
      } else {
        expect([401, 403, 404]).toContain(exp.status);
      }
    }
  });
});

describe("T-003 frozen clock at exact cutoff", () => {
  it("refuses dispatch eligibility at the cutoff instant and returns the timestamp used", async () => {
    const cutoff = env.clock.now().toISOString();
    const keys = await seed(env, "desk-t003");
    const imp = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...CARD, address: "0xMKT-CUTOFF", evidenceCutoffAt: cutoff } },
    });
    const mvId = (imp.body as { marketVersionId: string }).marketVersionId;
    const check = await api(env, "POST", "/api/dispatch-check", {
      key: keys.keys.analyst,
      payload: { marketVersionId: mvId },
    });
    expect(check.status).toBe(200);
    const body = check.body as { eligible: boolean; reasons: string[]; timestampUsed: string };
    expect(body.eligible).toBe(false);
    expect(body.reasons).toContain("cutoff_passed");
    expect(body.timestampUsed).toBe(cutoff);
  });
});

describe("T-004 comparator-only change creates a new version and stales approvals", () => {
  it("imports two card versions differing only in comparator; prior unsent approvals go stale", async () => {
    const keys = await seed(env, "desk-t004");
    const v1 = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...CARD, address: "0xMKT-CMP", question: "Below 0.0 degC?" } },
    });
    expect((v1.body as { created: boolean }).created).toBe(true);
    const mv1 = (v1.body as { marketVersionId: string }).marketVersionId;

    const bind = await api(env, "POST", `/api/markets/${mv1}/bindings`, {
      key: keys.keys.editor,
      payload: {
        stationAlias: "example-a",
        authority: "training-source",
        dataset: "synthetic",
        variable: "air_temperature",
        operator: "lt",
        threshold: "0.0",
        unit: "degC",
        localZone: "Asia/Shanghai",
        localDate: "2026-11-30",
        dayDefinition: { type: "civil" },
      },
    });
    const bindingId = (bind.body as { bindingId: string }).bindingId;
    await api(env, "POST", `/api/bindings/${bindingId}/verify`, { key: keys.keys.editor });

    // simulate an existing unsent approval under v1
    const editorId = (await env.pool.query(
      "SELECT p.id FROM principals p JOIN memberships m ON m.principal_id=p.id WHERE p.desk_id=$1 AND m.role='editor' LIMIT 1",
      [keys.deskId],
    )).rows[0].id;
    const candId = uuid();
    await env.pool.query(
      `INSERT INTO candidates(id, desk_id, rule_binding_id, origin_group, material_delta,
        observation_ids, citation_set, note_text, note_digest)
       VALUES ($1,$2,$3,'g1','{}','{}','[]','n','nd1')`,
      [candId, keys.deskId, bindingId],
    );
    const approvalId = uuid();
    await env.pool.query(
      `INSERT INTO approvals(id, desk_id, candidate_id, candidate_version, note_digest, citations_hash,
        rule_binding_id, observation_ids, editor_id, approved_at)
       VALUES ($1,$2,$3,1,'d1','c1',$4,'{}',$5, now())`,
      [approvalId, keys.deskId, candId, bindingId, editorId],
    );

    const v2 = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: {
        card: { ...CARD, address: "0xMKT-CMP", question: "At or below 0.0 degC?" },
      },
    });
    expect((v2.body as { created: boolean }).created).toBe(true);
    const mv2 = (v2.body as { marketVersionId: string }).marketVersionId;
    expect(mv2).not.toBe(mv1);

    const stale = await env.pool.query("SELECT status FROM approvals WHERE id=$1", [approvalId]);
    expect(stale.rows[0].status).toBe("stale");
    const detail = await api(env, "GET", `/api/markets/${mv1}`, { key: keys.keys.analyst });
    expect((detail.body as { market: { rule_revision: number } }).market.rule_revision).toBe(1);
    const detail2 = await api(env, "GET", `/api/markets/${mv2}`, { key: keys.keys.analyst });
    expect((detail2.body as { market: { rule_revision: number } }).market.rule_revision).toBe(2);
    // same card re-import is idempotent
    const v2again = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...CARD, address: "0xMKT-CMP", question: "At or below 0.0 degC?" } },
    });
    expect((v2again.body as { created: boolean }).created).toBe(false);
  });
});

describe("M02 regressions: parallel import + eligibility-only change", () => {
  it("concurrent imports of the same card converge to one version; differing cards serialize revisions", async () => {
    const keys = await seed(env, "desk-par");
    const card = { ...CARD, address: "0xMKT-PAR" };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api(env, "POST", "/api/markets/import", { key: keys.keys.editor, payload: { card } }),
      ),
    );
    const bodies = results.map((r) => r.body as { marketVersionId: string; created: boolean });
    expect(new Set(bodies.map((b) => b.marketVersionId)).size).toBe(1);
    expect(bodies.filter((b) => b.created).length).toBe(1);
    const { rows } = await env.pool.query(
      "SELECT COUNT(*)::int AS n, MAX(rule_revision) AS rev FROM market_versions WHERE market_address='0xMKT-PAR'",
    );
    expect(rows[0].n).toBe(1);
    expect(rows[0].rev).toBe(1);

    // two different cards for the same market raced in parallel → revisions 1 and 2
    const c1 = { ...card, question: "Comparator lt?" };
    const c2 = { ...card, question: "Comparator lte?" };
    const [r1, r2] = await Promise.all([
      api(env, "POST", "/api/markets/import", { key: keys.keys.editor, payload: { card: c1 } }),
      api(env, "POST", "/api/markets/import", { key: keys.keys.editor, payload: { card: c2 } }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const { rows: revs } = await env.pool.query(
      "SELECT rule_revision FROM market_versions WHERE market_address='0xMKT-PAR' ORDER BY rule_revision",
    );
    expect(revs.map((r) => r.rule_revision)).toEqual([1, 2, 3]);
  });

  it("an eligibility-only change creates a new version and stales prior unsent approvals", async () => {
    const keys = await seed(env, "desk-elig");
    const base = { ...CARD, address: "0xMKT-ELIG", eligibilityOpensAt: "2026-11-01T00:00:00Z" };
    const v1 = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: base },
    });
    const mv1 = (v1.body as { marketVersionId: string }).marketVersionId;

    const bind = await api(env, "POST", `/api/markets/${mv1}/bindings`, {
      key: keys.keys.editor,
      payload: {
        stationAlias: "example-a",
        authority: "training-source",
        dataset: "synthetic",
        variable: "air_temperature",
        operator: "lt",
        threshold: "0.0",
        unit: "degC",
        localZone: "Asia/Shanghai",
        localDate: "2026-11-30",
        dayDefinition: { type: "civil" },
      },
    });
    const bindingId = (bind.body as { bindingId: string }).bindingId;
    await api(env, "POST", `/api/bindings/${bindingId}/verify`, { key: keys.keys.editor });

    const editorId = (await env.pool.query(
      "SELECT p.id FROM principals p JOIN memberships m ON m.principal_id=p.id WHERE p.desk_id=$1 AND m.role='editor' LIMIT 1",
      [keys.deskId],
    )).rows[0].id;
    const candId = uuid();
    await env.pool.query(
      `INSERT INTO candidates(id, desk_id, rule_binding_id, origin_group, material_delta,
        observation_ids, citation_set, note_text, note_digest)
       VALUES ($1,$2,$3,'g2','{}','{}','[]','n','nd2')`,
      [candId, keys.deskId, bindingId],
    );
    const approvalId = uuid();
    await env.pool.query(
      `INSERT INTO approvals(id, desk_id, candidate_id, candidate_version, note_digest, citations_hash,
        rule_binding_id, observation_ids, editor_id, approved_at)
       VALUES ($1,$2,$3,1,'d','c',$4,'{}',$5, now())`,
      [approvalId, keys.deskId, candId, bindingId, editorId],
    );

    // identical question/cutoff/address — only the eligibility window moved
    const v2 = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...base, eligibilityOpensAt: "2026-11-15T00:00:00Z" } },
    });
    expect((v2.body as { created: boolean }).created).toBe(true);
    expect((v2.body as { marketVersionId: string }).marketVersionId).not.toBe(mv1);
    const stale = await env.pool.query("SELECT status FROM approvals WHERE id=$1", [approvalId]);
    expect(stale.rows[0].status).toBe("stale");

    // gate treats the old revision as non-current, and opens-at is enforced
    const oldGate = await api(env, "POST", "/api/dispatch-check", {
      key: keys.keys.analyst,
      payload: { marketVersionId: mv1 },
    });
    expect((oldGate.body as { reasons: string[] }).reasons).toContain("stale_market_revision");

    const keys2 = await seed(env, "desk-opens");
    const notYetOpen = {
      ...CARD,
      address: "0xMKT-OPEN",
      eligibilityOpensAt: "2999-01-01T00:00:00Z",
    };
    const mvOpen = await api(env, "POST", "/api/markets/import", {
      key: keys2.keys.editor,
      payload: { card: notYetOpen },
    });
    const gate = await api(env, "POST", "/api/dispatch-check", {
      key: keys2.keys.analyst,
      payload: { marketVersionId: (mvOpen.body as { marketVersionId: string }).marketVersionId },
    });
    expect((gate.body as { reasons: string[] }).reasons).toContain("not_yet_open");
  });

  it("a superseded binding cannot be re-verified", async () => {
    const keys = await seed(env, "desk-superseded");
    const imp = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...CARD, address: "0xMKT-SUP" } },
    });
    const mv1 = (imp.body as { marketVersionId: string }).marketVersionId;
    const b1 = await api(env, "POST", `/api/markets/${mv1}/bindings`, {
      key: keys.keys.editor,
      payload: { stationAlias: "example-a", localZone: "Asia/Shanghai" },
    });
    // supersede via a new market revision
    await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...CARD, address: "0xMKT-SUP", question: "Changed wording?" } },
    });
    const rev = await api(env, "POST", `/api/bindings/${(b1.body as { bindingId: string }).bindingId}/verify`, {
      key: keys.keys.editor,
    });
    expect(rev.status).toBe(409);
    expect((rev.body as { error: { code: string } }).error.code).toBe("binding_superseded");
  });
});

describe("T-005 regular card has no competition entry state", () => {
  it("appears in the workspace but the eligibility gate blocks the live outbox", async () => {
    const keys = await seed(env, "desk-t005");
    const regular = { ...CARD, address: "0xMKT-REG", entryState: undefined };
    delete regular.entryState;
    const imp = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: regular },
    });
    const mvId = (imp.body as { marketVersionId: string }).marketVersionId;
    const check = await api(env, "POST", "/api/dispatch-check", {
      key: keys.keys.analyst,
      payload: { marketVersionId: mvId },
    });
    const body = check.body as { eligible: boolean; reasons: string[] };
    expect(body.eligible).toBe(false);
    expect(body.reasons).toContain("not_competition_entry");
  });
});

describe("T-006 ambiguous station alias", () => {
  it("produces an unresolved binding; a documented exact station resolves in a new version", async () => {
    const keys = await seed(env, "desk-t006");
    const { seedCatalog } = await import("../../src/modules/catalog.ts");
    await seedCatalog(env.pool);
    const imp = await api(env, "POST", "/api/markets/import", {
      key: keys.keys.editor,
      payload: { card: { ...CARD, address: "0xMKT-ALIAS" } },
    });
    const mvId = (imp.body as { marketVersionId: string }).marketVersionId;

    // 'beijing-airport' documents two stations → ambiguous
    const unresolved = await api(env, "POST", `/api/markets/${mvId}/bindings`, {
      key: keys.keys.editor,
      payload: { stationAlias: "beijing-airport", localZone: "Asia/Shanghai" },
    });
    expect((unresolved.body as { status: string }).status).toBe("unresolved");
    const vfy = await api(env, "POST", `/api/bindings/${(unresolved.body as { bindingId: string }).bindingId}/verify`, {
      key: keys.keys.editor,
    });
    expect(vfy.status).toBe(422);
    expect((vfy.body as { error: { code: string } }).error.code).toBe("unresolved_binding");

    // editor selects the documented station id → new version records the mapping
    const zbaa = await env.pool.query("SELECT id FROM stations WHERE external_id='SYN-PEK-CAPITAL'");
    const resolved = await api(env, "POST", `/api/markets/${mvId}/bindings`, {
      key: keys.keys.editor,
      payload: {
        parentVersionId: (unresolved.body as { bindingId: string }).bindingId,
        stationId: zbaa.rows[0].id,
        authority: "CMA",
        dataset: "daily",
        variable: "air_temperature_min",
        operator: "lt",
        threshold: "0.0",
        unit: "degC",
        localZone: "Asia/Shanghai",
        localDate: "2026-11-30",
        dayDefinition: { type: "civil" },
      },
    });
    expect(resolved.status).toBe(200);
    expect((resolved.body as { version: number }).version).toBe(2);
    expect((resolved.body as { status: string }).status).toBe("draft");
  });
});
