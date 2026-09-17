/**
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
