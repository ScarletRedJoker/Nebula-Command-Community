CREATE TABLE IF NOT EXISTS installation (
  id integer PRIMARY KEY CHECK (id = 1),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO installation(id, name) VALUES (1, 'Local Community')
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('002_seed')
ON CONFLICT (version) DO NOTHING;