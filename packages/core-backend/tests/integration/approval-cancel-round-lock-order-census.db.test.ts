/**
 * Approval cancel-round — WI-0 lock-order census (real-PG), FIRST SLICE ONLY.
 *
 * Source of authority: `approval-change-request-design-lock-draft-20260915.md` v5.9 §3 (C-2,
 * lock:111 — "census not done before implementation"), §9-4 (lock:110, the RATIFIED abstract
 * order: rollout/advisory lock -> round-engine instance -> original document instance ->
 * attendance_requests -> balance batch), and §13 (lock:299, "review suggestions, NOT owner
 * ratify" — the concrete lock-site pairings Q-A/Q-B/Q-C/Q-D). Task breakdown: WI-0 in
 * `impl-taskbook-C-change-request-20260918.md`.
 *
 * SCOPE OF THIS FILE — Q-A ONLY, and only the first of its two pairings:
 *   Q-A asks whether the round-engine instance row AND the original document instance row
 *   (both `approval_instances` rows once WI-4's `createCancelRoundInstance` lands) can be locked
 *   in the §9-4 order without forming a cycle against the attendance class-`00` rollout advisory
 *   lock (`acquireAttendanceCalculationRolloutLock` / `buildAttendanceCalculationRolloutAdvisoryKey`,
 *   `w4c0-identity.ts`). WI-4's dedicated creation service does not exist on this branch yet (see
 *   the taskbook's PR-5 dependency), so this file cannot drive it through real application code.
 *   Instead — same technique as the standing precedent this file's shape is cloned from,
 *   `attendance-w7-3-context-source-transition.db.test.ts`'s "lock-order census" describe block
 *   (`docs/development/attendance-4556-w7-3-lock-order-census-20260815.md`) — it constructs the
 *   two lock acquisitions BY HAND with two real Postgres connections: the REAL production key
 *   derivation for class-`00` (imported, not reimplemented) against a REAL `approval_instances`
 *   row locked the same way `w4c3b-central-approval-hooks.ts` locks one (`SELECT ... FOR UPDATE`).
 *
 *   This covers only ONE of the two rows Q-A names (a single `approval_instances` row standing
 *   in for "an instance row locked under class-`00`"; it does not yet distinguish the round's
 *   engine-instance row from the original document's instance row, since WI-4 has not defined a
 *   stable sub-order between the two). Q-B (`attendance_requests` vs. class-`10`/`11`), Q-C
 *   (`record-link:row-auth` vs. class-`00`), and Q-D (re-confirming the W7-session-lock reverse
 *   edge still exists on `85ddd2926`) are NOT covered here — tracked as follow-up slices of this
 *   same WI-0, not silently dropped. This file's own conclusion is therefore PARTIAL, not a
 *   census-complete sign-off; per the taskbook's own discipline (§1.3), "no cycle" is not
 *   asserted as a ratified conclusion anywhere below — only what each constructed run observed.
 *
 * DISCIPLINE (memory: `feedback_toctou_needs_constructed_race.md`,
 * `feedback_positive_control_not_failclosed.md`): a passing "no deadlock" leg has zero
 * discriminating power unless paired with (a) proof the two connections actually contended
 * (a timed block, not a lucky non-overlap) and (b) a DELIBERATELY REVERSED order that produces a
 * DETERMINISTIC `40P01` — proving the harness can see a cycle when one exists, not just that it
 * failed to find one.
 */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
} from '../../src/attendance/w4c0-identity'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

// Sentinel deliberately OUTSIDE describeIfDatabase (top-level `it`, gated only on EXPECT_DB) —
// matches the landed pattern (approval-node-operation-policy.db.test.ts:36-42 and siblings): a
// sentinel nested inside describeIfDatabase would itself be skipped whenever DATABASE_URL is
// absent, so it could never catch a DB-expected lane whose DATABASE_URL is missing or broken.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase(
  'WI-0 lock-order census (Q-A, slice 1): approval_instances row lock vs. attendance class-`00` rollout advisory lock',
  () => {
    let pool: Pool
    const createdInstanceIds: string[] = []

    beforeAll(async () => {
      await ensureApprovalSchemaReady()
      pool = new Pool({ connectionString: dbUrl })
    }, 60000)

    afterAll(async () => {
      if (createdInstanceIds.length > 0) {
        await pool
          .query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
          .catch(() => undefined)
      }
      await pool?.end().catch(() => undefined)
    })

    async function seedInstanceRow(): Promise<string> {
      const id = `census-qa-${randomUUID()}`
      await pool.query("INSERT INTO approval_instances (id, status) VALUES ($1, 'approved')", [id])
      createdInstanceIds.push(id)
      return id
    }

    // The REAL production key derivation — not reimplemented — so a future change to the
    // formula is picked up by this file automatically instead of silently drifting from it.
    function rolloutKeyFor(orgId: string): bigint {
      return buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId))
    }

    it('§9-4 order (class-00 then instance row): a rollout holder BLOCKS a later instance-row acquisition, which proceeds once released', async () => {
      const orgId = randomUUID()
      const key = rolloutKeyFor(orgId)
      const instanceId = await seedInstanceRow()

      const holder = await pool.connect()
      const waiter = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
        await holder.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])

        await waiter.query('BEGIN')
        let settled = false
        const waiterAcquire = waiter
          .query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
          .then((result) => {
            settled = true
            return result
          })

        // The waiter must still be blocked: a non-contending harness would have "succeeded"
        // instantly, which is exactly the false-positive this timed check exists to catch.
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(settled, 'the second connection did not actually contend for the rollout key').toBe(false)

        await holder.query('COMMIT')
        await waiterAcquire
        expect(settled).toBe(true)
        // Having taken class-00, the waiter now takes the instance row — the row is free
        // because the holder released it in the same COMMIT — completing the §9-4 order.
        await waiter.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])
        await waiter.query('COMMIT')
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await waiter.query('ROLLBACK').catch(() => undefined)
        holder.release()
        waiter.release()
      }
    })

    it('the REVERSED order (instance row taken before class-00 on one side) deadlocks DETERMINISTICALLY (40P01)', async () => {
      // The standing proof this census slice rests on. No site in the tree takes this reversed
      // order today (WI-4/WI-10/WI-12 do not exist yet) — it is constructed by hand so that IF a
      // future implementation ever introduces one, Postgres's own detector — not a race that
      // fails rarely and silently under load — is what catches it, and this file demonstrates the
      // detector actually fires for this exact pair before any such site can exist.
      const orgId = randomUUID()
      const key = rolloutKeyFor(orgId)
      const instanceId = await seedInstanceRow()

      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        // A takes class-00 first (the §9-4 order).
        await a.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
        // B takes the instance row first (the REVERSE order).
        await b.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])

        const aSecond = a.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])
        const bSecond = b.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])

        const outcomes = await Promise.allSettled([aSecond, bSecond])
        const deadlocks = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        )
        // EXACTLY one victim: PostgreSQL aborts one side and lets the other proceed. Zero would
        // mean the cycle was never formed (the leg would be measuring nothing); two would mean
        // something else went wrong.
        expect(deadlocks.length, 'the constructed reverse order did not deadlock').toBe(1)
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })

    it('POSITIVE CONTROL: both connections following the §9-4 order (class-00 then instance row) do NOT deadlock', async () => {
      // Without this, the leg above could be passing because ANY two lock acquisitions on these
      // two primitives deadlock regardless of order. Both connections take class-00 then the
      // instance row — the §9-4 order — and both must complete.
      const orgId = randomUUID()
      const key = rolloutKeyFor(orgId)
      const instanceId = await seedInstanceRow()

      async function forwardOrder(client: PoolClient): Promise<void> {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
        await client.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])
        await client.query('COMMIT')
      }

      const a = await pool.connect()
      const b = await pool.connect()
      try {
        const outcomes = await Promise.allSettled([forwardOrder(a), forwardOrder(b)])
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })
  },
)
