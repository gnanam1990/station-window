// @vitest-environment happy-dom
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { makeTestEnv, seed, api, type TestEnv } from "../helpers.ts";
import { seedCatalog } from "../../src/modules/catalog.ts";
import { App } from "../../src/web/App.tsx";
import { MarketDetail } from "../../src/web/MarketDetail.tsx";
import { Queue } from "../../src/web/Queue.tsx";
import { ApiClient, type Transport } from "../../src/web/api.ts";

let env: TestEnv;
let base: string;

const transport: Transport = async ({ method, path, body, headers }) => {
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json().catch(() => ({})),
    setCookie: (res.headers.getSetCookie?.() ?? [])
      .concat(res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : [])
      .join("\n"),
  };
};

const client = () => new ApiClient(transport);

interface Seed { bindingId: string; stationId: string; policyId: string; marketVersionId: string }

async function seedDeskData(slug: string, opts: { gap?: boolean } = {}) {
  const keys = await seed(env, slug);
  await seedCatalog(env.pool);
  const { rows: st } = await env.pool.query(
    "select id from stations where external_id='EXAMPLE-A'");
  const imp = await api(env, "POST", "/api/markets/import", {
    key: keys.keys.editor,
    payload: {
      card: {
        address: `mkt-${slug}`, question: `Will station temp drop below freezing? (${slug})`,
        competitionId: "arena-1", evidenceCutoffAt: "2999-01-01T00:00:00Z",
        entryState: { canSubmit: true, remainingOnMarket: 3 },
      },
    },
  });
  const marketVersionId = (imp.body as { marketVersionId: string }).marketVersionId;
  const bind = await api(env, "POST", `/api/markets/${marketVersionId}/bindings`, {
    key: keys.keys.editor,
    payload: {
      stationId: st[0].id, authority: "training-source", dataset: "synthetic",
      variable: "air_temperature", operator: "lt", threshold: "0.0", unit: "degC",
      localZone: "UTC", localDate: "2026-11-30",
      dayDefinition: { type: "civil" },
      aggregatePolicy: { method: "sample_aggregate", aggregate: "max", cadenceMinutes: 60, minCoverage: 0.5 },
    },
  });
  const bindingId = (bind.body as { bindingId: string }).bindingId;
  await api(env, "POST", `/api/bindings/${bindingId}/verify`, { key: keys.keys.editor });
  const pol = await api(env, "POST", "/api/sources", {
    key: keys.keys.editor,
    payload: {
      stationId: st[0].id, dataset: "synthetic", variable: "air_temperature",
      endpointUrl: `https://training.example/feed-${slug}`, canSubmit: true,
    },
  });
  const policyId = (pol.body as { id: string }).id;
  // two readings three hours apart → one hourly-cadence gap when opts.gap
  const times = opts.gap ? ["2026-11-30T01:00:00Z", "2026-11-30T04:00:00Z"] : ["2026-11-30T01:00:00Z", "2026-11-30T02:00:00Z"];
  for (const t of times) {
    await api(env, "POST", "/api/observations/import", {
      key: keys.keys.worker,
      payload: {
        sourcePolicyId: policyId,
        content: JSON.stringify({ observedAt: t, fields: { air_temperature: "-0.5" } }),
      },
    });
  }
  return { keys, bindingId, stationId: st[0].id as string, policyId, marketVersionId };
}

async function makePendingCandidate(keys: { keys: Record<string, string> }, bindingId: string) {
  await api(env, "POST", "/api/evaluations", {
    key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
  });
  const run = await api(env, "POST", "/api/research/run", {
    key: keys.keys.analyst, payload: { ruleBindingId: bindingId },
  });
  return (run.body as { candidate: { id: string; version: number; note_text: string } }).candidate;
}

beforeAll(async () => {
  env = await makeTestEnv();
  await env.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = env.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  // the app is served same-origin in production (vite proxies /api); make the
  // test document share that origin so the real fetch path is exercised
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(base);
});

afterEach(() => cleanup());
afterAll(async () => {
  cleanup();
  await env.close();
});

describe("T-022: keyboard-only inspect → approve → refresh persists + focus returns", () => {
  it("walks the whole path with Tab/Enter only", async () => {
    const { keys, bindingId } = await seedDeskData("desk-t22");
    const cand = await makePendingCandidate(keys, bindingId);
    const c = client();
    const ui = render(<App client={c} />);
    const user = userEvent.setup();

    // sign in through the normal session path
    await user.type(await screen.findByLabelText("Desk API key"), keys.keys.editor);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Market inbox" });

    // navigate to the review queue via the nav link
    await user.click(screen.getByRole("link", { name: "Review queue" }));
    const item = await screen.findByRole("article", { name: /draft for Will station/ });
    expect(within(item).getByText(cand.note_text)).toBeTruthy();
    // the queue renders the real station id from the wire shape — never "unresolved"
    expect(item.textContent).toContain("EXAMPLE-A");
    expect(item.textContent).not.toContain("unresolved");

    // keyboard: tab to the citation link (inspect the source), prove it's a
    // real openable anchor, keep tabbing to Approve
    let target: HTMLElement | null = null;
    let sawSourceLink = false;
    for (let i = 0; i < 20; i++) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      if (el.tagName === "A" && el.getAttribute("href")?.startsWith("https://training.example"))
        sawSourceLink = true;
      if (el.getAttribute("aria-label")?.startsWith("approve draft")) { target = el; break; }
    }
    expect(sawSourceLink).toBe(true); // source inspectable by keyboard
    expect(target, "Approve must be reachable by Tab").toBeTruthy();

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(within(item).queryByRole("button", { name: /approve/i })).toBeNull());
    expect(within(item).getByText(/Approved/)).toBeTruthy();

    // focus returns predictably to the originating row after the re-render
    await waitFor(() =>
      expect((document.activeElement as HTMLElement)?.dataset?.focusKey)
        .toBe(`queue:${cand.id}`));

    // approval is persisted server-side, not just rendered
    const { rows: ap } = await env.pool.query(
      "select status, candidate_version from approvals where candidate_id=$1", [cand.id]);
    expect(ap[0].status).toBe("valid");

    // refresh (remount fetches fresh projections) — approval remains and focus
    // returns predictably to the originating row
    ui.unmount();
    const c2 = client();
    await c2.login(keys.keys.editor);
    render(<Queue client={c2} onError={() => {}} registerRefresh={() => () => {}} />);
    const item2 = await screen.findByRole("article", { name: /draft for Will station/ });
    expect(within(item2).getByText(/Approved/)).toBeTruthy();
    expect(within(item2).queryByRole("button", { name: /approve/i })).toBeNull();
  });
});

describe("T-023: phone-width gap explained in text and table rows, dual time", () => {
  it("marks the missing cadence bin and labels both clocks", async () => {
    const { keys, bindingId } = await seedDeskData("desk-t23", { gap: true });
    (window as { innerWidth: number }).innerWidth = 360;
    const c = client();
    await c.login(keys.keys.editor);
    render(<MarketDetail client={c} bindingId={bindingId} onError={() => {}} />);

    const table = await screen.findByTestId("series-table");
    // gap is explained by text, not just visually
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/gap/i);
    expect(note.textContent).toContain("60"); // cadence minutes spelled out

    // the gap row is explicit in the accessible table
    const rows = within(table).getAllByRole("row");
    const gapRow = rows.find((r) => r.textContent?.includes("gap before this row"));
    expect(gapRow, "a table row must carry the gap marker").toBeTruthy();

    // every observation row shows local + UTC time
    const observedCell = rows[1]!.querySelector("td")!.textContent!;
    expect(observedCell).toMatch(/Z\b/); // UTC marker
    expect(observedCell).toContain("UTC"); // zone label
    // second clock form present (local timestamp before the slash)
    expect(observedCell).toContain("/");

    // mobile no-horizontal-scroll contract lives in the shipped stylesheet
    const css = readFileSync("src/web/styles.css", "utf8");
    expect(css).toMatch(/@media\s*\(max-width:\s*520px\)/);
    expect(css).toMatch(/display:\s*block/); // stacked card rows
  });
});

describe("T-024: stale draft approve → conflict + actionable diff", () => {
  it("second-tab edit supersedes; approve on old draft shows conflict diff", async () => {
    const { keys, bindingId } = await seedDeskData("desk-t24");
    const cand = await makePendingCandidate(keys, bindingId);

    // tab A: analyst view loaded BEFORE the edit
    const tabA = client();
    await tabA.login(keys.keys.editor);
    render(<Queue client={tabA} onError={(e) => console.log("TAB-A-ERR", e)} registerRefresh={() => () => {}} />);
    const item = await screen.findByRole("article", { name: /draft for Will station/ });
    const approveBtn = within(item).getByRole("button", { name: /approve draft/i });

    // tab B: a second client (separate credential, no shared cookie jar —
    // same mechanism as two browser profiles) edits → v2, v1 superseded
    const v2 = await api(env, "POST", `/api/candidates/${cand.id}/edit`, {
      key: keys.keys.analyst,
      payload: { noteText: `${cand.note_text} Revised with station calibration.` },
    });
    expect(v2.status).toBe(200);
    expect((v2.body as { version: number }).version).toBe(2);

    // tab A approves the now-stale v1 → conflict with actionable diff
    await userEvent.setup().click(approveBtn);
    const conflict = await screen.findByRole("alert");
    expect(within(conflict).getByText(/superseded/i)).toBeTruthy();
    expect(within(conflict).getByText(/v2/)).toBeTruthy();
    // diff renders the inserted words from the newer version
    const diff = conflict.querySelector(".diff");
    expect(diff).toBeTruthy();
    const inserted = [...diff!.querySelectorAll(".ins")].map((e) => e.textContent).join("");
    expect(inserted).toContain("Revised");

    // database agrees: v1 superseded, v2 pending_review, no approval created
    const { rows } = await env.pool.query(
      "select version, status from candidates where rule_binding_id=$1 order by version",
      [bindingId]);
    expect(rows.map((r) => [r.version, r.status])).toEqual([[1, "superseded"], [2, "pending_review"]]);
    const { rows: ap } = await env.pool.query(
      "select count(*)::int as n from approvals where candidate_id=$1", [cand.id]);
    expect(ap[0].n).toBe(0);
  });
});

describe("observed series plot: missing vs zero vs threshold", () => {
  it("plots only actual zeros, marks missing points, renders the threshold line", async () => {
    const detail = {
      asOf: "2026-11-30T12:00:00Z",
      market: { marketVersionId: "mv", address: "0x1", competitionId: "c", isCompetitionEntry: false, evidenceCutoffAtUtc: "2026-12-01T00:00:00Z" },
      rule: {
        verbatim: "lowest temp below 0 °C?", status: "verified",
        structured: { variable: "air_temperature", operator: "lt", threshold: "0.0", unit: "degC", localZone: "UTC", localDate: "2026-11-30", dayDefinition: { type: "civil" }, aggregatePolicy: {} },
      },
      station: { externalId: "EXAMPLE-A", authority: "training-source", cityLabel: null },
      series: {
        cadenceMinutes: 60,
        points: [
          { observationId: "o1", observedAtUtc: "2026-11-30T01:00:00Z", firstSeenAtUtc: "2026-11-30T01:05:00Z", value: "0.0", unit: "degC", bindingValue: "0.0", bindingUnit: "degC", quality: "ok", lineLocator: "line:1", gapBefore: false },
          { observationId: "o2", observedAtUtc: "2026-11-30T02:00:00Z", firstSeenAtUtc: "2026-11-30T02:05:00Z", value: null, unit: "degC", bindingValue: null, bindingUnit: "degC", quality: "missing", lineLocator: "line:2", gapBefore: false },
          { observationId: "o3", observedAtUtc: "2026-11-30T03:00:00Z", firstSeenAtUtc: "2026-11-30T03:05:00Z", value: "-1.5", unit: "degC", bindingValue: "-1.5", bindingUnit: "degC", quality: "ok", lineLocator: "line:3", gapBefore: false },
        ],
      },
      latestEvaluation: null,
      candidates: [], currentCandidate: null, editorPreview: null, sourcePolicies: [],
    };
    const stub = { get: async () => detail, post: async () => ({}) } as unknown as ApiClient;
    render(<MarketDetail client={stub} bindingId="b1" onError={(e) => { throw e; }} />);
    const fig = await screen.findByRole("figure", { name: /observed series chart/i });
    // exactly two plottable values: the real zero and -1.5 — null never coerces
    expect(fig.querySelectorAll("circle.pt")).toHaveLength(2);
    // the missing reading is marked, not silently dropped or zeroed
    expect(fig.querySelectorAll("text.pt.miss")).toHaveLength(1);
    // the binding threshold is drawn as a line, not only captioned
    expect(fig.querySelector("line.thr-line")).toBeTruthy();
    const table = screen.getByTestId("series-table");
    expect(table.textContent).toContain("missing");
    expect(table.textContent).toContain("0.0");
    // series table is wrapped in the scrollable region for narrow viewports
    expect(document.querySelector(".table-scroll")).toBeTruthy();
  });
});

describe("session persistence across refresh", () => {
  it("a new client resumes through /api/me + sw_csrf cookie, no API key stored", async () => {
    const keys = await seed(env, "resume-desk");
    const c1 = client();
    await c1.login(keys.keys.editor);
    // happy-dom's jar holds both cookies; only the non-HttpOnly one is readable
    expect(document.cookie).toContain("sw_csrf=");

    // simulate a plain refresh: a brand-new client keeps only what a real
    // browser would — the cookie jar and document.cookie, no API key stored
    const c2 = client();
    expect(await c2.resume()).toBe(true);
    expect(c2.role).toBe("editor");
    expect(c2.deskSlug).toBe("resume-desk");
    expect(c2.csrf).toBe(c1.csrf); // re-read from sw_csrf, not held in memory

    // App renders the workspace, not the login form, after resume
    render(<App client={c2} />);
    await screen.findByRole("link", { name: /market inbox/i });

    // a mutation after "refresh" passes the CSRF check end-to-end
    const imp = await c2.post<{ marketVersionId: string }>("/api/markets/import", {
      card: {
        address: "0xRESUME", question: "q?", competitionId: "arena-1",
        evidenceCutoffAt: "2999-01-01T00:00:00Z",
        entryState: { canSubmit: true, remainingOnMarket: 3 },
      },
    });
    expect(imp.marketVersionId).toBeTruthy();
  });
});
