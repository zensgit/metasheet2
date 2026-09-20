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
-- 2026-09-20 (F6): the `automation_rules.actions` rows below were rewritten to
-- the RUNTIME action shape `{ "type": …, "config": { … } }`. The pre-F6 rows put
-- `url` directly on the action object, which no code path ever produces —
-- the editor writes `action.config.url`
-- (apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:504) and the
-- executor reads `config.url`
-- (packages/core-backend/src/multitable/automation-executor.ts:4199). The old
-- `$.**` sweep matched either shape, so the inaccuracy was invisible; the
-- narrowed read-path predicate is shape-exact, so the fixture has to be too.
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
-- ── NARROW positives: an http:// literal sitting on a jsonpath the executor
--    actually dereferences. Every one of these breaks when #5619 lands.
-- N1 — top-level action config (`$[*].config.url`)
  ('r-top', 'sheet-a', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"url": "http://fake-top.invalid/hook"}}]'),
-- N2 — condition_branch branch-local action
--      (`$[*].config.branches[*].actions[*].config.url`;
--       automation-executor.ts:2348, :2378)
  ('r-nested', 'sheet-a', 'condition_branch', '{}'::jsonb,
   '[{"type": "condition_branch", "config": {"branches": [{"key": "b1", "actions": [{"type": "send_webhook", "config": {"url": "http://fake-nested.invalid/x"}}]}]}}]'),
-- N3 — condition_branch DEFAULT branch
--      (`$[*].config.defaultBranch.actions[*].config.url`;
--       automation-executor.ts:2342, :2372-2373)
  ('r-default', 'sheet-a', 'condition_branch', '{}'::jsonb,
   '[{"type": "condition_branch", "config": {"branches": [{"key": "b1", "actions": []}], "defaultBranch": {"key": "fallback", "actions": [{"type": "send_webhook", "config": {"url": "http://fake-default.invalid/x"}}]}}}]'),
-- N4 — LAYOUT reversal: written with spaces after the colons, which is also how
--      jsonb renders it back. The pre-F3 `'%"url":"http://%'` text pattern
--      missed this (and would miss the un-spaced input too, since jsonb does not
--      preserve the input layout).
  ('r-spaced', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[ { "type" : "send_webhook" , "config" : { "url" : "http://fake-spaced.invalid/x" } } ]'),
-- N5 — VALUE case reversal: `HTTP://`. URL schemes are case-insensitive and
--      fetch() dials this, so it MUST still be counted.
  ('r-upper', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"url": "HTTP://FAKE-UPPER.invalid/x"}}]'),
-- N6 — internal literal on a read path: counted by Q2 AND by Q7's floor.
  ('r-internal', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"url": "http://127.0.0.1:9999/hook"}}]'),
-- ── UPPER-BOUND-ONLY rows (F6): an http:// literal that the `$.**` sweep
--    counts and the executor never dials. These are the false positives the
--    narrowing removes; they stay listed in Q3 with narrow_hit = f.
-- U1 — KEY case reversal. `config.url` is a JavaScript property read
--      (automation-executor.ts:4199), so a stored `"URL"` member is never read;
--      such a rule fails with 'Webhook URL is required' today, guard or no guard.
  ('r-keycase', 'sheet-c', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"URL": "http://fake-keycase.invalid/x"}}]'),
-- U2 — THE HEADLINE FALSE POSITIVE: the egress target is https, but the
--      USER-AUTHORED body carries a `callbackUrl` string. The body is
--      serialised and POSTed TO config.url (automation-executor.ts:4205-4216);
--      it is payload for the receiver, not a target this process dials.
  ('r-body-callback', 'sheet-c', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"url": "https://fake-secure.invalid/hook", "body": {"callbackUrl": "http://fake-callback.invalid/cb"}}}]'),
-- ── NEGATIVES: neither narrow nor upper bound may count these.
-- X1 — https
  ('r-https', 'sheet-b', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"url": "https://fake-secure.invalid/x"}}]'),
-- X2 — HTTPS upper case (must not be swept in by a sloppy ~* '^http')
  ('r-https-upper', 'sheet-c', 'send_webhook', '{}'::jsonb,
   '[{"type": "send_webhook", "config": {"url": "HTTPS://FAKE-SECURE.invalid/x"}}]'),
-- X3 — a DECOY: the literal text `"url":"http://…` inside a non-url string
--      field. The pre-F3 TEXT pattern counted this row; neither the narrow
--      predicate nor the upper bound does (it is not a url-keyed member).
  ('r-decoy', 'sheet-c', 'send_notification', '{}'::jsonb,
   '[{"type": "send_notification", "config": {"text": "docs say \"url\":\"http://fake-doc.invalid\" is legacy"}}]'),
-- ── LEGACY COLUMN rows (Q4). `actions` is NULL, so toExecutorRule falls back to
--    `[{ type: action_type, config: action_config }]`
--    (automation-service.ts:1187-1190) and these DO run.
-- L1 — legacy single send_webhook (`$.url`)
  ('r-legacy', 'sheet-d', 'send_webhook',
   '{"url": "http://fake-legacy.invalid/hook"}'::jsonb, NULL),
-- L2 — legacy condition_branch (`$.branches[*].actions[*].config.url`)
  ('r-legacy-branch', 'sheet-d', 'condition_branch',
   '{"branches": [{"key": "b1", "actions": [{"type": "send_webhook", "config": {"url": "http://fake-legacy-branch.invalid/x"}}]}]}'::jsonb, NULL),
-- L3 — legacy upper-bound-only: https target, http callbackUrl in the body
  ('r-legacy-body', 'sheet-d', 'send_webhook',
   '{"url": "https://fake-secure.invalid/hook", "body": {"callbackUrl": "http://fake-legacy-cb.invalid/cb"}}'::jsonb, NULL);

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
