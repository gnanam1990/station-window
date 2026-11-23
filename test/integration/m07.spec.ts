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

describe("M07 stale-worker takeover fencing", () => {
  it("a late stale-worker error never downgrades newer confirmed state", async () => {
    const keys = await seed(env, "desk-stale");
    const { approvalId } = await approvalFor(keys, "0xMKT-STALE");
    const enq = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    const intentId = (enq.body as { intent: { id: string } }).intent.id;

    // deferred transport: the first submit hangs until the test releases it
    let release!: (err?: Error) => void;
    const gate = new Promise<void>((res, rej) => {
      release = (err) => (err ? rej(err) : res());
    });
    let gatedSubmits = 0;
    const { TransportFault } = await import("../../src/modules/delphi.ts");
    const { dispatchTick } = await import("../../src/modules/outbox.ts");
    const { reconcileTick } = await import("../../src/modules/recovery.ts");
    const gated = {
      ...transport,
      submit: async (p: Parameters<typeof transport.submit>[0]) => {
        gatedSubmits++;
        if (gatedSubmits === 1) await gate; // worker A's send stays in flight
        return transport.submit(p);
      },
    };

    // worker A: claims lease + attempt atomically, submit is in-flight
    const tickA = dispatchTick(env.pool, env.config, env.clock,
      { workerId: "w-stale-A", transport: gated, deskId: keys.deskId });
    for (let i = 0; i < 100 && gatedSubmits === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(gatedSubmits).toBe(1);

    // A's lease expires mid-flight; recovery returns only the LATEST expired lease
    await env.pool.query(
      "UPDATE attempts SET lease_expires_at=$1 WHERE intent_id=$2",
      [new Date(0), intentId]);
    const rec = await reconcileTick(env.pool, env.config, env.clock);
    expect(rec.leasesRecovered).toBe(1);
    const { rows: st0 } = await env.pool.query(
      "SELECT state FROM intents WHERE id=$1", [intentId]);
    expect(st0[0].state).toBe("READY");

    // worker B: re-leases at epoch 2, resubmits the same key → REMOTE_KNOWN
    await dispatchTick(env.pool, env.config, env.clock,
      { workerId: "w-stale-B", transport: gated, deskId: keys.deskId });
    expect(gatedSubmits).toBe(2);
    const { rows: st1 } = await env.pool.query(
      "SELECT state FROM intents WHERE id=$1", [intentId]);
    expect(st1[0].state).toBe("REMOTE_KNOWN");

    // A's lost response finally errors — every outcome write is fenced
    release(new TransportFault("timeout", 0, "timeout", "lost response"));
    await tickA;
    const { rows: st2 } = await env.pool.query(
      "SELECT state, block_reason FROM intents WHERE id=$1", [intentId]);
    expect(st2[0].state).toBe("REMOTE_KNOWN"); // never downgraded to SENT_UNKNOWN
    const { rows: openCases } = await env.pool.query(
      "SELECT count(*)::int c FROM reconciliation_cases WHERE intent_id=$1 AND resolved_at IS NULL",
      [intentId]);
    expect(openCases[0].c).toBe(0); // no phantom case from the stale attempt
    const { rows: q } = await env.pool.query(
      "SELECT state FROM quota_reservations WHERE intent_id=$1", [intentId]);
    expect(q[0].state).toBe("consumed"); // uncertain quota preserved through the race
    const { rows: recs } = await env.pool.query(
      "SELECT count(*)::int c FROM receipts WHERE intent_id=$1", [intentId]);
    expect(recs[0].c).toBe(1); // the stale worker added no duplicate receipt
    const { rows: atts } = await env.pool.query(
      "SELECT epoch, result FROM attempts WHERE intent_id=$1 ORDER BY epoch", [intentId]);
    expect(atts.length).toBe(2);
    expect(atts[0].result).toBe("lease_expired"); // stale attempt closed by recovery
    expect(atts[1].result).toBe("sent");
  });

  it("lease recovery is desk-scoped: desk B's expired attempt is untouched", async () => {
    const keysA = await seed(env, "desk-lease-a");
    const keysB = await seed(env, "desk-lease-b");
    const a = await approvalFor(keysA, "0xMKT-LEASE-A");
    const b = await approvalFor(keysB, "0xMKT-LEASE-B");
    const idA = ((await api(env, "POST", "/api/intents", { key: keysA.keys.editor, payload: { approvalId: a.approvalId } }))
      .body as { intent: { id: string } }).intent.id;
    const idB = ((await api(env, "POST", "/api/intents", { key: keysB.keys.editor, payload: { approvalId: b.approvalId } }))
      .body as { intent: { id: string } }).intent.id;

    // both desks have a crashed worker: LEASED intent + expired latest attempt
    const { uuid } = await import("../../src/core/ids.ts");
    const { reconcileTick } = await import("../../src/modules/recovery.ts");
    for (const [deskId, intentId] of [[keysA.deskId, idA], [keysB.deskId, idB]] as const) {
      await env.pool.query("UPDATE intents SET state='LEASED' WHERE id=$1", [intentId]);
      await env.pool.query(
        `INSERT INTO attempts(id, desk_id, intent_id, epoch, worker_id, leased_at, lease_expires_at, started_at)
         VALUES ($1,$2,$3,1,'dead-worker',$4,$5,$4)`,
        [uuid(), deskId, intentId, env.clock.now(), new Date(0)]);
    }

    // a scoped recovery for desk A must not touch desk B at all
    const rec = await reconcileTick(env.pool, env.config, env.clock, keysA.deskId);
    expect(rec.leasesRecovered).toBe(1);
    const { rows: ia } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [idA]);
    expect(ia[0].state).toBe("READY");
    const { rows: aa } = await env.pool.query(
      "SELECT result, finished_at FROM attempts WHERE intent_id=$1", [idA]);
    expect(aa[0].result).toBe("lease_expired");
    expect(aa[0].finished_at).not.toBeNull();
    const { rows: ib } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [idB]);
    expect(ib[0].state).toBe("LEASED"); // still held — not freed by A's pass
    const { rows: ab } = await env.pool.query(
      "SELECT result, finished_at FROM attempts WHERE intent_id=$1", [idB]);
    expect(ab[0].finished_at).toBeNull(); // attempt not closed by another desk's pass

    // and a later scoped pass for B still recovers it exactly once
    const rec2 = await reconcileTick(env.pool, env.config, env.clock, keysB.deskId);
    expect(rec2.leasesRecovered).toBe(1);
    const { rows: ib2 } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [idB]);
    expect(ib2[0].state).toBe("READY");
  });

  it("a refusal after a lost response holds the intent and keeps the uncertain slot", async () => {
    const keys = await seed(env, "desk-hold");
    const { approvalId, policyId } = await approvalFor(keys, "0xMKT-HOLD");
    const enq = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    const intentId = (enq.body as { intent: { id: string } }).intent.id;

    // response lost → SENT_UNKNOWN + open reconciliation case + reserved slot
    transport.failNextSubmit("timeout");
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    const { rows: st } = await env.pool.query(
      "SELECT state FROM intents WHERE id=$1", [intentId]);
    expect(st[0].state).toBe("SENT_UNKNOWN");

    // rights revoked while uncertain → refusal must HOLD, not block+release the slot
    await api(env, "PATCH", `/api/sources/${policyId}`, {
      key: keys.keys.editor, payload: { canSubmit: false },
    });
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w2" } });
    const { rows: st2 } = await env.pool.query(
      "SELECT state, block_reason FROM intents WHERE id=$1", [intentId]);
    expect(st2[0].state).toBe("HOLD");
    expect(st2[0].block_reason).toMatch(/^uncertain_remote:/);
    const { rows: q } = await env.pool.query(
      "SELECT state FROM quota_reservations WHERE intent_id=$1", [intentId]);
    expect(q[0].state).toBe("reserved"); // slot still held — remote submission may exist
    const { rows: oc } = await env.pool.query(
      "SELECT count(*)::int c FROM reconciliation_cases WHERE intent_id=$1 AND resolved_at IS NULL",
      [intentId]);
    expect(oc[0].c).toBe(1); // the uncertainty is still tracked, never guessed closed
  });
});
