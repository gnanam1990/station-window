-- M06: mirrors. Same (station,dataset,variable) may be registered at several
-- endpoints; provenance of every observation keeps every endpoint path.

-- databases migrated before the column existed in 0003_observations.sql
ALTER TABLE observations ADD COLUMN IF NOT EXISTS is_official_final boolean NOT NULL DEFAULT false;

ALTER TABLE source_policies DROP CONSTRAINT source_policies_desk_id_station_id_dataset_variable_key;
ALTER TABLE source_policies
  ADD CONSTRAINT source_policies_endpoint_key
  UNIQUE (desk_id, station_id, dataset, variable, endpoint_url);

-- Every endpoint that produced a byte-identical copy of an observation is a
-- citation path for it. Ingesting identical bytes via a second policy is a
-- provenance no-op for the value but adds one row here.
CREATE TABLE observation_sources (
  id               uuid PRIMARY KEY,
  desk_id          uuid NOT NULL REFERENCES desks(id),
  observation_id   uuid NOT NULL REFERENCES observations(id),
  source_policy_id uuid NOT NULL REFERENCES source_policies(id),
  snapshot_id      uuid REFERENCES snapshots(id),
  endpoint_url     text NOT NULL,
  line_locator     text,
  first_seen_at    timestamptz NOT NULL,
  UNIQUE (observation_id, source_policy_id)
);
CREATE INDEX observation_sources_obs ON observation_sources(observation_id);

-- a revised candidate may keep identical note bytes (citation-only edit): the
-- dedup key must include the version so v2 does not collide with v1.
-- Only needed on databases created before the constraint gained `version`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'candidates_rule_binding_id_origin_group_note_digest_key'
  ) THEN
    ALTER TABLE candidates DROP CONSTRAINT candidates_rule_binding_id_origin_group_note_digest_key;
    ALTER TABLE candidates ADD CONSTRAINT candidates_group_note_version_key
      UNIQUE (rule_binding_id, origin_group, note_digest, version);
  END IF;
END $$;
