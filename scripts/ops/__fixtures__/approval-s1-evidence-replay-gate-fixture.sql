-- Minimal, hand-authored fixture for approval-s1-evidence-replay-gate.test.mjs's execution layer.
-- NOT the real app schema — see the test file's own docblock for the explicit non-claim (this
-- fixture is derived FROM the workflow's SQL payloads, not independently from the app's real
-- migrations, so it can never red on drift between the two). Just enough shape for every
-- extracted psql -c payload in approval-s1-org-backfill-evidence.yml to execute without erroring,
-- plus:
--   - >=2 distinct ACTIVE user_orgs.org_id values ('default', 'org-two'), so a GROUP-BY-shaped
--     mutation of a probe (the two-row mutation proof in the test file) produces a real,
--     distinguishing multi-row result rather than a vacuous one-org one.
--   - exactly ONE kysely_migration row whose name matches the workflow's current MIGRATION_NAME
--     literal, so the raw p03 timestamp payload is meaningfully single-row (a drift guard in the
--     test file asserts this literal stays in sync with the workflow — see
--     "drift guard: extracted MIGRATION_NAME..." in approval-s1-evidence-replay-gate.test.mjs).

CREATE TABLE kysely_migration (
  name text PRIMARY KEY,
  timestamp varchar(255) NOT NULL
);

CREATE TABLE users (
  id text PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE user_orgs (
  user_id text NOT NULL,
  org_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE directory_integrations (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  status text NOT NULL
);

CREATE TABLE directory_accounts (
  id text PRIMARY KEY,
  integration_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE directory_account_links (
  local_user_id text NOT NULL,
  directory_account_id text NOT NULL,
  link_status text NOT NULL
);

CREATE TABLE approval_instances (
  id text PRIMARY KEY,
  org_id text,
  source_system text,
  template_id text,
  requester_snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_attachments (
  instance_id text NOT NULL,
  org_id text
);

-- U3' (Lock-11 §8, ratified activation precondition — docs/development/approval-lock11-writer-
-- org-derivation-20260822.md:1624): minimal shape for the two attendance tables the probe reads.
CREATE TABLE attendance_records (
  id text PRIMARY KEY,
  user_id text,
  org_id text
);

CREATE TABLE attendance_requests (
  id text PRIMARY KEY,
  user_id text,
  org_id text
);

-- ---- seed --------------------------------------------------------------------------------

INSERT INTO kysely_migration (name, timestamp) VALUES
  ('zzzz20260821100000_add_approval_instance_org_id', '2026-08-21T10:00:00.000Z');

INSERT INTO users (id, is_active) VALUES
  ('u-member-default', true),
  ('u-member-org2', true),
  ('u-zero-membership', true),   -- u1b_split_no_row_at_all: no user_orgs row at all
  ('u-only-deactivated', true),  -- u1b_split_only_deactivated_rows: only a deactivated row
  ('u-inactive', false);

INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('u-member-default', 'default', true),
  ('u-member-org2', 'org-two', true),
  ('u-only-deactivated', 'default', false);

INSERT INTO directory_integrations (id, org_id, status) VALUES
  ('di-default', 'default', 'active'),
  ('di-org-two', 'org-two', 'active');

INSERT INTO approval_instances (id, org_id, source_system, template_id, requester_snapshot, created_at) VALUES
  ('plm:PLM-1', NULL, 'plm', NULL, '{}', now()),
  ('afs:AFS-1', NULL, 'afs', NULL, '{}', now()),
  ('platform-1', 'default', 'platform', NULL, '{"id":"u-member-default"}', now()),
  ('platform-2', NULL, 'platform', 'tmpl-1', '{"id":"u-member-default"}', now()),
  ('platform-3', NULL, 'platform', NULL, '{"id":"u-zero-membership"}', now());

INSERT INTO approval_attachments (instance_id, org_id) VALUES
  ('platform-1', 'default'),
  ('platform-2', 'default');

-- U3' fixture: one row matches a real user_orgs.org_id ('default'), one row carries an org id
-- that is NOT in user_orgs at all ('org-orphan') — a genuine, non-vacuous positive control so the
-- probe's count is meaningfully 1, not trivially 0 (same discipline as the >=2-org u1a fixture
-- above).
INSERT INTO attendance_records (id, org_id) VALUES
  ('att-1', 'default'),
  ('att-2', 'org-orphan');

INSERT INTO attendance_requests (id, org_id) VALUES
  ('req-1', 'default'),
  ('req-2', 'org-orphan');
