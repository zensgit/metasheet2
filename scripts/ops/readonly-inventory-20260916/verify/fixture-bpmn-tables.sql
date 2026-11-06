-- ============================================================================
-- fixture-bpmn-tables.sql — synthetic fixture for 07-bpmn-table-totals.sql
-- ============================================================================
-- Loaded by run-verify.mjs into a throwaway schema (inventory_fixture_bpmn_<rand>)
-- on a LOCAL/CONTAINER PostgreSQL. NEVER run against a real database.
--
-- The 11 core table names are the ones zz20251231_create_bpmn_tables.ts creates;
-- bpmn_deployments is the optional 12th table that only legacy 049 creates
-- (the tests drop it to cover the absent case).
-- 07 reads nothing but count(*), so each table carries only an `id` column
-- (plus `name` on bpmn_process_definitions, which the read-only witness
-- updates). No other fixture here creates a bpmn_* table, so 07 reports
-- `incomplete reason=missing-tables:11 scope=none` on them.
--
-- The counts are distinct where they are non-zero, so a swapped label shows up.
-- Expected B1, in file order, asserted by readonly-inventory-pack.test.mjs:
--   bpmn_process_definitions 3, bpmn_process_instances 2,
--   bpmn_activity_instances 0, bpmn_user_tasks 1, bpmn_timer_jobs 0,
--   bpmn_message_events 0, bpmn_signal_events 0, bpmn_variables 7,
--   bpmn_incidents 0, bpmn_external_tasks 0, bpmn_audit_log 4,
--   then the optional bpmn_deployments 5
-- All values are obviously fake.
-- ============================================================================

CREATE TABLE bpmn_process_definitions (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE bpmn_process_instances (id text PRIMARY KEY);
CREATE TABLE bpmn_activity_instances (id text PRIMARY KEY);
CREATE TABLE bpmn_user_tasks (id text PRIMARY KEY);
CREATE TABLE bpmn_timer_jobs (id text PRIMARY KEY);
CREATE TABLE bpmn_message_events (id text PRIMARY KEY);
CREATE TABLE bpmn_signal_events (id text PRIMARY KEY);
CREATE TABLE bpmn_variables (id text PRIMARY KEY);
CREATE TABLE bpmn_incidents (id text PRIMARY KEY);
CREATE TABLE bpmn_external_tasks (id text PRIMARY KEY);
CREATE TABLE bpmn_audit_log (id text PRIMARY KEY);
CREATE TABLE bpmn_deployments (id text PRIMARY KEY);

INSERT INTO bpmn_process_definitions (id, name) VALUES
 ('d1', 'fake-def-1'), ('d2', 'fake-def-2'), ('d3', 'fake-def-3');
INSERT INTO bpmn_process_instances (id) VALUES ('i1'), ('i2');
INSERT INTO bpmn_user_tasks (id) VALUES ('t1');
INSERT INTO bpmn_variables (id) VALUES ('v1'), ('v2'), ('v3'), ('v4'), ('v5'), ('v6'), ('v7');
INSERT INTO bpmn_audit_log (id) VALUES ('a1'), ('a2'), ('a3'), ('a4');
INSERT INTO bpmn_deployments (id) VALUES ('p1'), ('p2'), ('p3'), ('p4'), ('p5');
