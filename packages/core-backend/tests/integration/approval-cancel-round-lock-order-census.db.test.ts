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
