# Multitable Global History — D-1 Delete Revision PIT-Correctness — Dev/Verification (2026-07-09)

Status: implemented as the owner-ratified D-1 revision-only slice. This document records what changed and how it was verified; it does not authorize D-2 trash/tombstone recovery or any production flag.

## 1. Scope

D-1 fixes the point-in-time correctness gap where two hard-delete side doors removed `meta_records` rows without appending an `action='delete'` row to `meta_record_revisions`:

- automation `delete_record`
- plugin-SDK `deleteRecord`

The shipped behavior before this slice could make `reconstructRecordsAtT` treat an automation/plugin-deleted record as alive forever, because the last revision stayed at create/update. D-1 only adds append-only delete revisions. It does not add trash, tombstone capture, recoverability, public-form create revision coverage, or any new flag.

## 2. Runtime Changes

- `AutomationExecutor.executeDeleteRecord` now selects `locked`, `version`, and `data` with `FOR UPDATE`, records a `source='automation'` delete revision with the pre-delete snapshot, then hard-deletes the record inside one transaction.
- `AutomationService` supplies the executor a transaction dependency backed by the main pool.
- The button route's executor entry now supplies the same transaction dependency for non-transactional action dispatch; the already-transactional button update path continues to run on its existing transaction client.
- Plugin-SDK `deleteRecord` now selects the current row with `FOR UPDATE`, records a `source='plugin'` delete revision with the pre-delete snapshot, then hard-deletes the record inside the caller's transaction.
- The plugin real-DB CI allowlist now includes `multitable-d1-delete-revisions-realdb.test.ts`, so the new DATABASE_URL-gated goldens cannot skip silently in the real-DB job.

## 3. Verification

Local verification on `/private/tmp/ms2-d1-delete-revisions`:

- `pnpm --filter @metasheet/core-backend run type-check` — pass.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-records.test.ts tests/unit/automation-v1.test.ts --reporter=dot` — 228/228 pass.
- `DATABASE_URL='postgres://metasheet:metasheet@127.0.0.1:5435/metasheet_test' METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-d1-delete-revisions-realdb.test.ts --reporter=dot` — 5/5 pass.
- `DATABASE_URL='postgres://metasheet:metasheet@127.0.0.1:5435/metasheet_test' METASHEET_REAL_DB_TEST_STEP=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-record-reconstructor-realdb.test.ts --reporter=dot` — 8/8 pass.
- `git diff --check` — pass.

The D-1 real-DB suite covers:

- automation delete writes `action='delete', source='automation'`, preserves the pre-delete snapshot, and makes PIT after the delete report non-existence while PIT before the delete still reports existence.
- plugin-SDK delete writes `action='delete', source='plugin'`, preserves the pre-delete snapshot, and has the same PIT before/after behavior.
- forced delete-revision insert failure rolls back the hard delete for both automation and plugin-SDK paths, leaving the record present and no delete revision written.

## 4. Mutation Evidence

Neuter probe: temporarily changed both D-1 runtime emitters from `action: 'delete'` to `action: 'update'`, then reran the D-1 real-DB suite.

Expected RED observed:

- automation latest revision assertion failed (`update` vs `delete`).
- plugin latest revision assertion failed (`update` vs `delete`).
- automation atomicity golden failed because the trigger no longer fired and the delete committed.
- plugin atomicity golden failed because the trigger no longer fired and the delete committed.

The probe was reverted and the same D-1 real-DB suite returned to 5/5 pass.

## 5. Explicitly Out Of Scope

- D-2 recoverability: no `meta_records_trash`, no tombstone capture, no record undelete semantics.
- Public-form create revision coverage.
- Any new environment flag or rollout ladder.
- Any change to PIT Reset/Revert semantics beyond fixing the revision stream that they consume.
