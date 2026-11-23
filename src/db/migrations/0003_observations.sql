-- M04 observation capture: snapshots, immutable observation versions, ingest checkpoints.

CREATE TABLE snapshots (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  source_policy_id uuid NOT NULL REFERENCES source_policies(id),
  url          text NOT NULL,
  fetched_at   timestamptz NOT NULL,      -- server receive time (retrieval clock)
  digest       text NOT NULL,             -- sha256 of raw bytes
  byte_length  integer NOT NULL,
  content      bytea,                     -- NULL when retention not permitted
  redacted     boolean NOT NULL DEFAULT false,
  etag         text,
  last_modified text,
  http_status  integer,
  parser_version text NOT NULL,
  UNIQUE (source_policy_id, digest)       -- conditional retrieval dedup
);
CREATE INDEX snapshots_policy_time ON snapshots(source_policy_id, fetched_at);

CREATE TABLE observations (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  station_id   uuid NOT NULL REFERENCES stations(id),
  dataset      text NOT NULL,
  variable     text NOT NULL,
  observed_at  timestamptz NOT NULL,
  observed_precision text NOT NULL DEFAULT 'minute', -- original precision label
  source_offset_minutes integer,          -- stated source offset if any
  source_zone  text,
  period_definition jsonb,                -- observation-period definition if declared
  published_at timestamptz,               -- authority release time if supplied
  first_seen_at timestamptz NOT NULL,     -- desk knowledge clock
  value_text   text,                      -- raw token
  value_num    numeric,                   -- NULL for sentinel/missing — never coerced to 0
  unit         text NOT NULL,
  canonical_value numeric,
  canonical_unit  text,
  qc_flag      text,
  quality      text NOT NULL DEFAULT 'good' CHECK (quality IN ('good','suspect','missing','bad')),
  parser_version text NOT NULL,
  snapshot_id  uuid REFERENCES snapshots(id),
  line_locator text,                      -- e.g. 'line:12' or byte range
  body_digest  text NOT NULL,
  seq          integer NOT NULL,          -- ordered revision index per station/variable/time
  supersedes   uuid REFERENCES observations(id),
  quarantined  boolean NOT NULL DEFAULT false,
  quarantine_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (desk_id, station_id, dataset, variable, observed_at, seq)
);
CREATE INDEX obs_lookup ON observations(desk_id, station_id, variable, observed_at);
CREATE INDEX obs_first_seen ON observations(desk_id, first_seen_at);

CREATE TABLE ingest_checkpoints (
  source_policy_id uuid PRIMARY KEY REFERENCES source_policies(id),
  last_snapshot_id uuid REFERENCES snapshots(id),
  last_completed_at timestamptz,
  state       text NOT NULL DEFAULT 'idle',  -- idle | fetching | parsing | failed
  failure_reason text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
