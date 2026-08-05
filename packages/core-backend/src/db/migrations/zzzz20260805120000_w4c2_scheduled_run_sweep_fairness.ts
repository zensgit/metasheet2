/**
 * #4770 (W4C-2 recovery-sweep fairness/observability/call-through; owner ruling 2026-08-05,
 * baseline `db74bd8667df1084797c97d872fe53ef845e3803`) — the DURABLE-ROTATION column the
 * fairness fix in `w4c2-scheduled-run.ts`'s `scanAttendanceScheduledRunSweepCandidatesV1`
 * needs.
 *
 * `attendance_scheduled_runs` was created by a zzzz-prefixed migration
 * (`zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts`), so this ADD COLUMN
 * must also be zzzz-prefixed to sort after it (house rule: a new column on a zzzz table is
 * itself a zzzz migration).
 *
 * Adds:
 *  - `last_attempt_at timestamptz NULL` on `attendance_scheduled_runs` — stamped to `now()`
 *    by the scan/write-back statement every time a `running` row is selected as a sweep
 *    candidate (whether or not that tick's step actually progresses it). `NULL` for a run
 *    that has never been scanned, so a brand-new `running` row still sorts ahead of any
 *    previously-attempted row (`ORDER BY last_attempt_at ASC NULLS FIRST`) — never touched by
 *    resume/finalize/abandon, only by the scan itself.
 *  - widens `attendance_w4_scheduled_run_update_guard()`'s mutable-key allowlist to include
 *    `last_attempt_at` (otherwise the existing generic jsonb-minus guard rejects the scan's
 *    own write-back as a frozen-column mutation) — same function name, so the existing
 *    `trg_asr_update_guard` trigger picks up the new body without being re-created.
 *
 * `chk_asr_terminal_shape` is untouched: it does not enumerate `last_attempt_at`, and the new
 * column has no terminal-state constraint (a completed/abandoned run can carry a stale
 * `last_attempt_at` value harmlessly — the guard's `OLD.state IN ('completed','abandoned')`
 * branch already refuses ANY further update to a terminal row, `last_attempt_at` included).
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE attendance_scheduled_runs
      ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_scheduled_run_update_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      mutable_keys text[] := ARRAY['state','completed_user_count','generated_count',
                                    'abandon_reason_code','abandoned_by_actor_posture',
                                    'finalized_at','last_attempt_at'];
    BEGIN
      IF OLD.state IN ('completed', 'abandoned') THEN
        RAISE EXCEPTION 'W4C2_RUN_STATE: % row is immutable after terminal state on %', OLD.state, TG_TABLE_NAME;
      END IF;
      IF NEW.state NOT IN ('running', 'completed', 'abandoned') THEN
        RAISE EXCEPTION 'W4C2_RUN_STATE: illegal run state value on %', TG_TABLE_NAME;
      END IF;
      IF (to_jsonb(NEW) - mutable_keys) IS DISTINCT FROM (to_jsonb(OLD) - mutable_keys) THEN
        RAISE EXCEPTION 'W4C2_RUN_STATE: frozen run columns are immutable on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Fail-closed guard, same discipline as the parent migration's own down(): refuse to lose
  // rotation history for a run this sweep has actually touched (a partial down here would
  // otherwise silently drop a fairness-load-bearing column while runs are mid-rotation).
  const result = await sql`
    SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE last_attempt_at IS NOT NULL
  `.execute(db)
  const row = (result.rows[0] ?? {}) as { n?: number | string }
  const count = Number(row.n ?? 0)
  if (count > 0) {
    throw new Error(
      'W4C2_SWEEP_FAIRNESS_DOWN_BLOCKED: refusing to drop last_attempt_at while ' +
        String(count) +
        ' attendance_scheduled_runs row(s) carry a stamped value. Down never clears history to pass.',
    )
  }

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_scheduled_run_update_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      mutable_keys text[] := ARRAY['state','completed_user_count','generated_count',
                                    'abandon_reason_code','abandoned_by_actor_posture','finalized_at'];
    BEGIN
      IF OLD.state IN ('completed', 'abandoned') THEN
        RAISE EXCEPTION 'W4C2_RUN_STATE: % row is immutable after terminal state on %', OLD.state, TG_TABLE_NAME;
      END IF;
      IF NEW.state NOT IN ('running', 'completed', 'abandoned') THEN
        RAISE EXCEPTION 'W4C2_RUN_STATE: illegal run state value on %', TG_TABLE_NAME;
      END IF;
      IF (to_jsonb(NEW) - mutable_keys) IS DISTINCT FROM (to_jsonb(OLD) - mutable_keys) THEN
        RAISE EXCEPTION 'W4C2_RUN_STATE: frozen run columns are immutable on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`ALTER TABLE attendance_scheduled_runs DROP COLUMN IF EXISTS last_attempt_at`.execute(db)
}
