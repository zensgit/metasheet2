/**
 * Approval change-request design lock v5.9 §14.3 #10/#11 (lock:371-372) — WI-3's Q1c DDL package
 * real-DB acceptance (`zzzz20260918110000_add_attendance_requests_approval_workflow_key.ts`).
 * Taskbook (`impl-taskbook-C-change-request-20260918.md` §3.1/§4) names this file for four
 * cases: the migration's own preflight guard, the two `atr_*` CHECK constraints (each keyed by
 * `.constraint`, NOT merely by SQLSTATE — both share `23514`, so a bare code check cannot tell
 * them apart, memory: `feedback_not_this_error_is_not_an_outcome_assertion.md`), and #11's
 * "no independent guard, protected by #10" dependency claim.
 *
 * A SEPARATE THROWAWAY DATABASE per test (`CREATE DATABASE`/`DROP DATABASE`, the same pattern as
 * `attendance-w4c2-p12-durable-lock-gates.db.test.ts` and siblings), NOT an isolated schema
 * within the shared DB and NOT the shared migrated public schema. Two independent reasons force
 * a full database rather than a schema:
 *   1. the shared private DB (`metasheet2_lock_c`) already has this migration applied
 *      (constraints already exist on the real tables), so there is no "before" state left on it
 *      to dangle a reference against for the preflight case;
 *   2. (found while first drafting this file with an isolated-schema harness, then corrected —
 *      not a hypothetical) this migration's own idempotency guards
 *      (`SELECT 1 FROM pg_constraint WHERE conname = '...'`) are NOT schema-scoped — `pg_constraint`
 *      is a database-wide catalog keyed by name, with no `connamespace`/`current_schema()` filter
 *      in the guard's WHERE clause. Against `metasheet2_lock_c`, a same-named schema-local table
 *      never gets its constraints created at all: the guard sees `atr_instance_key_pair` etc.
 *      already present (on the UNRELATED public-schema table) and silently no-ops, so `up()`
 *      returns without error but the isolated-schema table stays completely unconstrained —
 *      every one of the CHECK tests below then observes `caught === undefined` (no rejection),
 *      which is a false pass waiting to happen, not a false failure. A separate database's
 *      `pg_constraint` starts empty, so the guards behave exactly as they do in a real first-ever
 *      deployment.
 * Each test hand-builds the two minimal columns this migration's own SQL actually touches
 * (`approval_instances(id, workflow_key)`, `attendance_requests(id, approval_instance_id)` —
 * `approval_workflow_key` is deliberately OMITTED from the initial CREATE so the migration's own
 * `ADD COLUMN IF NOT EXISTS` is exercised, not pre-empted), then calls the migration's exported
 * `up()` directly.
 *
 * The migration's own successful `up()` call inside every one of the CHECK/#11 tests below (no
 * dangling reference present) is the positive control for the preflight test's negative case
 * (memory: `feedback_positive_control_not_failclosed.md`) — three independent runs prove the
 * harness does not merely throw unconditionally.
 *
 * NOT covered by this file: WI-0 lock-order census, WI-4 creation, WI-7/8 outlet guards, WI-8
 * seat guards, WI-12/13/14 redemption (separate sibling files per the taskbook split);
 * attendance-parity — NOT attempted on this branch (unchanged conclusion), but the REASON below
 * is now stale, marked at the claim rather than rewritten (memory:
 * `feedback_supersession_marker_must_evaluate_not_void.md`):
 *
 * SUPERSEDED (2026-09-18): "blocked on WI-10/11, which are themselves blocked on WI-0's Q-B/Q-C
 * closing" is no longer true — `approval-cancel-round-lock-order-census.db.test.ts` now
 * constructs Q-B and Q-C (both green against this same private DB), so WI-0 no longer blocks
 * WI-10/WI-11 on that specific dependency. attendance-parity stays unattempted here for an
 * OWNER-SCOPE reason instead: 判据 II (final approve exercises C-1's real attendance
 * cancellation) and 判据 IV (C-3's system-side close) are named as a second-slice item in this
 * lane's own handoff (main-session ruling, not a technical blocker this file can close) —
 * restated here as blocked-with-reason, not as a residual WI-0 dependency.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { up } from '../../src/db/migrations/zzzz20260918110000_add_attendance_requests_approval_workflow_key'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'

interface ScratchDbCtx {
  scratchName: string
  adminPool: Pool
  testPool: Pool
  testDb: Kysely<unknown>
}

async function setupPreMigrationDatabase(): Promise<ScratchDbCtx> {
  const scratchName = `ms2_atrfk_${randomUUID().replace(/-/g, '').slice(0, 20)}`
  const adminUrl = new URL(dbUrl as string)
  adminUrl.pathname = '/postgres'
  const adminPool = new Pool({ connectionString: adminUrl.toString() })
  await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
  await adminPool.query(`CREATE DATABASE ${scratchName}`)

  const scratchUrl = new URL(dbUrl as string)
  scratchUrl.pathname = `/${scratchName}`
  const testPool = new Pool({ connectionString: scratchUrl.toString() })
  const testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

  // Minimal pre-migration shape: only the columns this migration's own SQL reads/writes.
  // `approval_workflow_key` is NOT created here — the migration's `ADD COLUMN IF NOT EXISTS` is
  // what is under test.
  await sql`
    CREATE TABLE approval_instances (
      id text PRIMARY KEY,
      workflow_key text
    )
  `.execute(testDb)
  await sql`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY,
      approval_instance_id text
    )
  `.execute(testDb)
  return { scratchName, adminPool, testPool, testDb }
}

async function teardownScratchDatabase(ctx: ScratchDbCtx): Promise<void> {
  for (const p of [ctx.testPool, ctx.adminPool]) p?.on('error', () => undefined)
  await ctx.testDb.destroy()
  await ctx.adminPool.query(`DROP DATABASE IF EXISTS ${ctx.scratchName} WITH (FORCE)`).catch(() => undefined)
  await ctx.adminPool.end()
}

function dbErrorInfo(caught: unknown): { code: string | null; constraint: string | null; message: string } {
  const e = caught as { code?: unknown; constraint?: unknown; message?: unknown }
  return {
    code: typeof e?.code === 'string' ? e.code : null,
    constraint: typeof e?.constraint === 'string' ? e.constraint : null,
    message: typeof e?.message === 'string' ? e.message : String(caught),
  }
}

/** Inserts a REAL (id, workflow_key='approval.cancel-round') pair into `approval_instances` (so
 * the composite FK target exists and the FK itself does not fire), then attempts to link an
 * `attendance_requests` row to it. Shared by the #10 CHECK test and the #11 dependency test —
 * same mechanism, two different framings (constraint name vs. resulting row count). */
async function attemptCancelRoundLink(ctx: ScratchDbCtx): Promise<{ caught: unknown; instanceId: string }> {
  const instanceId = randomUUID()
  await sql`INSERT INTO approval_instances (id, workflow_key) VALUES (${instanceId}, ${CANCEL_ROUND_WORKFLOW_KEY})`.execute(
    ctx.testDb,
  )
  let caught: unknown
  try {
    await sql`
      INSERT INTO attendance_requests (id, approval_instance_id, approval_workflow_key)
      VALUES (${randomUUID()}, ${instanceId}, ${CANCEL_ROUND_WORKFLOW_KEY})
    `.execute(ctx.testDb)
  } catch (error) {
    caught = error
  }
  return { caught, instanceId }
}

describeIfDatabase('WI-3 Q1c attendance FK migration (§14.3 #10/#11): real-DB acceptance', () => {
  it('migration preflight: dangling reference aborts migration', async () => {
    const ctx = await setupPreMigrationDatabase()
    try {
      const danglingRequestId = randomUUID()
      // `approval_instance_id` points at an approval_instances.id that was never inserted —
      // exactly the "dangling reference" the preflight SELECT's LEFT JOIN ... WHERE i.id IS NULL
      // branch is written to catch, BEFORE any constraint exists to reject it directly.
      await sql`
        INSERT INTO attendance_requests (id, approval_instance_id)
        VALUES (${danglingRequestId}, ${'no-such-approval-instance'})
      `.execute(ctx.testDb)

      let caught: unknown
      try {
        await up(ctx.testDb)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      const message = (caught as Error).message
      expect(message).toContain('preflight failed')
      expect(message).toContain('1 attendance_requests row(s)')
      expect(message).toContain(danglingRequestId)
    } finally {
      await teardownScratchDatabase(ctx)
    }
  })

  it('constraint: non-null approval_instance_id with NULL approval_workflow_key is rejected 23514 (atr_instance_key_pair)', async () => {
    const ctx = await setupPreMigrationDatabase()
    try {
      await up(ctx.testDb) // positive control: clean apply succeeds with no dangling rows present

      let caught: unknown
      try {
        // approval_workflow_key NULL means the composite FK (MATCH SIMPLE) is skipped entirely —
        // the only constraint left to fire is atr_instance_key_pair's paired-nullness CHECK, so
        // this test isolates that ONE constraint (not the FK, not atr_not_cancel_round).
        await sql`
          INSERT INTO attendance_requests (id, approval_instance_id, approval_workflow_key)
          VALUES (${randomUUID()}, ${'some-instance-id-never-validated-because-key-is-null'}, ${null})
        `.execute(ctx.testDb)
      } catch (error) {
        caught = error
      }
      const info = dbErrorInfo(caught)
      expect(info.code).toBe('23514')
      expect(info.constraint).toBe('atr_instance_key_pair')
    } finally {
      await teardownScratchDatabase(ctx)
    }
  })

  it('constraint: raw SQL pointing attendance_requests at a cancel round is rejected 23514 (atr_not_cancel_round)', async () => {
    const ctx = await setupPreMigrationDatabase()
    try {
      await up(ctx.testDb) // positive control: clean apply succeeds with no dangling rows present

      const { caught } = await attemptCancelRoundLink(ctx)
      const info = dbErrorInfo(caught)
      // The FK target (id, workflow_key='approval.cancel-round') is real, so the FK itself does
      // NOT fire here — only atr_not_cancel_round does. Discriminates from the previous test,
      // which shares the same SQLSTATE but a different `.constraint`.
      expect(info.code).toBe('23514')
      expect(info.constraint).toBe('atr_not_cancel_round')
    } finally {
      await teardownScratchDatabase(ctx)
    }
  })

  it('#11 relies on #10: attendance_requests cannot point at a cancel round to begin with', async () => {
    const ctx = await setupPreMigrationDatabase()
    try {
      await up(ctx.testDb)

      // #11 (upsertAttendanceApprovalInstance's ON CONFLICT ... SET status=EXCLUDED.status) has
      // NO independent guard of its own (lock:372) — its safety is entirely borrowed from #10's
      // CHECK. The acceptance criterion is therefore outcome-level, not just error-shape-level:
      // after the attempt, the row must not exist at all — not "exists with a different value".
      const { instanceId } = await attemptCancelRoundLink(ctx)
      const rows = await sql<{ cnt: string }>`
        SELECT count(*)::text AS cnt FROM attendance_requests WHERE approval_instance_id = ${instanceId}
      `.execute(ctx.testDb)
      expect(rows.rows[0]?.cnt).toBe('0')
    } finally {
      await teardownScratchDatabase(ctx)
    }
  })

  describe('five production writers pair the FK columns in the same statement (index.cjs)', () => {
    let source = ''

    beforeAll(() => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
      source = readFileSync(path.join(repoRoot, 'plugins/plugin-attendance/index.cjs'), 'utf8')
    })

    it('exactly 5 occurrences of approval_workflow_key exist in the plugin (census: no undocumented 6th writer, no dropped writer)', () => {
      // `grep -o approval_workflow_key plugins/plugin-attendance/index.cjs | wc -l` -> 5, matching
      // the migration file's own header census (4 INSERT column lists + 1 UPDATE SET clause).
      const occurrences = source.match(/approval_workflow_key/g) ?? []
      expect(occurrences.length).toBe(5)
    })

    it.each([
      ['executeGenericRequestCreate', 'async function executeGenericRequestCreate(trx, prepared)'],
      ['executeOutdoorRequestCreate', 'async function executeOutdoorRequestCreate(trx, prepared)'],
      ['executeScheduleDispatchRequestCreate', 'async function executeScheduleDispatchRequestCreate(trx, prepared)'],
      ['executeShiftSwapRequestCreate', 'async function executeShiftSwapRequestCreate(trx, prepared)'],
      ['executeRequestPendingEdit', 'execute: async function executeRequestPendingEdit(trx, prepared)'],
    ])('%s pairs approval_instance_id with approval_workflow_key in the same statement', (_name, anchor) => {
      const idx = source.indexOf(anchor)
      expect(idx, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0)
      const window = source.slice(idx, idx + 4000)
      expect(
        window,
        `${anchor}: approval_instance_id is not paired with approval_workflow_key within a 4000-char window`,
      ).toMatch(/approval_instance_id[\s\S]{0,120}approval_workflow_key|approval_workflow_key[\s\S]{0,120}approval_instance_id/)
    })
  })

  afterAll(() => {
    // Author-time discipline (not a CI-run assertion): the "five production writers" describe
    // block above is a SOURCE-TEXT guard (feedback_source_text_assertions_are_not_behaviour.md
    // caution acknowledged), and its actual discriminating power was probed twice during
    // authoring (cp backup -> targeted edit -> re-run -> cp restore -> cmp byte-identical, each
    // time), not merely asserted:
    //
    //   1. FIRST PROBE (revealed a real blind spot, corrected here rather than hidden):
    //      `executeGenericRequestCreate`'s VALUE `approvalPayload.workflowKey` (index.cjs:33650)
    //      was changed to a literal `null` while leaving the COLUMN NAME
    //      `approval_workflow_key` untouched in the INSERT's column list. Both this describe
    //      block's tests stayed GREEN — a source-text guard that only greps for the column-name
    //      string cannot see a value-level regression at all. This class of bug (column kept,
    //      value wrong) is NOT covered by the tests in this describe block; it is covered
    //      BEHAVIORALLY by the `atr_instance_key_pair` CHECK test above in this same file, which
    //      exercises the identical (`approval_instance_id` non-null, `approval_workflow_key`
    //      NULL) shape against a real Postgres and observes `23514`/`atr_instance_key_pair` —
    //      confirmed by that test passing on this exact tree, not merely inferred.
    //   2. SECOND PROBE (the taskbook's literal "dropping ... key write"): the column name AND
    //      its value AND its `$11` placeholder were all removed together from the same site
    //      (index.cjs:33636-33637,:33650). Both the "exactly 5 occurrences" count test (4, not
    //      5) and that site's own per-writer pairing test went RED. Restored and reconfirmed
    //      byte-identical with `cmp` both times; `git status --short
    //      plugins/plugin-attendance/index.cjs` empty after restore.
  })
})
