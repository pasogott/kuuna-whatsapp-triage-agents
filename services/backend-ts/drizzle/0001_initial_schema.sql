CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE role_name AS ENUM ('owner', 'admin', 'operator', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE template_version_status AS ENUM ('draft', 'ready', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE binding_status AS ENUM ('draft', 'provisioning', 'active', 'inactive', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE runtime_mode AS ENUM ('on_demand', 'hot');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE runtime_status AS ENUM ('pending', 'provisioning', 'healthy', 'degraded', 'stopped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_event_type AS ENUM ('message_created', 'message_edited', 'message_deleted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE media_status AS ENUM ('pending', 'ready', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE transcript_status AS ENUM ('pending', 'ready', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE knowledge_scope AS ENUM ('common', 'group', 'customer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE knowledge_version_status AS ENUM ('draft', 'ready', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE embedding_scope AS ENUM ('common', 'group', 'customer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE outbound_status AS ENUM ('pending', 'sending', 'sent', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tool_risk_class AS ENUM ('read', 'write', 'admin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE template_build_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE runtime_run_status AS ENUM ('started', 'succeeded', 'failed', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE todo_status AS ENUM ('open', 'in_progress', 'done', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE todo_priority AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE agent_run_status AS ENUM ('running', 'succeeded', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  name text NOT NULL,
  image text,
  role role_name NOT NULL DEFAULT 'viewer',
  banned boolean NOT NULL DEFAULT false,
  ban_reason text,
  ban_expires timestamptz,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  impersonated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);

CREATE TABLE IF NOT EXISTS verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_group_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_group_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES group_templates(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  status template_version_status NOT NULL,
  system_prompt text,
  model_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  tools_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  egress_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

CREATE TABLE IF NOT EXISTS tool_catalog_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  risk_class tool_risk_class NOT NULL,
  category text NOT NULL DEFAULT 'general',
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_group_id text NOT NULL,
  template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
  status binding_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_binding_id uuid NOT NULL REFERENCES group_bindings(id) ON DELETE CASCADE,
  runtime_mode runtime_mode NOT NULL DEFAULT 'on_demand',
  status runtime_status NOT NULL,
  runtime_container_name text,
  runtime_base_url text,
  secrets_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_group_id text NOT NULL,
  provider_message_id text NOT NULL,
  sender_provider_user_id text,
  latest_version_no integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_group_id, provider_message_id)
);

CREATE TABLE IF NOT EXISTS message_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  event_type message_event_type NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  text_content text,
  raw_event jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, version_no)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_media_id text NOT NULL,
  mime_type text NOT NULL,
  file_name text,
  byte_size integer,
  s3_key text,
  status media_status NOT NULL DEFAULT 'pending',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  text_content text,
  language text,
  status transcript_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_common_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_key text NOT NULL UNIQUE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_group_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_group_id text NOT NULL,
  doc_key text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_group_id, doc_key)
);

CREATE TABLE IF NOT EXISTS knowledge_customer_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_group_id text NOT NULL,
  customer_key text NOT NULL,
  doc_key text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_key, doc_key)
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope knowledge_scope NOT NULL,
  doc_ref_id uuid NOT NULL,
  version_no integer NOT NULL,
  status knowledge_version_status NOT NULL,
  content_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, doc_ref_id, version_no)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope embedding_scope NOT NULL,
  source_version_id uuid NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  chunk_no integer NOT NULL,
  content text NOT NULL,
  token_count integer NOT NULL,
  embedding text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_intent_id uuid NOT NULL UNIQUE,
  provider_group_id text NOT NULL,
  status outbound_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_group_id text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  binding_id uuid NOT NULL REFERENCES group_bindings(id) ON DELETE CASCADE,
  template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
  template_build_id uuid,
  image_ref text NOT NULL,
  status runtime_run_status NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms integer,
  error text,
  execution jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES group_templates(id) ON DELETE CASCADE,
  template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  status template_build_status NOT NULL DEFAULT 'queued',
  image_ref text,
  image_tag text,
  build_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  logs_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_group_id text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  agent_run_id uuid,
  title text NOT NULL,
  description text,
  status todo_status NOT NULL DEFAULT 'open',
  priority todo_priority NOT NULL DEFAULT 'normal',
  due_at timestamptz,
  completed_at timestamptz,
  exported_at timestamptz,
  export_attempt_count integer NOT NULL DEFAULT 0,
  external_ref text,
  last_export_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  provider_group_id text NOT NULL,
  trace_id text,
  status agent_run_status NOT NULL,
  model_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_used text,
  reasoning_effort text NOT NULL DEFAULT 'medium',
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieval_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_text text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS message_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_group_id text NOT NULL,
  decision_type text NOT NULL,
  reason text,
  should_execute boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  provider_group_id text NOT NULL,
  tool_name text NOT NULL,
  ok boolean NOT NULL DEFAULT false,
  stdout text NOT NULL DEFAULT '',
  stderr text NOT NULL DEFAULT '',
  timed_out boolean NOT NULL DEFAULT false,
  duration_ms integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieval_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  provider_group_id text,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  chunk_no integer NOT NULL,
  content text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  embedding text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_no)
);

CREATE TABLE IF NOT EXISTS message_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_group_id text NOT NULL,
  url text NOT NULL,
  normalized_url text NOT NULL,
  title text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, normalized_url)
);

CREATE INDEX IF NOT EXISTS ix_messages_provider_group_id_created_at
  ON messages (provider_group_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_instances_runtime_container_name
  ON agent_instances (runtime_container_name)
  WHERE runtime_container_name IS NOT NULL;
