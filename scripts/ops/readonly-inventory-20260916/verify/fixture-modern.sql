-- ============================================================================
-- fixture-modern.sql — synthetic "Shape A / current migrations" fixture
-- ============================================================================
-- Loaded by run-verify.mjs into a throwaway schema (inventory_fixture_<rand>_modern)
-- on a LOCAL/CONTAINER PostgreSQL. NEVER run against a real database.
--
-- Column names mirror the repo's current migrations (hand-authored subsets, not
-- the migrations themselves — the pack only reads the columns listed here):
--   data_sources.config jsonb            src/db/migrations/20251206000001_create_data_sources_table.ts:30
--   automation_rules.actions jsonb       src/db/migrations/zzzz20260414100000_extend_automation_rules.ts:27
--   automation_rules.action_config jsonb src/db/migrations/zzzz20260413120000_create_automation_rules.ts:32
--   multitable_webhooks.url/active/created_by
--                                        src/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:34,37,40,41
--   users.permissions jsonb / is_admin / is_active
--                                        src/db/migrations/zzzz20260119100000_create_users_table.ts:16,17,19
--   user_roles / user_permissions / role_permissions
--                                        migrations/033_create_rbac_core.sql:16-18,34-36,43-45
--
-- ALL VALUES ARE OBVIOUSLY FAKE (`*.invalid` hosts, `FAKE-NOT-A-REAL-*`
-- placeholders). There is no real credential material anywhere in this file.
-- ============================================================================

CREATE TABLE data_sources (
  id   text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  config jsonb NOT NULL
);

-- F4 negative: an ordinary connection object — right SHAPE, zero secret-shaped
-- keys. The old id query listed it; the count never did.
INSERT INTO data_sources VALUES
  ('ds-clean', 'fake clean source', 'postgresql',
   '{"connection": {"host": "fake-host.invalid", "port": 5432, "user": "fake-user"}}'),
-- F4 positive (top level)
  ('ds-top', 'fake secret source', 'postgresql',
   '{"connection": {"host": "fake-host.invalid", "password": "FAKE-NOT-A-REAL-SECRET"}}'),
-- F4 positive (nested headers nook)
  ('ds-headers', 'fake http source', 'http',
   '{"connection": {"baseUrl": "https://fake.invalid", "headers": {"Authorization": "FAKE-NOT-A-REAL-BEARER"}}}'),
-- negative: no connection object at all
  ('ds-noconn', 'fake other source', 'http',
   '{"options": {"retries": 1}}');

CREATE TABLE automation_rules (
  id            text PRIMARY KEY,
  sheet_id      text NOT NULL,
  action_type   text NOT NULL,
  action_config jsonb DEFAULT '{}'::jsonb,
  actions       jsonb
);

INSERT INTO automation_rules VALUES
-- F3 positive 1 — top-level action, plain http
  ('r-top', 'sheet-a', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "url": "http://fake-top.invalid/hook"}]'),
-- F3 positive 2 — nested inside a condition_branch's inner actions
  ('r-nested', 'sheet-a', 'condition_branch', '{}'::jsonb,
   '[{"type": "condition_branch", "branches": [{"actions": [{"type": "send_webhook", "url": "http://fake-nested.invalid/x"}]}]}]'),
-- F3 positive 3 — LAYOUT reversal: written with spaces after the colons, which
--   is also how jsonb renders it back. The old `'%"url":"http://%'` pattern
--   missed this (and would miss the un-spaced input too, since jsonb does not
--   preserve the input layout).
  ('r-spaced', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[ { "type" : "send_webhook" , "url" : "http://fake-spaced.invalid/x" } ]'),
-- F3 positive 4 — CASE reversal on the key and the scheme
  ('r-upper', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "URL": "HTTP://FAKE-UPPER.invalid/x"}]'),
-- F3 negative 1 — https
  ('r-https', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "url": "https://fake-secure.invalid/x"}]'),
-- F3 negative 2 — HTTPS upper case (must not be swept in by a sloppy ~* '^http')
  ('r-https-upper', 'sheet-c', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "url": "HTTPS://FAKE-SECURE.invalid/x"}]'),
-- F3 negative 3 — a DECOY: the literal text `"url":"http://…` inside a
--   non-url string field. The old TEXT pattern counted this row; the JSON
--   semantic predicate does not (it is not a url-keyed member).
  ('r-decoy', 'sheet-c', 'send_notification', '{}'::jsonb,
   '[{"type": "send_notification", "text": "docs say \"url\":\"http://fake-doc.invalid\" is legacy"}]'),
-- legacy single-action column only (actions NULL) — Q4 population
  ('r-legacy', 'sheet-d', 'send_webhook',
   '{"url": "http://fake-legacy.invalid/hook"}'::jsonb, NULL);

CREATE TABLE multitable_webhooks (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  url        text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_by text NOT NULL
);

INSERT INTO multitable_webhooks VALUES
  ('w-http',       'fake active http',   'http://fake-sub.invalid/hook',   true,  'user-fake-1'),
  ('w-http-off',   'fake disabled http', 'http://fake-sub2.invalid/hook',  false, 'user-fake-2'),
  ('w-http-upper', 'fake upper http',    'HTTP://FAKE-SUB3.invalid/hook',  true,  'user-fake-1'),
  ('w-https',      'fake https',         'https://fake-secure.invalid/h',  true,  'user-fake-3'),
  ('w-internal',   'fake internal',      'http://127.0.0.1:9999/hook',     true,  'user-fake-3');

CREATE TABLE users (
  id          text PRIMARY KEY,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'user',
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  is_admin    boolean NOT NULL DEFAULT false
);

INSERT INTO users VALUES
  ('u-plain',      'fake1@example.invalid', 'user',  '[]'::jsonb,                 true,  false),
  ('u-flag',       'fake2@example.invalid', 'user',  '[]'::jsonb,                 true,  true ),
  ('u-role',       'fake3@example.invalid', 'admin', '[]'::jsonb,                 false, false),
  ('u-consistent', 'fake4@example.invalid', 'admin', '[]'::jsonb,                 true,  true ),
  ('u-wild',       'fake5@example.invalid', 'user',  '["*:*"]'::jsonb,            true,  false),
  ('u-scoped',     'fake6@example.invalid', 'user',  '["sheet:read"]'::jsonb,     true,  false);

CREATE TABLE user_roles (
  user_id text NOT NULL,
  role_id text NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
INSERT INTO user_roles VALUES
  ('u-consistent', 'admin'),
  ('u-scoped',     'editor');

CREATE TABLE user_permissions (
  user_id         text NOT NULL,
  permission_code text NOT NULL,
  PRIMARY KEY (user_id, permission_code)
);
INSERT INTO user_permissions VALUES
  ('u-plain',  '*:*'),
  ('u-scoped', 'sheet:read');

CREATE TABLE role_permissions (
  role_id         text NOT NULL,
  permission_code text NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);
INSERT INTO role_permissions VALUES
  ('editor', '*:*'),
  ('admin',  'sheet:read');
