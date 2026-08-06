-- Attendance Windows-native QA v2 — GLOBAL residue check (SENTINEL).
-- Returns ONE integer: the count of leftover synthetic rows across every attendance,
-- platform-substrate, and local-directory table the PQA-01..10 provisioning + case steps populate.
-- Put the returned value in summary.json.residue; PASS requires 0.
--
-- Draft/HOLD. Run against the isolated database metasheet_windows_qa ONLY.
--
-- SYNTHETIC MARKERS (owner gate 1 — no hardcoded MINTED ids here; these are namespace markers, the
-- successor of the old `qa_synth_` text convention):
--   * orgs are deterministic reserved-namespace UUIDs -> org_id LIKE '00000000-0000-4000-8000-%'
--     (gen_random_uuid never emits this all-zero prefix, so no real org can collide).
--   * users are minted by the product path (random v4 UUIDs, captured to qa-identities.json), so they
--     carry NO prefix — they are detected by their deterministic synthetic namespace on
--     email ('qa-synth-%@qa.invalid') / username ('qa_synth_%'), never by a per-run id.
--   * the legacy `qa_synth_%` text net is kept as belt-and-suspenders (nothing writes it any more).
--
-- WHY THIS IS A SENTINEL, NOT THE CLEANUP: per-row DELETE cannot reach 0 — the append-only /
-- deny-delete triggers (durable_storage.ts:1258-1301, scheduled_run_...:218-368, outbox
-- trg_areo_deny_delete) REJECT deletes on rollout state/events, calculations, snapshots, segments,
-- operation registries, outbox, and scheduled-run tables. Cleanup is DROP+recreate the whole DB
-- (reset-isolated-db.mjs). This query's job is to PROVE the recreated DB is empty of synthetic rows;
-- reset-isolated-db.mjs additionally proves the recreated DB reached the pinned migration SET and the
-- deny triggers exist (the false-zero guard: a partial re-migrate with tables missing ALSO shows 0).
--
-- NEGATIVE CONTROL (run this BEFORE teardown, with synthetic rows present): the count MUST be > 0,
-- which proves the query can actually see synthetic rows. A residue query that only ever returns 0
-- is a green-test-against-nothing. See the runbook's per-case evidence order.
--
-- PRECONDITION: run against a FULLY MIGRATED metasheet_windows_qa. Every table below is created by a
-- migration in the pinned set (SOURCE_SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b), so a
-- "relation does not exist" error means the DB is NOT fully migrated (a setup failure), NOT a clean
-- residue result.

SELECT
  -- Platform substrate (users keyed only on id -> matched by synthetic email/username namespace).
    (SELECT count(*) FROM users
        WHERE email LIKE 'qa-synth-%@qa.invalid' OR username LIKE 'qa_synth_%' OR id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs
        WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  -- Local-directory anchor rows created by the provisioner (org anchor + local accounts + links).
  + (SELECT count(*) FROM directory_integrations
        WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM directory_accounts da
        WHERE EXISTS (SELECT 1 FROM directory_integrations di
                       WHERE di.id = da.integration_id
                         AND (di.org_id LIKE '00000000-0000-4000-8000-%' OR di.org_id LIKE 'qa_synth_%')))
  + (SELECT count(*) FROM directory_account_links dal
        WHERE EXISTS (SELECT 1 FROM directory_accounts da
                        JOIN directory_integrations di ON di.id = da.integration_id
                       WHERE da.id = dal.directory_account_id
                         AND (di.org_id LIKE '00000000-0000-4000-8000-%' OR di.org_id LIKE 'qa_synth_%')))
  -- Attendance authoring / scheduling substrate (all org-keyed).
  + (SELECT count(*) FROM attendance_shifts                         WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments                 WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_assignments              WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records                        WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_events                         WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_requests                       WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  -- W4C-0 durable storage (append-only / deny-delete surfaces; org-keyed).
  + (SELECT count(*) FROM attendance_record_calculations            WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_segments                WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_operations             WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_operation_batches      WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_event_outbox           WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_request_calculation_snapshots WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_calculation_rollout_state     WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_calculation_rollout_events    WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  -- W4C-2 scheduled-run union (append-only / deny-delete; org-keyed).
  + (SELECT count(*) FROM attendance_scheduled_runs                WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_targets         WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_target_outcomes WHERE org_id LIKE '00000000-0000-4000-8000-%' OR org_id LIKE 'qa_synth_%')
  AS residue;
