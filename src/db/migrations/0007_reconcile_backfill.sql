-- Reconcile databases created by earlier shipped file variants and backfill
-- provenance for observations captured before observation_sources existed.

-- Databases created at fa3bea8 have the pre-desk-scope observation unique;
-- replace it with the desk-scoped key used by every later schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='observations'::regclass
      AND conname='observations_station_id_dataset_variable_observed_at_seq_key'
  ) THEN
    ALTER TABLE observations
      DROP CONSTRAINT observations_station_id_dataset_variable_observed_at_seq_key;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='observations'::regclass
        AND conname='observations_desk_scoped_key'
    ) THEN
      ALTER TABLE observations ADD CONSTRAINT observations_desk_scoped_key
        UNIQUE (desk_id, station_id, dataset, variable, observed_at, seq);
    END IF;
  END IF;
END $$;

-- Every pre-M06 observation keeps a link to the policy/snapshot that produced
-- it: citation paths are reconstructed from the stored snapshot's policy so
-- upgraded desks retain full provenance.
INSERT INTO observation_sources
  (id, desk_id, observation_id, source_policy_id, snapshot_id, endpoint_url, line_locator, first_seen_at)
SELECT gen_random_uuid(), o.desk_id, o.id, sn.source_policy_id, o.snapshot_id,
       sp.endpoint_url, o.line_locator, o.first_seen_at
FROM observations o
JOIN snapshots sn ON sn.id = o.snapshot_id
JOIN source_policies sp ON sp.id = sn.source_policy_id
ON CONFLICT (observation_id, source_policy_id) DO NOTHING;
