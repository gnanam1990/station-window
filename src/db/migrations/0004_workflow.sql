-- M05 evaluations; M06 candidates + approvals; M07 intents/attempts/receipts/rewards.

CREATE TABLE evaluations (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  rule_binding_id uuid NOT NULL REFERENCES rule_bindings(id),
  as_of        timestamptz NOT NULL,      -- declared knowledge instant
  inputs_manifest jsonb NOT NULL,         -- observation ids + digests
  result       jsonb NOT NULL,            -- typed comparisons, reason codes, source times
  verdict      text NOT NULL,             -- e.g. interim_fact | final | incomplete | unresolved | not_supported
  created_by   uuid REFERENCES principals(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_binding ON evaluations(rule_binding_id, as_of);

CREATE TABLE candidates (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  rule_binding_id uuid NOT NULL REFERENCES rule_bindings(id),
  evaluation_id uuid REFERENCES evaluations(id),
  origin_group text NOT NULL,             -- mirror groups share one group
  origin_group_uncertain boolean NOT NULL DEFAULT false,
  material_delta jsonb NOT NULL,
  rank         numeric NOT NULL DEFAULT 0,
  observation_ids uuid[] NOT NULL,
  citation_set jsonb NOT NULL,            -- sorted {url, locator, digest}
  note_text    text NOT NULL,
  note_digest  text NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  parent_id    uuid REFERENCES candidates(id),
  status       text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','approved','rejected','correction_requested','superseded')),
  block_reason text,                      -- why a blocked draft cannot be approved/sent
  created_by   uuid REFERENCES principals(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_binding_id, origin_group, note_digest)
);
CREATE INDEX candidates_desk ON candidates(desk_id, status);

CREATE TABLE review_events (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  actor_id     uuid REFERENCES principals(id),
  action       text NOT NULL CHECK (action IN ('approve','reject','request_correction','edit','submit_review')),
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);

-- Approvals are immutable; semantic edits create a new candidate version needing fresh approval.
CREATE TABLE approvals (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  candidate_version integer NOT NULL,
  note_digest  text NOT NULL,
  citations_hash text NOT NULL,
  rule_binding_id uuid NOT NULL REFERENCES rule_bindings(id),
  observation_ids uuid[] NOT NULL,
  editor_id    uuid NOT NULL REFERENCES principals(id),
  approved_at  timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','stale','consumed')),
  UNIQUE (desk_id, candidate_id, note_digest, citations_hash)
);

CREATE TABLE intents (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  approval_id  uuid NOT NULL REFERENCES approvals(id),
  provider_account text NOT NULL,
  market_address text NOT NULL,
  payload      jsonb NOT NULL,            -- canonical submission payload
  payload_digest text NOT NULL,
  idempotency_key uuid NOT NULL,
  state        text NOT NULL DEFAULT 'READY'
    CHECK (state IN ('READY','LEASED','SENT_UNKNOWN','REMOTE_KNOWN','BLOCKED','HOLD','DONE')),
  block_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_account, market_address, approval_id),
  UNIQUE (provider_account, idempotency_key)
);
CREATE INDEX intents_state ON intents(desk_id, state);

CREATE TABLE attempts (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  intent_id    uuid NOT NULL REFERENCES intents(id),
  epoch        integer NOT NULL,
  worker_id    text NOT NULL,
  leased_at    timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at   timestamptz,
  finished_at  timestamptz,
  result       text,                      -- sent | timeout | refused:<reason> | error:<class>
  http_status  integer,
  UNIQUE (intent_id, epoch)
);

CREATE TABLE receipts (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  intent_id    uuid REFERENCES intents(id),
  provider_account text NOT NULL,
  remote_id    text NOT NULL,
  raw_status   text NOT NULL,
  payload      jsonb NOT NULL,            -- raw provider response (redacted of auth)
  observed_at  timestamptz NOT NULL,
  UNIQUE (provider_account, remote_id)
);

-- Wallet/market-scoped slot reservations, taken atomically with the intent.
CREATE TABLE quota_reservations (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  intent_id    uuid NOT NULL REFERENCES intents(id),
  market_address text NOT NULL,
  slot_index   integer NOT NULL,          -- 1..3 per (provider_account, market)
  provider_account text NOT NULL,
  state        text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','consumed','released')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  UNIQUE (provider_account, market_address, slot_index)
);

-- Per-market remote judgment/bounty state, kept separate from the verdict.
CREATE TABLE rewards (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  intent_id    uuid NOT NULL REFERENCES intents(id),
  receipt_id   uuid REFERENCES receipts(id),
  market_address text NOT NULL,
  remote_status text NOT NULL,            -- queued|judging|judged|rejected|failed|unmatched
  verdict      text,
  reason       text,
  bounty_amount_raw text,                 -- preserved exactly as provider string
  bounty_currency  text,                  -- NULL when denomination unverified → excluded from totals
  bounty_state text CHECK (bounty_state IN ('held','paid','voided','none')),
  zero_pay_reason text,
  last_poll_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, market_address)
);

CREATE TABLE reward_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reward_id    uuid NOT NULL REFERENCES rewards(id),
  remote_status text NOT NULL,
  bounty_state text,
  bounty_amount_raw text,
  observed_at  timestamptz NOT NULL,
  raw          jsonb NOT NULL DEFAULT '{}'
);

-- Provider-side quota the remote reports as authoritative.
CREATE TABLE provider_quota (
  desk_id   uuid NOT NULL REFERENCES desks(id),
  provider_account text NOT NULL,
  metric    text NOT NULL,                -- submits_left_this_hour | daily_cap_left | per_market
  market_address text,
  remaining text,
  reset_at  timestamptz,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (desk_id, provider_account, metric, market_address)
);

-- Next eligible provider retry instant per intent (Retry-After honored).
CREATE TABLE retry_schedule (
  intent_id   uuid PRIMARY KEY REFERENCES intents(id),
  next_at     timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
