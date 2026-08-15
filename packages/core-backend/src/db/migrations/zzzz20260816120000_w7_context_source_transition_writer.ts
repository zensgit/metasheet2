import { sql, type Kysely } from 'kysely'

/**
 * W7-3 (#4556) — the context-source TRANSITION WRITER's durable substrate.
 *
 * Authority: `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 (staging ladder), §5.2 (stage rollback), §5.3 (authoritative rollback),
 * §7 OD-W7-3(a) + OD-W7-4(a), red line W7-R4; ratified per #4556 comments
 * 5293034619 (owner-directed disclosed relay) + 5293478713 (owner first-person
 * confirmation), ruling 2 (OD-W7-1..8 = option (a)).
 *
 * This migration ships exactly what W7-1a's own migration
 * (`zzzz20260814120000_w7_attendance_context_source_posture_state.ts:23-27`)
 * declared it was deferring: "The transition writer's machinery (append-only
 * event table, version/prior_state columns, the legal-matrix trigger backstop,
 * evidence manifest) is W7-R4 write-side work that lands with the
 * transition-boundary slice, not here."
 *
 * SHAPE IS CLONED, NOT REUSED, from the W4 segment-calculation rollout machine
 * (`zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts`:
 * state table `:992-1008`, event table `:1010-1029`, guard function
 * `:1031-1073`, attachment `:1075-1080`). The two machines stay independent
 * (OD-W7-3(a) consequence note): nothing here reads, writes, or constrains the
 * W4 tables, and the W7 guard is its own function with its own name so that a
 * future edit to either matrix cannot silently move the other.
 *
 * ORDERING. This file must sort after:
 *   - `zzzz20260814120000_w7_attendance_context_source_posture_state.ts`, which
 *     CREATEs the table these columns are added to; and
 *   - `zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:397`,
 *     which is where `attendance_w4_deny_mutation()` is actually DEFINED (its
 *     other appearances, e.g. in `zzzz20260727100000_…:368-379`, are only
 *     attachments). Re-using that function rather than defining a second
 *     identical one is deliberate: append-only enforcement is one behaviour and
 *     two copies of it can drift.
 * It does, at `zzzz20260816120000`. Per the zzzz-ordering trap, a new column or
 * value on a zzzz table must itself arrive in a zzzz migration; no historical
 * migration is edited by this slice.
 *
 * STILL SHIPS EMPTY. This migration inserts no row anywhere. The table was
 * empty before it and is empty after it, so W7-1a's "no row ⇒ every org
 * resolves `off`" inertness leg is untouched.
 */

/**
 * Mirrors `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1`
 * (`packages/core-backend/src/attendance/w7-context-source-posture-contract.ts:28`),
 * exactly as the W7-1a migration already mirrors it (`…posture_state.ts:46-52`).
 *
 * A LOCAL MIRROR, deliberately, NOT an import of the contract module. A
 * migration whose emitted SQL changes when application code changes is a deploy
 * hazard: migrations must be immutable in meaning once shipped. The two are
 * pinned to each other by exercising the DATABASE against the IMPORTED TS
 * constant (`tests/integration/attendance-w7-3-context-source-transition.db.test.ts`,
 * legs T-M1 and T-B3) rather than by comparing two files' text — a text
 * comparison would pass on two identically-wrong lists.
 */
const CONTEXT_SOURCE_STATES = [
  'off',
  'group_shadow',
  'group_eligible',
  'group_authoritative',
  'suspended',
] as const

/**
 * Mirrors `ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1`
 * (`…w7-context-source-posture-contract.ts:56-66`) — the SEVEN pairs closed by
 * ruling 2 / OD-W7-4(a) ("No legacy fallback from `group_authoritative`;
 * suspend/resume only").
 *
 * Same local-mirror discipline and the same proof obligation as the state list
 * above: the trigger's accepted pair set is proven equal to the TS constant by
 * attempting every one of the 25 ordered pairs against a real database (leg
 * T-M1), never by reading both files. Adding a pair here and not to the TS
 * constant — or the reverse — makes exactly one of those 25 cells diverge.
 */
const CONTEXT_SOURCE_LEGAL_TRANSITIONS: ReadonlyArray<readonly [string, string]> = [
  ['off', 'group_shadow'],
  ['group_shadow', 'off'],
  ['group_shadow', 'group_eligible'],
  ['group_eligible', 'group_shadow'],
  ['group_eligible', 'group_authoritative'],
  ['group_authoritative', 'suspended'],
  ['suspended', 'group_authoritative'],
]

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * Renders the guard's UPDATE pair clauses from the mirror above, grouped by
 * source state and emitted in a deterministic order, so the plpgsql body is
 * generated rather than hand-typed. Hand-typing the same seven pairs a third
 * time is the two-hand-maintained-copies trap in a different costume.
 */
function renderLegalTransitionClauses(): string {
  const byFrom = new Map<string, string[]>()
  for (const [from, to] of CONTEXT_SOURCE_LEGAL_TRANSITIONS) {
    const existing = byFrom.get(from)
    if (existing) existing.push(to)
    else byFrom.set(from, [to])
  }
  return Array.from(byFrom.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([from, targets]) => {
      const sorted = [...targets].sort()
      return `(OLD.state = '${from}' AND NEW.state IN (${sqlList(sorted)}))`
    })
    .join(' OR\n        ')
}

/**
 * TWO AUTHORING HAZARDS THIS FILE HAS ALREADY BEEN BITTEN BY. Recorded so the
 * next author does not rediscover them, and because both are invisible in
 * review.
 *
 * 1. NULL IS NOT FALSE IN THE TRIGGER'S BOOTSTRAP CLAUSE. The clause was first
 *    written as the W4 guard writes it:
 *
 *        IF NOT ( (NEW.state = 'off'          AND NEW.prior_state IS NULL) OR
 *                 (NEW.state = 'group_shadow' AND NEW.prior_state = 'off') )
 *
 *    `prior_state` is NULLABLE. For the row `(state='group_shadow',
 *    prior_state=NULL)` the first disjunct is FALSE and the second is NULL
 *    (`NULL = 'off'` is NULL), so the disjunction is NULL, `NOT NULL` is NULL,
 *    and plpgsql treats a NULL `IF` condition as not-true — it FALLS THROUGH
 *    and ACCEPTS the row. That is precisely the illegal bootstrap shape the
 *    clause exists to reject. Fixed with `IS NOT DISTINCT FROM` plus a
 *    `COALESCE(..., false)` wrapper on both branches, so NULL fails CLOSED.
 *    Caught by the DB-exercised INSERT sweep in
 *    `tests/integration/attendance-w7-3-context-source-transition.db.test.ts`,
 *    not by review.
 *
 *    DISCLOSED, NOT FIXED HERE: `attendance_w4_rollout_state_guard`
 *    (`zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:1031-1073`)
 *    carries the identical latent shape for `(shadow, prior_state NULL)`.
 *    Correcting it means a new zzzz migration replacing a landed W4 trigger —
 *    a change to the W4 machine, with its own review. Recorded rather than
 *    silently cloned, and rather than silently patched inside a W7 slice.
 *
 * 2. NO BACKTICKS INSIDE THE `sql` TEMPLATE LITERALS BELOW. The plpgsql body is
 *    a JavaScript template literal; a backtick in a `--` SQL comment terminates
 *    it and the file fails to transform with a syntax error pointing at an
 *    unrelated line. Keep SQL comments backtick-free and put any prose that
 *    wants them up here, in TypeScript comment space.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Transition bookkeeping columns on the posture-state table.
  //
  // Each NOT NULL column is added WITH a transient DEFAULT and the DEFAULT is
  // then dropped. The table ships empty, but this migration deliberately does
  // NOT depend on that: if any environment ever has a row (a staging org
  // created by hand, a restored dump), `ADD COLUMN ... NOT NULL` without a
  // default would fail the deploy instead of migrating the row. The transient
  // defaults are sentinels that name themselves as backfill, never plausible
  // real operator values.
  // -------------------------------------------------------------------------
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ALTER COLUMN version DROP DEFAULT
  `.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD COLUMN IF NOT EXISTS prior_state text
  `.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD COLUMN IF NOT EXISTS engine_version text NOT NULL DEFAULT 'w7_pre_transition_backfill'
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ALTER COLUMN engine_version DROP DEFAULT
  `.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD COLUMN IF NOT EXISTS reason_code text NOT NULL DEFAULT 'w7_pre_transition_backfill'
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ALTER COLUMN reason_code DROP DEFAULT
  `.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD COLUMN IF NOT EXISTS actor_id text NOT NULL DEFAULT 'w7_pre_transition_backfill'
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ALTER COLUMN actor_id DROP DEFAULT
  `.execute(db)

  // `changed_at`'s DEFAULT is PERMANENT, matching `attendance_calculation_rollout_state`
  // (`zzzz20260725120000_…:998`): it is a real column default, not a backfill sentinel.
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD COLUMN IF NOT EXISTS changed_at timestamptz NOT NULL DEFAULT now()
  `.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      DROP CONSTRAINT IF EXISTS chk_accss_prior_state
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD CONSTRAINT chk_accss_prior_state
      CHECK (prior_state IS NULL OR prior_state IN (${sql.raw(sqlList(CONTEXT_SOURCE_STATES))}))
  `.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      DROP CONSTRAINT IF EXISTS chk_accss_version
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      ADD CONSTRAINT chk_accss_version CHECK (version >= 1)
  `.execute(db)

  // -------------------------------------------------------------------------
  // 2. Append-only event table, mirroring `attendance_calculation_rollout_events`
  //    (`zzzz20260725120000_…:1010-1029`) field for field.
  // -------------------------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_calculation_context_source_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      prior_state text,
      new_state text NOT NULL,
      reason_code text NOT NULL,
      engine_version text NOT NULL,
      actor_id text NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_accse_prior_state CHECK (
        prior_state IS NULL OR prior_state IN (${sql.raw(sqlList(CONTEXT_SOURCE_STATES))})
      ),
      CONSTRAINT chk_accse_new_state CHECK (
        new_state IN (${sql.raw(sqlList(CONTEXT_SOURCE_STATES))})
      )
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_accse_org_time
    ON attendance_calculation_context_source_events (org_id, created_at)
  `.execute(db)

  // -------------------------------------------------------------------------
  // 3. Append-only enforcement on the EVENT table, reusing the existing
  //    `attendance_w4_deny_mutation()` (defined at `zzzz20260725120000_…:397`,
  //    precedent attachment `zzzz20260727100000_…:368-379`).
  // -------------------------------------------------------------------------
  await sql`
    DROP TRIGGER IF EXISTS trg_accse_deny_mutation ON attendance_calculation_context_source_events
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_accse_deny_mutation
      BEFORE UPDATE OR DELETE ON attendance_calculation_context_source_events
      FOR EACH ROW EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)
  await sql`
    DROP TRIGGER IF EXISTS trg_accse_deny_truncate ON attendance_calculation_context_source_events
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_accse_deny_truncate
      BEFORE TRUNCATE ON attendance_calculation_context_source_events
      FOR EACH STATEMENT EXECUTE FUNCTION attendance_w4_deny_mutation()
  `.execute(db)

  // -------------------------------------------------------------------------
  // 4. The legal-matrix trigger BACKSTOP.
  //
  // Defense in depth, never the primary gate: the TS constant in
  // `w7-context-source-posture-contract.ts` is the SOLE source of pair
  // legality and the single writer refuses an illegal pair before any lock or
  // DB access. This trigger exists so that a raw-SQL writer that bypasses the
  // boundary entirely still cannot corrupt the ladder.
  // -------------------------------------------------------------------------
  await sql`
    CREATE OR REPLACE FUNCTION attendance_w7_context_source_state_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        -- IS NOT DISTINCT FROM, never a bare =, and the whole disjunction
        -- wrapped in COALESCE. See the TypeScript comment above up() for the
        -- full reasoning; in short, prior_state is NULLABLE, so a bare equality
        -- yields NULL rather than FALSE and plpgsql then FALLS THROUGH an
        -- IF NOT (...) guard, silently accepting the very shape this clause
        -- exists to reject.
        IF NOT COALESCE(
          (NEW.state = 'off' AND NEW.prior_state IS NULL) OR
          (NEW.state = 'group_shadow' AND NEW.prior_state IS NOT DISTINCT FROM 'off'),
          false
        ) THEN
          RAISE EXCEPTION 'W7_CONTEXT_SOURCE: illegal initial context-source state on %', TG_TABLE_NAME;
        END IF;
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'W7_CONTEXT_SOURCE: initial context-source version must be 1 on %', TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.scope IS DISTINCT FROM OLD.scope THEN
        RAISE EXCEPTION 'W7_CONTEXT_SOURCE: context-source identity fields are immutable on %', TG_TABLE_NAME;
      END IF;
      -- COALESCE for the same reason as the INSERT branch above. state is NOT
      -- NULL on both OLD and NEW today, so this cannot currently evaluate to
      -- NULL; it is uniform NULL-fail-closed hardening, so that a future
      -- widening of the column nullability cannot turn a refusal into a
      -- silent acceptance.
      IF NOT COALESCE(
        ${sql.raw(renderLegalTransitionClauses())},
        false
      ) THEN
        RAISE EXCEPTION 'W7_CONTEXT_SOURCE: illegal context-source state transition on %', TG_TABLE_NAME;
      END IF;
      IF NEW.prior_state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'W7_CONTEXT_SOURCE: prior_state must record the previous state on %', TG_TABLE_NAME;
      END IF;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'W7_CONTEXT_SOURCE: optimistic version must increment on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $fn$
  `.execute(db)

  await sql`
    DROP TRIGGER IF EXISTS trg_accss_state_guard ON attendance_calculation_context_source_state
  `.execute(db)
  await sql`
    CREATE TRIGGER trg_accss_state_guard
      BEFORE INSERT OR UPDATE ON attendance_calculation_context_source_state
      FOR EACH ROW EXECUTE FUNCTION attendance_w7_context_source_state_guard()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_accss_state_guard ON attendance_calculation_context_source_state
  `.execute(db)
  await sql`DROP FUNCTION IF EXISTS attendance_w7_context_source_state_guard()`.execute(db)

  // The event table's two triggers go with the table itself; `attendance_w4_deny_mutation()`
  // is NOT dropped — it is owned by the W4C-0 migration and is still attached to several
  // other tables.
  await sql`DROP TABLE IF EXISTS attendance_calculation_context_source_events`.execute(db)

  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      DROP CONSTRAINT IF EXISTS chk_accss_version
  `.execute(db)
  await sql`
    ALTER TABLE attendance_calculation_context_source_state
      DROP CONSTRAINT IF EXISTS chk_accss_prior_state
  `.execute(db)

  for (const column of ['changed_at', 'actor_id', 'reason_code', 'engine_version', 'prior_state', 'version']) {
    await sql`
      ALTER TABLE attendance_calculation_context_source_state
        DROP COLUMN IF EXISTS ${sql.raw(column)}
    `.execute(db)
  }
}
