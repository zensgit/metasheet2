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
 *
 * ADDENDUM (2026-09-17, WI-4 landed as `de9b94ce9`) — two sentences above are now STALE. Per this
 * lane's own supersession discipline, they are corrected here rather than silently rewritten; the
 * rest of each paragraph they sit in is untouched and still stands:
 *
 *   - "WI-4's dedicated creation service does not exist on this branch yet" (line ~16 above) is
 *     FALSE as of `de9b94ce9`: `ApprovalProductService.createCancelRoundInstance`
 *     (`packages/core-backend/src/services/ApprovalProductService.ts:8308`) is real, landed code.
 *   - "since WI-4 has not defined a stable sub-order between the two [rows]" (line ~27 above) no
 *     longer applies — but the CONCLUSION it supported ("this file covers only ONE of Q-A's two
 *     rows") is UNCHANGED and remains correct, for a reason WI-4's own code now makes explicit
 *     rather than merely unattempted:
 *
 *     At CREATE time (WI-4's transaction), only ONE `approval_instances` row exists — the
 *     original document. The round's own instance row is what this same transaction is in the
 *     process of INSERTing; there is nothing yet to take a second `FOR UPDATE` on. WI-4's own
 *     in-code comment says so directly (`ApprovalProductService.ts:8325-8327`): "no
 *     rollout/advisory lock is taken here at all (creation never touches W4 attendance
 *     calculation) — the only row this transaction must serialize against is the original
 *     document instance itself, locked FIRST and before any INSERT (Q-A)". Mechanically
 *     confirmed, not just quoted — `sed -n '8308,8545p' ApprovalProductService.ts | grep -c 'FOR
 *     UPDATE'` -> `1` (the original instance row, `:8329`); the same slice's only hit for
 *     `rollout` is inside that comment (`:8325`) — `grep -n
 *     'acquireAttendanceCalculationRolloutLock\|acquireContextSourceLockSessionExclusive\|pg_advisory'`
 *     over lines 8308-8545 -> zero matches. The function takes no W4/W7 advisory lock at all.
 *
 *     §9-4's "round-engine instance -> original document instance" sub-order therefore describes
 *     a DIFFERENT transaction — the C-2 final-approve dispatch, where BOTH rows already exist
 *     (the round's own instance is the one `dispatchAction` operates on, matching lock:109's
 *     "现有适配器...dispatchAction 先锁轮次引擎实例") — not WI-4's creation transaction, which
 *     only ever sees one row. WI-4 does not contradict §9-4; it sits outside the two-row case
 *     §9-4 is ordering. That C-2 transaction is not implemented on this branch (WI-4 is creation
 *     only), so this paragraph is a reading of the RATIFIED order against WI-4's actual code, not
 *     a census of code that does not exist yet — it is NOT a substitute for constructing Q-A's
 *     second pairing once C-2 lands.
 *
 * Q-D — head-scoped re-check (CLOSED for this lane's scope, read-only; no new `.db.test.ts`
 * needed). §13/lock:296 already treats Q-D's DEADLOCK MECHANISM as proven by real Postgres (not
 * PLAUSIBLE) at `attendance-w7-3-context-source-transition.db.test.ts:1836` (reverse order ->
 * deterministic `40P01`) with a positive control at `:1878` (writer's own order -> no deadlock).
 * The only open question was whether the reverse edge's PRECONDITION — the production writer
 * still taking the two locks the way that proof assumes — still holds on the CURRENT tree, and
 * whether this lane's own additions introduce a new site that could form the cycle. Re-verified
 * against this head: `git diff --stat origin/main..HEAD --
 * packages/core-backend/src/attendance/w7-context-source-transition.ts` is EMPTY — the file is
 * byte-for-byte unchanged from `origin/main`, so the lock's own line citations are exact, not
 * approximations that happened to still line up:
 *   - `:611` `LOW_62_MASK` (unchanged)
 *   - `:629` `buildAttendanceW7ContextSourceAdvisoryKeyV1` — mints the second, class-`00`-
 *     colliding key the lock names (unchanged)
 *   - `:671` `acquireContextSourceLockSessionExclusive` takes it via `pg_advisory_lock`
 *     (session-scoped, no xact release) — unchanged
 *   - The writer's real order, read end to end in `transitionAttendanceW7ContextSourceV1`: PHASE 1
 *     (`:1561`) takes the W7 session lock BEFORE opening any transaction; PHASE 2, conditionally
 *     (`:1064`, inside `if (canEvaluateDbPredicates && ...)`), takes the W4 class-`00` rollout
 *     lock SHARED via `acquireAttendanceCalculationRolloutLock` — i.e. W7-session-lock, then
 *     W4-class-`00`, exactly what the sibling proof's positive control exercises.
 * This lane's own additions introduce NO new site on either side of that pair: WI-4 takes zero
 * rollout/advisory locks (the Q-A correction above — 0 matches, mechanically confirmed) and never
 * touches `w7-context-source-transition.ts` or its advisory keyspace (empty diff, shown above).
 * Q-D's reverse-edge precondition holds unchanged and this lane introduces no competing edge.
 * The lock's own residual note — gate 16 (`w4c0-identity.test.ts:927`) sees this keyspace only
 * via single-module-export + name anchoring, and session-scope-vs-xact-scope mixing "needs
 * separate owner ruling" — is an ATTENDANCE-side census/ruling item, unchanged by this lane and
 * explicitly NOT attempted here (owner territory per §13's own framing).
 *
 * Q-B (`attendance_requests` vs. class-`10`/`11`) and Q-C (`record-link:row-auth` vs. class-`00`)
 * remain OPEN, untouched by this addendum, tracked as follow-up slices of this same WI-0 (not
 * silently dropped). Before attempting Q-B: grep whether a class-`10` key builder is exported
 * anywhere alongside `buildAttendanceCalculationRolloutAdvisoryKey` in `w4c0-identity.ts` AND
 * whether any production call site takes it; per lock:304 ("首期没有 class-11 就不要虚构它"), if
 * either is absent on this head the honest deliverable is "not constructible on this head" plus
 * that grep — not a synthesized pairing.
 *
 * CORRECTION (2026-09-17, before that grep was ever run): the sentence above is WITHDRAWN, not
 * followed. A first pass searched this file for the literal substring `class-10` and found zero
 * hits, which would have supported "not constructible" — but the source text spells it
 * ``class-`10` `` (with backticks around the digits), so a literal `class-10` search is a grep
 * bug, not evidence of absence (memory: `feedback_empty_read_is_not_absence.md`). Re-run with the
 * backtick-aware pattern, both class-`10` and class-`11` key builders exist and are exported
 * right beside `buildAttendanceCalculationRolloutAdvisoryKey`, and BOTH are taken by real
 * production code, not just defined:
 *   - class-`10` (`| CLASS_10_PREFIX`, `w4c0-identity.ts:970`):
 *     `buildAttendanceResultOperationAdvisoryKey` (`:1032`) and
 *     `buildAttendanceLegacyIdempotencyAdvisoryKey` (`:1072`).
 *   - class-`11` (`| CLASS_11_PREFIX`, `w4c0-identity.ts:970`):
 *     `buildAttendanceCalculationTargetAdvisoryKey` (`:1093`) and
 *     `buildAttendanceOperationalBulkTargetAdvisoryKey` (`:1100`).
 *   - production acquisition sites (the builders' own callers, not just their definitions —
 *     `grep -rln '<name>' packages/core-backend/src plugins --include='*.ts' --include='*.cjs' |
 *     grep -v '/__tests__/\|\.test\.\|/tests/'` per name, union not intersection):
 *     `acquireAttendanceResultOperationLocks` (`:1497`) ← `w4c3a-import-rollback-boundary.ts`,
 *     `w4c3a-rollout-control.ts`, `w4c3a-import-rollback.ts`;
 *     `acquireAttendanceImportReservationLocksV1` (`:1516`) ← `w4c3a-legacy-plan-processor.ts`,
 *     `w4c3a-sync-import-host.ts`, `w4c3a-legacy-plan-enqueue.ts`;
 *     `acquireAttendanceCalculationTargetLocks` (`:1546`) ← `w4c3a-legacy-plan-processor.ts`,
 *     `w4c3a-import-rollback-boundary.ts`, `w4c3a-rollout-control.ts`,
 *     `w4c3c-record-operation-boundary.ts`, `w4c3a-legacy-plan-enqueue.ts`,
 *     `w4c3a-import-rollback.ts`, `w4c2-live-scheduled-boundary.ts`;
 *     `acquireAttendanceOperationalBulkTargetLockV1` (`:1560`) ← `w4c3a-legacy-plan-processor.ts`,
 *     `w4c3a-legacy-plan-enqueue.ts` — a live, multi-caller keyspace, not a defined-but-dormant
 *     one.
 * Q-B is therefore CONSTRUCTIBLE on this head, not absent — lock:304's "首期没有 class-11 就不要
 * 虚构它" does not apply (class-`11` is not being invented; it already exists and is already
 * acquired). This correction only withdraws the (never-executed) "not constructible" shortcut; it
 * does not itself construct Q-B's census — that construction (which `attendance_requests` row and
 * which of the four builders above actually co-occur in one transaction, forward order, reversed
 * order, positive control) remains a follow-up slice of this same WI-0, unattempted here. Marking
 * the state at the claim, not voiding the paragraph (memory:
 * `feedback_supersession_marker_must_evaluate_not_void.md`).
 *
 * Q-C is a first-phase ABSENCE claim (lock:305: creation-
 * time auto-approve is forbidden, so `record-link:row-auth` never co-occurs with a W4 lock in
 * phase 1); per `feedback_positive_control_not_failclosed.md` an absence claim needs a positive
 * control proving the harness CAN see co-occurrence when it exists, not just a clean run —
 * roughly double the construction work of Q-D, and not attempted in this addendum.
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
