/**
 * W4C-2 P1-2 (#4556) — durable scheduled-run identity + outbox discriminated union
 * (schema/migration half; the run-creation/resume/finalization transactions and the
 * `abandoned` transition writer are a later slice — this migration only creates the
 * storage and constraints they will write into).
 *
 * Authority: docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md
 * (RATIFIED per PR #4617; owner Bundle A = 44a/45a/46a/47a/48a/49a/50a/51a/52a/53(i)),
 * sections 1.1, 1.1.1 (O-3=(a): append-only per-target outcome side table), 1.1.2, 1.2,
 * 1.2.1, 1.3, 1.4, 1.5, 1.10 — plus the governing lock
 * docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md.
 *
 * Creates:
 *  - attendance_scheduled_runs (section 1.1) — server-minted run_id, frozen posture/
 *    counts/target-set fingerprint, closed running|completed|abandoned states, generic-
 *    allowlist UPDATE guard (mutable: state, completed_user_count, generated_count,
 *    abandon_reason_code, abandoned_by_actor_posture, finalized_at), DELETE/TRUNCATE
 *    refusal, at-most-one-`running`-per-key partial unique index;
 *  - attendance_scheduled_run_targets (section 1.2) — fully immutable frozen plan rows,
 *    derived-operation-identity CHECK reusing the RATIFIED W4C-0 SQL UUIDv5 boundary,
 *    plus `uq_asrt_id_org_run` (O-3=(a), section 1.1.1's FK anchor);
 *  - attendance_scheduled_run_target_outcomes (section 1.1.1, O-3=(a)) — append-only
 *    per-`generate`-target terminal-outcome side table, plus the deferred
 *    `attendance_w4_run_completion_outcome_guard()` cross-table constraint trigger;
 *  - deferred commit-time constraint triggers tying the run row's frozen
 *    `expected_user_count`/`review_count` to the actual target rows, with a target-side
 *    mirror (a later INSERT into the target table re-checks its parent run — the same
 *    two-sided shape as W4C-0's `attendance_w4_operation_items_commit_guard`,
 *    `zzzz20260725120000_...:1454`, which exists precisely because a single insert-side
 *    trigger cannot see a row inserted by a LATER transaction);
 *  - the outbox discriminated union (section 1.4): `identity_kind`/`scheduled_run_id`,
 *    both FKs (`fk_areo_operation` now exists; `fk_areo_scheduled_run` new), the
 *    kind<->identity map CHECK, the entrypoint-binding CHECK, the two partial unique
 *    indexes replacing `uq_areo_identity`, and the outbox UPDATE guard rewritten to the
 *    same generic-allowlist form (mutable: delivery_state, attempts, next_attempt_at,
 *    delivered_at);
 *  - `chk_areo_event_kind` re-armed as an eight-member LOCAL literal (section 1.10 step 6
 *    — the already-applied W4C-0 migration's own six-member `OUTBOX_EVENT_KINDS` constant
 *    is a historical artifact and is NOT edited by this migration).
 *
 * House rules honored: zzzz naming (sorts after the W4C-0 migration this depends on),
 * idempotent up() (backfill covers the empty-table case identically to a populated one),
 * down() = success only on empty W4C-2 surfaces / populated => fail-closed BEFORE any DDL,
 * no backtick characters inside SQL text, values-free trigger errors (op/table/constraint
 * names only — never row values).
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// ---------------------------------------------------------------------------
// Closed sets this migration owns (section 1.2.1, 1.5, 1.10 step 6).
// ---------------------------------------------------------------------------

// Section 1.10 step 6: the new migration's OWN local eight-member literal — the six
// existing W4C-0 kinds plus the two run-level kinds this amendment adds. This is the
// gate-9 parity partner for `w4c0-operation-contract.ts`'s
// `ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1` from this migration forward — NOT the
// already-applied `zzzz20260725120000_...`'s own `OUTBOX_EVENT_KINDS` constant, which is
// permanently excluded from parity once this migration lands (section 1.5, 1.10).
export const W4C2_OUTBOX_EVENT_KINDS_V1 = [
  'attendance.punched',
  'attendance.requested',
  'attendance.request.updated',
  'attendance.request.cancelled',
  'attendance.resolved',
  'attendance.outdoorPunch.requested',
  'attendance.absence.generated',
  'attendance.work_date.review_required',
] as const

// Section 1.2.1: the closed review-reason set is the union of the 11 `// unresolved`-
// segment members of the frozen `REASON` map
// (plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs:28-52 — read directly,
// not merely cited: the map has 7 `// resolved` + 2 `// ambiguous` + 11 `// unresolved`
// members; only the 11 `// unresolved` codes are reachable as a scheduled review reason)
// plus the three literals the scheduled loop supplies itself
// (plugins/plugin-attendance/index.cjs:21207-21223). 14 members total — deliberately NOT
// the full 20-member `REASON` map (section 1.2.1's own reasoning: the 9 excluded codes are
// unreachable from the scheduled loop's branches and admitting them would silently weaken
// the negative gate).
export const W4C2_SCHEDULED_REVIEW_REASON_CODES_V1 = [
  // 11 reachable `// unresolved`-segment REASON codes:
  'NO_MATCHING_SHIFT',
  'FREE_TIME_NO_SHIFT',
  'UNSCHEDULED_NO_SHIFT',
  'EXPLICIT_IMPORT_REQUIRES_SHIFT',
  'EXPLICIT_SHIFT_MISMATCH',
  'MALFORMED_CROSS_ORG_REFERENCE',
  'MALFORMED_CROSS_USER_REFERENCE',
  'MALFORMED_CANDIDATE_SHAPE',
  'MALFORMED_CANDIDATE_SOURCE',
  'INVALID_INPUT',
  'NO_PUBLISHED_CANDIDATE',
  // 3 literals the scheduled loop itself supplies:
  'WORK_DATE_ATTRIBUTION_MISMATCH',
  'WORK_DATE_ATTRIBUTION_AMBIGUOUS',
  'WORK_DATE_ATTRIBUTION_UNRESOLVED',
] as const

// Section 1.1.1(a): the closed single-member failure-reason set for a deterministically
// failed `generate` target.
const SCHEDULED_TARGET_FAILURE_REASON_CODES_V1 = ['ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED'] as const

function sqlList(values: readonly string[]): string {
  return values.map((v) => "'" + v + "'").join(', ')
}

// ---------------------------------------------------------------------------
// up()
// ---------------------------------------------------------------------------

export async function up(db: Kysely<unknown>): Promise<void> {
  // -------------------------------------------------------------------------
  // Step 1 (section 1.10): attendance_scheduled_runs, drafted with the base
  // (equality-form) chk_asr_terminal_shape from section 1.1's own SQL block; step 9 below
  // narrows it to the O-3=(a) form (this migration's O-3 ratification), matching section
  // 1.10's own numbered-step sequencing rather than writing the narrowed form directly.
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_scheduled_runs (
      run_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id                 text NOT NULL,
      entrypoint             text NOT NULL,
      initiator              text NOT NULL,
      work_date              date NOT NULL,
      generation              integer NOT NULL,
      accepted_write_posture text NOT NULL,
      target_set_fingerprint text NOT NULL,
      expected_user_count    integer NOT NULL,
      review_count           integer NOT NULL,
      state                  text NOT NULL DEFAULT 'running',
      completed_user_count   integer,
      generated_count        integer,
      abandon_reason_code    text,
      abandoned_by_actor_posture text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      finalized_at           timestamptz,
      CONSTRAINT uq_asr_run_org       UNIQUE (run_id, org_id),
      CONSTRAINT uq_asr_run_org_date  UNIQUE (run_id, org_id, work_date),
      CONSTRAINT uq_asr_generation    UNIQUE (org_id, initiator, work_date, generation),
      CONSTRAINT chk_asr_entrypoint   CHECK (entrypoint = 'scheduled'),
      CONSTRAINT chk_asr_initiator    CHECK (initiator IN ('cron','admin_run')),
      CONSTRAINT chk_asr_posture      CHECK (accepted_write_posture IN ('shadow','authoritative')),
      CONSTRAINT chk_asr_state        CHECK (state IN ('running','completed','abandoned')),
      CONSTRAINT chk_asr_fingerprint  CHECK (target_set_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_asr_counts       CHECK (generation >= 1
                                         AND expected_user_count >= 0
                                         AND review_count >= 0),
      CONSTRAINT chk_asr_terminal_shape CHECK (
           (state = 'running'   AND completed_user_count IS NULL
                                AND generated_count IS NULL
                                AND finalized_at IS NULL
                                AND abandon_reason_code IS NULL
                                AND abandoned_by_actor_posture IS NULL)
        OR (state = 'completed' AND completed_user_count = expected_user_count
                                AND generated_count IS NOT NULL
                                AND generated_count <= expected_user_count
                                AND finalized_at IS NOT NULL
                                AND abandon_reason_code IS NULL
                                AND abandoned_by_actor_posture IS NULL)
        OR (state = 'abandoned' AND completed_user_count IS NOT NULL
                                AND generated_count IS NULL
                                AND finalized_at IS NOT NULL
                                AND abandon_reason_code IS NOT NULL
                                AND abandoned_by_actor_posture IS NOT NULL)
      ),
      CONSTRAINT chk_asr_abandon_reason CHECK (
        abandon_reason_code IS NULL
        OR abandon_reason_code IN ('ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')
      ),
      CONSTRAINT chk_asr_abandoned_by_posture CHECK (
        abandoned_by_actor_posture IS NULL
        OR abandoned_by_actor_posture IN ('platform_admin','attendance_admin')
      )
    )
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_asr_one_running
      ON attendance_scheduled_runs (org_id, initiator, work_date)
      WHERE state = 'running'
  `.execute(db)

  // attendance_scheduled_runs: generic-allowlist UPDATE guard (section 1.1) — the
  // jsonb-minus comparison is one condition; the legal out-of-`running`-transition check is
  // a SEPARATE condition evaluated by the same trigger, in addition to, not instead of, the
  // jsonb-equality check.
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

  await sql`DROP TRIGGER IF EXISTS trg_asr_update_guard ON attendance_scheduled_runs`.execute(db)
  await sql`
    CREATE TRIGGER trg_asr_update_guard
      BEFORE UPDATE ON attendance_scheduled_runs
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_scheduled_run_update_guard()
  `.execute(db)

  // DELETE/TRUNCATE refusal — reuses the existing generic deny-mutation function
  // (already live from the applied W4C-0 migration; not redefined here).
  await sql`DROP TRIGGER IF EXISTS trg_asr_deny_delete ON attendance_scheduled_runs`.execute(db)
  await sql`
    CREATE TRIGGER trg_asr_deny_delete
      BEFORE DELETE ON attendance_scheduled_runs
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_asr_deny_truncate ON attendance_scheduled_runs`.execute(db)
  await sql`
    CREATE TRIGGER trg_asr_deny_truncate
      BEFORE TRUNCATE ON attendance_scheduled_runs
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)

  // -------------------------------------------------------------------------
  // attendance_scheduled_run_targets (section 1.2) — fully immutable frozen plan rows.
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_scheduled_run_targets (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id             text NOT NULL,
      run_id             uuid NOT NULL,
      work_date          date NOT NULL,
      ordinal            integer NOT NULL,
      user_id            uuid NOT NULL,
      target_kind        text NOT NULL,
      review_reason_code text,
      operation_id       uuid,
      created_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_asrt_ordinal UNIQUE (org_id, run_id, ordinal),
      CONSTRAINT uq_asrt_user    UNIQUE (org_id, run_id, user_id),
      CONSTRAINT fk_asrt_run FOREIGN KEY (run_id, org_id, work_date)
        REFERENCES attendance_scheduled_runs (run_id, org_id, work_date),
      CONSTRAINT chk_asrt_ordinal     CHECK (ordinal >= 0),
      CONSTRAINT chk_asrt_kind        CHECK (target_kind IN ('generate','review')),
      CONSTRAINT chk_asrt_review_pair CHECK ((target_kind = 'review')   = (review_reason_code IS NOT NULL)),
      CONSTRAINT chk_asrt_op_pair     CHECK ((target_kind = 'generate') = (operation_id IS NOT NULL)),
      CONSTRAINT chk_asrt_reason_closed CHECK (
        review_reason_code IS NULL OR review_reason_code IN (${sql.raw(sqlList(W4C2_SCHEDULED_REVIEW_REASON_CODES_V1))})
      ),
      CONSTRAINT chk_asrt_derived_operation CHECK (
        target_kind <> 'generate'
        OR operation_id = attendance_w4_uuidv5(
             'e4363171-f53f-47d7-a074-607ef3fad391'::uuid,
             attendance_w4_scheduled_name_bytes(run_id, user_id, work_date))
      )
    )
  `.execute(db)

  // Section 1.2's own SQL block is otherwise untouched; O-3=(a) (section 1.1.1) adds this
  // one additive unique constraint over a superset of the primary key.
  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_asrt_id_org_run') THEN
        ALTER TABLE attendance_scheduled_run_targets
          ADD CONSTRAINT uq_asrt_id_org_run UNIQUE (id, org_id, run_id);
      END IF;
    END
    $do$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_asrt_deny_mutation ON attendance_scheduled_run_targets`.execute(db)
  await sql`
    CREATE TRIGGER trg_asrt_deny_mutation
      BEFORE UPDATE OR DELETE ON attendance_scheduled_run_targets
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_asrt_deny_truncate ON attendance_scheduled_run_targets`.execute(db)
  await sql`
    CREATE TRIGGER trg_asrt_deny_truncate
      BEFORE TRUNCATE ON attendance_scheduled_run_targets
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)

  // Deferred commit-time constraint tying the run row's frozen expected_user_count/
  // review_count to its target rows (section 1.1's last bullet). Insert-side (on the run
  // row) AND a target-side mirror (a LATER-inserted target row re-checks its own parent
  // run) — the same two-sided shape W4C-0 already uses for the analogous batch/item count
  // guard (`attendance_w4_operation_items_commit_guard`, `zzzz20260725120000_...:1454`),
  // because a single insert-side trigger cannot see a row a LATER transaction inserts.
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_scheduled_run_frozen_counts_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      run RECORD;
      generate_count integer;
      review_count_actual integer;
    BEGIN
      SELECT run_id, org_id, expected_user_count, review_count INTO run
        FROM attendance_scheduled_runs WHERE run_id = NEW.run_id AND org_id = NEW.org_id;
      IF NOT FOUND THEN
        RETURN NULL; -- fk_asrt_run already rejects a missing run
      END IF;
      SELECT count(*) FILTER (WHERE target_kind = 'generate'),
             count(*) FILTER (WHERE target_kind = 'review')
        INTO generate_count, review_count_actual
        FROM attendance_scheduled_run_targets
        WHERE run_id = run.run_id AND org_id = run.org_id;
      IF generate_count <> run.expected_user_count OR review_count_actual <> run.review_count THEN
        RAISE EXCEPTION 'W4C2_RUN_FROZEN_COUNTS: frozen counts disagree with target rows on %', TG_TABLE_NAME;
      END IF;
      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_asr_frozen_counts_guard ON attendance_scheduled_runs`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_asr_frozen_counts_guard
      AFTER INSERT ON attendance_scheduled_runs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_scheduled_run_frozen_counts_guard()
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_asrt_frozen_counts_guard ON attendance_scheduled_run_targets`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_asrt_frozen_counts_guard
      AFTER INSERT ON attendance_scheduled_run_targets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_scheduled_run_frozen_counts_guard()
  `.execute(db)

  // -------------------------------------------------------------------------
  // attendance_scheduled_run_target_outcomes (section 1.1.1, O-3=(a)) — append-only.
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_scheduled_run_target_outcomes (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id               text NOT NULL,
      run_id               uuid NOT NULL,
      target_id            uuid NOT NULL,
      terminal_outcome     text NOT NULL,
      failure_reason_code  text,
      recorded_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_asrto_target         UNIQUE (org_id, target_id),
      CONSTRAINT fk_asrto_target         FOREIGN KEY (target_id, org_id, run_id)
        REFERENCES attendance_scheduled_run_targets (id, org_id, run_id),
      CONSTRAINT chk_asrto_outcome       CHECK (terminal_outcome IN ('completed','failed')),
      CONSTRAINT chk_asrto_reason_pair   CHECK ((terminal_outcome = 'failed') = (failure_reason_code IS NOT NULL)),
      CONSTRAINT chk_asrto_reason_closed CHECK (
        failure_reason_code IS NULL
        OR failure_reason_code IN (${sql.raw(sqlList(SCHEDULED_TARGET_FAILURE_REASON_CODES_V1))})
      )
    )
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_asrto_deny_mutation ON attendance_scheduled_run_target_outcomes`.execute(db)
  await sql`
    CREATE TRIGGER trg_asrto_deny_mutation
      BEFORE UPDATE OR DELETE ON attendance_scheduled_run_target_outcomes
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_asrto_deny_truncate ON attendance_scheduled_run_target_outcomes`.execute(db)
  await sql`
    CREATE TRIGGER trg_asrto_deny_truncate
      BEFORE TRUNCATE ON attendance_scheduled_run_target_outcomes
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)

  // Deferred cross-table completion guard (section 1.1.1) — fires only on the
  // running -> completed transition. Every leg uses a LEFT JOIN to the operation row so a
  // target whose derived operation row is somehow missing counts as a mismatch rather than
  // silently vanishing from the count (an INNER JOIN would let a dangling outcome row pass
  // leg (c) vacuously).
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_run_completion_outcome_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      generate_target_count integer;
      outcome_row_count integer;
      completed_outcome_count integer;
      mismatch_count integer;
    BEGIN
      SELECT count(*) INTO generate_target_count
        FROM attendance_scheduled_run_targets
        WHERE run_id = NEW.run_id AND org_id = NEW.org_id AND target_kind = 'generate';

      SELECT count(*) INTO outcome_row_count
        FROM attendance_scheduled_run_target_outcomes o
        JOIN attendance_scheduled_run_targets t
          ON t.id = o.target_id AND t.org_id = o.org_id AND t.run_id = NEW.run_id
        WHERE o.org_id = NEW.org_id AND o.run_id = NEW.run_id AND t.target_kind = 'generate';

      IF outcome_row_count <> generate_target_count THEN
        RAISE EXCEPTION 'W4C2_RUN_COMPLETION: every generate target must have exactly one outcome row on %', TG_TABLE_NAME;
      END IF;

      SELECT count(*) INTO completed_outcome_count
        FROM attendance_scheduled_run_target_outcomes o
        JOIN attendance_scheduled_run_targets t
          ON t.id = o.target_id AND t.org_id = o.org_id AND t.run_id = NEW.run_id
        WHERE o.org_id = NEW.org_id AND o.run_id = NEW.run_id AND t.target_kind = 'generate'
          AND o.terminal_outcome = 'completed';

      IF completed_outcome_count IS DISTINCT FROM NEW.completed_user_count THEN
        RAISE EXCEPTION 'W4C2_RUN_COMPLETION: completed_user_count does not match recorded outcomes on %', TG_TABLE_NAME;
      END IF;

      SELECT count(*) INTO mismatch_count
        FROM attendance_scheduled_run_target_outcomes o
        JOIN attendance_scheduled_run_targets t
          ON t.id = o.target_id AND t.org_id = o.org_id AND t.run_id = NEW.run_id
        LEFT JOIN attendance_result_operations r
          ON r.org_id = o.org_id AND r.entrypoint = 'scheduled' AND r.operation_id = t.operation_id
        WHERE o.org_id = NEW.org_id AND o.run_id = NEW.run_id
          AND (
            r.state IS NULL
            OR (o.terminal_outcome = 'completed' AND r.state <> 'completed')
            OR (o.terminal_outcome = 'failed' AND r.state <> 'canceled')
          );

      IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'W4C2_RUN_COMPLETION: outcome label disagrees with operation state on %', TG_TABLE_NAME;
      END IF;

      RETURN NULL;
    END;
    $fn$
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_asr_completion_outcome_guard ON attendance_scheduled_runs`.execute(db)
  await sql`
    CREATE CONSTRAINT TRIGGER trg_asr_completion_outcome_guard
      AFTER UPDATE ON attendance_scheduled_runs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (NEW.state = 'completed' AND OLD.state = 'running')
      EXECUTE FUNCTION attendance_w4_run_completion_outcome_guard()
  `.execute(db)

  // Step 9 (O-3=(a)): narrow chk_asr_terminal_shape's `completed` branch from the equality
  // step 1 drafted to the O-3=(a) form (a `failed` target is real/permanent and is not
  // counted in completed_user_count).
  await sql`
    ALTER TABLE attendance_scheduled_runs DROP CONSTRAINT IF EXISTS chk_asr_terminal_shape
  `.execute(db)
  await sql`
    ALTER TABLE attendance_scheduled_runs ADD CONSTRAINT chk_asr_terminal_shape CHECK (
         (state = 'running'   AND completed_user_count IS NULL
                              AND generated_count IS NULL
                              AND finalized_at IS NULL
                              AND abandon_reason_code IS NULL
                              AND abandoned_by_actor_posture IS NULL)
      OR (state = 'completed' AND completed_user_count IS NOT NULL
                              AND completed_user_count <= expected_user_count
                              AND generated_count IS NOT NULL
                              AND generated_count <= expected_user_count
                              AND finalized_at IS NOT NULL
                              AND abandon_reason_code IS NULL
                              AND abandoned_by_actor_posture IS NULL)
      OR (state = 'abandoned' AND completed_user_count IS NOT NULL
                              AND generated_count IS NULL
                              AND finalized_at IS NOT NULL
                              AND abandon_reason_code IS NOT NULL
                              AND abandoned_by_actor_posture IS NOT NULL)
    )
  `.execute(db)

  // -------------------------------------------------------------------------
  // Step 2 (section 1.10): outbox discriminated union — add columns, drop NOT NULL.
  // -------------------------------------------------------------------------
  await sql`
    ALTER TABLE attendance_result_event_outbox
      ADD COLUMN IF NOT EXISTS identity_kind    text,
      ADD COLUMN IF NOT EXISTS scheduled_run_id uuid
  `.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox ALTER COLUMN operation_id DROP NOT NULL`.execute(db)

  // -------------------------------------------------------------------------
  // Step 3 (section 1.10): backfill, crossing the pre-existing guard trigger correctly.
  // Every pre-existing row has a non-null operation_id by the OLD NOT NULL constraint, so
  // the backfill is total once the trigger is disabled.
  // -------------------------------------------------------------------------
  await sql`ALTER TABLE attendance_result_event_outbox DISABLE TRIGGER trg_areo_update_guard`.execute(db)
  await sql`
    UPDATE attendance_result_event_outbox SET identity_kind = 'operation' WHERE identity_kind IS NULL
  `.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox ENABLE TRIGGER trg_areo_update_guard`.execute(db)

  // -------------------------------------------------------------------------
  // Step 4 (section 1.10): SET NOT NULL FIRST (the easiest-to-drop line — see the module
  // comment), then the CHECK constraints, both FKs (fk_areo_operation VALIDATED, never
  // NOT VALID — fail-closed semantics, section 1.10), and the two partial unique indexes;
  // drop uq_areo_identity only after the operation partial unique index exists.
  // -------------------------------------------------------------------------
  await sql`ALTER TABLE attendance_result_event_outbox ALTER COLUMN identity_kind SET NOT NULL`.execute(db)

  // Postgres has no `ADD CONSTRAINT IF NOT EXISTS` — each block is guarded by an explicit
  // pg_constraint existence check so a replay (up() run twice) does not error.
  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_areo_identity_kind') THEN
        ALTER TABLE attendance_result_event_outbox
          ADD CONSTRAINT chk_areo_identity_kind
            CHECK (identity_kind IN ('operation','scheduled_run')),
          ADD CONSTRAINT chk_areo_identity_operation
            CHECK ((identity_kind = 'operation')      = (operation_id IS NOT NULL)),
          ADD CONSTRAINT chk_areo_identity_run
            CHECK ((identity_kind = 'scheduled_run')  = (scheduled_run_id IS NOT NULL)),
          ADD CONSTRAINT chk_areo_identity_exclusive
            CHECK ((operation_id IS NULL) <> (scheduled_run_id IS NULL));
      END IF;
    END
    $do$
  `.execute(db)

  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_areo_operation') THEN
        ALTER TABLE attendance_result_event_outbox
          ADD CONSTRAINT fk_areo_operation
            FOREIGN KEY (org_id, entrypoint, operation_id)
              REFERENCES attendance_result_operations (org_id, entrypoint, operation_id);
      END IF;
    END
    $do$
  `.execute(db)
  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_areo_scheduled_run') THEN
        ALTER TABLE attendance_result_event_outbox
          ADD CONSTRAINT fk_areo_scheduled_run
            FOREIGN KEY (scheduled_run_id, org_id)
              REFERENCES attendance_scheduled_runs (run_id, org_id);
      END IF;
    END
    $do$
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_areo_operation_identity
      ON attendance_result_event_outbox (org_id, entrypoint, operation_id, event_kind)
      WHERE operation_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_areo_run_identity
      ON attendance_result_event_outbox (org_id, entrypoint, scheduled_run_id, event_kind)
      WHERE scheduled_run_id IS NOT NULL
  `.execute(db)

  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS uq_areo_identity`.execute(db)

  // -------------------------------------------------------------------------
  // Step 5 (section 1.10): outbox UPDATE guard rewritten to the generic-allowlist form —
  // ONLY AFTER the backfill (identity_kind is frozen by this new body, and installing it
  // before the backfill would block the backfill via a different clause). The three
  // pre-existing checks (delivered-terminality, delivery_state legality,
  // attempts-non-decreasing) are unchanged; only the frozen-column comparison changes from
  // a nine-column freeze list to jsonb-minus over the four mutable keys.
  // -------------------------------------------------------------------------
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_outbox_update_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      mutable_keys text[] := ARRAY['delivery_state','attempts','next_attempt_at','delivered_at'];
    BEGIN
      IF OLD.delivery_state = 'delivered' THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: delivered outbox row is immutable on %', TG_TABLE_NAME;
      END IF;
      IF (to_jsonb(NEW) - mutable_keys) IS DISTINCT FROM (to_jsonb(OLD) - mutable_keys) THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: outbox identity/payload is immutable on %', TG_TABLE_NAME;
      END IF;
      IF NEW.delivery_state NOT IN ('pending', 'delivered') THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: illegal outbox delivery state on %', TG_TABLE_NAME;
      END IF;
      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: outbox attempts cannot decrease on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  // -------------------------------------------------------------------------
  // Step 6 (section 1.10): the kind<->identity map + entrypoint-binding CHECKs, then
  // DROP/re-ADD chk_areo_event_kind as an eight-member LOCAL literal. The already-applied
  // W4C-0 migration's own OUTBOX_EVENT_KINDS constant (zzzz20260725120000_...:210-217) is
  // NOT edited — it is a historical artifact consumed once, at that migration's own up().
  // -------------------------------------------------------------------------
  await sql`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_areo_kind_identity_map') THEN
        ALTER TABLE attendance_result_event_outbox
          ADD CONSTRAINT chk_areo_kind_identity_map CHECK (
            CASE event_kind
              WHEN 'attendance.absence.generated'          THEN identity_kind = 'scheduled_run'
              WHEN 'attendance.work_date.review_required'  THEN identity_kind = 'scheduled_run'
              ELSE identity_kind = 'operation'
            END
          ),
          ADD CONSTRAINT chk_areo_run_entrypoint
            CHECK (identity_kind <> 'scheduled_run' OR entrypoint = 'scheduled');
      END IF;
    END
    $do$
  `.execute(db)

  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_event_kind`.execute(db)
  await sql`
    ALTER TABLE attendance_result_event_outbox
      ADD CONSTRAINT chk_areo_event_kind CHECK (event_kind IN (${sql.raw(sqlList(W4C2_OUTBOX_EVENT_KINDS_V1))}))
  `.execute(db)
}

// ---------------------------------------------------------------------------
// down(): section 1.10 — refuses BEFORE any DDL while any row exists in any of the four
// W4C-2 surfaces. Never clears history to pass.
// ---------------------------------------------------------------------------

export async function down(db: Kysely<unknown>): Promise<void> {
  const guards: Array<{ label: string; query: string }> = [
    { label: 'attendance_scheduled_runs', query: 'SELECT count(*)::int AS n FROM attendance_scheduled_runs' },
    { label: 'attendance_scheduled_run_targets', query: 'SELECT count(*)::int AS n FROM attendance_scheduled_run_targets' },
    {
      label: 'attendance_scheduled_run_target_outcomes',
      query: 'SELECT count(*)::int AS n FROM attendance_scheduled_run_target_outcomes',
    },
    {
      label: 'attendance_result_event_outbox scheduled-run rows',
      query: "SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE identity_kind = 'scheduled_run'",
    },
  ]

  for (const guard of guards) {
    const result = await sql.raw(guard.query).execute(db)
    const row = (result.rows[0] ?? {}) as { n?: number | string }
    const count = Number(row.n ?? 0)
    if (count > 0) {
      throw new Error(
        'W4C2_DOWN_BLOCKED: refusing to run down migration while W4C-2 rows exist in ' +
          guard.label +
          ' (count=' + String(count) + '). Down never clears history to pass.',
      )
    }
  }

  // All four W4C-2 surfaces proven empty — now (and only now) DDL teardown.

  // Restore chk_asr_terminal_shape's completed branch to the equality form (harmless before
  // the table itself is dropped below; kept for exact symmetry with the reverse of up()'s
  // own numbered steps).
  await sql`ALTER TABLE attendance_scheduled_runs DROP CONSTRAINT IF EXISTS chk_asr_terminal_shape`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_asr_completion_outcome_guard ON attendance_scheduled_runs`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_scheduled_run_target_outcomes`.execute(db)
  await sql`ALTER TABLE attendance_scheduled_run_targets DROP CONSTRAINT IF EXISTS uq_asrt_id_org_run`.execute(db)

  // Outbox: restore the original W4C-0 shape byte-equivalently.
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_event_kind`.execute(db)
  await sql`
    ALTER TABLE attendance_result_event_outbox
      ADD CONSTRAINT chk_areo_event_kind CHECK (event_kind IN (
        'attendance.punched',
        'attendance.requested',
        'attendance.request.updated',
        'attendance.request.cancelled',
        'attendance.resolved',
        'attendance.outdoorPunch.requested'
      ))
  `.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_kind_identity_map`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_run_entrypoint`.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION attendance_w4_outbox_update_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF OLD.delivery_state = 'delivered' THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: delivered outbox row is immutable on %', TG_TABLE_NAME;
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR
         NEW.org_id IS DISTINCT FROM OLD.org_id OR
         NEW.entrypoint IS DISTINCT FROM OLD.entrypoint OR
         NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
         NEW.event_kind IS DISTINCT FROM OLD.event_kind OR
         NEW.payload IS DISTINCT FROM OLD.payload OR
         NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version OR
         NEW.business_key_fingerprint IS DISTINCT FROM OLD.business_key_fingerprint OR
         NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: outbox identity/payload is immutable on %', TG_TABLE_NAME;
      END IF;
      IF NEW.delivery_state NOT IN ('pending', 'delivered') THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: illegal outbox delivery state on %', TG_TABLE_NAME;
      END IF;
      IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'W4C0_OUTBOX: outbox attempts cannot decrease on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`DROP INDEX IF EXISTS uq_areo_operation_identity`.execute(db)
  await sql`DROP INDEX IF EXISTS uq_areo_run_identity`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS fk_areo_operation`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS fk_areo_scheduled_run`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_identity_kind`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_identity_operation`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_identity_run`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP CONSTRAINT IF EXISTS chk_areo_identity_exclusive`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox ALTER COLUMN operation_id SET NOT NULL`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP COLUMN IF EXISTS identity_kind`.execute(db)
  await sql`ALTER TABLE attendance_result_event_outbox DROP COLUMN IF EXISTS scheduled_run_id`.execute(db)
  await sql`
    ALTER TABLE attendance_result_event_outbox
      ADD CONSTRAINT uq_areo_identity UNIQUE (org_id, entrypoint, operation_id, event_kind)
  `.execute(db)

  await sql`DROP FUNCTION IF EXISTS attendance_w4_run_completion_outcome_guard()`.execute(db)

  await sql`DROP TABLE IF EXISTS attendance_scheduled_run_targets`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_scheduled_runs`.execute(db)

  // Both tables' triggers reference these functions — the functions can only be dropped
  // after both tables (and therefore their triggers) are gone.
  await sql`DROP FUNCTION IF EXISTS attendance_w4_scheduled_run_frozen_counts_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w4_scheduled_run_update_guard()`.execute(db)
}
