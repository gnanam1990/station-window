import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, makeTestEnv, seed, type TestEnv } from "../helpers.ts";

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

const synthLine = (observedAt: string, value: string) =>
  JSON.stringify({ observedAt, fields: { air_temperature: value } });

async function setupEvaluatedBinding(
  keys: Awaited<ReturnType<typeof seed>>, address: string,
) {
  const imp = await api(env, "POST", "/api/markets/import", {
    key: keys.keys.editor,
    payload: {
      card: {
        address, question: "practice?", competitionId: "arena-1",
        evidenceCutoffAt: "2999-01-01T00:00:00Z", entryState: { canSubmit: true },
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
  return bindingId;
}

async function registerPolicy(
  keys: Awaited<ReturnType<typeof seed>>, endpoint: string,
) {
  const r = await api(env, "POST", "/api/sources", {
    key: keys.keys.editor,
    payload: {
      stationId: await stationId("EXAMPLE-A"), dataset: "synthetic",
      variable: "air_temperature", endpointUrl: endpoint,
    },
  });
  return (r.body as { id: string }).id;
}

async function ingest(keys: Awaited<ReturnType<typeof seed>>, policyId: string, lines: string[]) {
  const r = await api(env, "POST", "/api/observations/import", {
    key: keys.keys.worker,
    payload: { sourcePolicyId: policyId, content: lines.join("\n") },
  });
  return r.body as { inserted: number; deduped: number };
}

describe("T-016 mirror and original derive one origin group", () => {
  it("identical bytes from two endpoints → one group, both citation paths, uncertain independence", async () => {
    const keys = await seed(env, "desk-t016");
    const bindingId = await setupEvaluatedBinding(keys, "0xMKT-T016");
    const p1 = await registerPolicy(keys, "https://training.example/feed");
    const p2 = await registerPolicy(keys, "https://mirror.training.example/feed-copy");
    const lines = [synthLine("2026-11-30T01:00:00Z", "-0.5")];
    const a = await ingest(keys, p1, lines);
    expect(a.inserted).toBe(1);
    const b = await ingest(keys, p2, lines);
    expect(b.inserted).toBe(0); // same bytes → deduped, provenance link retained
    expect(b.deduped).toBe(1);

    await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const res = await api(env, "POST", "/api/research/run", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      candidate: { origin_group: string; origin_group_uncertain: boolean; citation_set: { url: string }[] };
      originGroup: { citationPaths: string[]; independenceUncertain: boolean };
    };
    const urls = body.candidate.citation_set.map((c) => c.url).sort();
    expect(urls).toEqual([
      "https://mirror.training.example/feed-copy",
      "https://training.example/feed",
    ]);
    expect(body.originGroup.independenceUncertain).toBe(true);
    expect(body.candidate.origin_group_uncertain).toBe(true);
    // one origin group key, not two
    expect(body.originGroup.citationPaths.length).toBe(2);
  });
});

describe("T-017 wrong unit via model stub is rejected", () => {
  it("model proposal with degF label on a degC observation fails typed validation, manual edit offered", async () => {
    const keys = await seed(env, "desk-t017");
    const bindingId = await setupEvaluatedBinding(keys, "0xMKT-T017");
    const policyId = await registerPolicy(keys, "https://training.example/feed-t17");
    await ingest(keys, policyId, [synthLine("2026-11-30T01:00:00Z", "-0.1")]);
    await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const { rows } = await env.pool.query(
      "SELECT id FROM observations WHERE desk_id=$1", [keys.deskId]);
    const obsId = rows[0].id as string;
    const res = await api(env, "POST", "/api/research/run", {
      key: keys.keys.analyst,
      payload: {
        ruleBindingId: bindingId,
        proposedClaims: [{ observationId: obsId, value: "-0.1", unit: "degF" }],
      },
    });
    const body = res.body as {
      validation: { ok: boolean; reason?: string };
      candidate: { status: string; block_reason: string | null };
      manualEditAvailable: boolean;
    };
    expect(body.validation.ok).toBe(false);
    expect(body.validation.reason).toBe("unit_mismatch");
    expect(body.candidate.status).toBe("draft");
    expect(body.candidate.block_reason).toBe("model_claim_rejected:unit_mismatch");
    expect(body.manualEditAvailable).toBe(true);
    // rejected draft cannot be approved as-is
    const ap = await api(env, "POST", `/api/candidates/${body.candidate.id}/approve`, {
      key: keys.keys.editor,
    });
    expect(ap.status).toBe(409);
  });
});

describe("T-018 approval covers note bytes + citations", () => {
  it("changing a citation stales the approval even when note text is identical", async () => {
    const keys = await seed(env, "desk-t018");
    const bindingId = await setupEvaluatedBinding(keys, "0xMKT-T018");
    const policyId = await registerPolicy(keys, "https://training.example/feed-t18");
    await ingest(keys, policyId, [synthLine("2026-11-30T01:00:00Z", "-0.1")]);
    await api(env, "POST", "/api/evaluations", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const run = await api(env, "POST", "/api/research/run", {
      key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
    });
    const cand = (run.body as { candidate: { id: string; note_text: string; citation_set: unknown[] } }).candidate;

    const ap = await api(env, "POST", `/api/candidates/${cand.id}/approve`, { key: keys.keys.editor });
    expect(ap.status).toBe(200);
    const approval = ap.body as { id: string };
    const ok = await api(env, "GET", `/api/approvals/${approval.id}/sendable`, { key: keys.keys.analyst });
    expect(ok.status).toBe(200);

    // identical note text, different citation set → new version, old approval stale
    const cits = cand.citation_set as { url: string; locator: string; digest: string }[];
    const edited = await api(env, "POST", `/api/candidates/${cand.id}/edit`, {
      key: keys.keys.analyst,
      payload: {
        noteText: cand.note_text,
        citationSet: cits.map((c) => ({ ...c, locator: "line:99" })),
      },
    });
    expect(edited.status).toBe(200);
    const v2 = edited.body as { id: string; version: number; status: string };
    expect(v2.id).not.toBe(cand.id);
    expect(v2.version).toBe(2);
    expect(v2.status).toBe("pending_review");

    const stale = await api(env, "GET", `/api/approvals/${approval.id}/sendable`, { key: keys.keys.analyst });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe("approval_stale");

    // fresh approval on the new version works
    const ap2 = await api(env, "POST", `/api/candidates/${v2.id}/approve`, { key: keys.keys.editor });
    expect(ap2.status).toBe(200);
  });
});
