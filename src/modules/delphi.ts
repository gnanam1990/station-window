import { EvidenceClient, EvidenceApiError } from "@gensyn-ai/gensyn-delphi-sdk";
import type { AppConfig } from "../config.ts";

/**
 * M07 transport boundary. The real implementation is the official
 * @gensyn-ai/gensyn-delphi-sdk EvidenceClient; tests inject a fixture
 * implementing the same surface. A fixture transport is never live proof.
 */

export interface SubmitRequest {
  note: string;
  links: string[];
  marketAddress: string;
  idempotencyKey: string;
}

export interface SubmitResult {
  remoteId: string;
  status: string;
  requestId?: string;
  raw: unknown;
}

export interface RemoteStatus {
  remoteId: string;
  status: string; // queued|judging|judged|rejected|failed|unmatched
  /** the submission's markets list contained our exact market address */
  marketMatched: boolean;
  verdict: string | null;
  reason: string | null;
  bounty: { amount: string; state: string } | null;
  zeroPayReason: string | null;
  retryAfterSeconds?: number;
  raw: unknown;
}

const normMarket = (a: string) => a.trim().toLowerCase();

export interface EntryStateInfo {
  canSubmit: boolean;
  reason?: string;
  remainingOnMarket: number;
  rateLimitResetAt?: string;
}

export interface LimitsInfo {
  submitsLeftThisHour: number;
  hourEndsAt?: string;
  dailyCapLeft: number;
  dailyCapResetAt?: string;
}

export interface TermsInfo {
  version: string;
  url: string;
  acceptedAt: string | null;
}

export interface DelphiTransport {
  submit(p: SubmitRequest): Promise<SubmitResult>;
  getSubmission(remoteId: string, marketAddress: string): Promise<RemoteStatus>;
  getEntryState(market: string): Promise<EntryStateInfo>;
  getLimits(): Promise<LimitsInfo>;
  getTerms(): Promise<TermsInfo>;
}

/** Live transport — constructed only when the operator opted in AND credentialed. */
export function createSdkTransport(config: AppConfig): DelphiTransport {
  if (!config.delphiBaseUrl || !config.delphiApiKey)
    throw new Error("live transport requires delphiBaseUrl + delphiApiKey");
  const client = new EvidenceClient({
    baseUrl: config.delphiBaseUrl,
    apiKey: config.delphiApiKey,
    agentId: config.delphiAgentId || undefined,
    agentHarness: "station-window",
  });
  return {
    async submit(p) {
      const r = await client.submitEvidence({
        note: p.note, links: p.links, marketAddress: p.marketAddress,
        idempotencyKey: p.idempotencyKey,
      });
      return {
        remoteId: r.data.id, status: r.data.status,
        requestId: r.meta.requestId, raw: redact(r.data),
      };
    },
    async getSubmission(id, marketAddress) {
      const r = await client.getSubmission(id);
      // never take markets[0]: the provider may report several markets in any
      // order — only the exact (case-insensitive) target is our judgment.
      const m = r.data.markets.find(
        (x) => normMarket(x.marketAddress) === normMarket(marketAddress));
      return {
        remoteId: r.data.id, status: r.data.status,
        marketMatched: m !== undefined,
        verdict: m?.verdict ?? null, reason: m?.reason ?? null,
        bounty: m?.bounty ? { amount: m.bounty.amount, state: m.bounty.state } : null,
        zeroPayReason: m?.zeroPayReason ?? null,
        retryAfterSeconds: r.meta.retryAfterSeconds, raw: redact(r.data),
      };
    },
    async getEntryState(market) {
      const r = await client.getEntryState(market);
      return {
        canSubmit: r.data.canSubmit, reason: r.data.reason,
        remainingOnMarket: r.data.remainingOnMarket,
        rateLimitResetAt: r.data.rateLimit?.resetAt,
      };
    },
    async getLimits() {
      const r = await client.getLimits();
      return {
        submitsLeftThisHour: r.data.submitsLeftThisHour, hourEndsAt: r.data.hourEndsAt,
        dailyCapLeft: r.data.dailyCapLeft, dailyCapResetAt: r.data.dailyCapResetAt,
      };
    },
    async getTerms() {
      const r = await client.getTerms();
      return { version: r.data.version, url: r.data.url, acceptedAt: r.data.acceptedAt };
    },
  };
}

/** Receipts never carry auth headers or secrets. */
function redact(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (k, x) =>
    /key|token|secret|authorization/i.test(k) ? "[redacted]" : x)) as unknown;
}

/** Typed error surface used by the outbox to classify outcomes. */
export class TransportFault extends Error {
  constructor(
    readonly kind: "timeout" | "network" | "http",
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TransportFault";
  }
}

export function classifyError(err: unknown): TransportFault {
  if (err instanceof TransportFault) return err;
  if (err instanceof EvidenceApiError)
    return new TransportFault(
      "http", err.status, String(err.code), err.message, err.retryAfterSeconds ?? undefined,
    );
  if (err instanceof Error && /timeout|abort/i.test(err.message))
    return new TransportFault("timeout", 0, "timeout", err.message);
  return new TransportFault("network", 0, "network_error", (err as Error).message ?? "unknown");
}

/**
 * SDK-compatible fixture transport for contract tests — exercises the same
 * idempotency/status/bounty surface. Evidence class: fixture, never live.
 */
export function makeFixtureTransport(seedState: {
  termsAccepted?: boolean;
  canSubmit?: boolean;
  submitsLeft?: number;
  failNext?: "timeout" | "network";       // next submit loses its response
  judged?: { verdict: string; bountyAmount: string; bountyState: string; zeroPayReason?: string };
} = {}): DelphiTransport & {
  submissions: Map<string, { key: string; req: SubmitRequest; status: string; judged?: typeof seedState.judged }>;
  submitCalls: number;
} {
  const submissions = new Map<string, { key: string; req: SubmitRequest; status: string; judged?: typeof seedState.judged }>();
  const byKey = new Map<string, string>();
  const state = {
    termsAccepted: seedState.termsAccepted ?? true,
    canSubmit: seedState.canSubmit ?? true,
    submitsLeft: seedState.submitsLeft ?? 10,
    failNext: seedState.failNext,
    judged: seedState.judged,
    decoys: undefined as { marketAddress: string; verdict: string | null; bounty: { amount: string; state: string } | null; zeroPayReason?: string }[] | undefined,
    includeTarget: true as boolean,
    submissions, submitCalls: 0,
  };
  let n = 0;
  const t: DelphiTransport = {
    async submit(p) {
      state.submitCalls++;
      if (state.failNext) {
        // the write lands remotely; the response is lost — the classic ambiguous send
        const mode = state.failNext;
        state.failNext = undefined;
        if (!byKey.has(p.idempotencyKey)) {
          const id = `sub-${++n}`;
          byKey.set(p.idempotencyKey, id);
          submissions.set(id, { key: p.idempotencyKey, req: p, status: "queued" });
        }
        throw new TransportFault(mode === "timeout" ? "timeout" : "network", 0, mode, `simulated ${mode}`);
      }
      if (byKey.has(p.idempotencyKey)) {
        // provider idempotency: same key returns the original submission
        const id = byKey.get(p.idempotencyKey)!;
        return { remoteId: id, status: submissions.get(id)!.status, requestId: `req-${id}`, raw: { id } };
      }
      const id = `sub-${++n}`;
      byKey.set(p.idempotencyKey, id);
      submissions.set(id, { key: p.idempotencyKey, req: p, status: "queued" });
      return { remoteId: id, status: "queued", requestId: `req-${id}`, raw: { id } };
    },
    async getSubmission(remoteId, marketAddress) {
      const s = submissions.get(remoteId);
      if (!s) throw new TransportFault("http", 404, "not_found", "submission not found");
      if (state.judged) s.status = "judged";
      // provider-style markets list: decoys (other markets) may precede or
      // replace the target row; matching is the caller's job, like the SDK path
      const markets = [
        ...(state.decoys ?? []),
        ...(state.includeTarget === false ? [] : [{
          marketAddress: s.req.marketAddress,
          verdict: s.status === "judged" ? state.judged?.verdict ?? "correct" : null,
          bounty: s.status === "judged"
            ? { amount: state.judged?.bountyAmount ?? "0", state: state.judged?.bountyState ?? "none" }
            : null,
          zeroPayReason: state.judged?.zeroPayReason ?? null,
        }]),
      ];
      const m = markets.find((x) => normMarket(x.marketAddress) === normMarket(marketAddress));
      return {
        remoteId, status: s.status, marketMatched: m !== undefined,
        verdict: m?.verdict ?? null,
        reason: null,
        bounty: m?.bounty ?? null,
        zeroPayReason: (m as { zeroPayReason?: string } | undefined)?.zeroPayReason ?? null,
        raw: { id: remoteId, status: s.status, markets },
      };
    },
    async getEntryState() {
      return { canSubmit: state.canSubmit, remainingOnMarket: state.canSubmit ? 3 : 0 };
    },
    async getLimits() {
      return { submitsLeftThisHour: state.submitsLeft, dailyCapLeft: 50 };
    },
    async getTerms() {
      return { version: "v1", url: "https://terms.example/v1", acceptedAt: state.termsAccepted ? "2026-01-01T00:00:00Z" : null };
    },
  };
  const out = Object.assign(t, {
    submissions,
    /** test hooks */
    setJudged(j: typeof seedState.judged) { state.judged = j; },
    setCanSubmit(v: boolean) { state.canSubmit = v; },
    setSubmitsLeft(v: number) { state.submitsLeft = v; },
    failNextSubmit(mode: "timeout" | "network") { state.failNext = mode; },
    /** provider reports other markets' rows (before and/or without ours) */
    setMarketRows(
      decoys: { marketAddress: string; verdict?: string | null; bounty?: { amount: string; state: string } | null; zeroPayReason?: string }[],
      includeTarget = true,
    ) {
      state.decoys = decoys.map((d) => ({ verdict: null, bounty: null, ...d }));
      state.includeTarget = includeTarget;
    },
  });
  Object.defineProperty(out, "submitCalls", { get: () => state.submitCalls, enumerable: true });
  return out as never;
}
