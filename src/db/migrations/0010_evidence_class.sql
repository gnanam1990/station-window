-- M10 evidence classification: every captured snapshot is labelled so historical
-- replays and live captures can never be conflated in reports or UI (INV-10).
--   live              — fetched from the real remote endpoint during a live run
--   historical_replay — retained/operator-imported sample bytes (pinned fixture path)
--   fixture           — synthetic transport/contract data, never external evidence

ALTER TABLE snapshots
  ADD COLUMN evidence_class text NOT NULL DEFAULT 'historical_replay'
  CHECK (evidence_class IN ('live','historical_replay','fixture'));

CREATE INDEX snapshots_class ON snapshots(desk_id, evidence_class);
