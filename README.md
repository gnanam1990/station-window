# Station Window

Forecast-desk evidence workflow for Delphi competition markets. Resolves literal
market rules to exact weather stations and permitted sources, captures dated
observations, evaluates typed predicates, drafts citation-backed factual notes,
routes them through editorial approval, and — only when independently authorized
and eligible — dispatches evidence through the official Delphi SDK while
reconciling remote judgment and bounty state.

## Stack

- Node ≥ 20, TypeScript, Fastify 5, React 18 + Vite 6
- PostgreSQL 17 via `pg` (docker-compose, bound to loopback)
- `@gensyn-ai/gensyn-delphi-sdk` 2.4.x for the live transport (fixture transport
  for local contract tests — fixture evidence is never live evidence)
- Vitest 2 (integration + happy-dom browser tests)

## Quick start (local, no external credentials)

```bash
npm ci
docker compose up -d                      # postgres on 127.0.0.1:55432 (named volume kept)
npm run migrate                           # applies src/db/migrations
npm run cli -- seed --desk demo             # creates desk + role API keys (printed once)
npm run cli -- catalog                    # seeds station catalogue (NOAA/NDBC, training)
npm run dev                               # API on http://127.0.0.1:8787
```

In other terminals:

```bash
npm run worker                            # ingest/outbox/poll/research loop
npm run web                               # vite dev server; proxies /api → 127.0.0.1:8787
```

For a production-style serve: `npm run build` then `npm run dev` — the API serves
`dist/` directly at `http://127.0.0.1:8787` (no vite needed).

Tests:

```bash
npm test                  # all specs: unit + integration + browser (real PG per file)
npm run test:integration  # DB-backed suites only
npm run test:browser      # UI tests over a real listening server
npm run typecheck && npm run build
```

## CLI

`npm run cli -- <command> [--option value ...]`

| command | purpose |
|---|---|
| `migrate` | apply pending migrations (known-variant upgrade validated by checksum+schema) |
| `seed --desk <slug>` | idempotent desk + role keys |
| `catalog` | seed station catalogue |
| `import-card --desk SLUG --file FILE` | import a market card version |
| `ingest --policy ID` | run one source ingest cycle |
| `evaluate --desk SLUG --binding ID` | evaluate a binding at current time |
| `research` | draft grounded candidates for changed inputs |
| `dispatch --desk SLUG --approval ID` / `outbox` / `poll` | intent → send → remote poll passes |
| `reconcile` | resolve open cases from remote state before resend |
| `replay --desk SLUG --binding ID --as-of TIME` | deterministic re-evaluation at a knowledge instant |
| `export --desk SLUG` | redacted audit export (auditor only) |
| `report --desk SLUG --out FILE` | redacted integration report (versions/times/outcomes) |
| `backup --desk SLUG --out FILE` | full desk backup — **CLI only**, file written `0600` |
| `restore --file FILE --desk SLUG [--replace]` | restore into an empty or (explicitly) replaced desk |
| `doctor` | liveness/readiness, connector lag, quota, open reconciliation |

## Roles

`auditor` (read-only: receipts, export, report), `analyst` (browse, evaluate,
research), `editor` (bindings, policies, approvals, intents), `worker`
(ingest + outbox + reconcile). The audit export and integration report are
auditor-exclusive per the FR-01 read-only auditor scope — analyst/editor/worker
keys get 403.

## Live evidence boundary (read this)

Remote transmission requires **all** of: `SW_MODE=competition`,
`SW_LIVE_SUBMISSIONS=yes`, `DELPHI_BASE_URL`, `DELPHI_API_KEY` — plus an
independently authorized account, accepted terms, and an eligible current market
card verified at gate time. Dev/replay modes and the fixture transport never
transmit. A local run, fixture result, public market listing or queued receipt
is never labelled a live competition judgment (`GET /api/ops/report` →
`evidence.liveCompetition` shows `BLOCKED` with the exact missing dependencies).

Source captures are labelled at ingest: `live` (fetched from the remote endpoint)
vs `historical_replay` (operator-imported retained sample; inline content is
refused in competition mode). NOAA/NDBC realtime2 is read-only public data.

## Ops

- Backup/restore are **local CLI-only** (no HTTP route — they write server files
  and cross desk boundaries). Backup reads under repeatable-read isolation and
  writes `0600`; restore into an existing desk requires `--replace` and holds
  `LEASED`/`SENT_UNKNOWN`/`REMOTE_KNOWN` intents pending remote reconciliation.
- `GET /api/ops/doctor` is desk-scoped over HTTP; `npm run doctor` is global.
- `GET /api/ops/export` / `GET /api/ops/report` are auditor-scoped and redacted.

## Layout

```
src/
  app.ts server.ts cli.ts worker.ts   entry points
  auth.ts config.ts seed.ts
  core/                               clock, decimal, units, tz, errors, safeFetch, ids
  db/migrations/                      numbered SQL, checksum-verified
  modules/                            markets, sources, ingest(+ndbc), evaluate,
                                      research, delphi(transport), outbox, projections,
                                      ops, recovery, report
  routes/                             HTTP surface
  web/                                React workbench (inbox, detail, queue, receipts)
  worker/loop.ts                      role loop
test/                                 unit, integration (real PG), browser (happy-dom)
deploy/compose.app.yml                api+worker overlay on the postgres compose
Dockerfile                            ui-build + runtime stages
```

See `docs/RUNBOOK.md` for the operator runbook and `evidence/` for captured
module/test evidence.
