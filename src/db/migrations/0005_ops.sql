-- M09 operations: connector health, feed pauses are source_policies.status; recovery holds.

CREATE TABLE connector_health (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  source_policy_id uuid REFERENCES source_policies(id),
  checked_at   timestamptz NOT NULL,
  ok           boolean NOT NULL,
  latency_ms   integer,
  detail       jsonb NOT NULL DEFAULT '{}'  -- redacted; never tokens/notes
);
CREATE INDEX connector_health_policy ON connector_health(source_policy_id, checked_at);

-- Restored backups set this hold; reconciliation clears it per intent after remote read.
-- (desk_settings key 'recovery.hold' carries the JSON detail; this table tracks the intents under review)
CREATE TABLE reconciliation_cases (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  intent_id    uuid REFERENCES intents(id),
  opened_at    timestamptz NOT NULL,
  resolved_at  timestamptz,
  resolution   text,                       -- remote_known | remote_absent | still_unknown
  detail       jsonb NOT NULL DEFAULT '{}'
);
