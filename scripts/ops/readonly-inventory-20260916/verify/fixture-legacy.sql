-- ============================================================================
-- fixture-legacy.sql — synthetic "Shape B / older raw-SQL DDL" fixture
-- ============================================================================
-- Loaded by run-verify.mjs into a throwaway schema (inventory_fixture_<rand>_legacy)
-- on a LOCAL/CONTAINER PostgreSQL. NEVER run against a real database.
--
-- This is the schema the pack's "old shape" branches and the F5 missing-column
-- paths are aimed at (hand-authored subsets):
--   data_sources.connection jsonb, NO config    migrations/040_data_sources.sql:12-13
--   users.permissions TEXT[], NO is_admin, NO is_active
--                                               migrations/054_create_users_table.sql:5,9,10
--   automation_rules WITHOUT the V1 `actions` column (pre-
--     zzzz20260414100000_extend_automation_rules.ts:27) — this is what makes
--     02-trg04 report `incomplete reason=missing-column:automation_rules.actions`
--     instead of a zero.
--
-- ALL VALUES ARE OBVIOUSLY FAKE.
-- ============================================================================

CREATE TABLE data_sources (
  id         varchar(100) PRIMARY KEY,
  name       varchar(255) NOT NULL,
  type       varchar(50)  NOT NULL,
  connection jsonb NOT NULL,
  credentials jsonb
);

INSERT INTO data_sources VALUES
-- negative: ordinary connection, no secret-shaped key (F4 control)
  ('ds-b-clean', 'fake clean', 'postgresql',
   '{"host": "fake-host.invalid", "user": "fake-user"}', NULL),
-- positive: nested headers nook
  ('ds-b-hit', 'fake secret', 'http',
   '{"baseUrl": "https://fake.invalid", "headers": {"apiKey": "FAKE-NOT-A-REAL-KEY"}}', NULL);

CREATE TABLE automation_rules (
  id            text PRIMARY KEY,
  sheet_id      text NOT NULL,
  action_type   text NOT NULL,
  action_config jsonb DEFAULT '{}'::jsonb
);

-- On this schema there is no `actions` column at all, so toExecutorRule's
-- fallback (`[{ type: action_type, config: action_config }]` —
-- automation-service.ts:1187-1190) applies to EVERY row: `action_config` IS the
-- executed action config here.
INSERT INTO automation_rules VALUES
-- narrow + upper bound: `$.url` on a send_webhook config
  ('r-b-legacy', 'sheet-x', 'send_webhook', '{"url": "http://fake-legacy-b.invalid/hook"}'::jsonb),
-- neither: https target
  ('r-b-https',  'sheet-x', 'send_webhook', '{"url": "https://fake-secure-b.invalid/hook"}'::jsonb),
-- upper bound ONLY (F6): https target, http `callbackUrl` inside the
-- user-authored body — payload for the receiver, never dialled by this process
  ('r-b-body',   'sheet-x', 'send_webhook', '{"url": "https://fake-secure-b.invalid/hook", "body": {"callbackUrl": "http://fake-cb-b.invalid/cb"}}'::jsonb);

CREATE TABLE multitable_webhooks (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  url        text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_by text NOT NULL
);

INSERT INTO multitable_webhooks VALUES
  ('w-b-http',  'fake http',  'http://fake-sub-b.invalid/hook',  true,  'user-fake-9'),
  ('w-b-https', 'fake https', 'https://fake-secure-b.invalid/h', true,  'user-fake-9');

CREATE TABLE users (
  id          text PRIMARY KEY,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'user',
  permissions text[] NOT NULL DEFAULT '{}'
);

INSERT INTO users VALUES
  ('u-b-plain', 'fake7@example.invalid', 'user',  '{}'),
  ('u-b-role',  'fake8@example.invalid', 'admin', '{}'),
  ('u-b-wild',  'fake9@example.invalid', 'user',  '{"*:*"}'),
  ('u-b-ok',    'fake10@example.invalid','admin', '{}');

CREATE TABLE user_roles (
  user_id text NOT NULL,
  role_id text NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
INSERT INTO user_roles VALUES ('u-b-ok', 'admin');

CREATE TABLE user_permissions (
  user_id         text NOT NULL,
  permission_code text NOT NULL,
  PRIMARY KEY (user_id, permission_code)
);
INSERT INTO user_permissions VALUES ('u-b-plain', 'sheet:read');

CREATE TABLE role_permissions (
  role_id         text NOT NULL,
  permission_code text NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);
INSERT INTO role_permissions VALUES ('viewer', 'sheet:read');
