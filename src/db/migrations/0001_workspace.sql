-- M01 workspace, principals, memberships, sessions, desk settings.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL
);

CREATE TABLE desks (
  id              uuid PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  deployment_mode text NOT NULL DEFAULT 'dev',
  clock_source    text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id           uuid PRIMARY KEY,
  desk_id      uuid NOT NULL REFERENCES desks(id),
  kind         text NOT NULL CHECK (kind IN ('user','worker')),
  display_name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  desk_id      uuid NOT NULL REFERENCES desks(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  role         text NOT NULL CHECK (role IN ('analyst','editor','worker','auditor')),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (desk_id, principal_id)
);

-- Browser sessions: cookie token + CSRF double-submit token (both stored hashed).
CREATE TABLE sessions (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES principals(id),
  desk_id       uuid NOT NULL REFERENCES desks(id),
  token_hash    text NOT NULL UNIQUE,
  csrf_hash     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_principal ON sessions(principal_id);

-- Per-desk operational flags: recovery_hold, clock overrides, etc.
CREATE TABLE desk_settings (
  desk_id   uuid NOT NULL REFERENCES desks(id),
  key       text NOT NULL,
  value     jsonb NOT NULL,
  set_at    timestamptz NOT NULL DEFAULT now(),
  set_by    uuid REFERENCES principals(id),
  PRIMARY KEY (desk_id, key)
);

-- Append-only audit of privileged reads/writes (metadata only, no payloads/secrets).
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  desk_id       uuid NOT NULL REFERENCES desks(id),
  principal_id  uuid REFERENCES principals(id),
  action        text NOT NULL,          -- e.g. read.export, approve, dispatch, transport.send
  resource_type text NOT NULL,
  resource_id   text,
  detail        jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_desk_at ON audit_log(desk_id, at);
