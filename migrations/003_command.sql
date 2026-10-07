CREATE TABLE IF NOT EXISTS command_projects (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS command_memories (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES command_projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('project', 'operator', 'research', 'decision')),
  content text NOT NULL,
  title text,
  source_url text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding jsonb,
  search_vector tsvector NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE command_memories ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE command_memories ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE command_memories ADD COLUMN IF NOT EXISTS captured_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE command_memories ADD COLUMN IF NOT EXISTS embedding jsonb;
ALTER TABLE command_memories ADD COLUMN IF NOT EXISTS search_vector tsvector NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION command_memories_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', concat_ws(' ', coalesce(NEW.title, ''), coalesce(NEW.source_url, ''), NEW.content));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS command_memories_search_vector_trigger ON command_memories;
CREATE TRIGGER command_memories_search_vector_trigger
BEFORE INSERT OR UPDATE OF title, source_url, content ON command_memories
FOR EACH ROW EXECUTE FUNCTION command_memories_search_vector_update();

UPDATE command_memories
SET search_vector = to_tsvector('simple', concat_ws(' ', coalesce(title, ''), coalesce(source_url, ''), content));

CREATE TABLE IF NOT EXISTS command_jobs (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES command_projects(id) ON DELETE SET NULL,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'complete', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS command_audit_events (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL,
  action text NOT NULL,
  project_id uuid REFERENCES command_projects(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('started', 'queued', 'running', 'awaiting_approval', 'complete', 'denied', 'failed', 'cancelled')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS command_memories_project_idx
  ON command_memories(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS command_memories_search_idx
  ON command_memories USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS command_jobs_status_idx
  ON command_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS command_jobs_recovery_idx
  ON command_jobs(created_at)
  WHERE kind = 'coding' AND status IN ('queued', 'running', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS command_audit_created_idx
  ON command_audit_events(created_at DESC);

-- Keep long-lived Community databases compatible with the bounded local task loop.
ALTER TABLE command_jobs DROP CONSTRAINT IF EXISTS command_jobs_status_check;
ALTER TABLE command_jobs
  ADD CONSTRAINT command_jobs_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_approval', 'complete', 'failed', 'cancelled'));
ALTER TABLE command_audit_events DROP CONSTRAINT IF EXISTS command_audit_events_outcome_check;
ALTER TABLE command_audit_events
  ADD CONSTRAINT command_audit_events_outcome_check
  CHECK (outcome IN ('started', 'queued', 'running', 'awaiting_approval', 'complete', 'denied', 'failed', 'cancelled'));

INSERT INTO schema_migrations(version) VALUES ('003_command')
ON CONFLICT (version) DO NOTHING;