import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeTestEnv, seed, type TestEnv } from "../helpers.ts";
import { makeFixtureTransport } from "../../src/modules/delphi.ts";

let env: TestEnv;
let transport: ReturnType<typeof makeFixtureTransport>;
beforeAll(async () => {
  transport = makeFixtureTransport();
  env = await makeTestEnv({ config: { transportOverride: transport, liveSubmissionsEnabled: true } });
  const { seedCatalog } = await import("../../src/modules/catalog.ts");
  await seedCatalog(env.pool);
});
afterAll(async () => {
  await env.close();
});

const synthLine = (observedAt: string, value: string) =>
  JSON.stringify({ observedAt, fields: { air_temperature: value } });

async function stationId(externalId: string) {
  const { rows } = await env.pool.query("SELECT id FROM stations WHERE external_id=$1", [externalId]);
  return rows[0].id as string;
}

/** Full desk pipeline → a valid approval ready to send. */
async function approvalFor(
  keys: Awaited<ReturnType<typeof seed>>, address: string,
  opts: { cutoff?: string } = {},
) {
  const imp = await api(env, "POST", "/api/markets/import", {
    key: keys.keys.editor,
    payload: {
      card: {
        address, question: "practice?", competitionId: "arena-1",
        evidenceCutoffAt: opts.cutoff ?? "2999-01-01T00:00:00Z",
        entryState: { canSubmit: true, remainingOnMarket: 3 },
      },
    },
  });
  const mvId = (imp.body as { marketVersionId: string }).marketVersionId;
  const bind = await api(env, "POST", `/api/markets/${mvId}/bindings`, {
    key: keys.keys.editor,
    payload: {
      stationId: await stationId("EXAMPLE-A"), authority: "training-source",
      dataset: "synthetic", variable: "air_temperature",
      operator: "lt", threshold: "0.0", unit: "degC",
      localZone: "UTC", localDate: "2026-11-30", dayDefinition: { type: "civil" },
    },
  });
  const bindingId = (bind.body as { bindingId: string }).bindingId;
  await api(env, "POST", `/api/bindings/${bindingId}/verify`, { key: keys.keys.editor });
  const pol = await api(env, "POST", "/api/sources", {
    key: keys.keys.editor,
    payload: {
      stationId: await stationId("EXAMPLE-A"), dataset: "synthetic",
      variable: "air_temperature", endpointUrl: `https://training.example/${address}`,
      canSubmit: true,
    },
  });
  const policyId = (pol.body as { id: string }).id;
  await api(env, "POST", "/api/observations/import", {
    key: keys.keys.worker,
    payload: { sourcePolicyId: policyId, content: synthLine("2026-11-30T01:00:00Z", "-0.5") },
  });
  await api(env, "POST", "/api/evaluations", {
    key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
  });
  const run = await api(env, "POST", "/api/research/run", {
    key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
  });
  const cand = (run.body as { candidate: { id: string } }).candidate;
  const ap = await api(env, "POST", `/api/candidates/${cand.id}/approve`, { key: keys.keys.editor });
  return { approvalId: (ap.body as { id: string }).id, policyId, bindingId };
}

describe("T-019 two tabs, two workers, lost response → one intent/key/remote/slot", () => {
  it("converges on a single intent, idempotency key, remote id and consumed slot", async () => {
    const keys = await seed(env, "desk-t019");
    const { approvalId } = await approvalFor(keys, "0xMKT-T019");

    // two tabs with different request IDs queue the same approval
    const [r1, r2] = await Promise.all([
      api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } }),
      api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const i1 = (r1.body as { intent: { id: string; idempotency_key: string } }).intent;
    const i2 = (r2.body as { intent: { id: string; idempotency_key: string } }).intent;
    expect(i1.id).toBe(i2.id);
    expect(i1.idempotency_key).toBe(i2.idempotency_key);
    const { rows: intCount } = await env.pool.query(
      "SELECT count(*) c FROM intents WHERE approval_id=$1", [approvalId]);
    expect(Number(intCount[0].c)).toBe(1);

    // worker A: submission lands remotely but the response is lost
    transport.failNextSubmit("timeout");
    const t1 = await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w-A" } });
    expect(t1.status).toBe(200);
    const { rows: afterLost } = await env.pool.query(
      "SELECT state FROM intents WHERE id=$1", [i1.id]);
    expect(afterLost[0].state).toBe("SENT_UNKNOWN");

    // worker B: re-gates, resubmits the SAME key → provider returns original submission
    const t2 = await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w-B" } });
    expect(t2.status).toBe(200);
    const detail = await api(env, "GET", `/api/intents/${i1.id}`, { key: keys.keys.analyst });
    const d = detail.body as {
      state: string; idempotency_key: string;
      receipts: { remote_id: string }[];
      rewards: { remote_status: string }[];
      attempts: { epoch: number; result: string }[];
      reconciliations: { resolution: string }[];
    };
    expect(d.state).toBe("REMOTE_KNOWN");
    expect(d.receipts.length).toBe(1);
    expect(d.receipts[0]!.remote_id).toBe("sub-1");
    expect(transport.submitCalls).toBe(2); // resend deduped remotely, not duplicated
    expect(d.reconciliations.every((r) => r.resolution === "remote_known")).toBe(true);
    const { rows: slots } = await env.pool.query(
      "SELECT state FROM quota_reservations WHERE intent_id=$1", [i1.id]);
    expect(slots.length).toBe(1);
    expect(slots[0].state).toBe("consumed");
    const { rows: attempts } = await env.pool.query(
      "SELECT result FROM attempts WHERE intent_id=$1 ORDER BY epoch", [i1.id]);
    expect(attempts.map((a) => a.result)).toEqual(["sent_unknown:timeout", "sent"]);
  });
});

describe("T-020 rights revoked / cutoff passed after queueing", () => {
  it("revoking can_submit blocks a queued intent with the recorded reason", async () => {
    const keys = await seed(env, "desk-t020a");
    const { approvalId, policyId } = await approvalFor(keys, "0xMKT-T020a");
    await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    // rights withdrawn AFTER the intent was queued
    await api(env, "PATCH", `/api/sources/${policyId}`, {
      key: keys.keys.editor, payload: { canSubmit: false },
    });
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    const { rows } = await env.pool.query(
      `SELECT i.state, i.block_reason, q.state AS slot FROM intents i
       JOIN quota_reservations q ON q.intent_id=i.id WHERE i.approval_id=$1`,
      [approvalId]);
    expect(rows[0].state).toBe("BLOCKED");
    expect(rows[0].block_reason).toContain("submission_rights_withdrawn");
    expect(rows[0].slot).toBe("released");
    expect(transport.submitCalls).toBe(2); // T-019's two; the blocked intent never transmitted
  });

  it("cutoff expiry blocks a queued intent with the timestamp used", async () => {
    const keys = await seed(env, "desk-t020b");
    const { approvalId } = await approvalFor(keys, "0xMKT-T020b", { cutoff: "2026-12-01T00:00:00Z" });
    await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    env.clock.set(new Date("2026-12-01T00:00:01Z")); // now past the evidence cutoff
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    const { rows } = await env.pool.query(
      "SELECT state, block_reason FROM intents WHERE approval_id=$1", [approvalId]);
    expect(rows[0].state).toBe("BLOCKED");
    expect(rows[0].block_reason).toContain("cutoff_passed");
    env.clock.set(new Date("2026-11-30T12:00:00Z")); // restore for later tests
  });
});

describe("T-021 judged with zero pay is recorded faithfully", () => {
  it("stores remote verdict, raw bounty string, state and zero-pay reason separately", async () => {
    const keys = await seed(env, "desk-t021");
    const { approvalId } = await approvalFor(keys, "0xMKT-T021");
    const cr = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    const intent = (cr.body as { intent: { id: string } }).intent;
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });

    transport.setJudged({ verdict: "correct", bountyAmount: "0", bountyState: "none", zeroPayReason: "below_minimum" });
    const poll = await api(env, "POST", "/api/outbox/poll", { key: keys.keys.worker });
    expect(poll.status).toBe(200);
    const { rows } = await env.pool.query(
      "SELECT remote_status, verdict, bounty_amount_raw, bounty_currency, bounty_state, zero_pay_reason FROM rewards WHERE intent_id=$1",
      [intent.id]);
    expect(rows[0].remote_status).toBe("judged");
    expect(rows[0].verdict).toBe("correct");
    expect(rows[0].bounty_amount_raw).toBe("0");      // raw provider string preserved
    expect(rows[0].bounty_currency).toBeNull();       // unverified denomination stays out of totals
    expect(rows[0].bounty_state).toBe("none");
    expect(rows[0].zero_pay_reason).toBe("below_minimum");
    const { rows: hist } = await env.pool.query(
      `SELECT rh.remote_status, rh.bounty_state FROM reward_history rh
       JOIN rewards r ON r.id=rh.reward_id WHERE r.intent_id=$1`, [intent.id]);
    expect(hist.some((h) => h.remote_status === "judged")).toBe(true);
    const { rows: st } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [intent.id]);
    expect(st[0].state).toBe("DONE");
    transport.setJudged(undefined);
  });
});

describe("provider wire: markets[] matched by exact address, never by position", () => {
  it("reordered rows → target market's zero-pay recorded; absent target → unresolved, no bounty", async () => {
    const keys = await seed(env, "desk-wire");
    const { approvalId } = await approvalFor(keys, "0xMKT-WIRE");
    const cr = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    const intent = (cr.body as { intent: { id: string; market_address: string } }).intent;
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });

    // provider reports another market PAID first, then our target accepted@0
    transport.setJudged({ verdict: "correct", bountyAmount: "0", bountyState: "none", zeroPayReason: "daily_cap" });
    transport.setMarketRows([
      { marketAddress: "0xOTHER-PAID", verdict: "correct", bounty: { amount: "987654321", state: "paid" } },
    ]);
    await api(env, "POST", "/api/outbox/poll", { key: keys.keys.worker });
    const { rows } = await env.pool.query(
      "SELECT remote_status, verdict, bounty_amount_raw, bounty_state, zero_pay_reason FROM rewards WHERE intent_id=$1",
      [intent.id]);
    expect(rows[0].remote_status).toBe("judged");
    expect(rows[0].verdict).toBe("correct");
    expect(rows[0].bounty_amount_raw).toBe("0");
    expect(rows[0].bounty_state).toBe("none");
    expect(rows[0].zero_pay_reason).toBe("daily_cap");

    // now the provider drops our row entirely — must not inherit the decoy's win
    transport.setMarketRows(
      [{ marketAddress: "0xOTHER-PAID", verdict: "correct", bounty: { amount: "987654321", state: "paid" } }],
      false,
    );
    const keys2 = await seed(env, "desk-wire2");
    const { approvalId: a2 } = await approvalFor(keys2, "0xMKT-WIRE2");
    const cr2 = await api(env, "POST", "/api/intents", { key: keys2.keys.editor, payload: { approvalId: a2 } });
    const intent2 = (cr2.body as { intent: { id: string } }).intent;
    await api(env, "POST", "/api/outbox/tick", { key: keys2.keys.worker, payload: { workerId: "w1" } });
    await api(env, "POST", "/api/outbox/poll", { key: keys2.keys.worker });
    const { rows: r2 } = await env.pool.query(
      "SELECT remote_status, verdict, bounty_amount_raw, bounty_state FROM rewards WHERE intent_id=$1",
      [intent2.id]);
    expect(r2[0].remote_status).toBe("unmatched");
    expect(r2[0].verdict).toBeNull();
    expect(r2[0].bounty_amount_raw).toBeNull();
    expect(r2[0].bounty_state).toBeNull();
    const { rows: st2 } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [intent2.id]);
    expect(st2[0].state).toBe("REMOTE_KNOWN"); // unresolved, not DONE on a foreign market's result
    transport.setMarketRows([], true);
    transport.setJudged(undefined);
  });
});

describe("shared provider market quota", () => {
  it("reserves three concurrent approvals, then reuses a released slot without losing its history", async () => {
    const market = "0xMKT-shared-quota";
    const editors = await Promise.all(["east", "west", "north", "south"].map(async (region) => {
      const desk = await seed(env, "quota-" + region);
      const approval = await approvalFor(desk, market);
      return { ...desk, ...approval };
    }));
    const enqueue = (desk: (typeof editors)[number]) =>
      api(env, "POST", "/api/intents", { key: desk.keys.editor, payload: { approvalId: desk.approvalId } });
    const results = await Promise.all(editors.map(enqueue));
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 200, 409]);
    const first = editors[results.findIndex(r => r.status === 200)]!;
    const waiting = editors[results.findIndex(r => r.status === 409)]!;
    await api(env, "PATCH", `/api/sources/${first.policyId}`, { key: first.keys.editor, payload: { canSubmit: false } });
    // A different permitted source on this station cannot license the queued citation.
    await api(env, "POST", "/api/sources", { key: first.keys.editor, payload: {
      stationId: await stationId("EXAMPLE-A"), dataset: "synthetic", variable: "air_temperature",
      endpointUrl: "https://training.example/another-source", canSubmit: true,
    }});
    const before = transport.submitCalls;
    const tick = await api(env, "POST", "/api/outbox/tick", { key: first.keys.worker, payload: {} });
    expect(tick.status).toBe(200);
    expect(transport.submitCalls).toBe(before);
    expect((await enqueue(waiting)).status).toBe(200);
    const slots = await env.pool.query(
      "SELECT slot_index, state FROM quota_reservations WHERE market_address=$1", [market]);
    expect(slots.rows.filter(s => s.state === "released")).toHaveLength(1);
    expect(slots.rows.filter(s => s.state === "reserved").map(s => s.slot_index).sort()).toEqual([1, 2, 3]);
  });
});
