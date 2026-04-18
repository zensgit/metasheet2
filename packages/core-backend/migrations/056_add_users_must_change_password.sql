-- 056_add_users_must_change_password.sql
-- Support forced password change after admin resets or temporary-password onboarding

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
