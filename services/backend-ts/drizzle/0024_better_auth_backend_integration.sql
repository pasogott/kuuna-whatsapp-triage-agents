ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS image text,
  ADD COLUMN IF NOT EXISTS role role_name NOT NULL DEFAULT 'viewer',
  ADD COLUMN IF NOT EXISTS banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ban_reason text,
  ADD COLUMN IF NOT EXISTS ban_expires timestamptz;

UPDATE users
SET
  name = COALESCE(NULLIF(name, ''), email),
  email_verified = true,
  banned = CASE
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users'
        AND column_name = 'is_active'
    )
    THEN NOT COALESCE((to_jsonb(users)->>'is_active')::boolean, true)
    ELSE banned
  END;

DO $$
BEGIN
  IF to_regclass('user_roles') IS NOT NULL AND to_regclass('roles') IS NOT NULL THEN
    UPDATE users
    SET role = ranked_roles.role::role_name
    FROM (
      SELECT
        ur.user_id,
        CASE
          WHEN bool_or(r.name = 'owner') THEN 'owner'
          WHEN bool_or(r.name = 'admin') THEN 'admin'
          WHEN bool_or(r.name = 'operator') THEN 'operator'
          ELSE 'viewer'
        END AS role
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      GROUP BY ur.user_id
    ) ranked_roles
    WHERE ranked_roles.user_id = users.id;
  END IF;
END $$;

ALTER TABLE users
  ALTER COLUMN name SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email);

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

CREATE INDEX IF NOT EXISTS ix_session_user_id ON session (user_id);

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

CREATE INDEX IF NOT EXISTS ix_account_user_id ON account (user_id);

INSERT INTO account (user_id, account_id, provider_id, password, created_at, updated_at)
SELECT id, id::text, 'credential', to_jsonb(users)->>'password_hash', created_at, updated_at
FROM users
WHERE to_regclass('account') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'password_hash'
  )
  AND to_jsonb(users)->>'password_hash' IS NOT NULL
ON CONFLICT (provider_id, account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
