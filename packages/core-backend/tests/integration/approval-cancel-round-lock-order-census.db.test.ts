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
 *
 * ADDENDUM (2026-09-18) — Q-B and Q-C are now CONSTRUCTED, in two further `describeIfDatabase`
 * blocks below (not inline here, so the paragraphs above stay an accurate record of what THIS
 * addendum found and did NOT yet do — per `feedback_supersession_marker_must_evaluate_not_void.md`
 * the claim above is evaluated, not deleted):
 *   - Q-B: the same three-leg technique as Q-A (candidate order proven to genuinely contend via a
 *     timed block; the reversed order proven to deadlock deterministically at `40P01`; a positive
 *     control proving both sides following the candidate order do not deadlock) — now against a
 *     REAL `attendance_requests` row and the REAL class-`11` key
 *     (`buildAttendanceOperationalBulkTargetAdvisoryKey`, `w4c0-identity.ts:1100`).
 *   - Q-C: (a) a mechanical scan of `createCancelRoundInstance`'s own source (re-read fresh, not a
 *     hand-transcribed line range, and anchored at BOTH ends — a positive end-anchor on the
 *     method's own last distinctive token, not just a length floor — mutation-tested: an inserted
 *     `// record-link` comment at the method's tail turns the scan RED, confirmed by hand then
 *     reverted) confirming it contains zero `record-link`-shaped tokens, and (b) two positive
 *     controls proving the RUNTIME detection technique is not vacuous — one showing a `pg_locks`
 *     audit sees TWO distinct advisory locks when both are deliberately held in one transaction,
 *     one showing the two CAN be forced to deadlock (`40P01`) when taken by two connections in
 *     opposite orders. These are two SEPARATE proofs, not one covering the other: (a) is a static
 *     scan of one function's source text, mutation-tested on its own; (b) is a live-Postgres
 *     probe of the lock pair in general. Per lock:305's own framing (a review suggestion, not
 *     owner-ratified), none of this rules for or against WI-4 ever taking both together in a
 *     LATER phase — it establishes that today's absence is a verified reading of the code (not an
 *     unexercised regex) and that IF a future site combined them, both a `pg_locks` audit and
 *     Postgres's own deadlock detector would see it.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  buildAttendanceOperationalBulkTargetAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
} from '../../src/attendance/w4c0-identity'
import { acquireRecordLinkRowAuthLockOnQuery } from '../../src/services/approval-record-link-row-auth-lock'
import {
  classifyAndLockAttendanceRequestForInstance,
  classifyAttendanceRequestForInstanceV1,
} from '../../src/attendance/w4c3b-central-approval-hooks'
import { resolveCancelRoundRolloutLockRequirementV1 } from '../../src/services/ApprovalProductService'
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

describeIfDatabase(
  'WI-0 lock-order census (Q-B): attendance_requests row lock vs. attendance class-`11` operational-bulk-target advisory lock',
  () => {
    let pool: Pool
    const createdInstanceIds: string[] = []
    const createdRequestIds: string[] = []

    beforeAll(async () => {
      await ensureApprovalSchemaReady()
      pool = new Pool({ connectionString: dbUrl })
    }, 60000)

    afterAll(async () => {
      if (createdRequestIds.length > 0) {
        await pool
          .query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds])
          .catch(() => undefined)
      }
      if (createdInstanceIds.length > 0) {
        await pool
          .query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
          .catch(() => undefined)
      }
      await pool?.end().catch(() => undefined)
    })

    // A non-cancel-round workflow key (`atr_not_cancel_round`, WI-3's Q1c migration, forbids the
    // reserved one) paired identically on both sides of the composite FK
    // (`attendance_requests_instance_workflow_fkey` on (approval_instance_id,
    // approval_workflow_key) -> approval_instances(id, workflow_key)) — the exact pairing that
    // migration requires, confirmed present on this private DB (`\d attendance_requests`).
    const REQUEST_WORKFLOW_KEY = 'attendance.request'

    async function seedRequestRow(): Promise<string> {
      const instanceId = `census-qb-instance-${randomUUID()}`
      await pool.query("INSERT INTO approval_instances (id, status, workflow_key) VALUES ($1, 'approved', $2)", [
        instanceId,
        REQUEST_WORKFLOW_KEY,
      ])
      createdInstanceIds.push(instanceId)
      const requestId = randomUUID()
      // user_id/work_date/request_type/org_id are NOT NULL on the real (shared) table with no
      // default for the first three — the throwaway-scratch-DB sibling tests (fk-migration) can
      // skip them because THEIR CREATE TABLE only has the two columns the migration itself
      // touches; this file runs against the real migrated schema, so all of them are required.
      // org_id is a RANDOMIZED value, not the literal `'default'` — this file's own tests run
      // inside `plugin-tests.yml` alongside ~124 other attendance real-DB files on the SAME
      // shared DB (`attendance-w4c3b-request-snapshots.db.test.ts`'s header names one concrete
      // cross-file collision on this exact table); several siblings aggregate
      // `attendance_requests` by `org_id` (e.g. `approval-org-writer-w4-s1.db.test.ts:183`,
      // `attendance-approval-manager-at-level-s7-4.db.test.ts`) — `'default'` is the single most
      // shared org value in the repo and would risk polluting one of those counts. Nothing in the
      // three legs below depends on org_id being a real org; the class-11 key already comes from
      // its own separately randomized `orgId`.
      const requestOrgId = `census-qb-org-${randomUUID()}`
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
         VALUES ($1, $2, CURRENT_DATE, 'missed_check_in', 'pending', $3, $4, $5)`,
        [requestId, `census-qb-user-${randomUUID()}`, requestOrgId, instanceId, REQUEST_WORKFLOW_KEY],
      )
      createdRequestIds.push(requestId)
      return requestId
    }

    // The REAL production key derivation for class-`11` — not reimplemented — so a future change
    // to the formula is picked up by this file automatically instead of silently drifting from it.
    // Unlike the other three class-`10`/`11` builders (which require a witness-checked identity,
    // §9-4's own factory/rehydrator discipline), this one takes only a parsed org key — same shape
    // as Q-A's class-`00` builder — which is why it is the one this census slice exercises: it is
    // a REAL, multi-caller production keyspace (`w4c3a-legacy-plan-processor.ts`,
    // `w4c3a-legacy-plan-enqueue.ts`), not a defined-but-dormant one (lock:304).
    function targetKeyFor(orgId: string): bigint {
      return buildAttendanceOperationalBulkTargetAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId))
    }

    it('candidate order (class-11 then attendance_requests row): a target-lock holder BLOCKS a later row acquisition, which proceeds once released', async () => {
      const orgId = randomUUID()
      const key = targetKeyFor(orgId)
      const requestId = await seedRequestRow()

      const holder = await pool.connect()
      const waiter = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
        await holder.query('SELECT id FROM attendance_requests WHERE id = $1 FOR UPDATE', [requestId])

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
        expect(settled, 'the second connection did not actually contend for the class-11 key').toBe(false)

        await holder.query('COMMIT')
        await waiterAcquire
        expect(settled).toBe(true)
        // Having taken class-11, the waiter now takes the row — free because the holder released
        // it in the same COMMIT — completing the candidate order.
        await waiter.query('SELECT id FROM attendance_requests WHERE id = $1 FOR UPDATE', [requestId])
        await waiter.query('COMMIT')
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await waiter.query('ROLLBACK').catch(() => undefined)
        holder.release()
        waiter.release()
      }
    })

    it('the REVERSED order (attendance_requests row taken before class-11 on one side) deadlocks DETERMINISTICALLY (40P01)', async () => {
      // No site in the tree takes this reversed order today (WI-10/WI-11 do not exist yet) —
      // constructed by hand so that IF a future implementation ever introduces one, Postgres's own
      // detector — not a race that fails rarely and silently under load — is what catches it.
      const orgId = randomUUID()
      const key = targetKeyFor(orgId)
      const requestId = await seedRequestRow()

      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        // A takes class-11 first (the candidate order).
        await a.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
        // B takes the row first (the REVERSE order).
        await b.query('SELECT id FROM attendance_requests WHERE id = $1 FOR UPDATE', [requestId])

        const aSecond = a.query('SELECT id FROM attendance_requests WHERE id = $1 FOR UPDATE', [requestId])
        const bSecond = b.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])

        const outcomes = await Promise.allSettled([aSecond, bSecond])
        const deadlocks = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        )
        // EXACTLY one victim: zero would mean the cycle was never formed; two would mean
        // something else went wrong.
        expect(deadlocks.length, 'the constructed reverse order did not deadlock').toBe(1)
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })

    it('POSITIVE CONTROL: both connections following the candidate order (class-11 then attendance_requests row) do NOT deadlock', async () => {
      // Without this, the leg above could be passing because ANY two lock acquisitions on these
      // two primitives deadlock regardless of order.
      const orgId = randomUUID()
      const key = targetKeyFor(orgId)
      const requestId = await seedRequestRow()

      async function forwardOrder(client: PoolClient): Promise<void> {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()])
        await client.query('SELECT id FROM attendance_requests WHERE id = $1 FOR UPDATE', [requestId])
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

describeIfDatabase(
  'WI-0 lock-order census (Q-C): record-link:row-auth advisory lock vs. attendance class-`00` rollout advisory lock',
  () => {
    // (a) MECHANICAL ABSENCE SCAN. §13/lock:305's suggestion (review, NOT owner-ratified) is that
    // `record-link:row-auth` never co-occurs with a W4 lock during creation. This re-reads
    // `createCancelRoundInstance`'s own source FRESH (not a hand-transcribed line range carried
    // over from the Q-A addendum above) so a future edit that moves the function cannot leave a
    // stale "0 matches" claim standing unnoticed.
    it('ABSENCE: createCancelRoundInstance never references the record-link row-auth lock (mechanical scan, re-read fresh)', () => {
      const sourcePath = join(__dirname, '../../src/services/ApprovalProductService.ts')
      const source = readFileSync(sourcePath, 'utf8')
      const startMarker = 'async createCancelRoundInstance('
      const startIndex = source.indexOf(startMarker)
      expect(
        startIndex,
        'createCancelRoundInstance not found — source moved, re-locate before trusting this scan',
      ).toBeGreaterThan(-1)
      expect(source.indexOf(startMarker, startIndex + 1), 'more than one match for the start marker').toBe(-1)
      // The method body ends at the first `\n  }\n` (two-space class-method indent) after the
      // start marker — the same boundary the Q-A addendum located by hand (`sed -n
      // '8308,8545p'`), now re-derived from source text so a line-number shift cannot silently
      // narrow or widen the scanned range.
      const closeMarker = '\n  }\n'
      const closeIndex = source.indexOf(closeMarker, startIndex)
      expect(closeIndex, 'method close brace not found after createCancelRoundInstance').toBeGreaterThan(startIndex)
      const body = source.slice(startIndex, closeIndex)
      // POSITIVE END-ANCHOR, not just a length floor: `body` must contain the method's own last
      // distinctive token (the error code on its final throw) so a boundary bug that grabbed only
      // a prefix of the method fails LOUDLY here instead of silently under-scanning and passing
      // the `record-link` check for the wrong reason (memory:
      // `feedback_source_text_assertions_are_not_behaviour.md` — an unexercised regex proves
      // nothing; this anchor is what makes the window itself trustworthy). Mutation-tested: a
      // `// record-link` comment inserted immediately before `return approval` at the method's own
      // tail turns this test RED (confirmed by hand, then reverted — see this commit's message).
      expect(body, 'scanned body does not reach the method tail — boundary detection likely wrong').toContain(
        'CANCEL_ROUND_CREATE_FAILED',
      )
      const hits = body.match(/record.?link/gi) ?? []
      expect(
        hits,
        `createCancelRoundInstance must not reference the record-link row-auth lock; found: ${JSON.stringify(hits)}`,
      ).toEqual([])
    })

    let pool: Pool

    beforeAll(async () => {
      await ensureApprovalSchemaReady()
      pool = new Pool({ connectionString: dbUrl })
    }, 60000)

    afterAll(async () => {
      await pool?.end().catch(() => undefined)
    })

    function rolloutKeyFor(orgId: string): bigint {
      return buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId))
    }

    // The REAL production helper — imported, not reimplemented (`approval-record-link-row-auth
    // -lock.ts`). `record_permissions` has zero rows for a freshly randomised (sheetId, recordId)
    // pair, so the helper's own internal `FOR UPDATE` is a real query against a real table but
    // never contends with anything — only the `pg_advisory_xact_lock(hashtext(...))` call at the
    // top of the helper is load-bearing for this file's two legs below.
    async function takeRecordLinkLock(client: PoolClient, sheetId: string, recordId: string): Promise<void> {
      await acquireRecordLinkRowAuthLockOnQuery(
        (sqlText: string, params?: unknown[]) => client.query(sqlText, params),
        sheetId,
        recordId,
      )
    }

    it('POSITIVE CONTROL: holding BOTH locks in one transaction is VISIBLE to a pg_locks audit as two distinct advisory locks', async () => {
      // Proves the detection technique itself, independent of whether any production code takes
      // this path today (it does not — see the ABSENCE scan above): if a future implementation
      // DID combine these two locks, an audit query over `pg_locks` filtered to this backend would
      // see two DISTINCT (classid, objid) advisory-lock rows, not a coalesced one and not zero.
      // Empirically confirmed independent of this test file (`psql`, same DB): a bigint-keyed
      // `pg_advisory_xact_lock` and a `pg_advisory_xact_lock(hashtext(...))` both land at
      // `objsubid = 1` with distinct (classid, objid) pairs — this is the single-key form for
      // BOTH call shapes, not a session/xact-scope artifact.
      const orgId = randomUUID()
      const sheetId = `census-qc-sheet-${randomUUID()}`
      const recordId = `census-qc-record-${randomUUID()}`
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [rolloutKeyFor(orgId).toString()])
        await takeRecordLinkLock(client, sheetId, recordId)

        const pidResult = await client.query('SELECT pg_backend_pid()::int AS pid')
        const pid = pidResult.rows[0].pid as number
        const locksResult = await client.query(
          "SELECT DISTINCT classid, objid FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND objsubid = 1",
          [pid],
        )
        expect(
          locksResult.rows.length,
          `expected 2 distinct advisory locks held on this backend, saw: ${JSON.stringify(locksResult.rows)}`,
        ).toBe(2)
        await client.query('COMMIT')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('POSITIVE CONTROL: the two locks CAN be forced to deadlock (40P01) when two connections take them in opposite orders', async () => {
      // Completes the "harness can see co-occurrence" proof: not only can a `pg_locks` audit see
      // both locks held at once (leg above), Postgres's own cycle detector fires if a future
      // implementation ever combined them in opposing orders across two transactions — the SAME
      // mechanism Q-A/Q-B/Q-D above rely on, applied to this pair.
      const orgId = randomUUID()
      const rolloutKey = rolloutKeyFor(orgId)
      const sheetId = `census-qc-sheet-${randomUUID()}`
      const recordId = `census-qc-record-${randomUUID()}`

      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        // A takes class-00 first.
        await a.query('SELECT pg_advisory_xact_lock($1::bigint)', [rolloutKey.toString()])
        // B takes record-link:row-auth first (the REVERSE order).
        await takeRecordLinkLock(b, sheetId, recordId)

        const aSecond = takeRecordLinkLock(a, sheetId, recordId)
        const bSecond = b.query('SELECT pg_advisory_xact_lock($1::bigint)', [rolloutKey.toString()])

        const outcomes = await Promise.allSettled([aSecond, bSecond])
        const deadlocks = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        )
        expect(deadlocks.length, 'the constructed reverse order did not deadlock').toBe(1)
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })
  },
)

describeIfDatabase(
  'WI-0 lock-order census (Q-D, phase 2): the NEW pair — original document instance row vs. the ' +
    '`approval_rounds` pending row, introduced by the 判据 IV close at outlet #5′',
  () => {
    /**
     * Why this leg exists, and why it is not covered by Q-A/Q-B/Q-C.
     *
     * Phase 2's `evaluateCancelRoundFinalInLock` is the first site in the tree that takes a
     * `FOR UPDATE` on an `approval_rounds` row at all (`git grep -n "FROM approval_rounds" -- src`
     * before it: every other read is unlocked, and 判据 III's terminations are bare `UPDATE`s). It
     * takes that lock in the same transaction as a `FOR UPDATE` on the ORIGINAL document instance,
     * so it creates a lock PAIR that no census leg had a denominator for — precisely the closed-
     * world hazard this lane keeps hitting. Q-A/Q-B/Q-C are all {row lock, advisory lock} pairs;
     * this one is {row lock, row lock} across two different tables.
     *
     * The counterparty is `createCancelRoundInstance`, which locks the original document FIRST and
     * only then touches `approval_rounds` — and its INSERT does not merely "touch" it: the partial
     * unique index `uq_approval_rounds_pending_document … WHERE outcome = 'pending'` makes that
     * INSERT WAIT on any uncommitted change to that document's pending round. That is the second
     * edge, and it is invisible to a reading that only looks for explicit `FOR UPDATE`s.
     *
     * The three legs below are the same technique as Q-A/Q-B: the reversed order proven to
     * deadlock deterministically (the standing proof), the shipped order proven not to, and the
     * shipped order's own outcome asserted so the "no deadlock" is not just "nothing happened".
     */
    let pool: Pool
    const createdInstanceIds: string[] = []
    const createdRoundIds: string[] = []

    beforeAll(async () => {
      await ensureApprovalSchemaReady()
      pool = new Pool({ connectionString: dbUrl })
    }, 60000)

    afterAll(async () => {
      if (createdRoundIds.length > 0) {
        await pool
          .query('DELETE FROM approval_rounds WHERE id = ANY($1::text[])', [createdRoundIds])
          .catch(() => undefined)
      }
      if (createdInstanceIds.length > 0) {
        await pool
          .query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
          .catch(() => undefined)
      }
      await pool?.end().catch(() => undefined)
    })

    /** An `approved` document with one `pending` cancel round on it, and its engine instance. */
    async function seedDocumentWithPendingRound(): Promise<{ documentId: string; engineId: string }> {
      const documentId = `census-qd-doc-${randomUUID()}`
      const engineId = `census-qd-eng-${randomUUID()}`
      const roundId = `apr_qd_${randomUUID().replace(/-/g, '')}`
      await pool.query(
        `INSERT INTO approval_instances (id, status) VALUES ($1, 'approved'), ($2, 'pending')`,
        [documentId, engineId],
      )
      createdInstanceIds.push(documentId, engineId)
      await pool.query(
        `INSERT INTO approval_rounds
         (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
         VALUES ($1, $2, 'cancel', $3, 'census-qd', 'pending', '{}'::jsonb)`,
        [roundId, documentId, engineId],
      )
      createdRoundIds.push(roundId)
      return { documentId, engineId }
    }

    /** The creator's side: lock the original document, then INSERT a second pending round for it. */
    async function creatorInsert(client: PoolClient, documentId: string): Promise<void> {
      const roundId = `apr_qd2_${randomUUID().replace(/-/g, '')}`
      createdRoundIds.push(roundId)
      await client.query(
        `INSERT INTO approval_rounds
         (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
         VALUES ($1, $2, 'cancel', NULL, 'census-qd', 'pending', '{}'::jsonb)`,
        [roundId, documentId],
      )
    }

    it('the REVERSED order (closer takes the ROUND row before the document row) deadlocks DETERMINISTICALLY (40P01)', async () => {
      const { documentId, engineId } = await seedDocumentWithPendingRound()
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        // A = creator: document row FIRST.
        await a.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [documentId])
        // B = closer, REVERSED: the round row first, then the document row.
        await b.query(
          `SELECT id FROM approval_rounds WHERE engine_instance_id = $1 AND outcome = 'pending' FOR UPDATE`,
          [engineId],
        )
        await b.query(
          `UPDATE approval_rounds SET outcome = 'expired', ended_at = now()
            WHERE engine_instance_id = $1 AND outcome = 'pending'`,
          [engineId],
        )
        const bSecond = b.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [documentId])
        // A's INSERT now waits on B's uncommitted change to the SAME document's pending round,
        // via the partial unique index — closing the cycle.
        const aSecond = creatorInsert(a, documentId)

        const outcomes = await Promise.allSettled([aSecond, bSecond])
        const deadlocks = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        )
        expect(deadlocks.length, 'the constructed reverse order did not deadlock').toBe(1)
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })

    it('POSITIVE CONTROL — the SHIPPED order (closer takes the document row before the round row) does NOT deadlock, and BOTH sides reach a defined outcome', async () => {
      const { documentId, engineId } = await seedDocumentWithPendingRound()
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        await a.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [documentId])
        // B follows the shipped order: it blocks on the DOCUMENT row before it can touch the round.
        const bClose = (async () => {
          await b.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [documentId])
          await b.query(
            `SELECT id FROM approval_rounds WHERE engine_instance_id = $1 AND outcome = 'pending' FOR UPDATE`,
            [engineId],
          )
          await b.query(
            `UPDATE approval_rounds SET outcome = 'expired', ended_at = now()
              WHERE engine_instance_id = $1 AND outcome = 'pending'`,
            [engineId],
          )
        })()

        // A's INSERT does NOT wait on B (B has not touched the round row — it is still queued on
        // the document row), so A resolves on its own merits: the existing pending round makes it
        // a 23505 on the partial unique index, which `createCancelRoundInstance` already
        // translates into `CANCEL_ROUND_ALREADY_PENDING`.
        const aOutcome = await creatorInsert(a, documentId).then(
          () => 'inserted',
          (error: { code?: string }) => error.code,
        )
        expect(aOutcome).toBe('23505')
        await a.query('COMMIT')

        // Neither side deadlocked: B proceeds once A releases the document row.
        await expect(bClose).resolves.toBeUndefined()
        await b.query('COMMIT')

        const round = await pool.query<{ outcome: string }>(
          `SELECT outcome FROM approval_rounds WHERE engine_instance_id = $1`,
          [engineId],
        )
        expect(round.rows[0]?.outcome).toBe('expired')
      } finally {
        await a.query('ROLLBACK').catch(() => undefined)
        await b.query('ROLLBACK').catch(() => undefined)
        a.release()
        b.release()
      }
    })

    it('the production closer takes the two in the shipped order (source scan, anchored at both ends)', () => {
      const source = readFileSync(
        join(__dirname, '../../src/services/ApprovalProductService.ts'),
        'utf8',
      )
      const method = source.slice(source.indexOf('private async evaluateCancelRoundFinalInLock('))
      const body = method.slice(0, method.indexOf('private async closeCancelRoundSystemTerminalInTxn('))
      expect(body.length).toBeGreaterThan(500)
      const docLock = body.indexOf('FROM approval_instances WHERE id = $1 FOR UPDATE')
      const roundLock = body.indexOf("WHERE engine_instance_id = $1 AND outcome = 'pending'\n        FOR UPDATE")
      expect(docLock, 'the document-instance FOR UPDATE was not found in the evaluator').toBeGreaterThan(-1)
      expect(roundLock, 'the round-row FOR UPDATE was not found in the evaluator').toBeGreaterThan(-1)
      // The whole point of Q-D: document row FIRST.
      expect(docLock).toBeLessThan(roundLock)
    })
  },
)

/**
 * Q-E (2026-09-18) — WHICH org key must 判据 II take the rollout lock on?
 *
 * Opened because §3.3b of the phase-2 verification MD named the rollout-lock ordering as 判据 II's
 * prerequisite but did NOT say which org the lock is keyed by, and the lock's own rule is
 * 「census 未做前不实现」. The answer decides what the `dispatchAction` pre-read must SELECT, so it
 * is settled here — with rows, not by reading one line of a type — BEFORE the restructure.
 *
 * The naive answer is `approval_instances.org_id`: the cancel round carries one
 * (`createCancelRoundInstance` copies `original.org_id`), it is one hop from the instance
 * `dispatchAction` already loads, and it is the column the approval side thinks in. **It is the
 * wrong column.** The demand comes from `assertExternalTransactionRolloutLockHeldV1`, which the
 * protocol calls with `identityPrepared.orgId` — the org the ADAPTER resolved in
 * `prepareIdentity`, whose contract (`AttendanceRequestOperationAdapterV1`) restricts it to
 * 「durable route identity (for example request org/subject)」, i.e. the `attendance_requests`
 * row. Leg 1 proves the two columns can hold different values on the very row shape a cancel
 * round runs on, so this is a live divergence and not a naming quibble.
 *
 * Leg 3 is the reason this census could not be answered by 「reuse the existing helper」: the repo
 * already contains TWO joins from an approval instance to its attendance request, and they do not
 * agree. Per `feedback_single_definition_does_not_make_a_narrow_predicate_correct.md`, picking one
 * by name would have inherited its predicate silently.
 */
describeIfDatabase('WI-0 lock-order census (Q-E): which org key 判据 II must take the rollout lock on', () => {
  let pool: Pool
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []
  const ATTENDANCE_WORKFLOW_KEY = 'attendance.request'
  const CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'

  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    pool = new Pool({ connectionString: dbUrl })
  }, 60000)

  afterAll(async () => {
    if (createdRequestIds.length > 0) {
      await pool
        .query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds])
        .catch(() => undefined)
    }
    if (createdInstanceIds.length > 0) {
      await pool
        .query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
        .catch(() => undefined)
    }
    await pool?.end().catch(() => undefined)
  })

  function rolloutKeyFor(orgId: string): bigint {
    return buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId))
  }

  /**
   * The row shape a cancel round actually runs on: an ORIGINAL attendance approval instance whose
   * `org_id` is stamped independently of the `attendance_requests` row it points at, plus the
   * cancel-round engine instance that `createCancelRoundInstance` builds from it (`business_key`
   * = the original's id, `org_id` copied from the original).
   *
   * `instanceOrg` and `requestOrg` are deliberately DIFFERENT canonical UUIDs. That is not a
   * contrived fixture: §the immutability census in the phase-2 verification MD found FOUR
   * `org_id = EXCLUDED.org_id` writers on `attendance_requests` and none on this path that keeps
   * the two in step, so nothing in the schema or the code pins them together.
   */
  async function seedCancelRoundOverAttendanceRequest(): Promise<{
    roundInstanceId: string
    originalInstanceId: string
    requestId: string
    instanceOrg: string
    requestOrg: string
  }> {
    const instanceOrg = randomUUID()
    const requestOrg = randomUUID()
    const originalInstanceId = `census-qe-original-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, org_id) VALUES ($1, 'approved', $2, $3)`,
      [originalInstanceId, ATTENDANCE_WORKFLOW_KEY, instanceOrg],
    )
    createdInstanceIds.push(originalInstanceId)

    const requestId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
       VALUES ($1, $2, CURRENT_DATE, 'leave', 'approved', $3, $4, $5)`,
      [requestId, `census-qe-user-${randomUUID()}`, requestOrg, originalInstanceId, ATTENDANCE_WORKFLOW_KEY],
    )
    createdRequestIds.push(requestId)

    const roundInstanceId = `census-qe-round-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
       VALUES ($1, 'pending', $2, $3, $4)`,
      [roundInstanceId, CANCEL_ROUND_WORKFLOW_KEY, originalInstanceId, instanceOrg],
    )
    createdInstanceIds.push(roundInstanceId)

    return { roundInstanceId, originalInstanceId, requestId, instanceOrg, requestOrg }
  }

  it('LEG 1: the cancel round`s own org_id and the attendance request`s org_id can DIVERGE — so a pre-read on approval_instances.org_id would take the WRONG rollout lock', async () => {
    const seeded = await seedCancelRoundOverAttendanceRequest()

    // What the approval side would reach for (one hop from the instance dispatchAction loads).
    const roundRow = await pool.query<{ org_id: string | null; business_key: string | null }>(
      `SELECT org_id::text AS org_id, business_key::text AS business_key FROM approval_instances WHERE id = $1`,
      [seeded.roundInstanceId],
    )
    expect(roundRow.rows[0]?.org_id).toBe(seeded.instanceOrg)
    expect(roundRow.rows[0]?.business_key).toBe(seeded.originalInstanceId)

    // What `prepareIdentity` resolves, and therefore what the entry demands.
    const requestRow = await pool.query<{ org_id: string }>(
      `SELECT org_id::text AS org_id FROM attendance_requests WHERE id = $1`,
      [seeded.requestId],
    )
    expect(requestRow.rows[0]?.org_id).toBe(seeded.requestOrg)

    // The two orgs are different, and — the part that actually bites — they derive DIFFERENT
    // class-`00` advisory keys through the real production builder. A pre-read on the instance
    // column would take key(instanceOrg); the entry would then look for key(requestOrg) in
    // `pg_locks` and fail closed with W4C3B_REQUEST_EXTERNAL_TRANSACTION_ROLLOUT_LOCK_NOT_HELD.
    expect(seeded.instanceOrg).not.toBe(seeded.requestOrg)
    expect(rolloutKeyFor(seeded.instanceOrg)).not.toBe(rolloutKeyFor(seeded.requestOrg))
  })

  it('LEG 2 (POSITIVE CONTROL for leg 1`s key comparison): the SAME org derives the SAME key, so leg 1`s inequality is a real divergence and not a builder that never repeats', async () => {
    const org = randomUUID()
    expect(rolloutKeyFor(org)).toBe(rolloutKeyFor(org))
    // …and the builder is the production one, so a formula change cannot leave this census stale.
    expect(typeof rolloutKeyFor(org)).toBe('bigint')
  })

  it('LEG 3: the repo`s TWO existing instance→request joins DISAGREE on a two-candidate fixture — so 「reuse the existing helper」 is not a single well-defined instruction', async () => {
    // Both rows point at the SAME original instance, with different orgs. Row A is reachable only
    // through `approval_instance_id`; row B is reachable through BOTH `approval_instance_id` and
    // the `attendance-request:<id>` business_key form.
    const instanceOrg = randomUUID()
    const orgA = randomUUID()
    const orgB = randomUUID()
    const originalInstanceId = `census-qe3-original-${randomUUID()}`
    const requestB = randomUUID()
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
       VALUES ($1, 'approved', $2, $3, $4)`,
      [originalInstanceId, ATTENDANCE_WORKFLOW_KEY, `attendance-request:${requestB}`, instanceOrg],
    )
    createdInstanceIds.push(originalInstanceId)

    const requestA = randomUUID()
    for (const [id, org] of [
      [requestA, orgA],
      [requestB, orgB],
    ] as const) {
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
         VALUES ($1, $2, CURRENT_DATE, 'leave', 'approved', $3, $4, $5)`,
        [id, `census-qe3-user-${randomUUID()}`, org, originalInstanceId, ATTENDANCE_WORKFLOW_KEY],
      )
      createdRequestIds.push(id)
    }

    // Derivation 1 — the REAL production function, called, not transcribed. (An earlier draft of
    // this leg re-typed its SQL into the test; that would have gone on passing if production
    // drifted, which is the whole failure mode this census exists to prevent.) It takes
    // `FOR UPDATE`, so it needs a transaction of its own.
    const classifierClient = await pool.connect()
    let classified: Awaited<ReturnType<typeof classifyAndLockAttendanceRequestForInstance>>
    try {
      await classifierClient.query('BEGIN')
      classified = await classifyAndLockAttendanceRequestForInstance(classifierClient, {
        id: originalInstanceId,
        workflow_key: ATTENDANCE_WORKFLOW_KEY,
        business_key: `attendance-request:${requestB}`,
      })
      await classifierClient.query('COMMIT')
    } finally {
      await classifierClient.query('ROLLBACK').catch(() => undefined)
      classifierClient.release()
    }
    expect(classified.kind).toBe('attendance')
    const classifiedRequest = classified.kind === 'attendance' ? classified.request : null
    expect(classifiedRequest).not.toBeNull()
    // Business-key match is PREFERRED by its explicit ORDER BY, then LIMIT 1. Deterministic: row B.
    expect(classifiedRequest?.requestId).toBe(requestB)
    expect(classifiedRequest?.orgId).toBe(orgB)

    // Derivation 2 — `filterBulkReassignDiscoveryForAttendance`'s LEFT JOIN (hooks:452-463). It
    // carries NO `approval_instance_id IS NULL OR = i.id` safety clause, NO ORDER BY and NO LIMIT,
    // so on this fixture it returns BOTH rows. Its consumer folds them into a Map keyed by
    // instance id, so whichever row Postgres hands back LAST silently wins the org.
    const joined = await pool.query<{ id: string; org_id: string }>(
      `SELECT r.id::text AS id, r.org_id::text AS org_id
         FROM approval_instances i
         LEFT JOIN attendance_requests r
           ON i.workflow_key = $2
          AND ((i.business_key IS NOT NULL AND i.business_key = ($3 || r.id::text))
               OR r.approval_instance_id = i.id)
        WHERE i.id = ANY($1::text[])`,
      [[originalInstanceId], ATTENDANCE_WORKFLOW_KEY, 'attendance-request:'],
    )
    expect(joined.rows).toHaveLength(2)
    const joinedOrgs = new Set(joined.rows.map((row) => row.org_id))
    expect(joinedOrgs).toEqual(new Set([orgA, orgB]))

    // The discriminating claim: one derivation pins a single org, the other admits an org the
    // first one REJECTED. A pre-read built on derivation 2 could take key(orgA) while the entry
    // demands key(orgB).
    expect(joinedOrgs.has(orgA)).toBe(true)
    expect(classifiedRequest?.orgId).not.toBe(orgA)
  })

  it('LEG 4: the entry demands the org `prepareIdentity` resolved — source scan, anchored at both ends', () => {
    const source = readFileSync(
      join(__dirname, '../../src/attendance/w4c3b-request-operation-boundary.ts'),
      'utf8',
    )
    const protocolStart = source.indexOf('async function runRequestOperationProtocolV1(')
    expect(protocolStart, 'the protocol runner was not found').toBeGreaterThan(-1)
    const body = source.slice(protocolStart)
    expect(body.length).toBeGreaterThan(500)

    // ⚠️ P3-hygiene (2026-09-19, positive format for impl-gate-C-slice2-round1 P3-5): a closed-
    // world count on the WHOLE FILE, not just the sliced `body`. Without this, a second call site
    // added OUTSIDE this function (or this leg's anchor drifting onto a stale one) would make the
    // `.toContain` below vacuously true regardless of which call it actually found.
    expect(
      source.split('assertExternalTransactionRolloutLockHeldV1(trx,').length - 1,
      'expected exactly one call site in this file — a second one would mean this leg no longer censuses the whole population',
    ).toBe(1)

    // The assert is fed `identityPrepared.orgId` — NOT any approval-side column, and not a field
    // of the caller-supplied input (which `normalizeExternalTransactionInput` has no org in).
    expect(body).toContain('await assertExternalTransactionRolloutLockHeldV1(trx, identityPrepared.orgId)')
    const prepareIdentityCall = body.indexOf('await adapter.prepareIdentity(')
    const assertCall = body.indexOf('assertExternalTransactionRolloutLockHeldV1(trx, identityPrepared.orgId)')
    expect(prepareIdentityCall).toBeGreaterThan(-1)
    expect(assertCall).toBeGreaterThan(-1)
    // The org cannot be known before the adapter resolves it — which is exactly why the approval
    // side has to derive the SAME org itself, one transaction earlier, to take the lock in order.
    expect(prepareIdentityCall).toBeLessThan(assertCall)

    // And the entry's own input type carries no org field to short-circuit that derivation.
    const inputType = source.slice(
      source.indexOf('export interface AttendanceRequestOperationExternalTransactionInputV1 {'),
    )
    const inputBody = inputType.slice(0, inputType.indexOf('\n}'))
    expect(inputBody.length).toBeGreaterThan(100)
    expect(inputBody).not.toContain('orgId')
  })
})

/**
 * WI-0 lock-order census — **Q-F**: the `dispatchAction` restructure that makes §3 C-2's global
 * order 「rollout/advisory 锁 → 轮次引擎实例 → 原单据实例 → …」 achievable at outlet #5/#5′.
 *
 * Q-E (above) settled WHICH org key. Q-F is about the SITE: `dispatchAction` used to open `BEGIN`
 * and immediately take `approval_instances … FOR UPDATE` with nothing in between, so any advisory
 * lock taken later on that path was taken AFTER a row lock. That violation is invisible to the W4
 * entry's own `assertExternalTransactionRolloutLockHeldV1`, which queries `pg_locks` for
 * HELD-ness only and has no notion of acquisition order — it would PASS while the order is broken.
 *
 * Four legs, deliberately split between RUNTIME behaviour and a both-ends-anchored source scan,
 * because they establish different things and only one of them can be established each way:
 *   - legs 1/2 drive the REAL production resolver (`resolveCancelRoundRolloutLockRequirementV1`,
 *     `dispatchAction`'s own, exported for this census) — what org, and when NOT to lock at all;
 *   - leg 3 is the ordering proof: source text is the only thing that can speak about the order of
 *     two acquisitions inside one method without racing a live dispatch;
 *   - leg 4 binds the pre-read's non-locking mode to the LOCKING path's own predicate.
 *
 * WHAT Q-F DOES NOT ESTABLISH, stated so no reader takes leg 3 for more than it is: leg 3 proves
 * the production ORDER of the two calls in `dispatchAction`'s source, not that a live concurrent
 * dispatch cannot deadlock against a counterparty. That would need the two-connection technique
 * Q-A/Q-D use, and it needs a driveable cancel-round dispatch over an attendance-owned original —
 * which is 判据 II's own fixture, not this unit's.
 */
describeIfDatabase('WI-0 lock-order census (Q-F): the dispatchAction entry restructure (判据 II prerequisite)', () => {
  let pool: Pool
  const createdRoundIds: string[] = []
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []
  const ATTENDANCE_WORKFLOW_KEY = 'attendance.request'
  const CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'

  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    pool = new Pool({ connectionString: dbUrl })
  }, 60000)

  afterAll(async () => {
    if (createdRoundIds.length > 0) {
      await pool.query('DELETE FROM approval_rounds WHERE id = ANY($1::text[])', [createdRoundIds]).catch(() => undefined)
    }
    if (createdRequestIds.length > 0) {
      await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
    }
    if (createdInstanceIds.length > 0) {
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
    }
    await pool?.end().catch(() => undefined)
  })

  /**
   * The full three-hop shape the resolver walks: cancel-round engine instance → its ONE pending
   * `approval_rounds` row → the ORIGINAL document instance → that instance's `attendance_requests`
   * row.
   *
   * `originalWorkflowKey` is a parameter so leg 2 can flip the original document's ownership. It
   * feeds TWO columns, not one, and that is a schema fact rather than a fixture convenience:
   * `attendance_requests` carries a COMPOSITE foreign key
   * `(approval_instance_id, approval_workflow_key) → approval_instances (id, workflow_key)`
   * (`attendance_requests_instance_workflow_fkey`), so a request row cannot point at an instance
   * whose `workflow_key` disagrees with its own mirror column. The first draft of leg 2 moved only
   * the instance column and was refused with `23503`; recorded here rather than quietly widened,
   * because it means 「一个字段之差」 is not literally available on this table.
   */
  async function seedResolvableCancelRound(originalWorkflowKey: string): Promise<{
    roundInstanceId: string
    originalInstanceId: string
    requestId: string
    instanceOrg: string
    requestOrg: string
  }> {
    const instanceOrg = randomUUID()
    const requestOrg = randomUUID()
    const originalInstanceId = `census-qf-original-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, org_id) VALUES ($1, 'approved', $2, $3)`,
      [originalInstanceId, originalWorkflowKey, instanceOrg],
    )
    createdInstanceIds.push(originalInstanceId)

    const requestId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
       VALUES ($1, $2, CURRENT_DATE, 'leave', 'approved', $3, $4, $5)`,
      [requestId, `census-qf-user-${randomUUID()}`, requestOrg, originalInstanceId, originalWorkflowKey],
    )
    createdRequestIds.push(requestId)

    const roundInstanceId = `census-qf-round-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
       VALUES ($1, 'pending', $2, $3, $4)`,
      [roundInstanceId, CANCEL_ROUND_WORKFLOW_KEY, originalInstanceId, instanceOrg],
    )
    createdInstanceIds.push(roundInstanceId)

    const roundId = `census-qf-roundrow-${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_rounds
         (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
       VALUES ($1, $2, 'cancel', $3, $4, 'pending', '{}'::jsonb)`,
      [roundId, originalInstanceId, roundInstanceId, `census-qf-requester-${randomUUID()}`],
    )
    createdRoundIds.push(roundId)

    return { roundInstanceId, originalInstanceId, requestId, instanceOrg, requestOrg }
  }

  it('LEG 1: the production resolver returns the REQUEST row`s org — not the cancel round`s own org_id, which is one hop closer and wrong', async () => {
    const seeded = await seedResolvableCancelRound(ATTENDANCE_WORKFLOW_KEY)
    const client = await pool.connect()
    try {
      const requirement = await resolveCancelRoundRolloutLockRequirementV1(
        client as unknown as Parameters<typeof resolveCancelRoundRolloutLockRequirementV1>[0],
        seeded.roundInstanceId,
        'approve',
      )
      expect(requirement.kind).toBe('required')
      if (requirement.kind !== 'required') throw new Error('unreachable — narrowed above')
      // The load-bearing assertion of this whole census: Q-E leg 1 proved the two orgs derive
      // DIFFERENT class-`00` keys, so picking the wrong one is a 500 at the W4 entry, not a
      // cosmetic difference.
      expect(requirement.orgId).toBe(seeded.requestOrg)
      expect(requirement.orgId).not.toBe(seeded.instanceOrg)
      expect(requirement.documentId).toBe(seeded.originalInstanceId)
      expect(requirement.requestId).toBe(seeded.requestId)
    } finally {
      client.release()
    }
  })

  it('LEG 2 (the fail-closed-in-the-WRONG-direction control): a cancel round whose ORIGINAL is not attendance-owned demands NO lock', async () => {
    // One CONCEPT differs from leg 1's fixture — the ORIGINAL document instance's ownership —
    // carried by the two columns the composite FK binds together (see the seeder's note). The
    // cancel round itself, its pending `approval_rounds` row, and the request row's org are all
    // built by the same code path as leg 1.
    //
    // This is the control for the failure the advisor named: if the pre-read (or the post-lock
    // re-assert) asked the WIDER question 「is this a cancel round?」 instead of the resolver's own,
    // this fixture would demand a rollout lock that nothing can supply — and a legitimate cancel
    // round over a non-attendance document would fail closed for ever. The predicate is ONE
    // function called twice precisely so the two evaluations cannot answer differently here.
    const seeded = await seedResolvableCancelRound('platform.generic-document')
    const client = await pool.connect()
    try {
      const requirement = await resolveCancelRoundRolloutLockRequirementV1(
        client as unknown as Parameters<typeof resolveCancelRoundRolloutLockRequirementV1>[0],
        seeded.roundInstanceId,
        'approve',
      )
      expect(requirement.kind).toBe('none')
    } finally {
      client.release()
    }
  })

  it('LEG 3: in dispatchAction`s production source the pre-read precedes BEGIN and the rollout lock precedes the instance row lock (source scan, both ends anchored)', () => {
    const source = readFileSync(
      join(__dirname, '../../src/services/ApprovalProductService.ts'),
      'utf8',
    )
    const methodStart = source.indexOf('  async dispatchAction(')
    expect(methodStart).toBeGreaterThan(-1)
    // Anchored at BOTH ends: the slice stops at the method's own catch, so a later method's text
    // cannot satisfy any of the offsets below.
    const methodEnd = source.indexOf('      await rollbackQuietly(client)', methodStart)
    expect(methodEnd).toBeGreaterThan(methodStart)
    const body = source.slice(methodStart, methodEnd)

    const preRead = body.indexOf('rolloutLock = await resolveCancelRoundRolloutLockRequirementV1(client, id, request.action)')
    const serializableBegin = body.indexOf("await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')")
    const plainBegin = body.indexOf("await client.query('BEGIN')")
    const rolloutAcquire = body.indexOf('await acquireAttendanceCalculationRolloutLock(')
    const instanceRowLock = body.indexOf('FROM approval_instances WHERE id = $1')
    const reAssert = body.indexOf('const rolloutLockUnderRowLock = await resolveCancelRoundRolloutLockRequirementV1(client, id, request.action)')

    for (const offset of [preRead, serializableBegin, plainBegin, rolloutAcquire, instanceRowLock, reAssert]) {
      expect(offset).toBeGreaterThan(-1)
    }
    // The pre-read is OUTSIDE the transaction — before BOTH `BEGIN` forms. PostgreSQL fixes the
    // isolation level at the transaction's first statement, so this is not a style preference.
    expect(preRead).toBeLessThan(serializableBegin)
    expect(preRead).toBeLessThan(plainBegin)
    // §3 C-2's global order, the thing this whole leg exists for.
    expect(rolloutAcquire).toBeLessThan(instanceRowLock)
    // …and the fail-closed re-assert comes AFTER the row lock (a re-assert before it would be a
    // second pre-read, not a re-assert).
    expect(instanceRowLock).toBeLessThan(reAssert)
  })

  it('LEG 4: the pre-read`s non-locking mode and the LOCKING path resolve the SAME row — one predicate, two lock modes, no transcribed copy', async () => {
    // Two candidate request rows for one instance, the same shape Q-E leg 3 uses to show the repo's
    // OTHER join disagrees. Row B is reachable through the `attendance-request:<id>` business_key
    // form, which the shared ORDER BY prefers.
    const originalInstanceId = `census-qf-modes-${randomUUID()}`
    const rowBId = randomUUID()
    await pool.query(
      `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
       VALUES ($1, 'approved', $2, $3, $4)`,
      [originalInstanceId, ATTENDANCE_WORKFLOW_KEY, `attendance-request:${rowBId}`, randomUUID()],
    )
    createdInstanceIds.push(originalInstanceId)

    const rowAId = randomUUID()
    for (const [id, org] of [[rowAId, randomUUID()], [rowBId, randomUUID()]] as const) {
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
         VALUES ($1, $2, CURRENT_DATE, 'leave', 'approved', $3, $4, $5)`,
        [id, `census-qf-user-${randomUUID()}`, org, originalInstanceId, ATTENDANCE_WORKFLOW_KEY],
      )
      createdRequestIds.push(id)
    }

    const instanceRef = {
      id: originalInstanceId,
      workflow_key: ATTENDANCE_WORKFLOW_KEY,
      business_key: `attendance-request:${rowBId}`,
    }

    const client = await pool.connect()
    try {
      const unlocked = await classifyAttendanceRequestForInstanceV1(client, instanceRef, { lock: 'none' })
      // The locking mode has to run inside a transaction to hold anything; it is the historical
      // wrapper, called by name, so this compares the PRODUCTION locking path — not a copy of it.
      await client.query('BEGIN')
      const locked = await classifyAndLockAttendanceRequestForInstance(client, instanceRef)
      await client.query('ROLLBACK')

      expect(unlocked.kind).toBe('attendance')
      expect(locked.kind).toBe('attendance')
      if (unlocked.kind !== 'attendance' || locked.kind !== 'attendance') {
        throw new Error('unreachable — narrowed above')
      }
      // Both must pin row B, and must agree. A transcribed non-locking copy that lost the
      // business-key preference from the ORDER BY would pin row A here (that is M-11's probe).
      expect(unlocked.request?.requestId).toBe(rowBId)
      expect(locked.request?.requestId).toBe(rowBId)
      expect(unlocked.request?.orgId).toBe(locked.request?.orgId)
      expect(unlocked.request?.requestId).not.toBe(rowAId)
    } finally {
      client.release()
    }
  })

  it('LEG 5 (the ACTION axis — the control for 判据 III`s already-shipped behaviour): the SAME fixture leg 1 resolves `required` for demands NO lock on revoke/reject/comment/a forbidden verb', async () => {
    // Leg 2 varies the DOCUMENT axis (attendance-owned or not). This leg varies the ACTION axis on
    // a fixture leg 1 has already proven resolves `required`, so the two together say the resolver
    // is narrow on BOTH and not merely on one.
    //
    // Why it is load-bearing rather than tidy: only the approve fall-through (outlet #5/#5′) can
    // reach W4. 判据 III's revoke/reject terminate the round row with a bare UPDATE and shipped in
    // phase 1. A resolver keyed on the instance alone would have moved them to SERIALIZABLE, given
    // them an org-wide advisory lock and a 40001 failure mode they never had, made a FORBIDDEN verb
    // take an org lock before `assertCancelRoundActionAllowed` refuses it, and put the re-assert's
    // 409 ahead of §14.3 #4/#6's outlet-guard codes. None of that is 判据 II's to change.
    const seeded = await seedResolvableCancelRound(ATTENDANCE_WORKFLOW_KEY)
    const client = await pool.connect()
    try {
      // Positive control FIRST, on this very fixture: without it a green `none` below could mean
      // 「the fixture never demanded a lock」 rather than 「the action axis refused it」.
      const onApprove = await resolveCancelRoundRolloutLockRequirementV1(
        client as unknown as Parameters<typeof resolveCancelRoundRolloutLockRequirementV1>[0],
        seeded.roundInstanceId,
        'approve',
      )
      expect(onApprove.kind).toBe('required')

      for (const action of ['reject', 'revoke', 'comment', 'transfer', 'handle'] as const) {
        const requirement = await resolveCancelRoundRolloutLockRequirementV1(
          client as unknown as Parameters<typeof resolveCancelRoundRolloutLockRequirementV1>[0],
          seeded.roundInstanceId,
          action,
        )
        expect(requirement, `action ${action} must demand no rollout lock`).toEqual({ kind: 'none' })
      }
    } finally {
      client.release()
    }
  })

  it('LEG 6: the 40001/40P01 mapping exists, is gated on the branch that created the surface, and uses the repo`s single predicate (source scan, both ends anchored)', () => {
    // DISCLOSURE, so this leg is not read as more than it is: this is a SOURCE scan, not a driven
    // serialization failure. `CANCEL_ROUND_DISPATCH_CONTENDED` has no runtime coverage — no test
    // in this repo makes a real 40001 reach it. The leg exists so that DELETING the mapping
    // reddens something (the `finding_o2_x2_fix_site_has_zero_test_coverage.md` shape), not so
    // that anyone can call the mapping exercised.
    const source = readFileSync(
      join(__dirname, '../../src/services/ApprovalProductService.ts'),
      'utf8',
    )
    const methodStart = source.indexOf('  async dispatchAction(')
    expect(methodStart).toBeGreaterThan(-1)
    const catchStart = source.indexOf('      await rollbackQuietly(client)', methodStart)
    expect(catchStart).toBeGreaterThan(methodStart)
    // Both ends anchored: the catch block only, ending at its own rethrow.
    const catchEnd = source.indexOf('    } finally {', catchStart)
    expect(catchEnd).toBeGreaterThan(catchStart)
    const catchBody = source.slice(catchStart, catchEnd)

    // ⚠️ P3-hygiene (2026-09-19, positive format for impl-gate-C-slice2-round1 P3-8): a closed-
    // world count on the WHOLE FILE, not just the sliced `catchBody`. Without this, a second throw
    // site added OUTSIDE `dispatchAction`'s catch block would leave this leg blind to it while
    // still reading green off the one site it already knows about.
    expect(
      source.split('CANCEL_ROUND_DISPATCH_CONTENDED').length - 1,
      'expected exactly one reference in this file — a second one would mean this leg no longer censuses the whole population',
    ).toBe(1)

    expect(catchBody).toContain('CANCEL_ROUND_DISPATCH_CONTENDED')
    // Gated on the branch that opened SERIALIZABLE — NOT a repo-wide retry-semantics change.
    expect(catchBody).toContain("rolloutLock.kind === 'required' && isRetryableSqlState(error)")
    // The ordinary dispatch's bare rethrow survives the mapping.
    expect(catchBody).toContain('throw error')
  })
})

describeIfDatabase(
  'WI-0 lock-order census (Q-G): {原单据实例, attendance_requests} — the adapter reorder (判据 II prerequisite)',
  () => {
    /**
     * Lock §3 C-2 (lock:110) fixes the global order
     *   `rollout/advisory 锁 → 轮次引擎实例 → 原单据实例 → attendance_requests → 余额批次`
     * and ends with 「现有适配器改为同序」; lock:227 restates it as the row-lock class order.
     *
     * Q-D covered {原单据实例, 轮次行}. This leg covers the NEXT pair on the same path, and unlike
     * Q-D's — whose cancel-round side does not exist until 判据 II lands — BOTH sides of this one
     * are LIVE production code today:
     *
     *   core side    `classifyAndLockAttendanceRequestForInstance` — always reached with the
     *                `approval_instances` row already `FOR UPDATE`-held (`dispatchAction`'s entry
     *                read, `bulkReassignApprovals`, `assertAttendanceCentralMutationFailClosed`),
     *                so it runs 原单据实例 → `attendance_requests`.
     *   plugin side  `executeRequestCancel` in `plugins/plugin-attendance/index.cjs` — took
     *                `attendance_requests` FIRST and the `approval_instances` row second.
     *
     * That is an inversion between two live paths on the SAME (request, instance) pair, and both
     * are reachable while the request is still `pending` (a pending request's cancel vs. a bulk
     * reassign / admin jump on its pending instance). LEG 1 CONSTRUCTS it and it deadlocks
     * deterministically; LEG 2 is the positive control on the shipped order; LEG 3 anchors the
     * production source; LEG 4 enumerates what is still NOT in the ratified order, so this block
     * cannot be read as 「全仓已同序」.
     */
    let pool: Pool
    const createdInstanceIds: string[] = []
    const createdRequestIds: string[] = []
    const ATTENDANCE_WORKFLOW_KEY = 'attendance.request'

    beforeAll(async () => {
      await ensureApprovalSchemaReady()
      pool = new Pool({ connectionString: dbUrl })
    }, 60000)

    afterAll(async () => {
      if (createdRequestIds.length > 0) {
        await pool
          .query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds])
          .catch(() => undefined)
      }
      if (createdInstanceIds.length > 0) {
        await pool
          .query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
          .catch(() => undefined)
      }
      await pool?.end().catch(() => undefined)
    })

    /** One attendance-owned `approval_instances` row and the `attendance_requests` row joined to it. */
    async function seedAttendanceRequestWithInstance(): Promise<{
      instanceId: string
      requestId: string
      orgId: string
    }> {
      const orgId = randomUUID()
      const instanceId = `census-qg-inst-${randomUUID()}`
      await pool.query(
        `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id)
         VALUES ($1, 'pending', $2, $3, $4)`,
        [instanceId, ATTENDANCE_WORKFLOW_KEY, null, orgId],
      )
      createdInstanceIds.push(instanceId)

      const requestId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, approval_instance_id, approval_workflow_key)
         VALUES ($1, $2, CURRENT_DATE, 'leave', 'pending', $3, $4, $5)`,
        [requestId, `census-qg-user-${randomUUID()}`, orgId, instanceId, ATTENDANCE_WORKFLOW_KEY],
      )
      createdRequestIds.push(requestId)
      return { instanceId, requestId, orgId }
    }

    /**
     * The CORE side's second lock, taken through the REAL production predicate rather than a
     * transcribed copy of its SQL — so a future change to that predicate is picked up here instead
     * of drifting away from it silently.
     */
    async function coreLocksRequestForInstance(client: PoolClient, instanceId: string): Promise<void> {
      await classifyAndLockAttendanceRequestForInstance(
        client as unknown as Parameters<typeof classifyAndLockAttendanceRequestForInstance>[0],
        { id: instanceId, workflow_key: ATTENDANCE_WORKFLOW_KEY, business_key: null },
      )
    }

    /**
     * Polls until PostgreSQL itself reports the given backend as waiting on a lock. Throws (rather
     * than returning false) on timeout, so a leg that silently stopped contending goes RED with a
     * message that says what it failed to establish instead of quietly proving nothing.
     */
    async function expectBackendBlockedOnLock(pid: number, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const probe = await pool.query<{ blocked: boolean }>(
          `SELECT count(*) > 0 AS blocked
             FROM pg_stat_activity
            WHERE pid = $1 AND wait_event_type = 'Lock'`,
          [pid],
        )
        if (probe.rows[0]?.blocked === true) return
        if (Date.now() > deadline) {
          throw new Error(
            `backend ${pid} never blocked on a lock within ${timeoutMs}ms — the two sides did not `
              + 'contend, so this leg proved nothing',
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    it('LEG 1: the PRE-FIX adapter order (attendance_requests before the instance row) deadlocks DETERMINISTICALLY (40P01) against the core order', async () => {
      const { instanceId, requestId } = await seedAttendanceRequestWithInstance()
      const core = await pool.connect()
      const adapter = await pool.connect()
      try {
        await core.query('BEGIN')
        await adapter.query('BEGIN')
        // CORE (ratified order): 原单据实例 first.
        await core.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])
        // ADAPTER as it stood BEFORE the reorder: `attendance_requests` first. Written out by
        // hand deliberately. NOT because the order is gone from the repo — LEG 4 reads it off the
        // DECISION adapter, which still runs request-first — but so that this leg stays
        // independent of any one production site: it proves the SHAPE deadlocks, and LEG 4
        // separately reports who still has that shape.
        await adapter.query('SELECT id FROM attendance_requests WHERE id = $1::uuid FOR UPDATE', [requestId])

        // Each side now reaches for the row the other holds — the cycle.
        const coreSecond = coreLocksRequestForInstance(core, instanceId)
        const adapterSecond = adapter.query(
          'SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE',
          [instanceId],
        )

        const outcomes = await Promise.allSettled([coreSecond, adapterSecond])
        const deadlocks = outcomes.filter(
          (outcome) => outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === '40P01',
        )
        expect(deadlocks.length, 'the constructed pre-fix order did not deadlock').toBe(1)
      } finally {
        await core.query('ROLLBACK').catch(() => undefined)
        await adapter.query('ROLLBACK').catch(() => undefined)
        core.release()
        adapter.release()
      }
    })

    it('POSITIVE CONTROL (LEG 2): the SHIPPED order (both sides take the instance row first) does NOT deadlock, and BOTH sides reach a defined outcome', async () => {
      const { instanceId, requestId } = await seedAttendanceRequestWithInstance()
      const core = await pool.connect()
      const adapter = await pool.connect()
      try {
        await core.query('BEGIN')
        await adapter.query('BEGIN')
        await core.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])

        // The adapter, in its SHIPPED order, blocks on the INSTANCE row before it can touch the
        // request row — so it can never hold half the cycle.
        const adapterPid = (await adapter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const adapterRun = (async () => {
          await adapter.query('SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE', [instanceId])
          const locked = await adapter.query(
            'SELECT id FROM attendance_requests WHERE id = $1::uuid FOR UPDATE',
            [requestId],
          )
          return locked.rowCount
        })()

        // The core side proceeds on its own merits: it takes the request row and returns the
        // attendance classification — a DEFINED outcome, not merely "nothing happened".
        await expect(coreLocksRequestForInstance(core, instanceId)).resolves.toBeUndefined()
        // CONTENTION PROOF, MEASURED on the server rather than inferred from JS timing. Without it
        // this leg would pass just as happily on a fixture where the two sides never overlapped,
        // and "no deadlock" would have no discriminating power at all.
        //
        // An earlier draft used a `settled` flag flipped in `adapterRun.then(...)` and asserted it
        // was still false here. That was VACUOUS and was caught by its own mutation: pointing the
        // adapter at a DIFFERENT (request, instance) pair — so it contends with nothing and
        // finishes immediately — left the flag `false` anyway, because the callback had not been
        // scheduled yet. `pg_stat_activity.wait_event_type` is the server's own answer and does
        // not depend on which promise the event loop happened to reach first.
        await expectBackendBlockedOnLock(adapterPid)
        await core.query('COMMIT')

        await expect(adapterRun).resolves.toBe(1)
        await adapter.query('COMMIT')
      } finally {
        await core.query('ROLLBACK').catch(() => undefined)
        await adapter.query('ROLLBACK').catch(() => undefined)
        core.release()
        adapter.release()
      }
    })

    it('LEG 3: the production cancel adapter takes the two in the ratified order (source scan, anchored at both ends)', () => {
      const source = readFileSync(
        join(__dirname, '../../../../plugins/plugin-attendance/index.cjs'),
        'utf8',
      )
      const start = source.indexOf('execute: async function executeRequestCancel(')
      expect(start, 'executeRequestCancel was not found').toBeGreaterThan(-1)
      // Far end anchored on the adapter's own terminal write, so the slice cannot run past the
      // function and pick up some other site's statements.
      const end = source.indexOf("SET status = 'cancelled', resolved_by = $2", start)
      expect(end, 'the adapter`s attendance_requests terminal write was not found').toBeGreaterThan(start)
      const body = source.slice(start, end)

      const instanceLock = body.indexOf("'SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE'")
      const requestLock = body.indexOf("'SELECT * FROM attendance_requests WHERE id = $1::uuid FOR UPDATE'")
      expect(instanceLock, 'the instance FOR UPDATE was not found in executeRequestCancel').toBeGreaterThan(-1)
      expect(requestLock, 'the request FOR UPDATE was not found in executeRequestCancel').toBeGreaterThan(-1)
      expect(instanceLock, '原单据实例 must be locked BEFORE attendance_requests').toBeLessThan(requestLock)
    })

    it('LEG 4 (registered, NOT buried): among the `FOR UPDATE` sites, the plugin`s OTHER both-row path is still in the pre-fix order — this fix is one site, not a repo-wide sweep', () => {
      const source = readFileSync(
        join(__dirname, '../../../../plugins/plugin-attendance/index.cjs'),
        'utf8',
      )
      // Mechanical enumeration, so the claim is a count and not a memory. Comment/doc lines are
      // excluded by requiring the quoted statement form the adapters actually execute.
      //
      // SCOPE, stated so the counts are not read as the whole population: this enumerates
      // EXPLICIT `FOR UPDATE` reads ONLY. A bare `UPDATE approval_instances …` / `UPDATE
      // attendance_requests …` takes a row lock too (`feedback_writer_audit_both_query_syntaxes`),
      // and the plugin has 3 and 5 of those respectively. They are NOT enumerated here and NOT
      // ordered by this commit — registered as a residual in the phase-2 verification MD §3.10.2.
      const requestLocks = [...source.matchAll(/SELECT \* FROM attendance_requests WHERE id = \$1(?:::uuid)? FOR UPDATE/g)]
      const instanceLocks = [...source.matchAll(/SELECT \* FROM approval_instances WHERE id = \$1 FOR UPDATE/g)]
      expect(requestLocks.length, 'attendance_requests FOR UPDATE site count changed').toBe(3)
      expect(instanceLocks.length, 'approval_instances FOR UPDATE site count changed').toBe(3)

      // The decision adapter (`attendance_requests` → `approval_instances`) is the residual: it is
      // the approve/reject path, which runs only while the request is `pending`, so it is NOT on
      // 判据 II's approved-document path and is deliberately left to the attendance line.
      //
      // ⚠️ READ THE FAILURE MESSAGE BEFORE "FIXING" ANYTHING. This leg pins PRODUCTION SOURCE to a
      // state that is known-wrong-but-out-of-scope, which is the opposite polarity from every other
      // leg in this file. A RED here does NOT mean something broke: it almost certainly means
      // someone correctly reordered the decision adapter, and the right response is to DELETE this
      // assertion and update the phase-2 verification MD's residual list in the same commit — not
      // to put the old order back. It exists only so that the residual cannot be silently closed
      // while the MD goes on calling it open.
      const decisionStart = source.indexOf('const decisionReferenceSegments = operation?.referenceSegments === true')
      expect(decisionStart, 'the decision adapter anchor was not found').toBeGreaterThan(-1)
      const decisionEnd = source.indexOf('const requestMetadata = normalizeMetadata(requestRow.metadata)', decisionStart)
      expect(decisionEnd).toBeGreaterThan(decisionStart)
      const decisionBody = source.slice(decisionStart, decisionEnd)
      const dRequest = decisionBody.indexOf("'SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE'")
      const dInstance = decisionBody.indexOf("'SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE'")
      expect(dRequest).toBeGreaterThan(-1)
      expect(dInstance).toBeGreaterThan(-1)
      expect(
        dRequest,
        'the decision adapter is no longer request-first: if that was a deliberate reorder, DELETE '
          + 'this assertion and update the phase-2 verification MD residual list — do not revert it',
      ).toBeLessThan(dInstance)
    })
  },
)
