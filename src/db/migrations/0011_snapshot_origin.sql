-- Retained copies from different acquisition paths have separate provenance.
ALTER TABLE snapshots DROP CONSTRAINT snapshots_source_policy_id_digest_key;
ALTER TABLE snapshots ADD UNIQUE (source_policy_id, digest, evidence_class);
