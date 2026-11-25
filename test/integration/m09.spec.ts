import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeTestEnv, seed, type TestEnv } from "../helpers.ts";
import { makeFixtureTransport } from "../../src/modules/delphi.ts";
import { backupDesk, restoreDesk } from "../../src/modules/ops.ts";
import { reconcileTick } from "../../src/modules/recovery.ts";
import { dispatchTick } from "../../src/modules/outbox.ts";
import { createPool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

const ADMIN_URL =
  process.env.SW_DATABASE_URL ?? "postgres://station:station_local_dev@127.0.0.1:55432/postgres";

let env: TestEnv;
let transport: ReturnType<typeof makeFixtureTransport>;
const restoreDbs: { name: string; pool: pg.Pool }[] = [];

beforeAll(async () => {
  transport = makeFixtureTransport();
  env = await makeTestEnv({ config: { transportOverride: transport, liveSubmissionsEnabled: true } });
  const { seedCatalog } = await import("../../src/modules/catalog.ts");
  await seedCatalog(env.pool);
});
afterAll(async () => {
  await env.close();
  for (const r of restoreDbs) {
    await r.pool.end();
    const admin = createPool(ADMIN_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${r.name} WITH (FORCE)`);
    await admin.end();
  }
});

/** An isolated, empty, migrated database — what a bare restore target looks like. */
async function emptyDatabase() {
  const admin = createPool(ADMIN_URL);
  const name = `sw_restore_${Math.random().toString(16).slice(2, 14)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  restoreDbs.push({ name, pool });
  return pool;
}

// fixture derived from the real 46002 realtime2 feed (header + row shapes)
const NDBC_FEED = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 30 01 50 180 18.0 24.0   7.5    11   8.7 200  999.0    MM    MM    MM   MM   MM    MM
2026 11 30 01 40 180 19.0 24.0   7.5    MM   8.7 200  995.7    MM    MM    MM   MM   MM    MM
2026 11 30 01 30 180 18.0 23.0    MM    MM    MM  MM  995.5    MM    MM    MM   MM   MM    MM
2026 11 30 01 20 180 19.0 24.0   6.7    10   8.5 196  995.6    MM    MM    MM   MM   MM    MM
`;

async function stationId(externalId: string) {
  const { rows } = await env.pool.query("SELECT id FROM stations WHERE external_id=$1", [externalId]);
  return rows[0].id as string;
}

/**
 * Full NOAA pipeline on 46002/WVHT: card → binding → source policy → real
 * realtime2 bytes through the parser → evaluation → grounded note → approval.
 */
async function noaaApproval(
  keys: Awaited<ReturnType<typeof seed>>, address: string,
  opts: { content?: string; canExport?: boolean } = {},
) {
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
      canSubmit: true, canExport: opts.canExport ?? false,
    },
  });
  const policyId = (pol.body as { id: string }).id;
  await api(env, "POST", "/api/observations/import", {
    key: keys.keys.worker,
    payload: { sourcePolicyId: policyId, content: opts.content ?? NDBC_FEED },
  });
  await api(env, "POST", "/api/evaluations", {
    key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
  });
  const run = await api(env, "POST", "/api/research/run", {
    key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
  });
  const cand = (run.body as { candidate: { id: string; note_text?: string } }).candidate;
  const ap = await api(env, "POST", `/api/candidates/${cand.id}/approve`, { key: keys.keys.editor });
  return {
    approvalId: (ap.body as { id: string }).id,
    policyId, bindingId, candidateId: cand.id, noteText: cand.note_text,
  };
}

describe("T-025 backup restore holds possibly-sent intents until remote read", () => {
  it("full restore into an empty database: arrays/jsonb/unbound stations survive; held sends reconcile first", async () => {
    const keys = await seed(env, "desk-t025");
    // intent 1: outstanding — remote landed but the response was lost
    const { approvalId: a1 } = await noaaApproval(keys, "0xMKT-T025-A");
    const c1 = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId: a1 } });
    const i1 = (c1.body as { intent: { id: string; idempotency_key: string } }).intent;
    transport.failNextSubmit("timeout");
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    // intent 2: delivered, awaiting remote judgment
    const { approvalId: a2 } = await noaaApproval(keys, "0xMKT-T025-B");
    const c2 = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId: a2 } });
    const i2 = (c2.body as { intent: { id: string } }).intent;
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    // intent 3: mid-send when the backup is taken (leased, possibly-sent)
    const { approvalId: a3 } = await noaaApproval(keys, "0xMKT-T025-C");
    const c3 = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId: a3 } });
    const i3 = (c3.body as { intent: { id: string } }).intent;
    await env.pool.query("UPDATE intents SET state='LEASED' WHERE id=$1", [i3.id]);

    // an unbound source station: policy exists but no rule binding ever used it
    const s46050 = await stationId("46050");
    await api(env, "POST", "/api/sources", {
      key: keys.keys.editor,
      payload: {
        stationId: s46050, dataset: "realtime2", variable: "PRES",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46050.txt",
      },
    });

    // capture source-of-truth rows for comparison
    const { rows: srcApprovals } = await env.pool.query(
      "SELECT id, observation_ids FROM approvals WHERE desk_id=$1", [keys.deskId]);
    const { rows: srcCandidates } = await env.pool.query(
      "SELECT id, citation_set, material_delta, observation_ids FROM candidates WHERE desk_id=$1", [keys.deskId]);
    const { rows: srcSnaps } = await env.pool.query(
      "SELECT id, digest, content FROM snapshots WHERE desk_id=$1", [keys.deskId]);

    const dir = mkdtempSync(join(tmpdir(), "sw-backup-"));
    const file = join(dir, "desk-t025.backup.json");
    const backup = await backupDesk(env.pool, "desk-t025", file);
    // private permissions: key material is inside
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(backup.counts.observations).toBeGreaterThan(0);

    const target = await emptyDatabase();
    const res = await restoreDesk(target, file);
    expect(res.deskId).toBe(keys.deskId);
    expect(res.heldIntents).toBe(3); // SENT_UNKNOWN + REMOTE_KNOWN + LEASED all held

    // all three intents held pending reconciliation — none may send
    const { rows: held } = await target.query(
      "SELECT id, state, block_reason FROM intents WHERE desk_id=$1 ORDER BY id", [keys.deskId]);
    expect(held.every((h) => h.state === "HOLD")).toBe(true);
    expect(held.every((h) => h.block_reason === "restored_pending_reconciliation")).toBe(true);
    const { rows: cases } = await target.query(
      "SELECT count(*)::int n FROM reconciliation_cases WHERE desk_id=$1 AND resolved_at IS NULL",
      [keys.deskId]);
    expect(cases[0].n).toBe(3);

    // arrays / jsonb / bytea round-trip verbatim
    const { rows: dstApprovals } = await target.query(
      "SELECT id, observation_ids FROM approvals WHERE desk_id=$1", [keys.deskId]);
    expect(dstApprovals.sort((a, b) => (a.id as string).localeCompare(b.id as string)))
      .toEqual(srcApprovals.sort((a, b) => (a.id as string).localeCompare(b.id as string)));
    const { rows: dstCandidates } = await target.query(
      "SELECT id, citation_set, material_delta, observation_ids FROM candidates WHERE desk_id=$1", [keys.deskId]);
    expect(dstCandidates[0].citation_set).toEqual(srcCandidates[0].citation_set);
    expect(dstCandidates[0].observation_ids).toEqual(srcCandidates[0].observation_ids);
    const { rows: dstSnaps } = await target.query(
      "SELECT id, digest, content FROM snapshots WHERE desk_id=$1", [keys.deskId]);
    expect(dstSnaps[0].digest).toBe(srcSnaps[0].digest);
    expect((dstSnaps[0].content as Buffer).equals(srcSnaps[0].content as Buffer)).toBe(true);

    // unbound source station + policy restored; desk settings/audit present
    const { rows: station } = await target.query(
      "SELECT s.external_id FROM source_policies sp JOIN stations s ON s.id=sp.station_id WHERE sp.desk_id=$1 AND s.external_id='46050'",
      [keys.deskId]);
    expect(station.length).toBe(1);
    const { rows: keys2 } = await target.query(
      "SELECT count(*)::int n FROM principals WHERE desk_id=$1", [keys.deskId]);
    expect(keys2[0].n).toBeGreaterThan(0);

    // held sends must NOT transmit before reconciliation reads remote state
    const submitsBefore = transport.submitCalls;
    const d = await dispatchTick(target, env.config, env.clock, { workerId: "w-restore" });
    expect(transport.submitCalls).toBe(submitsBefore);
    const { rows: still } = await target.query(
      "SELECT count(*)::int n FROM intents WHERE desk_id=$1 AND state='HOLD'", [keys.deskId]);
    expect(still[0].n).toBe(3);

    // reconciliation reads remote state, then classifies — never guesses
    const rec = await reconcileTick(target, env.config, env.clock);
    expect(rec.casesOpen).toBe(0);
    const { rows: after } = await target.query(
      `SELECT i.id, i.state, rc.resolution FROM intents i
       JOIN reconciliation_cases rc ON rc.intent_id=i.id
       WHERE i.desk_id=$1`, [keys.deskId]);
    const byId = new Map(after.map((r) => [r.id as string, r]));
    // i1's lost response was recovered pre-backup by the second tick's
    // idempotent resubmit → receipt exists → remote read resolves it;
    // i2 was delivered cleanly → remote read; i3 was mid-send (LEASED) with
    // no receipt → released to resubmit under the same key
    expect(byId.get(i1.id)!.resolution).toBe("remote_state_read");
    expect(byId.get(i1.id)!.state).toBe("REMOTE_KNOWN");
    expect(byId.get(i2.id)!.resolution).toBe("remote_state_read");
    expect(byId.get(i2.id)!.state).toBe("REMOTE_KNOWN"); // released, poll continues
    expect(byId.get(i3.id)!.resolution).toBe("resubmit_idempotent");
    expect(byId.get(i3.id)!.state).toBe("SENT_UNKNOWN");

    // i3's resend is now lawful — same key, one remote id even if the
    // pre-backup lease had already landed a submission remotely
    await dispatchTick(target, env.config, env.clock, { workerId: "w-restore" });
    const { rows: i3r } = await target.query(
      "SELECT state FROM intents WHERE id=$1", [i3.id]);
    expect(i3r[0].state).toBe("REMOTE_KNOWN");
    const { rows: rec3 } = await target.query(
      "SELECT remote_id FROM receipts WHERE intent_id=$1", [i3.id]);
    expect(rec3.length).toBe(1); // one remote id, not two — key dedupe held
  });
});

describe("restore regression: out-of-order revision/history rows", () => {
  it("restores self-linked rows enumerated child-first; history ids regenerate", async () => {
    const keys = await seed(env, "desk-order");
    const { approvalId, candidateId } = await noaaApproval(keys, "0xMKT-ORDER");
    // judged intent → rewards + reward_history rows (GENERATED ALWAYS ids)
    const c = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    const intent = (c.body as { intent: { id: string } }).intent;
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    transport.setJudged({ verdict: "correct", bountyAmount: "0", bountyState: "none" });
    await api(env, "POST", "/api/outbox/poll", { key: keys.keys.worker });
    transport.setJudged({ verdict: "correct", bountyAmount: "5", bountyState: "paid" });
    await api(env, "POST", "/api/outbox/poll", { key: keys.keys.worker });
    transport.setJudged(undefined);
    // a v2 draft supersedes v1 — candidates gain a self-referencing parent_id
    // (after dispatch: editing stales the approval by design — T-018)
    const v2 = await api(env, "POST", `/api/candidates/${candidateId}/edit`, {
      key: keys.keys.editor,
      payload: { noteText: "revised factual sentence for the out-of-order test" },
    });
    expect(v2.status).toBe(200);
    const { rows: histN } = await env.pool.query(
      `SELECT count(*)::int n FROM reward_history rh
       JOIN rewards r ON r.id=rh.reward_id WHERE r.desk_id=$1`, [keys.deskId]);
    expect(histN[0].n).toBeGreaterThanOrEqual(1);

    const dir = mkdtempSync(join(tmpdir(), "sw-backup-"));
    const file = join(dir, "order.json");
    await backupDesk(env.pool, "desk-order", file);
    // deliberately enumerate children before parents in the backup file
    const bak = JSON.parse(readFileSync(file, "utf8"));
    bak.tables.candidates.reverse(); // v2 (references v1) now precedes its parent
    const obs = bak.tables.observations;
    obs[0].supersedes = obs[1].id;     // fabricated self-link, child listed first
    [obs[0], obs[1]] = [obs[1], obs[0]];
    bak.tables.reward_history.reverse();
    writeFileSync(file, JSON.stringify(bak));

    const target = await emptyDatabase();
    const res = await restoreDesk(target, file);
    expect(res.heldIntents).toBe(0); // DONE intent: no unresolved effect to hold
    const { rows: kids } = await target.query(
      "SELECT id, parent_id FROM candidates WHERE parent_id IS NOT NULL AND desk_id=$1",
      [keys.deskId]);
    expect(kids.length).toBe(1);
    // v1 restored verbatim: superseded by v2, whose parent link survived the
    // child-first enumeration
    const { rows: v1 } = await target.query(
      "SELECT status FROM candidates WHERE id=$1", [candidateId]);
    expect(v1[0].status).toBe("superseded");
    expect(kids[0].parent_id).toBe(candidateId);
    const { rows: sup } = await target.query(
      "SELECT count(*)::int n FROM observations WHERE supersedes IS NOT NULL AND desk_id=$1",
      [keys.deskId]);
    expect(sup[0].n).toBe(1);
    const { rows: rh } = await target.query(
      `SELECT rh.remote_status, rh.bounty_state FROM reward_history rh
       JOIN rewards r ON r.id=rh.reward_id WHERE r.desk_id=$1`, [keys.deskId]);
    expect(rh.length).toBe(histN[0].n);
    expect(rh.every((h) => h.remote_status === "judged")).toBe(true);
  });
});

describe("T-026 429 Retry-After then outage: backoff respected, next retry exposed", () => {
  it("rate-limit schedules retry at Retry-After; outage reschedules; sends resume after", async () => {
    const keys = await seed(env, "desk-t026");
    const { approvalId } = await noaaApproval(keys, "0xMKT-T026");
    const c = await api(env, "POST", "/api/intents", { key: keys.keys.editor, payload: { approvalId } });
    const intent = (c.body as { intent: { id: string } }).intent;
    const submits0 = transport.submitCalls;

    // provider answers 429 with Retry-After: 600 — honored verbatim (> old 300s cap)
    transport.failNextSubmit("rate_limit", 600);
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    const { rows: rs } = await env.pool.query(
      "SELECT next_at, attempts FROM retry_schedule WHERE intent_id=$1", [intent.id]);
    const nextAt = new Date(rs[0].next_at as string).getTime();
    expect(nextAt - env.clock.now().getTime()).toBe(600_000);
    const { rows: st } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [intent.id]);
    expect(st[0].state).toBe("READY"); // eligible later, not blocked

    // a tick inside the backoff window must not touch the provider
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    expect(transport.submitCalls).toBe(submits0 + 1);

    // transient outage: even when eligible, the fault reschedules cleanly
    transport.setOutage(true);
    env.clock.set(new Date(nextAt + 1_000));
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    expect(transport.submitCalls).toBe(submits0 + 1);
    const { rows: rs2 } = await env.pool.query(
      "SELECT next_at, attempts FROM retry_schedule WHERE intent_id=$1", [intent.id]);
    expect(rs2[0].attempts).toBe(2); // next eligible retry is recorded, not guessed
    const nextAt2 = new Date(rs2[0].next_at as string).getTime();
    expect(nextAt2).toBeGreaterThan(env.clock.now().getTime());
    const { rows: st2 } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [intent.id]);
    expect(st2[0].state).toBe("READY");

    // service restored + backoff elapsed → the same intent transmits once
    transport.setOutage(false);
    env.clock.set(new Date(nextAt2 + 1_000));
    await api(env, "POST", "/api/outbox/tick", { key: keys.keys.worker, payload: { workerId: "w1" } });
    expect(transport.submitCalls).toBe(submits0 + 2);
    const { rows: st3 } = await env.pool.query("SELECT state FROM intents WHERE id=$1", [intent.id]);
    expect(st3[0].state).toBe("REMOTE_KNOWN");
  });
});

describe("T-027 desk-scoped redacted export: no other desk, keys, restricted bytes or prose", () => {
  it("export contains only the calling desk's digests, never raw keys/secrets", async () => {
    const keysA = await seed(env, "desk-t027a");
    // restricted policy: retains bytes locally, forbids export
    const { noteText } = await noaaApproval(keysA, "0xMKT-T027A", {
      content: `${NDBC_FEED}# restricted-source-marker\n`,
    });
    // permitted policy: same station/dataset, different variable, export granted
    const s46002 = await stationId("46002");
    const pol = await api(env, "POST", "/api/sources", {
      key: keysA.keys.editor,
      payload: {
        stationId: s46002, dataset: "realtime2", variable: "PRES",
        endpointUrl: "https://www.ndbc.noaa.gov/data/realtime2/46002.txt?mkt=permitted",
        canExport: true,
      },
    });
    await api(env, "POST", "/api/observations/import", {
      key: keysA.keys.worker,
      payload: {
        sourcePolicyId: (pol.body as { id: string }).id,
        content: `${NDBC_FEED}# permitted-source-marker\n`,
      },
    });

    // a second desk whose data must never appear in desk A's export
    const keysB = await seed(env, "desk-t027b");
    const b = await noaaApproval(keysB, "0xMKT-T027B");

    const res = await api(env, "GET", "/api/ops/export", { key: keysA.keys.auditor });
    expect(res.status).toBe(200);
    const exp = res.body as {
      desk: { slug: string };
      restrictedSourceEndpoints: string[];
      tables: Record<string, Record<string, unknown>[]>;
    };
    const json = JSON.stringify(exp);

    expect(exp.desk.slug).toBe("desk-t027a");
    // no other desk's rows, markets or prose
    expect(json).not.toContain("desk-t027b");
    expect(json).not.toContain("0xMKT-T027B");
    // no key material from either desk
    for (const k of Object.values(keysA.keys).concat(Object.values(keysB.keys)))
      expect(json).not.toContain(k as string);
    expect(json).not.toContain("api_key_hash");
    // restricted source bytes withheld; digest still proves the fetch
    const snaps = exp.tables.snapshots ?? [];
    const restricted = snaps.filter((s) => s.content_withheld);
    const permitted = snaps.filter((s) => !s.content_withheld && s.content);
    expect(restricted.length).toBe(1);
    expect(permitted.length).toBe(1);
    expect(exp.restrictedSourceEndpoints).toContain(
      "https://www.ndbc.noaa.gov/data/realtime2/46002.txt?mkt=0xMKT-T027A");
    const decoded = permitted.map((s) => Buffer.from(s.content as string, "base64").toString());
    expect(decoded[0]).toContain("permitted-source-marker");
    expect(decoded.join()).not.toContain("restricted-source-marker");
    // draft prose never leaves; the digest preserves verifiability
    expect(json).not.toContain(noteText as string);
    expect(json).not.toContain(b.noteText as string);
    const cand = exp.tables.candidates?.[0];
    if (!cand) throw new Error("audit export is missing the candidate");
    expect(cand.note_text).toBeUndefined();
    expect(cand.note_digest).toBeTruthy();
    // auditor-exclusive surface (contract FR-01 read-only auditor scope):
    // analyst, editor and worker keys are all refused
    for (const k of [keysA.keys.analyst, keysA.keys.editor, keysA.keys.worker]) {
      const denied = await api(env, "GET", "/api/ops/export", { key: k });
      expect(denied.status).toBe(403);
    }
  });
});
