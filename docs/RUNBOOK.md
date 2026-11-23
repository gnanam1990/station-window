# Station Window — Operator Runbook

Audience: a fresh operator on a clean checkout. Everything here uses normal UI,
CLI and worker paths. Live competition proof is a separate gated section at the
end — skip it unless you hold an authorized account and an eligible card.

## 0. Prerequisites

- Node ≥ 20 (`node --version`), Docker with compose
- No credentials needed for the local path. Ports used: `127.0.0.1:8787` (API/UI),
  `127.0.0.1:55432` (Postgres), vite dev `127.0.0.1:5173`.

## 1. Install (T-030 clean profile)

```bash
git clone <repo> station-window && cd station-window
npm ci
docker compose up -d                 # postgres, loopback-only
npm run migrate
npm run cli -- seed --desk demo        # save the printed role keys
npm run cli -- catalog
```

Start three processes (or `docker compose -f docker-compose.yml -f deploy/compose.app.yml up -d --build` for the container path):

```bash
npm run dev        # API 127.0.0.1:8787 — runs migrations on boot
npm run worker     # SW_WORKER_ROLES=ingest,outbox,poll,research,reconcile
npm run web        # vite dev UI (proxies /api to 8787)
```

Sanity: `curl -s http://127.0.0.1:8787/api/health` and `npm run doctor` (global).
Desk-scoped variant: `GET /api/ops/doctor` with a desk key.

## 2. Desk workflow (UI + API parity)

1. Import a market card: `POST /api/markets/import` with an editor key. Card revisions digest eligibility fields — re-imports are idempotent.
2. Bind the rule: `POST /api/markets/{mv}/bindings` (station, authority, dataset,
   variable, predicate, local zone/date, day definition) → `/verify`.
   A binding to a station that doesn't serve the endpoint is refused
   (`station_endpoint_mismatch`) — e.g. a `46050` policy at the `46002` file.
3. Register a source policy: `POST /api/sources` with endpoint + permission
   flags (`canBrowse/canRetain/canSubmit/canExport`). Station-endpoint
   consistency is enforced.
4. Ingest: `POST /api/observations/import` (retained sample —
   `evidence_class=historical_replay`) or let the `ingest` worker fetch the
   remote endpoint (`evidence_class=live`). Snapshots dedupe on
   `(source_policy, digest, evidence_class)`; checkpoints resume a crashed parse.
5. Evaluate: `POST /api/evaluations` (analyst). Canonical units convert to the
   binding's declared unit; coverage counts unique cadence bins; `final` only at
   a mature window with a sourced official-final input.
6. Research + review: `POST /api/research/run` drafts a grounded candidate —
   note bytes, `observation_ids` and `citation_set` scoped to the printed
   sentence. Editor approves (`/api/candidates/{id}/approve`). Editing
   supersedes and stales the approval; approving the stale draft returns 409
   with the successor for a diff.
7. Dispatch: `POST /api/intents` (editor) → worker `outbox` leases, re-gates at
   send time, submits with the intent's stable idempotency key → `poll` tracks
   remote state into `rewards` (verdict/bounty kept apart from local state).

## 3. Video runbook shot-list

1. Terminal: `docker compose up -d && npm run migrate` — show applied list.
2. Terminal: `seed` — show role keys once, point at `.env.example` scope notes.
3. Browser `http://127.0.0.1:5173`: log in (analyst key) → inbox shows the market
   card with station authority/external ID, cutoff in local + UTC.
4. Import a retained NOAA sample via CLI `ingest`, reload — observation timeline
   fills; open a source receipt (digest, fetched_at, endpoint).
5. Evaluate → candidate appears in the review queue; switch to editor session,
   approve — note + citations visible.
6. Editor creates the intent; watch `worker` log dispatch → receipts → poll.
7. Phone-width viewport: same detail page stacks as cards, no horizontal scroll;
   keyboard-only tab through approve → focus returns after refresh.
8. `npm run cli -- report --desk demo` — show versions/times/outcomes + the
   `liveCompetition: BLOCKED` block.

## 4. Failure drills

- **Outage**: worker keeps intents `READY` with `retry_schedule.next_at`
  (429 `Retry-After` honored). `doctor` shows connector lag + open cases.
- **Lost response**: timeout on submit → `SENT_UNKNOWN` + reconciliation case;
  the next tick resubmits the *same* key — provider dedupes, one remote id.
- **Disconnect / restart**: kill worker mid-lease → `reconcile` returns expired
  leases to `READY`; remote-read resolves restored/uncertain cases first.
- **Backup/restore** (CLI only):
  `npm run cli -- backup --desk demo --out backups/demo.json` (file is `0600`),
  `npm run cli -- restore --file backups/demo.json --desk demo --replace`.
  Restored `LEASED`/`SENT_UNKNOWN`/`REMOTE_KNOWN` intents hold until a reconcile
  reads remote state — possibly-sent is never resent blind.

## 5. Gated live competition proof (T-029)

Requires an authorized Delphi account, accepted terms, and a current eligible
market card — external authority we do not hold by default. To run it when
authorized:

```bash
SW_MODE=competition SW_LIVE_SUBMISSIONS=yes \
  DELPHI_BASE_URL=<api> DELPHI_API_KEY=<key> \
  npm run dev            # and worker
```

Then a normal dispatch intent produces a real remote id and poll yields the
actual judgment. Until then the integration report records
`evidence.liveCompetition.status = BLOCKED` with the exact missing dependencies.
Never report a fixture/local run as a live judgment (INV-10).
