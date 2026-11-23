-- M02 market intake + rule bindings; M03 stations + source policies.

CREATE TABLE market_versions (
  id              uuid PRIMARY KEY,
  desk_id         uuid NOT NULL REFERENCES desks(id),
  network         text NOT NULL,
  competition_id  text NOT NULL,
  market_address  text NOT NULL,
  content_digest  text NOT NULL,
  rule_revision   integer NOT NULL DEFAULT 1,
  source_wording  text NOT NULL,           -- verbatim question text
  card_json       jsonb NOT NULL,          -- raw card for provenance/replay
  field_provenance jsonb NOT NULL DEFAULT '{}',
  eligibility_opens_at  timestamptz,
  cutoff_at       timestamptz NOT NULL,    -- UTC evidence cutoff
  terms_fetched_at timestamptz,
  is_competition_entry boolean NOT NULL DEFAULT false,  -- regular cards cannot enter live outbox
  imported_by     uuid REFERENCES principals(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (desk_id, competition_id, market_address, content_digest)
);
CREATE INDEX market_versions_desk ON market_versions(desk_id, cutoff_at);

CREATE TABLE stations (
  id           uuid PRIMARY KEY,
  authority    text NOT NULL,              -- e.g. 'NOAA/NDBC'
  external_id  text NOT NULL,              -- exact station/buoy id e.g. '46002'
  city_label   text,
  local_zone   text,                       -- IANA zone
  kind         text NOT NULL DEFAULT 'station', -- station | buoy
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (authority, external_id)
);

-- Aliases may be ambiguous: one alias can map to many stations.
CREATE TABLE station_aliases (
  id         uuid PRIMARY KEY,
  alias      text NOT NULL,
  station_id uuid NOT NULL REFERENCES stations(id),
  documented boolean NOT NULL DEFAULT false,  -- editor-documented mapping
  UNIQUE (alias, station_id)
);
CREATE INDEX station_aliases_alias ON station_aliases(alias);

CREATE TABLE rule_bindings (
  id                uuid PRIMARY KEY,
  desk_id           uuid NOT NULL REFERENCES desks(id),
  market_version_id uuid NOT NULL REFERENCES market_versions(id),
  version           integer NOT NULL,
  status            text NOT NULL CHECK (status IN ('unresolved','draft','verified','superseded')),
  authority         text,                 -- required once resolved
  station_id        uuid REFERENCES stations(id),
  dataset           text,                 -- e.g. 'realtime2'
  variable          text,                 -- e.g. 'WVHT'
  operator          text CHECK (operator IN ('lt','lte','gt','gte','eq','neq')),
  threshold_text    text,                 -- exact decimal as written
  unit              text,                 -- e.g. 'degC','m'
  local_zone        text,
  day_definition    jsonb,                -- {type:'civil'|'climatological'|...}
  local_date        date,                 -- the market's local day
  aggregate_policy  jsonb,                -- finality rules
  predicate_draft   jsonb NOT NULL DEFAULT '{}',
  binding_notes     text,
  created_by        uuid REFERENCES principals(id),
  verified_by       uuid REFERENCES principals(id),
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_version_id, version)
);
CREATE INDEX rule_bindings_desk ON rule_bindings(desk_id);

CREATE TABLE source_policies (
  id              uuid PRIMARY KEY,
  desk_id         uuid NOT NULL REFERENCES desks(id),
  station_id      uuid NOT NULL REFERENCES stations(id),
  dataset         text NOT NULL,
  variable        text NOT NULL,
  endpoint_url    text NOT NULL,          -- operator-registered; never analyst-entered at fetch time
  cadence_seconds integer NOT NULL DEFAULT 3600,
  -- distinct permissions
  can_browse      boolean NOT NULL DEFAULT true,
  can_retain      boolean NOT NULL DEFAULT true,
  can_submit      boolean NOT NULL DEFAULT false,
  can_export      boolean NOT NULL DEFAULT false,
  retention_until timestamptz,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  policy_version  integer NOT NULL DEFAULT 1,
  verification_evidence text,             -- who verified rights + when
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','expired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (desk_id, station_id, dataset, variable)
);
