/**
 * W7-1a (#4556) real-PG gate — posture resolver, group-effective facts
 * resolver, and the composite lock order.
 *
 * Ratified per #4556 comments 5293034619 (owner-directed disclosed relay) + 5293478713 (owner
 * first-person confirmation). The legs below are the ones that ratification
 * makes REQUIRED:
 *
 *   ruling 7 — one positive control (persisted `group_authoritative` row +
 *              implementationCapability + exact allowlist, with the W4
 *              variable OFF) and two inert negative controls (allowlist-only
 *              and row-only each resolve `off`);
 *   ruling 8 — a REAL two-connection reverse-contention test on the one shared
 *              composite lock helper;
 *   rulings 5/6/11 — `fixed_shift` only, W1-vs-FSER mismatch fail-closes,
 *              `flex_required_duration` fail-closes.
 *
 * SCOPE HONESTY (do not read this suite as more than it is). Ruling 7's
 * positive control is stated as "group arm runs AND the outer fingerprint is
 * non-null". Only the FIRST half is buildable in W7-1a: the outer
 * source-definition fingerprint mirror lives at the `:29365` pre-boundary
 * block, and wiring it is W7-1b behavioural work that W7-1a deliberately does
 * not do. What is pinned here is the RESOLVER-LEVEL half. The outer-mirror leg
 * is an OUTSTANDING ruling-7 obligation that lands in W7-1b; it is named as
 * unmet rather than described as satisfied.
 */
import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
} from '../../src/attendance/w7-context-source-posture-contract'
import {
  down as postureMigrationDown,
  up as postureMigrationUp,
} from '../../src/db/migrations/zzzz20260814120000_w7_attendance_context_source_posture_state'
import { up as contextSourceWriterMigrationUp } from '../../src/db/migrations/zzzz20260816120000_w7_context_source_transition_writer'
import { coreIssueGroupEffectiveContextV2 } from '../../src/attendance/w7-resolver/w7-group-effective-context-issuance'
import {
  ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP,
  resolveW7GroupEffectiveFactsInTransactionV1,
  type AttendanceW7GroupEffectiveResolverDepsV1,
} from '../../src/attendance/w7-resolver/w7-group-effective-facts-resolver'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV,
  ATTENDANCE_W7_CONTEXT_SOURCE_SCOPE_INVALID,
  ATTENDANCE_W7_CONTEXT_SOURCE_STATE_AMBIGUOUS,
  ATTENDANCE_W7_CONTEXT_SOURCE_STATE_INVALID,
  isResolvedAttendanceW7ContextSourcePostureV1,
  resolveAttendanceW7ContextSourcePostureV1,
} from '../../src/attendance/w7-resolver/w7-context-source-posture-resolver'
import {
  acquireAttendanceW7CompositeFactsLocksV1,
  buildAttendanceW7MembershipTimelineLockKeyV1,
  buildAttendanceW7ScheduleFactsLockKeyV1,
} from '../../src/attendance/w7-resolver/w7-composite-lock-order'

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  deriveAttendanceGroupFixedScheduleEffectiveness,
} = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs')
const {
  buildAttendanceGroupFixedScheduleProducerKey,
} = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs')

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'
/** W7-3's legal-matrix trigger backstop
 *  (`zzzz20260816120000_w7_context_source_transition_writer.ts`). */
const STATE_GUARD_TRIGGER = 'trg_accss_state_guard'
const WORK_DATE = '2026-08-14'

/** The rule scalars are org-level, not group policy — injected exactly as
 *  W7-1b will inject the legacy loader. Fixed values so the V2 assertion below
 *  is an equality, not a range. */
const RULE_FACTS = { severeLateThresholdMinutes: 60, absenceLateThresholdMinutes: 240 }

function deps(): AttendanceW7GroupEffectiveResolverDepsV1 {
  return {
    // The REAL exported pure FSER derivation — not a stub. A stubbed predicate
    // would make every `state === 'effective'` leg below a test of the stub.
    deriveFixedScheduleEffectiveness: deriveAttendanceGroupFixedScheduleEffectiveness,
    buildFixedScheduleProducerKey: buildAttendanceGroupFixedScheduleProducerKey,
    loadOrgRuleFacts: async () => RULE_FACTS,
    now: () => '2026-08-14T00:00:00.000Z',
  }
}

function asTrx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: async (sqlText: string, params?: unknown[]) => {
      const result = await client.query(sqlText, params as never[])
      return { rows: result.rows as Array<Record<string, unknown>> }
    },
  }
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? `<no code: ${String(error)}>`
}

/**
 * Removes W7-3's BEFORE trigger for the duration of the CALLER's transaction.
 *
 * The three hard-throw legs below deliberately construct rows the schema
 * forbids. W7-3's trigger would reject those INSERTs before the resolver is ever
 * reached, so each leg drops it alongside the constraint it already drops.
 *
 * WHY THIS IS NOT COSMETIC: without it these legs still passed, but only because
 * the `replays down/up` leg declared EARLIER in this file had already dropped
 * and recreated the table WITHOUT W7-3's columns or trigger. That made them
 * silently order-dependent — reordering the file, or running a leg in isolation,
 * would have broken them. Dropping it explicitly here makes each leg
 * self-contained. `DROP TRIGGER` is transactional, so the rollback restores it,
 * and `IF EXISTS` keeps this a no-op on a database where W7-3 has not been
 * applied.
 */
/**
 * The full shipped column set for a fixture row.
 *
 * W7-3 (#4556) added `version` / `prior_state` / `engine_version` /
 * `reason_code` / `actor_id` / `changed_at`, four of them NOT NULL with no
 * default, so a bare `(org_id, state, scope)` INSERT now fails `23502` before
 * reaching either the trigger or the CHECKs. Every fixture below supplies the
 * full set through this ONE helper, so the discriminating enforcer for each leg
 * is the one that leg is actually about.
 */
function postureFixtureInsert(stateExpr: string, scopeExpr: string, priorExpr = 'NULL'): string {
  return (
    `INSERT INTO ${POSTURE_TABLE}` +
    ' (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)' +
    ` VALUES ($1, ${stateExpr}, ${scopeExpr}, 1, ${priorExpr},` +
    " 'w7-1a-fixture', 'context_source_transition', 'w7-1a-fixture')"
  )
}

/** The legal ladder path from `off` to `target`, derived from the RATIFIED
 *  transition constant by breadth-first search — never a hand-written route. */
function legalLadderPathTo(target: string): string[] {
  if (target === 'off') return []
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

async function dropW73StateGuard(client: PoolClient): Promise<void> {
  await client.query(`DROP TRIGGER IF EXISTS ${STATE_GUARD_TRIGGER} ON ${POSTURE_TABLE}`)
}

describeIfDatabase('W7-1a resolvers (real PG)', () => {
  const pool = new Pool({ connectionString: dbUrl, max: 8 })
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  // Org keys MUST be canonical UUIDs (or the exact literal `default`) —
  // `parseCanonicalAttendanceRolloutOrgKeyV1` accepts nothing else.
  const orgId = randomUUID()
  const otherOrgId = randomUUID()
  const userId = randomUUID()
  const strangerId = randomUUID()
  const fixedGroupId = randomUUID()
  const freeTimeGroupId = randomUUID()
  const scheduledGroupId = randomUUID()
  const flexGroupId = randomUUID()
  const shiftId = randomUUID()
  const flexShiftId = randomUUID()

  let savedW4: string | undefined
  let savedW7: string | undefined

  async function seedGroup(id: string, attendanceType: string, name: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, code, timezone, attendance_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Asia/Shanghai', $5, now(), now())`,
      [id, orgId, `${name} ${suffix}`, `${name}-${suffix}`, attendanceType],
    )
  }

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required')

    for (const id of [userId, strangerId]) {
      await pool.query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions,
                            is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $1, 'W7 Fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())`,
        [id, `${id}@example.test`],
      )
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
        [id, orgId],
      )
    }

    await seedGroup(fixedGroupId, 'fixed_shift', 'w7-fixed')
    await seedGroup(freeTimeGroupId, 'free_time', 'w7-free')
    await seedGroup(scheduledGroupId, 'scheduled_shift', 'w7-sched')
    await seedGroup(flexGroupId, 'fixed_shift', 'w7-flex')

    for (const [id, flexMode] of [
      [shiftId, 'strict'],
      [flexShiftId, 'flex_required_duration'],
    ] as const) {
      await pool.query(
        `INSERT INTO attendance_shifts (id, org_id, name, timezone, work_start_time, work_end_time,
                                        late_grace_minutes, early_grace_minutes, rounding_minutes,
                                        is_overnight, flex_mode, flex_required_minutes,
                                        flex_arrival_window_before_minutes, flex_arrival_window_after_minutes,
                                        created_at, updated_at)
         VALUES ($1, $2, $3, 'Asia/Shanghai', '09:00', '18:00', 5, 5, 5, false, $4,
                 CASE WHEN $4 = 'flex_required_duration' THEN 480 ELSE NULL END,
                 CASE WHEN $4 = 'flex_required_duration' THEN 60 ELSE NULL END,
                 CASE WHEN $4 = 'flex_required_duration' THEN 60 ELSE NULL END,
                 now(), now())`,
        [id, orgId, `w7-shift-${flexMode}-${suffix}`, flexMode],
      )
    }

    // A fully-effective fixed schedule (config + member + a published managed
    // assignment whose producer key matches the config) for EVERY group,
    // including the `free_time`, `scheduled_shift` and flex ones.
    //
    // Seeding the non-`fixed_shift` groups completely is deliberate and is the
    // difference between a real leg and a decorative one. Mutation testing
    // caught this: with those groups left unconfigured, deleting the ruling-5
    // `attendance_type !== 'fixed_shift'` gate ENTIRELY still left both legs
    // green, because FSER's `not_configured` door caught them instead and
    // returned the same `incomplete-policy` reason. Two fail-closed doors were
    // covering for each other. Now each non-fixed group differs from the
    // passing fixture in exactly ONE respect — its `attendance_type` (or, for
    // the flex group, its `flex_mode`) — so the corresponding gate is the only
    // thing that can be producing the fail-close.
    for (const [groupId, sid] of [
      [fixedGroupId, shiftId],
      [flexGroupId, flexShiftId],
      [freeTimeGroupId, shiftId],
      [scheduledGroupId, shiftId],
    ] as const) {
      await pool.query(
        `INSERT INTO attendance_group_fixed_schedule_configs
           (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 1, 'w7-fixture')`,
        [orgId, groupId, sid],
      )
      await pool.query(
        `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
        [orgId, groupId, userId],
      )
      const producerKey = buildAttendanceGroupFixedScheduleProducerKey({
        groupId,
        shiftId: sid,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      })
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (org_id, user_id, shift_id, start_date, end_date, is_active,
            producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
         VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', true,
                 'attendance_group_fixed_schedule', $4, $5, $6, 'published')`,
        [orgId, userId, sid, groupId, producerKey, randomUUID()],
      )
    }

    // W1 effective membership -> the fixed group.
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships
         (org_id, user_id, group_id, effective_from, effective_to,
          assigned_by, assigned_reason, assigned_correlation_id)
       VALUES ($1, $2, $3, '2026-01-01', NULL, 'w7-fixture', 'seed', $4)`,
      [orgId, userId, fixedGroupId, `w7-corr-${suffix}`],
    )
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM attendance_calculation_group_memberships WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM attendance_shift_assignments WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM attendance_group_fixed_schedule_configs WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM attendance_group_members WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM attendance_groups WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM attendance_shifts WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM user_orgs WHERE org_id = $1`, [orgId])
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[userId, strangerId]])
    await pool.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [[orgId, otherOrgId]])
    await pool.end()
  })

  beforeEach(() => {
    // Env leakage between cases would silently make the two inert negative
    // controls vacuous, so both variables are saved and restored per case.
    savedW4 = process.env[W4_ENV]
    savedW7 = process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
    delete process.env[W4_ENV]
    delete process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
  })

  afterEach(async () => {
    if (savedW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = savedW4
    if (savedW7 === undefined) delete process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
    else process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = savedW7
    await pool.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [[orgId, otherOrgId]])
  })

  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  /**
   * Seeds a persisted posture row in `state`.
   *
   * W7-3 (#4556) AMENDMENT — this used to be a single bare INSERT of an
   * arbitrary state. It cannot be any more, and that is the point of the change
   * rather than an inconvenience: W7-3's `trg_accss_state_guard` restricts
   * INSERT to the two BOOTSTRAP shapes (`off` with no prior state, or
   * `group_shadow` from `off`), so an arbitrary posture is now reachable ONLY by
   * walking the ratified legal ladder. A test that could still conjure
   * `group_authoritative` out of a bare INSERT would be seeding a row the
   * production writer can never produce.
   *
   * The path is DERIVED from the ratified transition constant by breadth-first
   * search, never hand-written, so removing a pair from that constant makes the
   * walk unreachable and throws here instead of silently taking a stale route.
   */
  async function insertPosture(state: string): Promise<void> {
    await pool.query(
      postureFixtureInsert("'off'", "'synthetic_staging'"),
      [orgId],
    )
    for (const step of legalLadderPathTo(state)) {
      await pool.query(
        `UPDATE ${POSTURE_TABLE}
            SET state = $2, prior_state = state, version = version + 1
          WHERE org_id = $1`,
        [orgId, step],
      )
    }
    // The walk must have LANDED. An unasserted walk would let every leg below
    // run against whatever state the row happened to stop at.
    const landed = await pool.query(`SELECT state FROM ${POSTURE_TABLE} WHERE org_id = $1`, [orgId])
    expect(landed.rows[0]?.state, `ladder walk to ${state} did not land`).toBe(state)
  }

  async function resolvePosture(org: string = orgId) {
    return withClient(async (client) => resolveAttendanceW7ContextSourcePostureV1(asTrx(client), org))
  }

  // -------------------------------------------------------------------------
  // STEP 0 — the posture-state table itself.
  // -------------------------------------------------------------------------

  describe('STEP 0: the OD-W7-3(a) posture-state table', () => {
    /** Values inside a `CHECK (x = ANY (ARRAY['a'::text, ...]))` definition. */
    function checkedValues(definition: string): string[] {
      return [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort()
    }

    async function constraintDef(name: string): Promise<string> {
      const result = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = $1::regclass AND conname = $2`,
        [POSTURE_TABLE, name],
      )
      expect(result.rows, `constraint ${name} is missing`).toHaveLength(1)
      return String(result.rows[0].def)
    }

    it('the state CHECK is exactly the TS state union — DERIVED from the constant, never re-spelled', () => {
      // This is the pin the migration header claims. The expected list comes
      // from the imported W7-0 constant, so editing either side alone reds:
      // widening the CHECK without the constant, or the constant without the
      // CHECK. 1a-M's provenance widening depends on this staying true.
      expect([...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1]).toHaveLength(5)
      return constraintDef('chk_accss_state').then((definition) => {
        expect(checkedValues(definition)).toEqual([...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1].sort())
      })
    })

    it('the scope CHECK pins synthetic_staging (OD-W7-8(a))', async () => {
      const definition = await constraintDef('chk_accss_scope')
      expect(definition).toContain('synthetic_staging')
      expect(checkedValues(`${definition.replace(/=\s*'([^']*)'::text/, "= '$1'::text")}`)).not.toContain('production')
    })

    it('the CHECKs actually REJECT out-of-union values (a constraint definition is not behaviour)', async () => {
      // W7-3 (#4556) AMENDMENT — a declared behavioural change, not a relaxation.
      //
      // This leg used to assert SQLSTATE `23514` (check_violation) for a bare
      // out-of-union INSERT. W7-3 adds `trg_accss_state_guard`, a
      // `BEFORE INSERT OR UPDATE ... FOR EACH ROW` trigger on this table.
      // PostgreSQL runs BEFORE triggers ahead of CHECK constraint evaluation, so
      // the OBSERVABLE error for these two inserts is now the trigger's `P0001`
      // and the CHECK is never reached. That is a change to a landed table's
      // error contract and is recorded as such rather than discovered later.
      //
      // The leg is made STRONGER rather than merely updated: it now proves BOTH
      // doors, each EXCLUSIVELY. Two fail-closed doors that are only ever tested
      // together cover for each other — either could be deleted with every test
      // still green.

      // ANCHOR CHECK: door 1 only means something if the trigger is actually
      // installed. Asserted rather than assumed — an absent trigger would make
      // every `P0001` expectation below fail confusingly instead of saying why.
      const guard = await pool.query(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`,
        [STATE_GUARD_TRIGGER, POSTURE_TABLE],
      )
      expect(
        Number(guard.rows[0].n),
        `${STATE_GUARD_TRIGGER} is not installed — is the database migrated to the W7-3 head?`,
      ).toBe(1)

      // DOOR 1 (outer): the trigger refuses both rows.
      await expect(
        pool.query(
          postureFixtureInsert("'authoritative'", "'synthetic_staging'"),
          [otherOrgId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' })
      await expect(
        pool.query(
          postureFixtureInsert("'group_shadow'", "'production'"),
          [otherOrgId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' })

      // DOOR 2 (inner): with the trigger neutered, the CHECKs still refuse —
      // and with the ORIGINAL `23514`, so the constraints remain behaviourally
      // load-bearing and not merely defined.
      await pool.query(`ALTER TABLE ${POSTURE_TABLE} DISABLE TRIGGER ${STATE_GUARD_TRIGGER}`)
      try {
        await expect(
          pool.query(
            postureFixtureInsert("'authoritative'", "'synthetic_staging'"),
            [otherOrgId],
          ),
        ).rejects.toMatchObject({ code: '23514' })
        await expect(
          pool.query(
            postureFixtureInsert("'group_shadow'", "'production'"),
            [otherOrgId],
          ),
        ).rejects.toMatchObject({ code: '23514' })
      } finally {
        await pool.query(`ALTER TABLE ${POSTURE_TABLE} ENABLE TRIGGER ${STATE_GUARD_TRIGGER}`)
      }

      // The ENABLE really took effect — otherwise every later leg in this file
      // would be running against a silently trigger-less table.
      await expect(
        pool.query(
          postureFixtureInsert("'authoritative'", "'synthetic_staging'"),
          [otherOrgId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' })

      // POSITIVE CONTROL: a well-formed BOOTSTRAP row inserts, so every
      // rejection above is a real refusal and not a broken INSERT. `group_shadow`
      // with `prior_state = 'off'` is the shape W7-3's trigger accepts on INSERT.
      await pool.query(
        postureFixtureInsert("'group_shadow'", "'synthetic_staging'", "'off'"),
        [otherOrgId],
      )
    })

    it('org_id is the primary key, and the table SHIPS EMPTY apart from this suite’s own rows', async () => {
      const pk = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'p'`,
        [POSTURE_TABLE],
      )
      expect(String(pk.rows[0].def)).toBe('PRIMARY KEY (org_id)')

      const foreign = await pool.query(
        `SELECT count(*)::int AS n FROM ${POSTURE_TABLE} WHERE org_id <> ALL($1::text[])`,
        [[orgId, otherOrgId]],
      )
      expect(Number(foreign.rows[0].n), 'the migration must ship the table EMPTY — it seeds nothing').toBe(0)
    })

    it('replays down/up (and a second up) without schema drift', async () => {
      const migrationPool = new Pool({ connectionString: dbUrl, max: 2 })
      const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
      try {
        await postureMigrationDown(db)
        const gone = await migrationPool.query(`SELECT to_regclass($1)::text AS t`, [POSTURE_TABLE])
        expect(gone.rows[0].t).toBeNull()

        await postureMigrationUp(db)
        await postureMigrationUp(db) // idempotent second up
        const back = await migrationPool.query(`SELECT to_regclass($1)::text AS t`, [POSTURE_TABLE])
        expect(back.rows[0].t).toBe(POSTURE_TABLE)

        const definition = await migrationPool.query(
          `SELECT pg_get_constraintdef(oid) AS def
             FROM pg_constraint
            WHERE conrelid = $1::regclass AND conname = 'chk_accss_state'`,
          [POSTURE_TABLE],
        )
        expect(checkedValues(String(definition.rows[0].def))).toEqual(
          [...ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1].sort(),
        )
      } finally {
        // RESTORE THE SHARED SCHEMA UNCONDITIONALLY.
        //
        // This leg is the one place in the suite that mutates schema rather
        // than rows, and it does so on the SHARED database — in CI a single
        // `metasheet_test` carries all 109 attendance files. `down()` is a
        // DROP TABLE: if any assertion above throws between `down()` and the
        // final `up()`, the table stays missing (or keeps a drifted CHECK) for
        // whatever file runs next, and the failure surfaces somewhere
        // unrelated. Observed exactly that during mutation testing: a failed
        // replay left a drifted CHECK behind and redded an innocent leg on the
        // following run.
        //
        // `up()` is idempotent (`CREATE TABLE IF NOT EXISTS`) and is proven so
        // by the double-up above, so re-applying here is safe on both the
        // success and failure paths. Errors are swallowed deliberately: this
        // is cleanup, and letting it throw would mask the real assertion
        // failure that sent us here.
        try {
          await postureMigrationUp(db)
          // W7-3 (#4556): restoring HALF the shipped schema is not restoring it.
          // `postureMigrationDown` is a DROP TABLE, so it also takes W7-3's
          // columns, CHECKs, event-table triggers and the legal-matrix guard —
          // and `postureMigrationUp` alone brings back only the W7-1a shape.
          // Before this line, every run of this leg left the shared database
          // permanently missing W7-3's schema, which made the trigger-vs-CHECK
          // leg above pass or fail depending on whether this file had already
          // run against that database. Re-applying the writer migration here
          // restores the table to the shape a migrated database actually ships.
          await contextSourceWriterMigrationUp(db)
        } catch {
          /* best-effort restore — never mask the original failure */
        }
        await db.destroy()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Ruling 7 — the three REQUIRED controls.
  // -------------------------------------------------------------------------

  describe('ruling 7: two-part posture (persisted row AND exact allowlist)', () => {
    it('POSITIVE CONTROL: row + capability + exact allowlist, with the W4 variable OFF, resolves the persisted state', async () => {
      await insertPosture('group_authoritative')
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId

      // The "W4 variable OFF" clause is the point of the leg, so assert it
      // rather than assume the beforeEach did it.
      expect(process.env[W4_ENV]).toBeUndefined()

      const posture = await resolvePosture()
      expect(posture.effectiveState).toBe('group_authoritative')
      expect(posture.persistedState).toBe('group_authoritative')
      expect(posture.orgKey).toBe(orgId)
      // The witness is minted by the resolver, not fabricable inline.
      expect(isResolvedAttendanceW7ContextSourcePostureV1(posture)).toBe(true)
      expect(isResolvedAttendanceW7ContextSourcePostureV1({ ...posture })).toBe(false)

      // OUTSTANDING ruling-7 obligation, recorded here so it cannot be lost:
      // the other half of this control ("outer fingerprint non-null") requires
      // the `:29365` mirror, which is W7-1b. Not asserted, not claimed.
    })

    it('INERT NEGATIVE CONTROL A: allowlist entry but NO row resolves off', async () => {
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
      const posture = await resolvePosture()
      expect(posture.effectiveState).toBe('off')
      expect(posture.persistedState).toBeNull()
    })

    it('INERT NEGATIVE CONTROL B: row but NO allowlist entry resolves off', async () => {
      await insertPosture('group_authoritative')
      expect(process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]).toBeUndefined()
      const posture = await resolvePosture()
      expect(posture.effectiveState).toBe('off')
      // The persisted state is still reported — "off" is the EFFECTIVE answer,
      // not an erasure of what the row says.
      expect(posture.persistedState).toBe('group_authoritative')
    })

    it('the wildcard `*` NEVER counts, and neither does another org’s entry', async () => {
      await insertPosture('group_authoritative')
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = '*'
      expect((await resolvePosture()).effectiveState).toBe('off')

      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = `${otherOrgId},*`
      expect((await resolvePosture()).effectiveState).toBe('off')

      // POSITIVE CONTROL for this leg: the same machinery DOES admit the org
      // when its exact key is present, so "off" above is a real rejection and
      // not an env that never parsed.
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = `${otherOrgId}, ${orgId} ,*`
      expect((await resolvePosture()).effectiveState).toBe('group_authoritative')
    })

    it('a persisted `suspended` is ALWAYS suspended — never evadable through the environment', async () => {
      await insertPosture('suspended')
      expect((await resolvePosture()).effectiveState).toBe('suspended')

      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId
      expect((await resolvePosture()).effectiveState).toBe('suspended')
    })

    it('canonicalization happens FIRST: an upper-case org UUID matches a lower-case row and allowlist entry', async () => {
      await insertPosture('group_eligible')
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = orgId

      const upper = orgId.toUpperCase()
      expect(upper).not.toBe(orgId)
      const posture = await resolvePosture(upper)
      expect(posture.effectiveState).toBe('group_eligible')
      expect(posture.orgKey).toBe(orgId)

      // A validate-then-normalize implementation would query (or allowlist-match)
      // on `upper` and find nothing. Prove the raw spelling really is absent
      // from both sides, so this leg discriminates.
      const rawRow = await pool.query(`SELECT 1 FROM ${POSTURE_TABLE} WHERE org_id = $1`, [upper])
      expect(rawRow.rows).toHaveLength(0)
      expect(process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]).not.toContain(upper)
    })
  })

  // -------------------------------------------------------------------------
  // The three W7-0 P3-2 carry-forwards: each MUST throw, never collapse to off.
  // -------------------------------------------------------------------------

  describe('the three hard throws (P3-2 carry-forwards)', () => {
    /**
     * Each case constructs state the schema forbids, inside a transaction that
     * is ROLLED BACK, by dropping the relevant constraint for the life of that
     * transaction.
     *
     * That is not a contrivance, it is the whole point: these three throws
     * exist to catch a table that has been corrupted or hand-edited past its
     * constraints. If the constraints could not be bypassed, the throws would
     * be unreachable — and an unreachable guard that no test can exercise is
     * indistinguishable from a missing one.
     */
    async function inRolledBackTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        return await fn(client)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }

    it('POSITIVE CONTROL: a well-formed row inside the same harness does NOT throw', async () => {
      // Without this, all three legs below could be "passes because the harness
      // itself throws".
      const state = await inRolledBackTx(async (client) => {
        // Same reason as the three hard-throw legs below: W7-3's INSERT guard
        // would reject this bare `group_shadow` row (no `prior_state`), and this
        // leg is about the RESOLVER, not about the write path. Dropped inside
        // the rolled-back transaction, so the trigger is restored on exit.
        await dropW73StateGuard(client)
        await client.query(
          postureFixtureInsert("'group_shadow'", "'synthetic_staging'"),
          [orgId],
        )
        return resolveAttendanceW7ContextSourcePostureV1(asTrx(client), orgId)
      })
      expect(state.effectiveState).toBe('off') // no allowlist entry — but no throw
      expect(state.persistedState).toBe('group_shadow')
    })

    it('>1 row for one org THROWS _STATE_AMBIGUOUS (never "pick one")', async () => {
      const code = await inRolledBackTx(async (client) => {
        await dropW73StateGuard(client)
        await client.query(`ALTER TABLE ${POSTURE_TABLE} DROP CONSTRAINT ${POSTURE_TABLE}_pkey`)
        await client.query(
          `INSERT INTO ${POSTURE_TABLE}
             (org_id, state, scope, version, prior_state, engine_version, reason_code, actor_id)
           VALUES
             ($1, 'group_shadow', 'synthetic_staging', 1, NULL, 'w7-1a-fixture', 'context_source_transition', 'w7-1a-fixture'),
             ($1, 'group_authoritative', 'synthetic_staging', 1, NULL, 'w7-1a-fixture', 'context_source_transition', 'w7-1a-fixture')`,
          [orgId],
        )
        try {
          await resolveAttendanceW7ContextSourcePostureV1(asTrx(client), orgId)
          return '<did not throw>'
        } catch (error) {
          return codeOf(error)
        }
      })
      expect(code).toBe(ATTENDANCE_W7_CONTEXT_SOURCE_STATE_AMBIGUOUS)
    })

    it('an invalid state value THROWS _STATE_INVALID (never collapses to off)', async () => {
      const code = await inRolledBackTx(async (client) => {
        await dropW73StateGuard(client)
        await client.query(`ALTER TABLE ${POSTURE_TABLE} DROP CONSTRAINT chk_accss_state`)
        await client.query(
          postureFixtureInsert("'authoritative'", "'synthetic_staging'"),
          [orgId],
        )
        try {
          await resolveAttendanceW7ContextSourcePostureV1(asTrx(client), orgId)
          return '<did not throw>'
        } catch (error) {
          return codeOf(error)
        }
      })
      // Note the fixture value: `authoritative` is a valid W4 state and an
      // INVALID W7 one. A resolver that reused the W4 state set would pass this
      // by accident; it must not.
      expect(code).toBe(ATTENDANCE_W7_CONTEXT_SOURCE_STATE_INVALID)
    })

    it('a non-synthetic_staging scope THROWS _SCOPE_INVALID', async () => {
      const code = await inRolledBackTx(async (client) => {
        await dropW73StateGuard(client)
        await client.query(`ALTER TABLE ${POSTURE_TABLE} DROP CONSTRAINT chk_accss_scope`)
        await client.query(
          postureFixtureInsert("'group_authoritative'", "'production'"),
          [orgId],
        )
        try {
          await resolveAttendanceW7ContextSourcePostureV1(asTrx(client), orgId)
          return '<did not throw>'
        } catch (error) {
          return codeOf(error)
        }
      })
      expect(code).toBe(ATTENDANCE_W7_CONTEXT_SOURCE_SCOPE_INVALID)
    })
  })

  // -------------------------------------------------------------------------
  // Group-effective facts resolver.
  // -------------------------------------------------------------------------

  describe('group-effective facts resolver', () => {
    async function resolveFacts(user = userId, workDate = WORK_DATE) {
      return withClient(async (client) => {
        await client.query('BEGIN')
        try {
          return await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId: user,
            workDate,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
        } finally {
          await client.query('ROLLBACK')
        }
      })
    }

    it('resolves persisted facts under locks, and op(i) mints a valid V2 from them', async () => {
      const result = await resolveFacts()
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.facts.calculationGroupId).toBe(fixedGroupId)
      expect(result.facts.shiftId).toBe(shiftId)
      // The shift's own timezone wins over the caller's, as in the legacy builder.
      expect(result.facts.timezone).toBe('Asia/Shanghai')
      expect(result.facts.roundingMinutes).toBe(5)
      expect(result.facts.severeLateThresholdMinutes).toBe(60)
      expect(result.facts.segments).toEqual([
        {
          index: 0,
          startTime: '09:00',
          endTime: '18:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 5,
          earlyLeaveGraceMinutes: 5,
        },
      ])

      const context = coreIssueGroupEffectiveContextV2(result.facts)
      expect(context.schemaVersion).toBe(2)
      expect(context.selector).toBe('group_effective')
      expect(context.calculationGroupId).toBe(fixedGroupId)
      expect(Object.getOwnPropertyNames(context)).toHaveLength(14)
    })

    it('takes BOTH composite locks, in the ruled order, before reading any fact', async () => {
      // Observed on the server, not argued from source: after the resolver
      // runs, the transaction must hold both advisory locks. `pg_locks` is the
      // evidence.
      await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
          // `pg_locks` stores advisory keys split across `classid`/`objid`
          // (both `oid`, i.e. UNSIGNED 32-bit) with `objsubid` discriminating
          // the two-argument form (2) from the one-argument bigint form (1).
          // Every comparison below is done in `bigint` with the expectation
          // masked to unsigned 32 bits, because `hashtext` returns a SIGNED
          // int4 and a naive equality silently never matches for negative
          // hashes — which would make this leg pass by never matching anything.
          const held = await client.query(
            `WITH expected AS (
               SELECT
                 (hashtext($1::text)::bigint & 4294967295) AS sched_class,
                 (hashtext($2::text)::bigint & 4294967295) AS sched_obj,
                 ((hashtextextended($3::text, 0) >> 32) & 4294967295) AS timeline_class,
                 (hashtextextended($3::text, 0) & 4294967295) AS timeline_obj
             )
             SELECT
               (SELECT count(*)::int FROM pg_locks
                 WHERE pid = pg_backend_pid() AND locktype = 'advisory') AS advisory_locks,
               (SELECT count(*)::int FROM pg_locks, expected
                 WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND objsubid = 2
                   AND classid::bigint = expected.sched_class
                   AND objid::bigint = expected.sched_obj) AS schedule_lock,
               (SELECT count(*)::int FROM pg_locks, expected
                 WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND objsubid = 1
                   AND classid::bigint = expected.timeline_class
                   AND objid::bigint = expected.timeline_obj) AS timeline_lock`,
            [buildAttendanceW7ScheduleFactsLockKeyV1(orgId), userId, buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)],
          )
          const row = held.rows[0]
          expect(Number(row.advisory_locks)).toBeGreaterThanOrEqual(2)
          expect(Number(row.schedule_lock), 'schedule-facts advisory lock not held').toBe(1)
          expect(Number(row.timeline_lock), 'membership-timeline advisory lock not held').toBe(1)
        } finally {
          await client.query('ROLLBACK')
        }
      })
    })

    it('takes the W1 membership read with FOR SHARE (a locked read, not a pooled one)', async () => {
      // The row lock is observable: after the resolver runs, the membership row
      // must carry a tuple/row-level lock held by this backend.
      await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
          // `SELECT ... FOR SHARE` takes a RowShareLock on the RELATION for the
          // life of the transaction. A plain unlocked `SELECT` takes only
          // AccessShareLock, so the MODE is what discriminates — asserting
          // merely "some lock exists" would pass for a pooled read too.
          const locks = await client.query(
            `SELECT count(*)::int AS n
               FROM pg_locks
              WHERE pid = pg_backend_pid()
                AND locktype = 'relation'
                AND relation = 'attendance_calculation_group_memberships'::regclass
                AND mode = 'RowShareLock'`,
          )
          expect(Number(locks.rows[0].n), 'membership read did not take FOR SHARE').toBe(1)
        } finally {
          await client.query('ROLLBACK')
        }
      })
    })

    it('membership absent -> `membership-absent` (a distinct reason, not incomplete-policy)', async () => {
      const result = await resolveFacts(strangerId)
      expect(result).toEqual({ ok: false, reason: 'membership-absent' })
    })

    it('a work date outside the membership window is also `membership-absent`', async () => {
      const result = await resolveFacts(userId, '2025-06-01')
      expect(result).toEqual({ ok: false, reason: 'membership-absent' })
    })

    it('W7-R2: >1 effective membership on the work date THROWS the overlap code (never a silent winner)', async () => {
      // The gist EXCLUDE constraint forbids this at rest, which is exactly why
      // W7-R2 demands a RUNTIME re-check: effective-dating makes storage-level
      // validity date-dependent. Constructed inside a rolled-back transaction.
      const outcome = await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await client.query(
            `ALTER TABLE attendance_calculation_group_memberships
               DROP CONSTRAINT attendance_calc_group_memberships_no_overlap`,
          )
          await client.query(
            `INSERT INTO attendance_calculation_group_memberships
               (org_id, user_id, group_id, effective_from, effective_to,
                assigned_by, assigned_reason, assigned_correlation_id)
             VALUES ($1, $2, $3, '2026-02-01', NULL, 'w7-fixture', 'overlap', $4)`,
            [orgId, userId, freeTimeGroupId, `w7-overlap-${suffix}`],
          )
          try {
            await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
              orgId,
              userId,
              workDate: WORK_DATE,
              timezone: 'UTC',
              isWorkday: true,
              holidayKind: null,
            })
            return '<did not throw>'
          } catch (error) {
            return codeOf(error)
          }
        } finally {
          await client.query('ROLLBACK')
        }
      })
      expect(outcome).toBe(ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP)
    })

    /** Repoint the user's effective membership at another group for one
     *  rolled-back transaction. */
    async function resolveWithGroup(groupId: string) {
      return withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await client.query(
            `UPDATE attendance_calculation_group_memberships
                SET group_id = $3
              WHERE org_id = $1 AND user_id = $2`,
            [orgId, userId, groupId],
          )
          return await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
        } finally {
          await client.query('ROLLBACK')
        }
      })
    }

    it('ruling 5: a `free_time` group fail-closes with incomplete-policy', async () => {
      expect(await resolveWithGroup(freeTimeGroupId)).toEqual({ ok: false, reason: 'incomplete-policy' })
    })

    it('ruling 5: a `scheduled_shift` group fail-closes with incomplete-policy (composition DEFERRED, not implemented)', async () => {
      expect(await resolveWithGroup(scheduledGroupId)).toEqual({ ok: false, reason: 'incomplete-policy' })
    })

    it('ruling 11: a `flex_required_duration` effective shift fail-closes with incomplete-policy', async () => {
      // POSITIVE CONTROL built in: the flex group is otherwise fully effective
      // (config + member + matching published assignment), and differs from the
      // passing fixture ONLY in `flex_mode`. So this leg reds for the flex mode,
      // not for an incidentally broken fixture.
      expect(await resolveWithGroup(flexGroupId)).toEqual({ ok: false, reason: 'incomplete-policy' })
    })

    it('a legal `rounding_minutes = 0` shift fail-closes instead of handing op(i) facts it throws on', async () => {
      // The resolver's success output must be a SUBSET of op(i)'s accepted
      // domain. `rounding_minutes` is `integer NOT NULL DEFAULT 5` with no
      // CHECK and the shift schema accepts `min(0)`, so 0 is reachable; op(i)
      // requires `>= 1` (the same predicate the live v1 validator carries).
      // Previously the resolver returned ok:true here and op(i) then THREW.
      const result = await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await client.query(`UPDATE attendance_shifts SET rounding_minutes = 0 WHERE id = $1 AND org_id = $2`, [
            shiftId,
            orgId,
          ])
          return await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
        } finally {
          await client.query('ROLLBACK')
        }
      })
      expect(result).toEqual({ ok: false, reason: 'incomplete-policy' })
    })

    it('every ok:true fact set this suite can produce is accepted by op(i) (the subset invariant)', async () => {
      // The general statement of the leg above: whatever the resolver calls a
      // success, the boundary must mint. A fixture-specific assertion would
      // not have caught the rounding case.
      const result = await resolveFacts()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(() => coreIssueGroupEffectiveContextV2(result.facts)).not.toThrow()
      expect(result.facts.roundingMinutes).toBeGreaterThanOrEqual(1)
    })

    it('a legal `rounding_minutes = 0` shift fail-closes instead of emitting facts op(i) would THROW on', async () => {
      // The resolver's `ok: true` must mean "op(i) will accept these facts".
      // `rounding_minutes = 0` is legal at rest (`integer NOT NULL DEFAULT 5`,
      // no CHECK) and authorable (`z.number().int().min(0)`), but op(i)'s v2
      // shape requires `>= 1` — the byte-identical predicate the LIVE v1
      // validator already carries (`w4c1-segment-calculator.ts:359`).
      //
      // Before this gate the resolver returned `ok: true` and op(i) then threw,
      // converting what the v1 path handles as `review('input_schema_invalid')`
      // into an exception, with a success report on the way to it.
      const result = await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await client.query(
            `UPDATE attendance_shifts SET rounding_minutes = 0 WHERE id = $1 AND org_id = $2`,
            [shiftId, orgId],
          )
          return await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
        } finally {
          await client.query('ROLLBACK')
        }
      })
      expect(result).toEqual({ ok: false, reason: 'incomplete-policy' })
    })

    it('op(i) really would have rejected those facts — the gate above is not guarding a non-problem', async () => {
      // Pins the reason the gate exists: hand op(i) the exact facts the
      // ungated resolver would have emitted and confirm it throws. Without
      // this, the `incomplete-policy` leg above could be pure ceremony.
      const ok = await resolveFacts()
      expect(ok.ok).toBe(true)
      if (!ok.ok) return

      expect(() => coreIssueGroupEffectiveContextV2({ ...ok.facts, roundingMinutes: 0 })).toThrow()
      // POSITIVE CONTROL: the unmodified facts mint cleanly, so the throw above
      // is attributable to `roundingMinutes` and nothing else.
      expect(() => coreIssueGroupEffectiveContextV2(ok.facts)).not.toThrow()
    })

    it('FSER state !== effective fail-closes with incomplete-policy', async () => {
      const result = await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          // Unpublish the managed assignment -> FSER drops out of `effective`.
          await client.query(
            `UPDATE attendance_shift_assignments SET publish_status = 'draft'
              WHERE org_id = $1 AND producer_ref_id = $2`,
            [orgId, fixedGroupId],
          )
          return await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
        } finally {
          await client.query('ROLLBACK')
        }
      })
      expect(result).toEqual({ ok: false, reason: 'incomplete-policy' })
    })

    it('ruling 6: a user W1-effective in the group but ABSENT from the FSER member set fail-closes', async () => {
      // The reconciliation gap ruling 6 names: `attendance_group_members` is a
      // different, non-effective-dated table. Here W1 says the stranger is in
      // the group; FSER has never heard of them. No soft degrade, no shadow
      // substitute — fail-close.
      const result = await withClient(async (client) => {
        await client.query('BEGIN')
        try {
          await client.query(
            `INSERT INTO attendance_calculation_group_memberships
               (org_id, user_id, group_id, effective_from, effective_to,
                assigned_by, assigned_reason, assigned_correlation_id)
             VALUES ($1, $2, $3, '2026-01-01', NULL, 'w7-fixture', 'recon', $4)`,
            [orgId, strangerId, fixedGroupId, `w7-recon-${suffix}`],
          )
          return await resolveW7GroupEffectiveFactsInTransactionV1(asTrx(client), deps(), {
            orgId,
            userId: strangerId,
            workDate: WORK_DATE,
            timezone: 'UTC',
            isWorkday: true,
            holidayKind: null,
          })
        } finally {
          await client.query('ROLLBACK')
        }
      })
      expect(result).toEqual({ ok: false, reason: 'incomplete-policy' })
    })
  })

  // -------------------------------------------------------------------------
  // Ruling 8 — the REQUIRED two-connection reverse-contention test.
  // -------------------------------------------------------------------------

  describe('ruling 8: composite lock order, proven by constructed concurrency', () => {
    const scheduleKey = () => buildAttendanceW7ScheduleFactsLockKeyV1(orgId)
    const timelineKey = () => buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)

    async function backendPid(client: PoolClient): Promise<number> {
      const r = await client.query('SELECT pg_backend_pid() AS pid')
      return Number(r.rows[0].pid)
    }

    async function waitUntilBlockedBy(blockedPid: number, blockerPid: number): Promise<void> {
      const deadline = Date.now() + 10000
      for (;;) {
        const result = await pool.query('SELECT pg_blocking_pids($1)::int[] AS blockers', [blockedPid])
        if ((result.rows[0]?.blockers ?? []).includes(blockerPid)) return
        if (Date.now() > deadline) {
          throw new Error(`pid ${blockedPid} never blocked by ${blockerPid} (vacuous concurrency proof)`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    it('the helper BLOCKS behind an exclusive holder of the membership-timeline lock (lock 1 is real)', async () => {
      const holder = await pool.connect()
      const waiter = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [timelineKey()])
        const holderPid = await backendPid(holder)

        await waiter.query('BEGIN')
        const waiterPid = await backendPid(waiter)
        let settled = false
        const pending = acquireAttendanceW7CompositeFactsLocksV1(asTrx(waiter), { orgKey: orgId, userId }).then(
          () => {
            settled = true
          },
        )

        // Wait for the SERVER to report the block — not a sleep, and not an
        // inference from "the promise has not resolved yet".
        await waitUntilBlockedBy(waiterPid, holderPid)
        expect(settled).toBe(false)

        await holder.query('COMMIT')
        await pending
        expect(settled).toBe(true)
      } finally {
        await waiter.query('ROLLBACK').catch(() => undefined)
        await holder.query('ROLLBACK').catch(() => undefined)
        waiter.release()
        holder.release()
      }
    })

    it('the helper BLOCKS behind an exclusive holder of the schedule-facts lock (lock 2 is real)', async () => {
      const holder = await pool.connect()
      const waiter = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', [
          scheduleKey(),
          userId,
        ])
        const holderPid = await backendPid(holder)

        await waiter.query('BEGIN')
        const waiterPid = await backendPid(waiter)
        let settled = false
        const pending = acquireAttendanceW7CompositeFactsLocksV1(asTrx(waiter), { orgKey: orgId, userId }).then(
          () => {
            settled = true
          },
        )

        await waitUntilBlockedBy(waiterPid, holderPid)
        expect(settled).toBe(false)

        await holder.query('COMMIT')
        await pending
        expect(settled).toBe(true)
      } finally {
        await waiter.query('ROLLBACK').catch(() => undefined)
        await holder.query('ROLLBACK').catch(() => undefined)
        waiter.release()
        holder.release()
      }
    })

    it('REVERSE-CONTENTION: a connection that takes the two families in the OPPOSITE order deadlocks against the helper', async () => {
      // THIS is the leg that makes the ruled order load-bearing. Two
      // connections both succeeding proves nothing; what proves the order is
      // that VIOLATING it produces a real, server-detected deadlock (40P01).
      //
      // Interleaving:
      //   reverse: takes SCHEDULE (exclusive)                 -- granted
      //   helper : takes TIMELINE (shared)                    -- granted
      //   helper : takes SCHEDULE (shared)                    -- blocks on reverse
      //   reverse: takes TIMELINE (exclusive)                 -- blocks on helper
      //   => cycle; PostgreSQL's deadlock detector aborts one side.
      const reverse = await pool.connect()
      const forward = await pool.connect()
      try {
        await reverse.query('BEGIN')
        await forward.query('BEGIN')

        // reverse holds lock 2 first (the WRONG order).
        await reverse.query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', [
          scheduleKey(),
          userId,
        ])

        // forward (the helper) takes lock 1, then blocks taking lock 2.
        const forwardPid = await backendPid(forward)
        const reversePid = await backendPid(reverse)
        const forwardPending = acquireAttendanceW7CompositeFactsLocksV1(asTrx(forward), {
          orgKey: orgId,
          userId,
        }).then(
          () => 'forward-ok',
          (error: unknown) => `forward-err:${(error as { code?: string }).code ?? 'unknown'}`,
        )
        await waitUntilBlockedBy(forwardPid, reversePid)

        // reverse now closes the cycle by reaching for lock 1.
        const reversePending = reverse
          .query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [timelineKey()])
          .then(
            () => 'reverse-ok',
            (error: unknown) => `reverse-err:${(error as { code?: string }).code ?? 'unknown'}`,
          )

        const [forwardOutcome, reverseOutcome] = await Promise.all([forwardPending, reversePending])
        const outcomes = [forwardOutcome, reverseOutcome]

        // Exactly one side must be aborted with SQLSTATE 40P01. Asserting the
        // SPECIFIC error code, not merely "something failed": "not a success"
        // is not an outcome assertion.
        const deadlocked = outcomes.filter((outcome) => outcome.endsWith(':40P01'))
        expect(
          deadlocked.length,
          `expected exactly one 40P01 deadlock victim, got ${JSON.stringify(outcomes)}`,
        ).toBe(1)
        expect(outcomes.filter((outcome) => outcome.endsWith('-ok'))).toHaveLength(1)
      } finally {
        await forward.query('ROLLBACK').catch(() => undefined)
        await reverse.query('ROLLBACK').catch(() => undefined)
        forward.release()
        reverse.release()
      }
    })

    it('POSITIVE CONTROL: two connections BOTH using the shared helper do not deadlock and do not serialize', async () => {
      // Without this, the deadlock leg above could be "any two connections on
      // these keys deadlock". Both readers take SHARED locks in the SAME order,
      // so both proceed.
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        await Promise.all([
          acquireAttendanceW7CompositeFactsLocksV1(asTrx(a), { orgKey: orgId, userId }),
          acquireAttendanceW7CompositeFactsLocksV1(asTrx(b), { orgKey: orgId, userId }),
        ])
        // Both got here: no deadlock, no mutual block.
        expect(true).toBe(true)
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })
  })
})
