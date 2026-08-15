/**
 * W7-3 (#4556) real-PG gate — the context-source transition boundary.
 *
 * The legs here are the ones that CANNOT be proven without a database: the
 * trigger backstop's accepted pair set, the writer's DML ordering and
 * atomicity, the plan reporter's zero-write proof, the two-connection
 * serialization proof, and migration replay.
 *
 * DISCIPLINE, stated once and applied to every leg below:
 *  - assert POSITIVE equalities; a `notEqual` cannot tell "correct" from
 *    "failed for another reason", so every refusal leg asserts WHICH code came
 *    back, and every acceptance leg asserts the resulting row;
 *  - every "nothing happened" leg carries a named POSITIVE CONTROL that proves
 *    the assertion could have seen a change;
 *  - the 25-pair sweep asserts it really ran 25 statements, and its ladder walk
 *    is asserted to have SUCCEEDED before the sweep runs — a silently failed
 *    walk would make all 25 attempts fail on the bookkeeping clauses, and the
 *    sweep would look discriminating while measuring nothing.
 *
 * The TRIGGER-vs-TS equality is proven by EXERCISING THE DATABASE against the
 * IMPORTED TS constant, never by comparing the migration's text to the
 * contract's text — two identically-wrong lists would pass a text comparison.
 *
 * DEDICATED EPHEMERAL DATABASE, not the shared `metasheet_test` — and the reason
 * is a measured collision, not caution. This suite performs SCHEMA-destructive
 * work (a `down()`/`up()` replay of the W7-3 migration; a
 * `DISABLE TRIGGER`/`ENABLE TRIGGER` pair proving the CHECK is a separate door),
 * and the landed `attendance-w7-1a-resolver.db.test.ts` performs its own
 * schema-destructive replay of the W7-1a migration — whose `down()` is a
 * `DROP TABLE` that takes W7-3's columns and trigger with it and whose `up()`
 * recreates the table WITHOUT them. Two suites replaying migrations against one
 * shared table under `pool: 'forks'` parallelism broke each other in both
 * directions when this was first run against the shared database: 11 failures
 * across the two files, none of them a real defect in either.
 *
 * The shape is cloned from the equivalent W4 transition-boundary suite,
 * `attendance-w4c3a-rollout-control.db.test.ts` (scratch database ->
 * hand-built minimal base tables -> the REAL W4C-0 migration `up()` on top), so
 * the parts that carry weight — this slice's own migration, the W4C-0
 * `attendance_w4_deny_mutation()` function, and the W4 rollout state machine the
 * `W4_POSTURE_COHERENT` predicate reads — all run for real rather than being
 * re-spelled by hand.
 */
import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'
import { ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1 } from '../../src/attendance/w4c3b-request-snapshots'
import {
  ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1,
  readAttendanceRequestSnapshotDefectReportV1,
} from '../../src/attendance/w4c3a-rollout-control'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  isAttendanceW7ContextSourcePostureLegalTransitionV1,
  type AttendanceW7ContextSourcePostureStateV1,
} from '../../src/attendance/w7-context-source-posture-contract'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1,
  __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests,
  __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests,
} from '../../src/attendance/w7-context-source-delivery'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1,
  buildAttendanceW7ContextSourceAdvisoryKeyV1,
  __setW7ContextSourcePlanInsideTransactionForTests,
  planAttendanceW7ContextSourceTransitionV1,
  transitionAttendanceW7ContextSourceV1,
  __setW7ContextSourceTransitionAfterExclusiveLockForTests,
  __setW7ContextSourceTransitionBeforeEventInsertForTests,
  __setW7ContextSourceTransitionBeforeStateUpdateForTests,
  type AttendanceW7ContextSourceTransitionInputV1,
} from '../../src/attendance/w7-context-source-transition'
import { ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV } from '../../src/attendance/w7-resolver/w7-context-source-posture-resolver'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as postureSchemaUp } from '../../src/db/migrations/zzzz20260814120000_w7_attendance_context_source_posture_state'
import {
  down as writerMigrationDown,
  up as writerMigrationUp,
} from '../../src/db/migrations/zzzz20260816120000_w7_context_source_transition_writer'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const STATE_TABLE = 'attendance_calculation_context_source_state'
const EVENT_TABLE = 'attendance_calculation_context_source_events'

const MANIFEST = 'b'.repeat(64)
const BASE_REFS = Object.freeze({
  imageSha: 'sha256:bbbb',
  ownerAuthorizationRef: 'owner-ref-w73',
  syntheticOrgRef: 'synthetic-org-w73',
})
const RESUME_REFS = Object.freeze({
  ...BASE_REFS,
  ownerIncidentReviewRef: 'incident-w73',
  offlineReplayArtifactRef: 'replay-w73',
})

/** The legal ladder path from `off` to each state, used to place a row in a
 *  chosen state through LEGAL edges only. Derived by breadth-first search over
 *  the ratified constant, never hand-written — a pair removed from the constant
 *  makes the walk unreachable and reds the anchor check rather than silently
 *  taking a stale path. */
function ladderPathTo(target: AttendanceW7ContextSourcePostureStateV1): readonly string[] {
  const queue: Array<{ state: string; path: string[] }> = [{ state: 'off', path: [] }]
  const seen = new Set<string>(['off'])
  while (queue.length > 0) {
    const head = queue.shift() as { state: string; path: string[] }
    if (head.state === target) return head.path
    for (const [from, to] of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1) {
      if (from !== head.state || seen.has(to)) continue
      seen.add(to)
      queue.push({ state: to, path: [...head.path, to] })
    }
  }
  throw new Error(`no legal ladder path to ${target}`)
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? `<no code: ${String(error)}>`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asTrx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: async (sqlText: string, params?: unknown[]) => {
      const result = await client.query(sqlText, params as never[])
      return { rows: result.rows as Array<Record<string, unknown>> }
    },
  }
}

/**
 * The minimal non-W4C-0 tables this boundary's predicates read. Copied in shape
 * from `attendance-w4c3a-rollout-control.db.test.ts`'s own `createBase` — the
 * same predicates, so the same minimum. Everything else (the rollout state
 * machine, the request-snapshot table, `attendance_w4_deny_mutation`) comes from
 * the REAL W4C-0 migration applied on top, never hand-written here.
 */
async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean, meta jsonb,
      source_batch_id uuid, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL,
      requested_in_at timestamptz, requested_out_at timestamptz, reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb, approval_instance_id text
    )`)
  await pool.query(`
    CREATE TABLE approval_instances (
      id text PRIMARY KEY, status text NOT NULL, version integer NOT NULL DEFAULT 0
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY, org_id text NOT NULL, idempotency_key text, status text NOT NULL,
      row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, org_id text NOT NULL,
      user_id text, work_date date, record_id uuid, preview_snapshot jsonb
    )`)
}

describeIfDatabase('W7-3 context-source transition boundary (real PG, dedicated ephemeral DB)', () => {
  const scratchName = `ms2_w73_ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let adminPool: Pool
  let pool: Pool
  const createdOrgs: string[] = []

  let savedW4: string | undefined
  let savedW7: string | undefined

  /** Raw-SQL bootstrap of the ladder's base row — deliberately bypassing the
   *  writer, because these fixtures exist to test the TRIGGER, which must hold
   *  against a writer-bypassing caller. */
  async function seedBaseRow(orgId: string): Promise<void> {
    createdOrgs.push(orgId)
    await pool.query(
      `INSERT INTO ${STATE_TABLE}
         (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
       VALUES ($1, 'off', 'synthetic_staging', 1, NULL, 'w7-fixture', 'context_source_transition', 'fixture')`,
      [orgId],
    )
  }

  /**
   * Walks an org up the ladder to `target` using ONLY legal edges, with correct
   * `prior_state` / `version` bookkeeping at every step. Returns the row's final
   * state and version so the caller can ASSERT the walk succeeded — an
   * unasserted walk is the difference between a discriminating sweep and one
   * that measures nothing.
   */
  async function walkTo(
    orgId: string,
    target: AttendanceW7ContextSourcePostureStateV1,
  ): Promise<{ state: string; version: number }> {
    for (const step of ladderPathTo(target)) {
      await pool.query(
        `UPDATE ${STATE_TABLE}
            SET state = $2, prior_state = state, version = version + 1
          WHERE org_id = $1`,
        [orgId, step],
      )
    }
    const row = await pool.query(`SELECT state, version FROM ${STATE_TABLE} WHERE org_id = $1`, [
      orgId,
    ])
    return { state: row.rows[0].state as string, version: Number(row.rows[0].version) }
  }

  /**
   * Seeds ONE pending calculation-affecting request with NO snapshot row — the
   * `pendingMissing` cell of the eight-cell defect report that
   * `readAttendanceRequestSnapshotDefectReportV1` produces, reused AS-IS from
   * the W4 boundary.
   *
   * FIXTURE SHAPE MATCHES THE NAMED SCENARIO: `request_type` is drawn from the
   * real `ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1` union and `status`
   * is `pending`, which is exactly the bucket the classifier selects. A row
   * outside that union would leave the count at zero and the leg would pass
   * VACUOUSLY, so the type is asserted to be a real member of that union.
   *
   * WHY THIS PREDICATE AND NOT `INCOMPLETE_OPERATION`, recorded rather than left
   * as an unexplained choice: a `w4_contract_version = 1`
   * `attendance_import_jobs` row is gated by THREE landed guards — the
   * enqueue-seam GUC, `chk_aij_w4_shape`'s full identity column set, and the
   * deferred `attendance_validate_import_legacy_plan_v1` trigger, which demands
   * a matching durable execution-plan and chunk chain. Building that chain here
   * would be a large fixture whose failure modes belong to the W4C-3a plan
   * machinery, not to this boundary. `INCOMPLETE_OPERATION`'s applicability and
   * its zero-count pass ARE asserted below; what this helper adds is the
   * "counts are REAL, not booleans" proof, and one predicate proves that
   * property for the shared `passVerdict` mechanism they all use.
   */
  async function seedPendingRequestWithoutSnapshot(orgId: string): Promise<void> {
    expect(
      (ATTENDANCE_CALCULATION_AFFECTING_REQUEST_TYPES_V1 as readonly string[]).includes(
        'time_correction',
      ),
      'the fixture request type is not calculation-affecting — the leg would be vacuous',
    ).toBe(true)
    await pool.query(
      `INSERT INTO attendance_requests (id, user_id, work_date, request_type, status, org_id, metadata)
       VALUES ($1, $2, '2026-08-14', 'time_correction', 'pending', $3, '{}'::jsonb)`,
      [randomUUID(), randomUUID(), orgId],
    )
  }

  /** Puts the org's W4 segment-calculation posture into `shadow`, so the
   *  `W4_POSTURE_COHERENT` predicate can pass. Uses the W4 machine's own legal
   *  bootstrap + transition shape. */
  async function seedCoherentW4Posture(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w7-fixture', 'rollout_transition', 'fixture', 1, NULL, 'synthetic_staging')`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = state, version = version + 1
        WHERE org_id = $1`,
      [orgId],
    )
  }

  function input(
    orgId: string,
    overrides: Partial<AttendanceW7ContextSourceTransitionInputV1> = {},
  ): AttendanceW7ContextSourceTransitionInputV1 {
    return {
      orgId,
      actorId: 'operator-w73',
      correlationId: randomUUID(),
      engineVersion: 'w7-engine-1',
      targetState: 'group_shadow',
      expectedState: 'off',
      expectedVersion: 1,
      evidenceManifestSha256: MANIFEST,
      evidenceReferences: BASE_REFS,
      reasonCode: 'context_source_transition',
      ...overrides,
    } as AttendanceW7ContextSourceTransitionInputV1
  }

  async function withClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      return await run(client)
    } finally {
      client.release()
    }
  }

  async function stateRow(
    orgId: string,
  ): Promise<{ state: string; priorState: string | null; version: number } | null> {
    const result = await pool.query(
      `SELECT state, prior_state, version FROM ${STATE_TABLE} WHERE org_id = $1`,
      [orgId],
    )
    if (result.rows.length === 0) return null
    return {
      state: result.rows[0].state as string,
      priorState: result.rows[0].prior_state as string | null,
      version: Number(result.rows[0].version),
    }
  }

  async function eventCount(orgId: string): Promise<number> {
    const result = await pool.query(`SELECT count(*)::int AS n FROM ${EVENT_TABLE} WHERE org_id = $1`, [
      orgId,
    ])
    return Number(result.rows[0].n)
  }

  /** A fully prepared org: base row present, allowlisted, W4 posture coherent. */
  async function preparedOrg(): Promise<string> {
    const orgId = randomUUID()
    await seedBaseRow(orgId)
    await seedCoherentW4Posture(orgId)
    process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
    process.env[W4_ENV] = orgId
    return orgId
  }

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required')
    savedW4 = process.env[W4_ENV]
    savedW7 = process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]

    const adminUrl = new URL(dbUrl)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 12 })

    await createBase(pool)
    // Kysely owns a pool on destroy, so it gets its own; `pool` is retained for
    // the suite's own connections (including the two-connection contention legs)
    // and is closed in afterAll.
    const migrationPool = new Pool({ connectionString: scratchUrl.toString(), max: 4 })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    try {
      await w4c0Up(db)
      await postureSchemaUp(db)
      await writerMigrationUp(db)
    } finally {
      await db.destroy()
    }

    // ANCHOR CHECK on the bootstrap itself: if any of the three migrations
    // silently no-opped, every leg below would be measuring an empty or
    // half-built schema. Assert the objects this suite depends on EXIST before
    // a single assertion runs.
    const objects = await pool.query(
      `SELECT to_regclass($1)::text AS state_table,
              to_regclass($2)::text AS event_table,
              to_regclass('attendance_calculation_rollout_state')::text AS rollout_table,
              (SELECT count(*)::int FROM pg_proc WHERE proname = 'attendance_w4_deny_mutation') AS deny_fn,
              (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'trg_accss_state_guard') AS guard_trigger`,
      [STATE_TABLE, EVENT_TABLE],
    )
    expect(objects.rows[0].state_table, 'scratch bootstrap: state table missing').toBe(STATE_TABLE)
    expect(objects.rows[0].event_table, 'scratch bootstrap: event table missing').toBe(EVENT_TABLE)
    expect(objects.rows[0].rollout_table, 'scratch bootstrap: W4 rollout table missing').toBe(
      'attendance_calculation_rollout_state',
    )
    expect(Number(objects.rows[0].deny_fn), 'scratch bootstrap: deny-mutation fn missing').toBe(1)
    expect(Number(objects.rows[0].guard_trigger), 'scratch bootstrap: W7 guard trigger missing').toBe(1)
  }, 60_000)

  afterAll(async () => {
    if (savedW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = savedW4
    if (savedW7 === undefined) delete process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
    else process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = savedW7
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
  })

  beforeEach(() => {
    delete process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
    delete process.env[W4_ENV]
  })

  afterEach(() => {
    __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests(null)
    __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests(null)
    __setW7ContextSourceTransitionAfterExclusiveLockForTests(null)
    __setW7ContextSourceTransitionBeforeEventInsertForTests(null)
    __setW7ContextSourceTransitionBeforeStateUpdateForTests(null)
    __setW7ContextSourcePlanInsideTransactionForTests(null)
  })

  // -------------------------------------------------------------------------
  // T-M1 / T-M0 — the trigger's accepted pair set, proven against the DB.
  // -------------------------------------------------------------------------
  describe('T-M1 trigger backstop: the accepted pair set equals the imported TS constant', () => {
    it('all 25 ordered pairs, attempted directly against the table, with correct bookkeeping', async () => {
      let attempted = 0
      const divergences: string[] = []

      for (const from of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
        for (const to of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
          const orgId = randomUUID()
          await seedBaseRow(orgId)

          // ANCHOR CHECK: the walk must have really landed on `from`. Without
          // this every attempt below would fail on a bookkeeping clause and the
          // sweep would look discriminating while measuring pair legality not
          // at all.
          const placed = await walkTo(orgId, from)
          expect(placed.state, `ladder walk to ${from} did not land`).toBe(from)

          attempted += 1
          let accepted = false
          let failureMessage = ''
          try {
            // `prior_state` and `version` are set CORRECTLY, so the ONLY
            // variable under test is pair legality.
            await pool.query(
              `UPDATE ${STATE_TABLE}
                  SET state = $2, prior_state = state, version = version + 1
                WHERE org_id = $1`,
              [orgId, to],
            )
            accepted = true
          } catch (error) {
            failureMessage = messageOf(error)
          }

          const legal = isAttendanceW7ContextSourcePostureLegalTransitionV1(from, to)
          if (accepted !== legal) {
            divergences.push(
              `${from}->${to}: trigger ${accepted ? 'ACCEPTED' : 'REJECTED'}, TS constant says ${
                legal ? 'legal' : 'illegal'
              }`,
            )
          }
          if (!accepted) {
            // Assert WHICH exception came back per cell: a rejection for the
            // wrong reason (a bookkeeping clause, a CHECK constraint) would
            // otherwise be indistinguishable from the pair-legality refusal.
            expect(failureMessage, `${from}->${to}`).toContain(
              'illegal context-source state transition',
            )
          }
        }
      }

      expect(divergences, 'trigger and TS constant disagree').toEqual([])
      expect(attempted, 'the 25-pair sweep did not really execute 25 statements').toBe(25)
    })

    it('NON-VACUITY: the sweep really places rows in all five states', async () => {
      const reached = new Set<string>()
      for (const state of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
        const orgId = randomUUID()
        await seedBaseRow(orgId)
        reached.add((await walkTo(orgId, state)).state)
      }
      expect([...reached].sort()).toEqual([...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1].sort())
    })
  })

  // -------------------------------------------------------------------------
  // T-M2 / T-M3 / T-M4 — the trigger's other clauses, each dropped independently.
  // -------------------------------------------------------------------------
  describe('T-M2 trigger INSERT branch', () => {
    it('accepts ONLY the two bootstrap shapes; every other initial state is refused', async () => {
      // Positive control 1: (off, prior NULL, version 1).
      const okA = randomUUID()
      await expect(seedBaseRow(okA)).resolves.toBeUndefined()

      // Positive control 2: (group_shadow, prior 'off', version 1).
      const okB = randomUUID()
      createdOrgs.push(okB)
      await pool.query(
        `INSERT INTO ${STATE_TABLE}
           (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
         VALUES ($1, 'group_shadow', 'synthetic_staging', 1, 'off', 'e', 'r', 'a')`,
        [okB],
      )
      expect((await stateRow(okB))?.state).toBe('group_shadow')

      // Every other (state, prior_state) initial shape is refused.
      for (const state of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
        for (const prior of [null, ...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1]) {
          const isBootstrap =
            (state === 'off' && prior === null) || (state === 'group_shadow' && prior === 'off')
          if (isBootstrap) continue
          const orgId = randomUUID()
          let message = '<accepted>'
          try {
            await pool.query(
              `INSERT INTO ${STATE_TABLE}
                 (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
               VALUES ($1, $2, 'synthetic_staging', 1, $3, 'e', 'r', 'a')`,
              [orgId, state, prior],
            )
            createdOrgs.push(orgId)
          } catch (error) {
            message = messageOf(error)
          }
          expect(message, `INSERT(${state}, prior=${String(prior)})`).toContain(
            'illegal initial context-source state',
          )
        }
      }
    })

    it('refuses an initial version other than 1 — its OWN clause, its OWN message', async () => {
      // A BEFORE trigger runs before CHECK constraints are evaluated, so the
      // trigger's clause is what every caller actually meets — including for
      // `version = 0`. Asserted as observed rather than as assumed; the CHECK
      // is proven to be a genuinely SEPARATE door in the next leg.
      for (const version of [0, 2, 99]) {
        const orgId = randomUUID()
        let message = '<accepted>'
        try {
          await pool.query(
            `INSERT INTO ${STATE_TABLE}
               (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
             VALUES ($1, 'off', 'synthetic_staging', $2, NULL, 'e', 'r', 'a')`,
            [orgId, version],
          )
          createdOrgs.push(orgId)
        } catch (error) {
          message = messageOf(error)
        }
        expect(message, `version=${version}`).toContain('initial context-source version must be 1')
      }
    })

    it('chk_accss_version is a SEPARATE door: with the trigger disabled it still refuses version < 1', async () => {
      // Two fail-closed doors must be proven EXCLUSIVELY, by neutering each in
      // turn — otherwise they cover for each other and one could be deleted
      // with every test still green.
      const orgId = randomUUID()
      await pool.query(`ALTER TABLE ${STATE_TABLE} DISABLE TRIGGER trg_accss_state_guard`)
      try {
        await expect(
          pool.query(
            `INSERT INTO ${STATE_TABLE}
               (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
             VALUES ($1, 'off', 'synthetic_staging', 0, NULL, 'e', 'r', 'a')`,
            [orgId],
          ),
        ).rejects.toThrow(/chk_accss_version/)

        // POSITIVE CONTROL: with the trigger disabled, a version >= 1 row IS
        // accepted — so the refusal above is the CHECK and not the disable
        // having failed.
        createdOrgs.push(orgId)
        await pool.query(
          `INSERT INTO ${STATE_TABLE}
             (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
           VALUES ($1, 'group_authoritative', 'synthetic_staging', 9, 'suspended', 'e', 'r', 'a')`,
          [orgId],
        )
        expect((await stateRow(orgId))?.version).toBe(9)
      } finally {
        await pool.query(`ALTER TABLE ${STATE_TABLE} ENABLE TRIGGER trg_accss_state_guard`)
      }

      // ...and with the trigger back on, that same bypass shape is refused —
      // proving the ENABLE really took effect.
      await expect(
        pool.query(
          `INSERT INTO ${STATE_TABLE}
             (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
           VALUES ($1, 'group_authoritative', 'synthetic_staging', 9, 'suspended', 'e', 'r', 'a')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/illegal initial context-source state/)
    })
  })

  describe('T-M3 / T-M4 trigger UPDATE bookkeeping and immutability', () => {
    it('prior_state must record the previous state — dropped independently of the pair clause', async () => {
      const orgId = randomUUID()
      await seedBaseRow(orgId)
      // A LEGAL pair with a WRONG prior_state must still be refused, and with
      // the prior_state message, not the pair message.
      await expect(
        pool.query(
          `UPDATE ${STATE_TABLE} SET state='group_shadow', prior_state='group_eligible', version=version+1
            WHERE org_id=$1`,
          [orgId],
        ),
      ).rejects.toThrow(/prior_state must record the previous state/)
      // POSITIVE CONTROL: the same legal pair with the right prior_state passes.
      await pool.query(
        `UPDATE ${STATE_TABLE} SET state='group_shadow', prior_state=state, version=version+1 WHERE org_id=$1`,
        [orgId],
      )
      expect(await stateRow(orgId)).toEqual({ state: 'group_shadow', priorState: 'off', version: 2 })
    })

    it('version must increment by exactly one — its own clause', async () => {
      const orgId = randomUUID()
      await seedBaseRow(orgId)
      // The BEFORE trigger runs ahead of the CHECK, so all three meet the
      // trigger's own clause. (The CHECK's independence is proven separately,
      // by disabling the trigger, in the T-M2 block above.)
      for (const version of [1, 3, 0]) {
        await expect(
          pool.query(
            `UPDATE ${STATE_TABLE} SET state='group_shadow', prior_state=state, version=$2 WHERE org_id=$1`,
            [orgId, version],
          ),
          `version=${version}`,
        ).rejects.toThrow(/optimistic version must increment/)
      }
      // POSITIVE CONTROL.
      await pool.query(
        `UPDATE ${STATE_TABLE} SET state='group_shadow', prior_state=state, version=version+1 WHERE org_id=$1`,
        [orgId],
      )
      expect((await stateRow(orgId))?.version).toBe(2)
    })

    it('org_id and scope are immutable — each dropped independently', async () => {
      const orgId = randomUUID()
      await seedBaseRow(orgId)
      await expect(
        pool.query(
          `UPDATE ${STATE_TABLE} SET org_id=$2, state='group_shadow', prior_state=state, version=version+1
            WHERE org_id=$1`,
          [orgId, randomUUID()],
        ),
      ).rejects.toThrow(/identity fields are immutable/)
      await expect(
        pool.query(
          `UPDATE ${STATE_TABLE} SET scope='other', state='group_shadow', prior_state=state, version=version+1
            WHERE org_id=$1`,
          [orgId],
        ),
      ).rejects.toThrow(/chk_accss_scope|identity fields are immutable/)
      // POSITIVE CONTROL: leaving both alone succeeds.
      await pool.query(
        `UPDATE ${STATE_TABLE} SET state='group_shadow', prior_state=state, version=version+1 WHERE org_id=$1`,
        [orgId],
      )
      expect((await stateRow(orgId))?.state).toBe('group_shadow')
    })
  })

  // -------------------------------------------------------------------------
  // T-B3 — migration replay + CHECK definitions against the IMPORTED constant.
  // -------------------------------------------------------------------------
  describe('T-B3 migration: replay without drift, CHECKs equal the imported constant AND reject', () => {
    it('every state CHECK renders exactly the imported state union', async () => {
      for (const constraint of ['chk_accss_prior_state', 'chk_accse_prior_state', 'chk_accse_new_state']) {
        const result = await pool.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
          [constraint],
        )
        expect(result.rows.length, `${constraint} is missing`).toBe(1)
        const def = result.rows[0].def as string
        for (const state of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
          expect(def, `${constraint} omits ${state}`).toContain(`'${state}'`)
        }
        // ...and nothing beyond the union: count the quoted literals.
        const literals = (def.match(/'[a-z_]+'::text/g) ?? []).length
        expect(literals, `${constraint} carries extra literals: ${def}`).toBe(
          ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1.length,
        )
      }
    })

    it('the CHECKs REJECT an out-of-union value (a definition is not behaviour)', async () => {
      await expect(
        pool.query(
          `INSERT INTO ${EVENT_TABLE} (org_id, prior_state, new_state, reason_code, engine_version, actor_id)
           VALUES ($1, 'off', 'not_a_state', 'r', 'e', 'a')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/chk_accse_new_state/)
      await expect(
        pool.query(
          `INSERT INTO ${EVENT_TABLE} (org_id, prior_state, new_state, reason_code, engine_version, actor_id)
           VALUES ($1, 'not_a_state', 'off', 'r', 'e', 'a')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/chk_accse_prior_state/)
    })

    it('the event table is APPEND-ONLY: UPDATE and DELETE are both refused', async () => {
      const orgId = randomUUID()
      await pool.query(
        `INSERT INTO ${EVENT_TABLE} (org_id, prior_state, new_state, reason_code, engine_version, actor_id)
         VALUES ($1, 'off', 'group_shadow', 'r', 'e', 'a')`,
        [orgId],
      )
      await expect(
        pool.query(`UPDATE ${EVENT_TABLE} SET actor_id='x' WHERE org_id=$1`, [orgId]),
      ).rejects.toThrow(/UPDATE is not permitted/)
      await expect(
        pool.query(`DELETE FROM ${EVENT_TABLE} WHERE org_id=$1`, [orgId]),
      ).rejects.toThrow(/DELETE is not permitted/)
    })

    it('down() then up() replays without drift', async () => {
      // Safe HERE and only here: this suite owns its database outright, so a
      // schema replay cannot reach any sibling suite. On the shared database
      // this exact leg broke the W7-1a suite (and was broken by it) in both
      // directions — see the file header.
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
      const before = await pool.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = $1 ORDER BY column_name`,
        [STATE_TABLE],
      )
      await writerMigrationDown(db)
      const stripped = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [STATE_TABLE],
      )
      // POSITIVE CONTROL on the replay: down() really removed the columns, so
      // the up()-equality below is not a no-op comparison.
      expect(stripped.rows.map((r) => r.column_name).sort()).toEqual(['org_id', 'scope', 'state'])
      await writerMigrationUp(db)
      await writerMigrationUp(db) // idempotent second up
      const after = await pool.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = $1 ORDER BY column_name`,
        [STATE_TABLE],
      )
      expect(after.rows).toEqual(before.rows)
    })
  })

  // -------------------------------------------------------------------------
  // The writer.
  // -------------------------------------------------------------------------
  describe('W7-3 writer: refusals leave ZERO rows behind', () => {
    it('T-W5 a non-allowlisted org is refused, with zero DML', async () => {
      const orgId = randomUUID()
      await seedBaseRow(orgId)
      await seedCoherentW4Posture(orgId)
      // Deliberately allowlisting a DIFFERENT org: "unset" and "set to someone
      // else" are different failure modes and only the latter proves exactness.
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = randomUUID()
      process.env[W4_ENV] = orgId
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })

      const before = await stateRow(orgId)
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_ORG_NOT_ALLOWLISTED' })
      })
      expect(await stateRow(orgId)).toEqual(before)
      expect(await eventCount(orgId)).toBe(0)

      // POSITIVE CONTROL: the SAME org, allowlisted exactly, transitions.
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      expect(await stateRow(orgId)).toEqual({ state: 'group_shadow', priorState: 'off', version: 2 })
      expect(await eventCount(orgId)).toBe(1)
    })

    it('T-W3 a stale expectedState or expectedVersion refuses with zero DML — each conjunct alone', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      const before = await stateRow(orgId)

      // Conjunct 1: wrong expectedState (version correct).
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgId, { expectedState: 'group_shadow', targetState: 'group_eligible' }),
          ),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_STALE_EXPECTED_STATE' })
      })
      expect(await stateRow(orgId)).toEqual(before)
      expect(await eventCount(orgId)).toBe(0)

      // Conjunct 2: right expectedState, wrong expectedVersion.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId, { expectedVersion: 7 })),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_STALE_EXPECTED_STATE' })
      })
      expect(await stateRow(orgId)).toEqual(before)
      expect(await eventCount(orgId)).toBe(0)

      // POSITIVE CONTROL: both correct.
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      expect((await stateRow(orgId))?.state).toBe('group_shadow')
    })

    it('T-W4 bootstrap is permitted ONLY for allowlisted `off -> group_shadow` — each conjunct alone', async () => {
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({
        group_shadow: true,
        group_eligible: true,
      })

      // Conjunct 1: allowlisted, but not the first rung -> STATE_MISSING.
      const orgA = randomUUID()
      createdOrgs.push(orgA)
      await seedCoherentW4Posture(orgA)
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgA
      process.env[W4_ENV] = orgA
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgA, { expectedState: 'group_shadow', targetState: 'group_eligible' }),
          ),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_STATE_MISSING' })
      })
      expect(await stateRow(orgA)).toBe(null)

      // Conjunct 2: the first rung, but NOT allowlisted -> refused earlier.
      const orgB = randomUUID()
      createdOrgs.push(orgB)
      await seedCoherentW4Posture(orgB)
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = randomUUID()
      process.env[W4_ENV] = orgB
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgB)),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_ORG_NOT_ALLOWLISTED' })
      })
      expect(await stateRow(orgB)).toBe(null)

      // POSITIVE CONTROL: both conjuncts satisfied -> the row is bootstrapped
      // AND advanced in one call, with the event recorded.
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgB
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgB))
      })
      expect(await stateRow(orgB)).toEqual({ state: 'group_shadow', priorState: 'off', version: 2 })
      expect(await eventCount(orgB)).toBe(1)
    })
  })

  describe('W7-3 declared-undelivered: the ladder cannot be walked forward at this head', () => {
    it('promotion into every group state is refused by the SHIPPED declaration', async () => {
      const orgId = await preparedOrg()
      // No delivery override: the shipped values are what is under test.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toMatchObject({
          code: 'W7_CONTEXT_SOURCE_TRANSITION_STATE_PRODUCER_NOT_DELIVERED',
        })
      })
      expect(await stateRow(orgId)).toEqual({ state: 'off', priorState: null, version: 1 })
      expect(await eventCount(orgId)).toBe(0)
    })

    it('the compare-window pair is ALSO refused for its own reason once the producer is delivered', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({
        group_shadow: true,
        group_eligible: true,
      })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      // With the producer declared delivered, the remaining blocker on
      // `group_shadow -> group_eligible` is the W7-2 compare evidence — a
      // DIFFERENT code, which is what makes the two declarations independent
      // gates rather than one covering for the other.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgId, {
              expectedState: 'group_shadow',
              targetState: 'group_eligible',
              expectedVersion: 2,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'W7_CONTEXT_SOURCE_TRANSITION_COMPARE_EVIDENCE_NOT_DELIVERED',
        })
      })
      expect((await stateRow(orgId))?.state).toBe('group_shadow')

      // POSITIVE CONTROL: with BOTH declarations overridden, the same call
      // succeeds — so the refusal above was the compare evidence and not some
      // unrelated precondition.
      __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests({
        W7_CRITICAL_SHADOW_DIFF: true,
        W7_OFF_ROSTER_DIFF: true,
      })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(
          asTrx(client),
          input(orgId, {
            expectedState: 'group_shadow',
            targetState: 'group_eligible',
            expectedVersion: 2,
          }),
        )
      })
      expect(await stateRow(orgId)).toEqual({
        state: 'group_eligible',
        priorState: 'group_shadow',
        version: 3,
      })
    })

    it('the two EXITS are NOT gated by the declaration — a stuck org can always leave', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      // Producer declaration back to SHIPPED (undelivered) — the rollback must
      // still work, which is the whole point of not gating the exits.
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests(null)
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(
          asTrx(client),
          input(orgId, { expectedState: 'group_shadow', targetState: 'off', expectedVersion: 2 }),
        )
      })
      expect(await stateRow(orgId)).toEqual({ state: 'off', priorState: 'group_shadow', version: 3 })
    })
  })

  describe('W4_POSTURE_COHERENT (C-1 option (a)): entry into a group state needs a coherent W4 posture', () => {
    it('refuses when the W4 posture is not authoring segments, and passes when it is', async () => {
      const orgId = randomUUID()
      await seedBaseRow(orgId)
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })

      // No W4 rollout row at all -> the W4 posture resolves `legacy`.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_W4_POSTURE_INCOHERENT' })
      })
      expect(await eventCount(orgId)).toBe(0)

      // A W4 row in `shadow` but the W4 env UNSET -> still `legacy` (the W4
      // two-part read). This is a SECOND, independent conjunct of the same
      // predicate and is asserted separately.
      await seedCoherentW4Posture(orgId)
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_W4_POSTURE_INCOHERENT' })
      })

      // POSITIVE CONTROL: row + W4 allowlist -> coherent -> the transition runs.
      process.env[W4_ENV] = orgId
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      expect((await stateRow(orgId))?.state).toBe('group_shadow')
    })

    it('the coherence gate does NOT apply to the exits', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      // Take the W4 posture away entirely, then roll back: it must succeed.
      delete process.env[W4_ENV]
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(
          asTrx(client),
          input(orgId, { expectedState: 'group_shadow', targetState: 'off', expectedVersion: 2 }),
        )
      })
      expect((await stateRow(orgId))?.state).toBe('off')
    })
  })

  describe('T-W9 / T-W10 DML ordering, atomicity, and the evidence blob', () => {
    it('the event INSERT precedes the state UPDATE; a throw between them leaves NEITHER', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })

      __setW7ContextSourceTransitionBeforeStateUpdateForTests(async () => {
        // The event row must already be visible INSIDE the transaction at this
        // point — that is the ordering claim, asserted rather than assumed.
        throw new Error('W7_TEST_ABORT_AFTER_EVENT_INSERT')
      })
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toThrow(/W7_TEST_ABORT_AFTER_EVENT_INSERT/)
      })
      expect(await eventCount(orgId), 'the event survived a rolled-back transition').toBe(0)
      expect(await stateRow(orgId)).toEqual({ state: 'off', priorState: null, version: 1 })

      // ...and a throw BEFORE the event insert leaves state/version untouched too.
      __setW7ContextSourceTransitionBeforeStateUpdateForTests(null)
      __setW7ContextSourceTransitionBeforeEventInsertForTests(async () => {
        throw new Error('W7_TEST_ABORT_BEFORE_EVENT_INSERT')
      })
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toThrow(/W7_TEST_ABORT_BEFORE_EVENT_INSERT/)
      })
      expect(await eventCount(orgId)).toBe(0)
      expect(await stateRow(orgId)).toEqual({ state: 'off', priorState: null, version: 1 })

      // POSITIVE CONTROL: with no seam, both rows land.
      __setW7ContextSourceTransitionBeforeEventInsertForTests(null)
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      expect(await eventCount(orgId)).toBe(1)
      expect((await stateRow(orgId))?.state).toBe('group_shadow')
    })

    it('T-W10 the evidence blob has EXACTLY the declared keys, including every precondition counter', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      const correlationId = randomUUID()
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId, { correlationId }))
      })
      const result = await pool.query(
        `SELECT prior_state, new_state, reason_code, engine_version, actor_id, evidence
           FROM ${EVENT_TABLE} WHERE org_id = $1`,
        [orgId],
      )
      expect(result.rows.length).toBe(1)
      const row = result.rows[0]
      expect(row.prior_state).toBe('off')
      expect(row.new_state).toBe('group_shadow')
      expect(row.reason_code).toBe('context_source_transition')
      expect(row.engine_version).toBe('w7-engine-1')
      expect(row.actor_id).toBe('operator-w73')

      const evidence = row.evidence as Record<string, unknown>
      expect(Object.keys(evidence).sort()).toEqual([
        'correlationId',
        'ladderRole',
        'manifestSha256',
        'preconditionCounts',
        'references',
        'schemaVersion',
        'targetState',
      ])
      expect(evidence.schemaVersion).toBe(1)
      expect(evidence.manifestSha256).toBe(MANIFEST)
      expect(evidence.correlationId).toBe(correlationId)
      expect(evidence.targetState).toBe('group_shadow')
      expect(evidence.ladderRole).toBe('advance')
      expect(evidence.references).toEqual(BASE_REFS)

      const counts = evidence.preconditionCounts as Record<string, unknown>
      expect(Object.keys(counts).sort()).toEqual([
        'defectiveRequestSnapshots',
        'defectiveRequestSnapshotsByCell',
        'incompleteOperations',
        'suspendSourceWritersInFlight',
        'undeliveredCompareEvidence',
        'undeliveredStateProducers',
        'unresolvedReviews',
      ])
      // The declaration counts really reached the blob, not zeroes.
      expect(counts.undeliveredCompareEvidence).toBe(2)
      expect(counts.undeliveredStateProducers).toBe(0)
    })

    it('the RESUME pair records the widened reference set verbatim', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests(
        Object.fromEntries(
          ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1.map((s) => [s, true]),
        ) as never,
      )
      __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests({
        W7_CRITICAL_SHADOW_DIFF: true,
        W7_OFF_ROSTER_DIFF: true,
      })

      const ladder: Array<[AttendanceW7ContextSourcePostureStateV1, AttendanceW7ContextSourcePostureStateV1]> =
        [
          ['off', 'group_shadow'],
          ['group_shadow', 'group_eligible'],
          ['group_eligible', 'group_authoritative'],
          ['group_authoritative', 'suspended'],
        ]
      let version = 1
      for (const [expectedState, targetState] of ladder) {
        await withClient(async (client) => {
          await transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgId, {
              expectedState,
              targetState,
              expectedVersion: version,
              evidenceReferences: BASE_REFS,
            }),
          )
        })
        version += 1
      }
      expect(await stateRow(orgId)).toEqual({
        state: 'suspended',
        priorState: 'group_authoritative',
        version: 5,
      })

      // Resume with the BASE set refuses...
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgId, {
              expectedState: 'suspended',
              targetState: 'group_authoritative',
              expectedVersion: 5,
              evidenceReferences: BASE_REFS,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID',
        })
      })
      // ...and with the widened set succeeds, storing all five keys verbatim.
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(
          asTrx(client),
          input(orgId, {
            expectedState: 'suspended',
            targetState: 'group_authoritative',
            expectedVersion: 5,
            evidenceReferences: RESUME_REFS,
          }),
        )
      })
      const result = await pool.query(
        `SELECT evidence FROM ${EVENT_TABLE} WHERE org_id = $1 AND new_state = 'group_authoritative'
          ORDER BY created_at DESC LIMIT 1`,
        [orgId],
      )
      const evidence = result.rows[0].evidence as Record<string, unknown>
      expect(evidence.references).toEqual(RESUME_REFS)
      expect(evidence.ladderRole).toBe('resume')
    })
  })

  describe('T-W12 / T-W13 / T-W14 lock discipline', () => {
    it('T-W13 the writer refuses a connection that is already inside a transaction', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await expect(
            transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
          ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        } finally {
          await client.query('ROLLBACK')
        }
      })
      expect(await eventCount(orgId)).toBe(0)
    })

    it('T-W12 the session lock is held during the transition and RELEASED on both outcomes', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      const key = buildAttendanceW7ContextSourceAdvisoryKeyV1(orgId)

      async function heldByAnySession(): Promise<number> {
        const result = await pool.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND objid IS NOT NULL
              AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
          [key.toString()],
        )
        return Number(result.rows[0].n)
      }

      let observedWhileHeld = -1
      __setW7ContextSourceTransitionAfterExclusiveLockForTests(async () => {
        observedWhileHeld = await heldByAnySession()
      })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      expect(observedWhileHeld, 'the advisory lock was not held inside the boundary').toBe(1)
      expect(await heldByAnySession(), 'the advisory lock leaked after SUCCESS').toBe(0)

      // ...and after a THROWING path (a refusal), the lock is still released.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toMatchObject({ code: 'W7_CONTEXT_SOURCE_TRANSITION_STALE_EXPECTED_STATE' })
      })
      expect(await heldByAnySession(), 'the advisory lock leaked after a REFUSAL').toBe(0)

      // ...and after a THROWING TEST SEAM, which throws before the transaction
      // even opens: the `finally` must still run.
      __setW7ContextSourceTransitionAfterExclusiveLockForTests(async () => {
        throw new Error('W7_TEST_ABORT_AFTER_LOCK')
      })
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)),
        ).rejects.toThrow(/W7_TEST_ABORT_AFTER_LOCK/)
      })
      expect(await heldByAnySession(), 'the advisory lock leaked after a throwing seam').toBe(0)
    })

    it('T-W14 two concurrent transitions on ONE org serialize; the loser sees the VERSION conflict', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })

      // Both callers assert the SAME (state, version), so exactly one can win.
      // The loser must fail on the version conflict — NOT on a lock timeout,
      // which would prove only that `lock_timeout` fires, not that the writer
      // serializes. A barrier holds the first caller inside the boundary until
      // the second has definitely started waiting.
      let releaseFirst: (() => void) | null = null
      const firstIsInside = new Promise<void>((resolve) => {
        __setW7ContextSourceTransitionAfterExclusiveLockForTests(async () => {
          // Only the FIRST caller through gets the barrier; the second is
          // already blocked on the advisory lock and never reaches here until
          // the first has finished.
          __setW7ContextSourceTransitionAfterExclusiveLockForTests(null)
          resolve()
          await new Promise<void>((release) => {
            releaseFirst = release
          })
        })
      })

      const clientA = await pool.connect()
      const clientB = await pool.connect()
      try {
        const runA = transitionAttendanceW7ContextSourceV1(asTrx(clientA), input(orgId))
        await firstIsInside
        const runB = transitionAttendanceW7ContextSourceV1(asTrx(clientB), input(orgId))
        // Give B a real chance to reach the advisory-lock wait before A commits.
        await new Promise((resolve) => setTimeout(resolve, 250))
        ;(releaseFirst as unknown as () => void)()

        await expect(runA).resolves.toMatchObject({ state: 'group_shadow', version: 2 })
        await expect(runB).rejects.toMatchObject({
          code: 'W7_CONTEXT_SOURCE_TRANSITION_STALE_EXPECTED_STATE',
        })
      } finally {
        clientA.release()
        clientB.release()
      }

      // Exactly one transition happened: one event, one version bump.
      expect(await eventCount(orgId)).toBe(1)
      expect(await stateRow(orgId)).toEqual({ state: 'group_shadow', priorState: 'off', version: 2 })
    })
  })

  // -------------------------------------------------------------------------
  // The plan reporter.
  // -------------------------------------------------------------------------
  describe('T-P1 / T-P4 / T-P6 / T-P7 the read-only plan reporter', () => {
    it('T-P1 plan NEVER commits: a write made INSIDE its transaction does not survive', async () => {
      // WHY THIS SHAPE AND NOT THE OBVIOUS ONE, recorded because the obvious one
      // was written first and was found to be worthless by mutation: asserting
      // "the row is byte-identical (row hash + xmin) after a plan call" passes
      // whether the `finally` issues ROLLBACK or COMMIT, because a transaction
      // that performed no DML commits nothing observable. Replacing ROLLBACK
      // with COMMIT left the entire suite green. The leg below makes the plan's
      // transaction dirty ON PURPOSE through the module's test seam, so the
      // outcome differs between the two.
      const orgId = await preparedOrg()
      const probeOrg = randomUUID()
      createdOrgs.push(probeOrg)

      __setW7ContextSourcePlanInsideTransactionForTests(async (trx) => {
        await trx.query(
          `INSERT INTO ${STATE_TABLE}
             (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
           VALUES ($1, 'off', 'synthetic_staging', 1, NULL, 'probe', 'context_source_transition', 'probe')`,
          [probeOrg],
        )
      })
      try {
        await withClient(async (client) => {
          const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
            orgId,
            targetState: 'group_shadow',
          })
          expect(plan.currentState).toBe('off')
        })
      } finally {
        __setW7ContextSourcePlanInsideTransactionForTests(null)
      }

      // The seam's write must NOT have survived the plan call.
      expect(await stateRow(probeOrg), 'the plan reporter COMMITTED its transaction').toBe(null)

      // POSITIVE CONTROL: the identical statement outside the plan (autocommit)
      // DOES persist — so the assertion above can see a write, and is not
      // passing because the INSERT never ran or the org key was wrong.
      await pool.query(
        `INSERT INTO ${STATE_TABLE}
           (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
         VALUES ($1, 'off', 'synthetic_staging', 1, NULL, 'probe', 'context_source_transition', 'probe')`,
        [probeOrg],
      )
      expect(await stateRow(probeOrg)).toEqual({ state: 'off', priorState: null, version: 1 })
      await pool.query(`DELETE FROM ${STATE_TABLE} WHERE org_id = $1`, [probeOrg])
    })

    it('T-P1b plan performs zero DML of its own: xmin and the event count are unmoved', async () => {
      const orgId = await preparedOrg()
      const before = await pool.query(
        `SELECT xmin::text AS xmin, state, version FROM ${STATE_TABLE} WHERE org_id = $1`,
        [orgId],
      )
      const eventsBefore = await eventCount(orgId)

      await withClient(async (client) => {
        const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
          orgId,
          targetState: 'group_shadow',
        })
        expect(plan.currentState).toBe('off')
        expect(plan.rowExists).toBe(true)
      })

      const after = await pool.query(
        `SELECT xmin::text AS xmin, state, version FROM ${STATE_TABLE} WHERE org_id = $1`,
        [orgId],
      )
      expect(after.rows).toEqual(before.rows)
      expect(await eventCount(orgId)).toBe(eventsBefore)

      // POSITIVE CONTROL on the xmin probe: a real write DOES move xmin, so the
      // equality above is not comparing two constants.
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      const moved = await pool.query(`SELECT xmin::text AS xmin FROM ${STATE_TABLE} WHERE org_id = $1`, [
        orgId,
      ])
      expect(moved.rows[0].xmin).not.toBe(before.rows[0].xmin)
    })

    it('plan never bootstraps a row, even for a bootstrap-legal org', async () => {
      const orgId = randomUUID()
      createdOrgs.push(orgId)
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
      await withClient(async (client) => {
        const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
          orgId,
          targetState: 'group_shadow',
        })
        expect(plan.rowExists).toBe(false)
        expect(plan.canBootstrap).toBe(true)
        expect(plan.currentState).toBe('off')
      })
      expect(await stateRow(orgId), 'the plan reporter bootstrapped a row').toBe(null)
    })

    it('T-P2 every predicate code appears EXACTLY once, applicable or not', async () => {
      const orgId = await preparedOrg()
      await withClient(async (client) => {
        for (const targetState of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
          const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
            orgId,
            targetState,
          })
          const codes = plan.predicates.map((p) => p.code)
          expect(new Set(codes).size, targetState).toBe(codes.length)
          expect([...codes].sort(), targetState).toEqual(
            [...ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1].sort(),
          )
        }
      })
    })

    it('T-P4 / T-P6 a seeded defect makes the count EXACTLY N, breaks down byCell, and blocks', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({
        group_shadow: true,
        group_eligible: true,
      })
      __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests({
        W7_CRITICAL_SHADOW_DIFF: true,
        W7_OFF_ROSTER_DIFF: true,
      })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })

      // POSITIVE CONTROL first: with nothing seeded, BOTH quiescence predicates
      // pass with count 0 and the plan is not blocked on either.
      await withClient(async (client) => {
        const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
          orgId,
          targetState: 'group_eligible',
        })
        expect(plan.predicates.find((p) => p.code === 'INCOMPLETE_OPERATION')).toMatchObject({
          applicable: true,
          pass: true,
          count: 0,
        })
        expect(plan.predicates.find((p) => p.code === 'DEFECTIVE_REQUEST_SNAPSHOT')).toMatchObject({
          applicable: true,
          pass: true,
          count: 0,
        })
        expect(plan.blocked).toBe(false)
      })

      // Seed THREE defective requests: the count must track EXACTLY, not merely
      // be non-zero. An implementation returning a boolean, or `1` for "some",
      // reds here. Asserted after EACH seed, so an off-by-one cannot hide.
      for (let seeded = 1; seeded <= 3; seeded += 1) {
        await seedPendingRequestWithoutSnapshot(orgId)
        await withClient(async (client) => {
          const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
            orgId,
            targetState: 'group_eligible',
          })
          expect(
            plan.predicates.find((p) => p.code === 'DEFECTIVE_REQUEST_SNAPSHOT'),
            `after seeding ${seeded}`,
          ).toMatchObject({ applicable: true, pass: false, count: seeded })
          expect(plan.blocked).toBe(true)
        })
      }

      // ...and the BOUNDARY refuses with that predicate's OWN code.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgId, {
              expectedState: 'group_shadow',
              targetState: 'group_eligible',
              expectedVersion: 2,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'W7_CONTEXT_SOURCE_TRANSITION_REQUEST_SNAPSHOT_DEFECTIVE',
        })
      })
      expect((await stateRow(orgId))?.state).toBe('group_shadow')

      // The 8-cell report is reused AS-IS and really lands in the right cell —
      // so the count above is the defect classifier's, not a local re-derivation.
      await withClient(async (client) => {
        const report = await readAttendanceRequestSnapshotDefectReportV1(asTrx(client), orgId)
        expect(report.totalDefectiveRequests).toBe(3)
        expect(report.byCell.pendingMissing).toBe(3)
        expect(report.byCell.reversibleMissing).toBe(0)
        expect(Object.keys(report.byCell).sort()).toEqual(
          [...ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1].sort(),
        )
      })
    })

    it('T-P7 predicates are evaluated INSIDE the transition transaction, not reused from a preflight', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({
        group_shadow: true,
        group_eligible: true,
      })
      __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests({
        W7_CRITICAL_SHADOW_DIFF: true,
        W7_OFF_ROSTER_DIFF: true,
      })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })

      // A CLEAN preflight...
      await withClient(async (client) => {
        const plan = await planAttendanceW7ContextSourceTransitionV1(asTrx(client), {
          orgId,
          targetState: 'group_eligible',
        })
        expect(plan.blocked).toBe(false)
      })
      // ...then the world changes...
      await seedPendingRequestWithoutSnapshot(orgId)
      // ...and the boundary must NOT honour the stale clean preflight.
      await withClient(async (client) => {
        await expect(
          transitionAttendanceW7ContextSourceV1(
            asTrx(client),
            input(orgId, {
              expectedState: 'group_shadow',
              targetState: 'group_eligible',
              expectedVersion: 2,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'W7_CONTEXT_SOURCE_TRANSITION_REQUEST_SNAPSHOT_DEFECTIVE',
        })
      })
    })
  })

  // -------------------------------------------------------------------------
  // LOCK-ORDER CENSUS — the counterexample, constructed rather than argued.
  // See docs/development/attendance-4556-w7-3-lock-order-census-20260815.md.
  // -------------------------------------------------------------------------
  describe('lock-order census: the (W7 -> W4) edge closes no cycle', () => {
    it('the W7 key and the W4 rollout key are DIFFERENT keys for the same org', async () => {
      // If they were the same key, the writer would be taking one lock twice
      // and the "two families" question would be meaningless — so this is the
      // anchor check for everything below.
      const orgId = randomUUID()
      expect(buildAttendanceW7ContextSourceAdvisoryKeyV1(orgId)).not.toBe(
        buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId)),
      )
    })

    it('a W4-rollout holder BLOCKS the writer and the writer proceeds once it releases', async () => {
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      const w4Key = buildAttendanceCalculationRolloutAdvisoryKey(
        parseCanonicalAttendanceRolloutOrgKeyV1(orgId),
      )

      const holder = await pool.connect()
      let settled = false
      try {
        // A W4 transition boundary holds this key EXCLUSIVELY at session level
        // for its whole transaction; that is reproduced here directly.
        await holder.query('SELECT pg_advisory_lock($1::bigint)', [w4Key.toString()])

        const client = await pool.connect()
        try {
          const run = transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId)).then(
            (result) => {
              settled = true
              return result
            },
          )
          // The writer must still be waiting: it reached the W4 shared
          // acquisition and blocked. A NON-blocking implementation would have
          // finished by now, which is what makes this leg discriminating.
          await new Promise((resolve) => setTimeout(resolve, 400))
          expect(settled, 'the writer did NOT serialize against the W4 rollout holder').toBe(false)

          await holder.query('SELECT pg_advisory_unlock($1::bigint)', [w4Key.toString()])
          await expect(run).resolves.toMatchObject({ state: 'group_shadow', version: 2 })
        } finally {
          client.release()
        }
      } finally {
        holder.release()
      }
      expect(await eventCount(orgId)).toBe(1)
    })

    it('the REVERSE order deadlocks DETERMINISTICALLY (40P01), so a future reverse site fails loudly', async () => {
      // The standing proof the census rests on. A site that took the W4 key and
      // then the W7 key would form a cycle with this writer's order. It is
      // constructed by hand here — no such site exists in the tree — and
      // PostgreSQL's own detector must catch it, rather than the pair failing
      // rarely and silently under load.
      const orgId = randomUUID()
      const w7Key = buildAttendanceW7ContextSourceAdvisoryKeyV1(orgId)
      const w4Key = buildAttendanceCalculationRolloutAdvisoryKey(
        parseCanonicalAttendanceRolloutOrgKeyV1(orgId),
      )

      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        // A takes W7 first (the writer's order); B takes W4 first (the reverse).
        await a.query('SELECT pg_advisory_xact_lock($1::bigint)', [w7Key.toString()])
        await b.query('SELECT pg_advisory_xact_lock($1::bigint)', [w4Key.toString()])

        const aSecond = a.query('SELECT pg_advisory_xact_lock($1::bigint)', [w4Key.toString()])
        const bSecond = b.query('SELECT pg_advisory_xact_lock($1::bigint)', [w7Key.toString()])

        const outcomes = await Promise.allSettled([aSecond, bSecond])
        const deadlocks = outcomes.filter(
          (outcome) =>
            outcome.status === 'rejected' &&
            (outcome.reason as { code?: string }).code === '40P01',
        )
        // EXACTLY one victim: PostgreSQL aborts one side and lets the other
        // proceed. Zero would mean the cycle was never formed (the leg would be
        // measuring nothing); two would mean something else went wrong.
        expect(deadlocks.length, 'the constructed reverse order did not deadlock').toBe(1)
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })

    it('POSITIVE CONTROL: the writer ORDER on two connections does NOT deadlock', async () => {
      // Without this, the leg above could be passing because any two advisory
      // acquisitions deadlock. Both connections take W7 then W4 — the writer's
      // own order — and both must complete.
      const orgId = randomUUID()
      const w7Key = buildAttendanceW7ContextSourceAdvisoryKeyV1(orgId)
      const w4Key = buildAttendanceCalculationRolloutAdvisoryKey(
        parseCanonicalAttendanceRolloutOrgKeyV1(orgId),
      )

      async function sameOrder(client: PoolClient): Promise<void> {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [w7Key.toString()])
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [w4Key.toString()])
        await client.query('COMMIT')
      }

      const a = await pool.connect()
      const b = await pool.connect()
      try {
        const outcomes = await Promise.allSettled([sameOrder(a), sameOrder(b)])
        expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled'])
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })
  })

  // -------------------------------------------------------------------------
  // T-B2 — byte-neutrality of the READ side.
  // -------------------------------------------------------------------------
  describe('T-B2 the read side is unchanged: three conjuncts, each individually removable', () => {
    it('a persisted row alone, an allowlist entry alone, and both together', async () => {
      const { resolveAttendanceW7ContextSourcePostureV1 } = await import(
        '../../src/attendance/w7-resolver/w7-context-source-posture-resolver'
      )
      const orgId = await preparedOrg()
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: true })
      await withClient(async (client) => {
        await transitionAttendanceW7ContextSourceV1(asTrx(client), input(orgId))
      })
      expect((await stateRow(orgId))?.state).toBe('group_shadow')

      // Conjunct: the ROW exists but the allowlist entry is gone -> `off`.
      delete process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
      await withClient(async (client) => {
        const posture = await resolveAttendanceW7ContextSourcePostureV1(asTrx(client), orgId)
        expect(posture.effectiveState).toBe('off')
        // ...and the persisted state is still reported honestly, so this is
        // "not advertised", not "not written".
        expect(posture.persistedState).toBe('group_shadow')
      })

      // Conjunct: the ALLOWLIST entry exists but for an org with no row -> `off`.
      const rowlessOrg = randomUUID()
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = rowlessOrg
      await withClient(async (client) => {
        const posture = await resolveAttendanceW7ContextSourcePostureV1(asTrx(client), rowlessOrg)
        expect(posture.effectiveState).toBe('off')
        expect(posture.persistedState).toBe(null)
      })

      // POSITIVE CONTROL: row AND allowlist together -> the group posture is
      // advertised. Both negatives above are therefore real, not vacuous.
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
      await withClient(async (client) => {
        const posture = await resolveAttendanceW7ContextSourcePostureV1(asTrx(client), orgId)
        expect(posture.effectiveState).toBe('group_shadow')
      })
    })
  })
})
