/**
 * ============================================================================================
 * PRECONDITION UNMET (2026-09-17) — this migration is NOT safe to land as-is. Read before
 * touching this file or removing this block. BLOCKED, not a defect in the code below.
 * ============================================================================================
 *
 * Lock v5.9's own 互斥性说明 (lock:377, the paragraph immediately after the §14.3 table) names
 * the exact condition this migration is in:
 *   "#10 的 FK 与配对 CHECK 会让既有悬空引用与空键实例从可写变不可写——真实行为变化,
 *    须先普查并单独裁" (a census must run FIRST, and the owner must rule separately — the
 *    author of this migration is not authorized to make that call).
 *
 * The migration's own preflight guard (below) covers the "既有悬空引用" half against
 * PRODUCTION data (empirically empty on the private test DB this was verified against, which
 * has zero rows in both tables — that DB cannot stand in for a census of real data). The half
 * the lock's own text calls PLAUSIBLE-not-confirmed ("五写入方经 upsertAttendanceApprovalInstance
 * 永远写该键,真实数据里该集合应为空——PLAUSIBLE,迁移彩排实测后才算证实") is exactly the one this
 * census turned up a population for — but in TEST FIXTURES, not production data, which the lock
 * text did not anticipate:
 *
 * Running the actual attendance real-DB suite (`vitest --config vitest.integration.config.ts`,
 * the same invocation `.github/workflows/plugin-tests.yml`'s "Run attendance integration tests"
 * step uses) against a migrated private DB (`metasheet2_lock_c_u1`) with this migration applied:
 *
 *   `tests/integration/attendance-w4c3b-request-snapshots.db.test.ts`: 2 of 3 "P12 request
 *   snapshots (real PostgreSQL)" tests FAIL with `23514 atr_instance_key_pair` — both construct
 *   an `attendance_requests` row via raw SQL with a non-null `approval_instance_id` and no
 *   `approval_workflow_key` (lines ~304 and ~413 of that file at the time of this note).
 *
 * That is a CONFIRMED, exercised failure — not a static read. The broader population is not yet
 * fully exercised but is structurally certain from a mechanical sweep (this file's author did
 * not touch any test file; the counts below are read-only greps, run from the repo root):
 *
 *   `for f in $(grep -rl "INSERT INTO attendance_requests" packages/core-backend/tests/); do
 *      grep -A6 "INSERT INTO attendance_requests" "$f" | grep -c approval_instance_id; done`
 *   -> non-zero (1-5 occurrences) in 9 of the 17 files that INSERT into attendance_requests via
 *   raw SQL: attendance-approval-action-authorization.db.test.ts (1),
 *   attendance-w4c3b-central-approval.db.test.ts (1),
 *   attendance-approval-flow-dynamic-kind-s7-1.db.test.ts (1),
 *   attendance-decision-trace-w5-0.db.test.ts (3), attendance-plugin.test.ts (1),
 *   attendance-w4c3b-request-snapshots.db.test.ts (2, CONFIRMED above),
 *   attendance-w4c5-rollout-transition-tool.db.test.ts (1),
 *   attendance-w4c3a-rollout-control.db.test.ts (5), attendance-result-edit.test.ts (3).
 *
 * Two DISTINCT failure modes, not one — a fixer must handle both, or will half-fix and re-red:
 *   (a) `23514 atr_instance_key_pair` — the attendance-side INSERT/UPDATE sets a non-null
 *       `approval_instance_id` without `approval_workflow_key` (CONFIRMED above).
 *   (b) `23503` (the composite FK itself) — a fixture that DOES pair both columns on the
 *       attendance side, but seeds its own `approval_instances` row without `workflow_key`
 *       (NULL), so the referenced (id, workflow_key) tuple never exists. Census:
 *       `for f in $(grep -rl "INSERT INTO approval_instances" packages/core-backend/tests/); do
 *          echo "$(grep -A8 "INSERT INTO approval_instances" "$f" | grep -c workflow_key)/
 *          $(grep -c "INSERT INTO approval_instances" "$f") :: $f"; done`
 *       -> 24 of the ~38 files with an `approval_instances` INSERT have at least one occurrence
 *       with zero `workflow_key` mentions nearby (exact file list in the command output; not
 *       reproduced here to avoid this comment going stale on an unrelated future edit to those
 *       files — re-run the command for the current list).
 *
 * Mechanical closure of two adjacent risks, so a future reader does not have to re-ask:
 *   - Exactly 5 production writers exist (not 6+): `grep -rn "INSERT INTO attendance_requests\|
 *     UPDATE attendance_requests" packages/core-backend/src/ plugins/ --include="*.ts"
 *     --include="*.cjs" | grep -v node_modules` returns exactly this file's own backfill UPDATE
 *     plus 9 lines in index.cjs — the 5 that set approval_instance_id (already edited, this same
 *     commit) and 4 more (:35184, :35561, :37886, :37902 as of this note) that UPDATE status by
 *     matching on `id`/`org_id`/`status` only and never touch `approval_instance_id` or
 *     `approval_workflow_key` — confirmed by reading each, these are the lock's "同键写点"
 *     (§14.3 #10 row, keyed BY the column, not writing it) and correctly need no edit.
 *   - No kysely-syntax (`insertInto('attendance_requests')` / `updateTable(...)`) writer exists
 *     anywhere in src/, tests/, or plugins/ — raw SQL is the only syntax touching this table, so
 *     the syntax-sweep half of `feedback_writer_audit_both_query_syntaxes` is exhaustively clean.
 *
 * Disposition: per lock:377's own "须先普查并单独裁", this migration's author (an implementer
 * bound to a file mandate that forbids editing tests/**) is not authorized to fix the fixtures
 * or to narrow/weaken the ratified CHECK/FK to make them pass. This file's DDL is written
 * correctly to the lock's spec (see the verification log at the bottom of this header) and
 * should NOT be edited to "fix" the fixtures — the ratified constraint is not the bug. Landing
 * it requires EITHER a follow-up PR touching the listed test files (add
 * `approval_workflow_key`/`workflow_key` pairing to each raw-SQL fixture; case (b) additionally
 * needs `approval_instances.workflow_key` set) OR an owner ruling that changes the DDL itself.
 * Do not remove this block until that follow-up has landed and the full attendance real-DB
 * suite has been re-run green with this migration applied.
 *
 * ---- 2026-09-17 follow-up (fixture pairing applied to 7 of the 9; two are FALSE POSITIVES) ----
 *
 * 7 of the 9 files named above got `approval_workflow_key`/`workflow_key` added to the exact
 * raw-SQL INSERT the census flagged, value matched to whatever that file's OWN paired
 * `approval_instances.workflow_key` already used (a per-file literal — `'attendance_request_approval'`
 * in three files, the imported `ATTENDANCE_APPROVAL_WORKFLOW_KEY` constant in one, and the plain
 * production value `'attendance.request'` where no local convention existed): action-authorization,
 * w4c3b-central-approval, flow-dynamic-kind-s7-1, w4c3b-request-snapshots (the original CONFIRMED
 * pair, now also carries workflow_key on its `approval_instances` insert per (b) below),
 * decision-trace-w5-0 (3 sites), attendance-plugin.test.ts (1 site), result-edit (3 sites). Each
 * was pre-fix-confirmed to hit the real `atr_instance_key_pair` 23514 (not just mechanically
 * flagged) by reverting the one file to its pre-fix text against a freshly migrated private DB and
 * observing the failure, then restoring and reconfirming green — see this commit's message for the
 * exact command and file list.
 *
 * The other 2 — attendance-w4c3a-rollout-control.db.test.ts and
 * attendance-w4c5-rollout-transition-tool.db.test.ts — are FALSE POSITIVES from the grep sweep and
 * were deliberately left untouched (adding the columns there was tried and reverted: it breaks
 * previously-green tests with `42703 column "approval_workflow_key" of relation "attendance_requests"
 * does not exist`). Mechanism: both files never touch the shared migrated schema at all — each
 * spins up its own throwaway `CREATE DATABASE ms2_w4c3a_control_*` / `ms2_w4c5_tool_*` and builds
 * `attendance_requests`/`approval_instances` by hand in a local `createBase()` (minimal columns
 * only, no FK, no CHECK — see that function's own comment: "the rollout-control predicate reads
 * only `id` and `status`"). The Q1c contract is a constraint on the SHARED migrated database; a
 * fixture that never runs against that database cannot violate it and gains nothing from carrying
 * the pairing. Do not re-add these two — grep each file for `CREATE DATABASE` before assuming any
 * new "INSERT INTO attendance_requests ... approval_instance_id" hit needs the same fix this block
 * describes.
 *
 * Case (b)'s "24 of the ~38 files" collapses to exactly the same 7 (zero *additional* files) once
 * exercised, not under-fixed to 7: `\d approval_instances` shows `workflow_key` is nullable with no
 * table-level NOT NULL, and the FK is Postgres's default MATCH SIMPLE — either column of the pair
 * being NULL skips the FK check entirely (lock:371's own §14.3 #10 note on step 5). So an
 * `approval_instances` row missing `workflow_key` only ever matters to THIS migration when some
 * `attendance_requests` row's `approval_instance_id`+`approval_workflow_key` pair is later resolved
 * against it — i.e. exactly the same 9 (7 real + 2 false-positive) files case (a) already covers;
 * the other ~30 "0/N" files in the (b) census insert `approval_instances` rows nothing in
 * `attendance_requests` ever references, so they can carry a NULL `workflow_key` forever without
 * tripping either CHECK or FK. No separate case-(b)-only fix site exists.
 *
 * UPDATE-statement and kysely-syntax sweep (extends the src/plugins claim above to tests/): no
 * `UPDATE attendance_requests` in `tests/` sets `approval_instance_id` (`grep -rn -A8 "UPDATE
 * attendance_requests" packages/core-backend/tests/ | grep "approval_instance_id"` → empty), and no
 * kysely-syntax writer targets either table anywhere in `tests/`, `src/`, or `plugins/`
 * (`grep -rn "insertInto('attendance_requests')\|updateTable('attendance_requests')\|insertInto('approval_instances')\|updateTable('approval_instances')"` → empty, both single- and
 * double-quote forms checked).
 *
 * Verified GREEN on a freshly created+migrated private DB (`createdb metasheet2_lock_c_v1 && tsx
 * src/db/migrate.ts`), each of the 9 named files run individually with `vitest --config
 * vitest.integration.config.ts run <file> --reporter=dot`. Still open before this block can be
 * removed: (1) the full ~124-file invocation this comment's top section names (plugin-tests.yml's
 * "Run attendance integration tests" step) has NOT yet been run end-to-end in one pass — running
 * these 9 files together (still on a virgin DB) surfaces 2 UNRELATED failures in
 * attendance-plugin.test.ts ("auto-writes one high-confidence suggestion..." and "W4C-3a reproduces
 * the committed legacy-import-v1 governing-SHA golden") that do NOT reproduce when that file runs
 * alone against the same virgin DB (166/166 green) — a cross-file fixture/state collision from one
 * of the other 8 files, confirmed unrelated to this migration's columns (reverting only this file's
 * one-hunk fix and re-running the 9-file batch reproduces the identical 2 failures). Root cause not
 * yet isolated; do not attribute it to Q1c without first bisecting which of the other 8 files
 * causes it. (2) The remaining ~115 files in the full invocation have not been touched by this
 * census at all and may hold their own unrelated failures.
 *
 * ---- end 2026-09-17 follow-up ----
 *
 * ============================================================================================
 *
 * Approval change-request design lock v5.9 §14.3 #10 (lock:371) — "Q1c" package, DDL/migration
 * 3 of 3 for the first slice (WI-3, impl-taskbook-C-change-request-20260918.md).
 *
 * Problem this closes: `attendance_requests.approval_instance_id` (text, no FK) can point at ANY
 * `approval_instances` row, including a future `approval.cancel-round` one. Nothing stops a
 * consumer of that column — the three same-key writers named in the lock
 * (`index.cjs:37705-37717`, `:35145-35149`, `:35525-35529`) — from ever reaching a cancel round
 * through the attendance side. This migration adds a composite FK keyed on
 * `(approval_instance_id, approval_workflow_key)` so the pairing is enforced by the database, not
 * by writer discipline, then a CHECK that specifically excludes the cancel-round workflow key.
 *
 * MUST land in the same PR as the five attendance writer edits (index.cjs:33635, :33877, :34152,
 * :34437, :34777 at the base this was verified against, 85ddd2926) — once the CHECKs below exist,
 * any writer that still omits `approval_workflow_key` while writing a non-null
 * `approval_instance_id` gets `23514` on every attendance submission (lock:371 "迁移与代码同一
 * 发布,部署说明单列"). This migration file alone does not activate anything in a shared/prod
 * database — see the same commit's writer-side edit for the paired half.
 *
 * Order matters and is the DDL-gate-reviewed reason for it (lock:371):
 *   1. add the column (nullable, no default — paired nullness is enforced by the CHECK below, not
 *      by NOT NULL)
 *   2. pre-flight assertion (SQL, executed — not a doc comment): abort if any existing
 *      attendance_requests row references a dangling or workflow_key-less approval_instances row.
 *      A dangling reference is NOT auto-repaired (setting approval_instance_id to NULL would be a
 *      silent, destructive rewrite of pre-existing data) — the migration throws and lists the
 *      offending ids for a human to triage.
 *   3. backfill BEFORE adding constraints — `ADD CONSTRAINT ... CHECK` validates every existing
 *      row against the new predicate; if the CHECK existed first, the backfill's own UPDATE would
 *      write into a column already being validated one row at a time is fine, but a bare `ADD
 *      COLUMN` + immediate `ADD CONSTRAINT` (skipping backfill) would fail immediately: every
 *      pre-existing row has `approval_instance_id IS NOT NULL AND approval_workflow_key IS NULL`,
 *      which violates `atr_instance_key_pair` the instant it is added.
 *   4. the composite FK's target needs an explicit UNIQUE (id, workflow_key) on approval_instances
 *      — `id` is already a PK, but Postgres requires a unique constraint/index over the EXACT
 *      column set a composite FK references, not just uniqueness implied by a subset. Precedent
 *      for the `pg_constraint` idempotency guard:
 *      zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:410-419
 *      (`uq_attendance_records_id_org` / `uq_attendance_requests_id_org`).
 *   5. the FK itself, `ON UPDATE NO ACTION` (lock:371) — MATCH SIMPLE (Postgres's default): either
 *      column being NULL skips the FK check entirely, which is exactly why step 6 exists.
 *   6. CHECK `atr_instance_key_pair`: forbids the half-NULL case MATCH SIMPLE alone would allow
 *      (an instance id with a NULL key, or a key with a NULL instance id).
 *   7. CHECK `atr_not_cancel_round`: the pairing above says a REAL instance+key combination must
 *      exist together — this CHECK says that combination must never be the cancel-round workflow
 *      key. `<>` against a NULL column evaluates to NULL, which CHECK treats as satisfied, so this
 *      does not fight the paired-nullness rule.
 *
 * `ON UPDATE NO ACTION` note (lock:371, complexity worth naming): the only production UPDATE that
 * ever rewrites `attendance_requests.approval_instance_id` after initial write is
 * `index.cjs:34777` (`request_pending_edit`), which always assigns a FRESH id from a newly created
 * `approval_instances` row — it never updates an EXISTING `approval_instances.id` value in place,
 * so `ON UPDATE NO ACTION` is never exercised by that path. `workflowKey` itself has exactly one
 * assignment site in the whole file (`index.cjs:24239`, the constant `ATTENDANCE_APPROVAL_WORKFLOW_KEY
 * = 'attendance.request'`), so a same-value re-`UPDATE ... SET workflow_key = EXCLUDED.workflow_key`
 * (the `ON CONFLICT` branch of `upsertAttendanceApprovalInstance`, `index.cjs:24303`) never changes
 * the key Postgres's FK check compares against either.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE attendance_requests ADD COLUMN IF NOT EXISTS approval_workflow_key TEXT`.execute(db)

  const preflight = await sql<{ cnt: string }>`
    SELECT count(*)::text AS cnt
    FROM attendance_requests r
    LEFT JOIN approval_instances i ON i.id = r.approval_instance_id
    WHERE r.approval_instance_id IS NOT NULL
      AND (i.id IS NULL OR i.workflow_key IS NULL)
  `.execute(db)
  const danglingCount = Number(preflight.rows[0]?.cnt ?? '0')
  if (danglingCount > 0) {
    const sample = await sql<{ id: string; approval_instance_id: string | null }>`
      SELECT r.id::text AS id, r.approval_instance_id
      FROM attendance_requests r
      LEFT JOIN approval_instances i ON i.id = r.approval_instance_id
      WHERE r.approval_instance_id IS NOT NULL
        AND (i.id IS NULL OR i.workflow_key IS NULL)
      LIMIT 20
    `.execute(db)
    throw new Error(
      `add_attendance_requests_approval_workflow_key preflight failed: ${danglingCount} ` +
        'attendance_requests row(s) reference an approval_instances row that either does not ' +
        'exist or has a NULL workflow_key. Aborting rather than silently nulling ' +
        'approval_instance_id (lock v5.9 §14.3 #10: "置NULL是破坏性,不自动做") -- triage the ' +
        `listed rows and either repair approval_instances.workflow_key or clear ` +
        `approval_instance_id manually before re-running. Sample offending ids (up to 20): ` +
        `${JSON.stringify(sample.rows)}`,
    )
  }

  // Backfill BEFORE the constraints below (lock:371 "回填先于约束").
  await sql`
    UPDATE attendance_requests r
    SET approval_workflow_key = i.workflow_key
    FROM approval_instances i
    WHERE i.id = r.approval_instance_id
      AND r.approval_workflow_key IS NULL
  `.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_approval_instances_id_workflow_key') THEN
        ALTER TABLE approval_instances
          ADD CONSTRAINT uq_approval_instances_id_workflow_key UNIQUE (id, workflow_key);
      END IF;
    END
    $do$
  `.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_requests_instance_workflow_fkey') THEN
        ALTER TABLE attendance_requests
          ADD CONSTRAINT attendance_requests_instance_workflow_fkey
          FOREIGN KEY (approval_instance_id, approval_workflow_key)
          REFERENCES approval_instances (id, workflow_key)
          ON UPDATE NO ACTION;
      END IF;
    END
    $do$
  `.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atr_instance_key_pair') THEN
        ALTER TABLE attendance_requests
          ADD CONSTRAINT atr_instance_key_pair
          CHECK ((approval_instance_id IS NULL) = (approval_workflow_key IS NULL));
      END IF;
    END
    $do$
  `.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'atr_not_cancel_round') THEN
        ALTER TABLE attendance_requests
          ADD CONSTRAINT atr_not_cancel_round
          CHECK (approval_workflow_key <> 'approval.cancel-round');
      END IF;
    END
    $do$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS atr_not_cancel_round`.execute(db)
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS atr_instance_key_pair`.execute(db)
  await sql`ALTER TABLE attendance_requests DROP CONSTRAINT IF EXISTS attendance_requests_instance_workflow_fkey`.execute(db)
  await sql`ALTER TABLE approval_instances DROP CONSTRAINT IF EXISTS uq_approval_instances_id_workflow_key`.execute(db)
  await sql`ALTER TABLE attendance_requests DROP COLUMN IF EXISTS approval_workflow_key`.execute(db)
}
