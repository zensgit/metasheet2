/**
 * W7-1b (#4556) — B9: THE COMPOSITE-LOCK RE-CENSUS, redone over the SEVEN-producer
 * reality, plus T-M6 (the mirror's lock scope).
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * ---------------------------------------------------------------------------
 * WHY THE CENSUS HAD TO BE REDONE
 * ---------------------------------------------------------------------------
 * W7-1a recorded that ZERO production sites take BOTH lock families — which is
 * what made the ruled order a fresh invariant rather than a change to an
 * existing one. W7-1b invalidates that census by construction: seven producers
 * plus the mirror now take the W7 composite locks, and they do it INSIDE
 * transactions that already hold other locks. In particular the two live arms
 * compose with the parent row lock in OPPOSITE relative order:
 *
 *   P1  live authoritative      — parent `FOR UPDATE` BEFORE the seam (:1869 -> :1962)
 *   P2  live shadow             — parent `FOR UPDATE` BEFORE the seam (:2207 -> :2285)
 *   P3a scheduled authoritative — parent `FOR UPDATE` BEFORE the seam
 *   P3b scheduled shadow        — parent `FOR UPDATE` BEFORE the seam (:3241 -> :3258)
 *
 * ⚠️ CORRECTION (gate finding P2-5). An earlier revision of this census recorded
 * P2 live shadow as taking the parent lock AFTER the seam, and built its whole
 * headline on the resulting "opposite relative orderings". THAT ROW WAS FALSE:
 * `lockShadowParentRecord` at boundary:2207 precedes the seam call at :2285.
 * Re-derived, ALL FOUR boundary arms take the parent lock BEFORE the seam —
 * the composition is UNIFORM, and the opposite-order hazard does not exist in
 * the boundary at all.
 *
 * The correction makes the census SIMPLER and the tree SAFER than the earlier
 * claim, which is exactly why it must be stated rather than quietly amended: a
 * census that overstates a hazard is still a census that was not derived.
 *
 * ⚠️ AND THE D2 SERIALIZATION ARGUMENT DOES NOT TRANSFER. `w4c2-live-scheduled-
 * boundary.ts` argues the two orderings cannot interleave because the org
 * rollout SHARED advisory lock is held on both paths and a posture transition
 * needs the EXCLUSIVE one. That argument is about the **W4** rollout state
 * machine. W7 is a SEPARATE state machine with NO rollout-lock coupling — a W7
 * posture transition takes no W4 rollout lock — so inheriting it silently is the
 * single easiest way to produce a census that looks complete and proves nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT ACTUALLY MAKES THE COMPOSITION SAFE — AND IT IS TESTED, NOT ARGUED
 * ---------------------------------------------------------------------------
 * A deadlock needs a cycle over TWO resources with CONFLICTING modes at both
 * ends. The producers take the W7 composite locks SHARED
 * (`pg_advisory_xact_lock_shared`), so two producers never conflict there, and
 * the opposite parent-lock ordering alone cannot cycle.
 *
 * The only way to close a cycle is a counterpart that takes a W7 composite key
 * EXCLUSIVELY **and** takes the `attendance_records` parent row lock. The W1
 * membership writer does take the timeline key exclusively — so the census
 * question reduces to one mechanical property:
 *
 *   NO production site takes a W7 composite lock key EXCLUSIVELY *and* an
 *   `attendance_records ... FOR UPDATE`.
 *
 * `census` below asserts exactly that over derived source, and `40P01 positive
 * control` proves the claim is not vacuous by CONSTRUCTING the cycle and
 * observing the server detect it. A negative claim without that control is
 * indistinguishable from a probe that never fired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool, type PoolClient } from 'pg'
import {
  buildAttendanceW7MembershipTimelineLockKeyV1,
  buildAttendanceW7ScheduleFactsLockKeyV1,
} from '../../src/attendance/w7-resolver/w7-composite-lock-order'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../../')

/**
 * THE CENSUS — seven producers plus the mirror, each with the locks its
 * transaction already holds when the seam runs and the parent lock's RELATIVE
 * position. Anchors are structural (symbol + predicate shape); the non-vacuity
 * leg asserts every one of them still exists in the file, exactly once.
 */
const W7_1B_LOCK_CENSUS_V1 = Object.freeze([
  Object.freeze({
    producer: 'P1 live authoritative',
    file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts',
    // W7-2 re-anchor: the call sites now destructure the dual-run result
    // (`const issued = await issueThroughW7Seam(...)`), so the anchor is the
    // adjacent served-half unwrap line, which stays producer-pair-distinct.
    anchor: 'authoritativeContext = issued.context',
    heldWhenSeamRuns: 'org rollout SHARED advisory + parent FOR UPDATE',
    parentLockRelativePosition: 'BEFORE the seam',
  }),
  Object.freeze({
    producer: 'P2 live shadow',
    file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts',
    anchor: 'context = issued.context',
    // CORRECTED (gate P2-5): `lockShadowParentRecord` at :2207 PRECEDES the seam
    // call at :2285. The earlier 'AFTER' was wrong.
    heldWhenSeamRuns: 'org rollout SHARED advisory + parent FOR UPDATE',
    parentLockRelativePosition: 'BEFORE the seam',
  }),
  Object.freeze({
    producer: 'P3a scheduled authoritative (added by D3)',
    file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts',
    anchor: 'authoritativeContext = issued.context',
    heldWhenSeamRuns: 'org rollout SHARED advisory + run-state guard + per-target SAVEPOINT + parent FOR UPDATE',
    parentLockRelativePosition: 'BEFORE the seam',
  }),
  Object.freeze({
    producer: 'P3b scheduled shadow',
    file: 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts',
    anchor: 'context = issued.context',
    heldWhenSeamRuns: 'org rollout SHARED advisory + run-state guard',
    parentLockRelativePosition: 'BEFORE the seam',
  }),
  Object.freeze({
    producer: 'P4 request-creation snapshot',
    file: 'plugins/plugin-attendance/index.cjs',
    anchor: 'const contextSnapshot = (await issueW4FrozenContextForProducerV1(trx, {',
    heldWhenSeamRuns: 'request-operation transaction; no attendance_records parent row lock',
    parentLockRelativePosition: 'n/a — no parent row lock on this path',
  }),
  Object.freeze({
    producer: 'P5 batch import',
    file: 'plugins/plugin-attendance/index.cjs',
    anchor: 'frozenImportContext = (await issueW4FrozenContextForProducerV1(trx, {',
    heldWhenSeamRuns: 'import plan transaction; parent locks are taken by the import kernel AFTER the freeze',
    parentLockRelativePosition: 'AFTER the seam',
  }),
  Object.freeze({
    producer: 'P6 recompute current_policy',
    file: 'plugins/plugin-attendance/index.cjs',
    anchor: 'const frozenContext = (await issueW4FrozenContextForProducerV1(trx, {',
    heldWhenSeamRuns: 'record-operation transaction + the claimed operation row',
    parentLockRelativePosition: 'AFTER the seam',
  }),
  Object.freeze({
    producer: 'MIRROR (in the census, NOT excluded from it)',
    file: 'plugins/plugin-attendance/index.cjs',
    anchor: 'issueW4FrozenContextViaW7SeamV1(mirrorTrx, {',
    heldWhenSeamRuns: 'NOTHING — its own short read transaction on the pooled connection',
    parentLockRelativePosition: 'n/a — committed BEFORE executeLivePunch opens',
  }),
])

/** Production sites that take a W7 composite lock key EXCLUSIVELY. Derived by
 *  spelling, not assumed: these are the only counterparties that could close a
 *  cycle against a producer's SHARED acquisition. */
const W7_EXCLUSIVE_KEY_TAKERS_V1 = Object.freeze([
  Object.freeze({
    file: 'packages/core-backend/src/services/AttendanceCalculationGroupMembership.ts',
    keyFamily: 'attendance-calc-timeline',
    note: 'the W1 membership writer — takes the timeline key EXCLUSIVE',
  }),
  Object.freeze({
    file: 'plugins/plugin-attendance/index.cjs',
    keyFamily: 'attendance-schedule:',
    note: 'the schedule-assignment writer — takes the schedule key EXCLUSIVE',
  }),
])

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')

/**
 * The full block of the function declared at `declStart`: paren-balance the
 * PARAMETER LIST first, then brace-balance the BODY from the first `{` after
 * it. The two-phase order is the load-bearing part — an earlier revision
 * brace-matched from the declaration head and closed on the `{}` of a
 * `options = {}` DEFAULT PARAMETER, returning a 91-char signature fragment
 * that contained neither the needle nor any lock call.
 */
function functionBlockAt(source: string, declStart: number): { start: number; end: number } | null {
  const parenAt = source.indexOf('(', declStart)
  if (parenAt === -1) return null
  let pDepth = 0
  let i = parenAt
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') pDepth += 1
    else if (ch === ')') {
      pDepth -= 1
      if (pDepth === 0) break
    }
  }
  if (pDepth !== 0) return null
  const bodyOpen = source.indexOf('{', i + 1)
  if (bodyOpen === -1) return null
  let depth = 0
  for (let j = bodyOpen; j < source.length; j += 1) {
    const ch = source[j]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { start: declStart, end: j + 1 }
    }
  }
  return null
}

/**
 * The smallest function block CONTAINING `needle` — the ENCLOSING function,
 * selected by containment, never by proximity. An earlier revision took the
 * NEAREST PRECEDING declaration (`lastIndexOf`), which for a needle deep
 * inside one function returned the complete body of the unrelated helper
 * declared just above it. This scans every declaration head before the
 * needle, computes each full block, and keeps the innermost one whose span
 * contains the needle. Known limitation (stated, not hidden): brace balance
 * can be fooled by an unmatched `{`/`}` inside a string literal; the
 * caller's containment assertion (`acquiring` must include the needle) makes
 * an extraction failure red the leg rather than pass it.
 */
function enclosingFunctionContaining(source: string, needle: string): string | null {
  const at = source.indexOf(needle)
  if (at === -1) return null
  const headRe =
    /\n\s*(?:export\s+)?(?:async\s+)?function\s+\w|\n\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\()/g
  let best: { start: number; end: number } | null = null
  let m: RegExpExecArray | null
  while ((m = headRe.exec(source)) !== null) {
    if (m.index > at) break
    const block = functionBlockAt(source, m.index)
    if (block && block.start <= at && at < block.end) {
      if (!best || block.end - block.start < best.end - best.start) best = block
    }
  }
  return best ? source.slice(best.start, best.end) : null
}

describeDb('W7-1b — B9 composite-lock re-census over the seven-producer reality (real DB)', () => {
  let pool: Pool
  const orgId = randomUUID().toLowerCase()
  const userId = randomUUID()
  const recordId = randomUUID()

  const withClient = async <T>(body: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect()
    try { return await body(c) } finally { c.release() }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
          status, is_workday, projection_owner, visibility_state, visibility_reason, created_at, updated_at)
       VALUES ($1,$2,$3,'2026-07-01','UTC',0,0,0,'normal',true,'legacy_untracked','active','active',now(),now())`,
      [recordId, userId, orgId],
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.query(`DELETE FROM attendance_records WHERE org_id = $1`, [orgId]).catch(() => undefined)
    await pool?.end()
  }, 60_000)

  // -------------------------------------------------------------------------
  // The census itself.
  // -------------------------------------------------------------------------

  it('census non-vacuity: every enumerated producer anchor still exists in its file', () => {
    // A census whose anchors have drifted is a census of nothing. Anchors are
    // matched by structure; two producers share an anchor spelling by design
    // (the live/scheduled pairs), so occurrences are counted, not required to
    // be unique per row.
    const bySpelling = new Map<string, number>()
    for (const row of W7_1B_LOCK_CENSUS_V1) {
      const key = `${row.file}::${row.anchor}`
      bySpelling.set(key, (bySpelling.get(key) ?? 0) + 1)
    }
    for (const [key, expected] of bySpelling) {
      const [file, anchor] = key.split('::')
      const found = read(file).split(anchor).length - 1
      expect(found, `census anchor drifted: ${anchor} in ${file}`).toBe(expected)
    }
    expect(W7_1B_LOCK_CENSUS_V1.length, 'the census must cover 7 producers + the mirror').toBe(8)
    // The mirror is IN the census, not excluded from it.
    expect(W7_1B_LOCK_CENSUS_V1.some((r) => r.producer.startsWith('MIRROR'))).toBe(true)
    // ⚠️ The earlier revision asserted BOTH orderings were present — which is
    // what let a FALSE row survive. The derived fact is that every boundary arm
    // is uniform, so the assertion is now the DERIVED one: no boundary producer
    // takes the parent lock after the seam. A future arm that did would red here
    // and re-open the opposite-order question honestly.
    const boundaryRows = W7_1B_LOCK_CENSUS_V1.filter((r) =>
      r.file.endsWith('w4c2-live-scheduled-boundary.ts'),
    )
    expect(boundaryRows.length, 'four boundary producers').toBe(4)
    for (const row of boundaryRows) {
      expect(row.parentLockRelativePosition, `${row.producer}`).toBe('BEFORE the seam')
    }
    // ...and the recorded ordering is CHECKED AGAINST SOURCE, not just declared:
    // the shadow arm's parent lock must really precede its seam call.
    const boundarySource = read('packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts')
    const lines = boundarySource.split('\n')
    const shadowParent = lines.findIndex((l) => l.includes('const parent = await lockShadowParentRecord(trx, org, input.userId, input.workDate)'))
    // W7-2 re-anchor: all four boundary sites now spell the seam call
    // identically (`const issued = await issueThroughW7Seam(...)`), so the P2
    // site is identified positionally — the FIRST seam call AFTER P2's parent
    // lock line (P1's call precedes that line; P3a/P3b follow later).
    const shadowSeam = lines.findIndex(
      (l, index) => index > shadowParent && l.includes('= await issueThroughW7Seam(pluginTrx, {'),
    )
    expect(shadowParent, 'shadow parent lock not found').toBeGreaterThan(-1)
    expect(shadowSeam, 'shadow seam call not found').toBeGreaterThan(-1)
    expect(shadowParent, 'the shadow arm must lock the parent BEFORE the seam').toBeLessThan(shadowSeam)
  })

  it('census leg 1: every producer takes the W7 composite keys SHARED, never exclusively', () => {
    // The whole safety argument rests on this. The seam reaches the keys only
    // through W7-1a's one helper, and that helper uses the SHARED spelling.
    const helper = read('packages/core-backend/src/attendance/w7-resolver/w7-composite-lock-order.ts')
    expect(helper).toContain('pg_advisory_xact_lock_shared')
    expect(
      helper.includes('pg_advisory_xact_lock(') ,
      'the composite helper must not take either key EXCLUSIVELY',
    ).toBe(false)
  })

  it('census leg 2 (THE INVARIANT): no EXCLUSIVE W7-key taker also locks an attendance_records parent row', () => {
    // This is the property that makes the opposite parent-lock orderings safe.
    // A counterparty that held a W7 key exclusively AND wanted the parent row
    // would close the cycle; none exists.
    // ⚠️ EVALUATED PER TAKER. An earlier revision ran the `FOR UPDATE` criterion
    // ONCE, outside this loop, against the W1 file only — where the regex is
    // unconditionally false because that file contains zero `attendance_records`
    // occurrences at all. Taker #2 (the plugin) was therefore never checked, and
    // the leg's central claim was carried by a probe that could not fire. The
    // invariant itself holds; the CHECK did not.
    let takersChecked = 0
    for (const taker of W7_EXCLUSIVE_KEY_TAKERS_V1) {
      const source = read(taker.file)
      expect(source, `${taker.file} no longer spells ${taker.keyFamily}`).toContain(taker.keyFamily)
      // Non-vacuity per taker: the file must be real and non-trivial, so a
      // mis-typed path cannot pass by scanning an empty string.
      expect(source.length, `${taker.file} is suspiciously small`).toBeGreaterThan(500)
      // THE INVARIANT, per taker, evaluated over the ACQUIRING FUNCTION rather
      // than the whole file.
      //
      // ⚠️ A file-wide regex is NOT a sound implementation of this at this
      // granularity: `index.cjs` is ~50k lines, `attendance_records` appears
      // throughout it, and "a `FOR UPDATE` within 400 characters of the string
      // `attendance_records`" matches somewhere by coincidence without the two
      // being the same statement, let alone inside the key-holding function.
      // The first per-taker revision of this leg used exactly that and went red
      // on a coincidence. Scoping to the acquiring function is the part that can
      // be checked mechanically and soundly.
      const acquiring = enclosingFunctionContaining(source, taker.keyFamily)
      expect(acquiring, `could not locate the function acquiring ${taker.keyFamily}`).not.toBeNull()
      // FAIL-CLOSED extraction check: the extracted block must contain the very
      // acquisition it was located by, and the acquisition call itself. Without
      // this, a broken extractor returns SOME block, the FOR UPDATE probe scans
      // the wrong text, and the leg is vacuous — which is exactly what happened
      // twice before (signature fragment; unrelated neighbouring helper).
      expect(
        acquiring as string,
        'the extracted block does not contain the acquisition it was located by',
      ).toContain(taker.keyFamily)
      expect(
        acquiring as string,
        'the extracted block does not contain an advisory-lock call at all',
      ).toContain('pg_advisory_xact_lock')
      // THE PROBE MATCHES THE INVARIANT'S OWN WORDS: a `FOR UPDATE` whose
      // statement reads `attendance_records`. A bare any-`FOR UPDATE` probe is
      // BROADER than the invariant — the W1 writer legitimately row-locks its
      // own membership/operation tables inside the same function, and those
      // locks cannot close a cycle against the producers' parent-then-shared
      // ordering, because the producers' parent lock is on attendance_records.
      // (The earlier broken extractor never reached the real body, so the
      // over-broad probe never had the chance to misfire.) Statement anchoring
      // is structural, not a fixed window: for each FOR UPDATE, the segment
      // from its statement's nearest preceding SELECT is what names the table.
      const block = acquiring as string
      const offendingStatements: string[] = []
      const forUpdateRe = /FOR\s+UPDATE/gi
      let fu: RegExpExecArray | null
      while ((fu = forUpdateRe.exec(block)) !== null) {
        const selectAt = block.toUpperCase().lastIndexOf('SELECT', fu.index)
        const statementHead = selectAt === -1 ? block.slice(0, fu.index) : block.slice(selectAt, fu.index)
        if (/\battendance_records\b/.test(statementHead)) {
          offendingStatements.push(statementHead.slice(0, 200))
        }
      }
      expect(
        offendingStatements,
        `${taker.file}: the function acquiring ${taker.keyFamily} EXCLUSIVELY also row-locks ` +
          'attendance_records — that is how a cycle closes against a producer’s parent-then-shared ordering',
      ).toEqual([])
      takersChecked += 1
    }
    // The loop must actually have run over every enumerated taker.
    expect(takersChecked, 'the per-taker check did not cover the enumerated set').toBe(
      W7_EXCLUSIVE_KEY_TAKERS_V1.length,
    )
    expect(W7_EXCLUSIVE_KEY_TAKERS_V1.length).toBeGreaterThanOrEqual(2)
    // ⚠️ WHAT THIS LEG DOES NOT ESTABLISH, stated rather than implied: the
    // invariant is really about the whole TRANSACTION that holds the exclusive
    // key, which can span callers. This leg checks the ACQUIRING FUNCTION, which
    // is the part a mechanical check can carry soundly. Whole-transaction
    // reachability across callers was verified by hand at review time (all 19
    // sites) and is NOT re-derived here — so a future caller that wrapped one of
    // these acquisitions in a transaction that also locks a parent row would
    // NOT be caught by this leg.
  })

  // -------------------------------------------------------------------------
  // Constructed races. Server-observed, never argued.
  // -------------------------------------------------------------------------

  it('POSITIVE CONTROL: the cycle IS detectable when it exists (40P01, exactly one victim)', async () => {
    // Without this the invariant leg above is indistinguishable from a probe
    // that never fires. Here the forbidden shape is CONSTRUCTED deliberately:
    // one side takes the parent row then the timeline key EXCLUSIVE, the other
    // takes them in the reverse order.
    const timelineKey = buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)
    const outcomes: string[] = []
    const side = async (first: 'row' | 'lock') =>
      withClient(async (c) => {
        await c.query('BEGIN')
        try {
          if (first === 'row') {
            await c.query(`SELECT 1 FROM attendance_records WHERE id = $1::uuid FOR UPDATE`, [recordId])
            await new Promise((r) => setTimeout(r, 250))
            await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [timelineKey])
          } else {
            await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [timelineKey])
            await new Promise((r) => setTimeout(r, 250))
            await c.query(`SELECT 1 FROM attendance_records WHERE id = $1::uuid FOR UPDATE`, [recordId])
          }
          await c.query('COMMIT')
          outcomes.push(`${first}:ok`)
        } catch (error) {
          await c.query('ROLLBACK').catch(() => undefined)
          outcomes.push(`${first}:${(error as { code?: string }).code ?? 'err'}`)
        }
      })
    await Promise.all([side('row'), side('lock')])
    // EXACTLY one victim and exactly one success — the server's own verdict.
    expect(outcomes.filter((o) => o.endsWith(':40P01')).length, `outcomes: ${outcomes.join(',')}`).toBe(1)
    expect(outcomes.filter((o) => o.endsWith(':ok')).length, `outcomes: ${outcomes.join(',')}`).toBe(1)
  }, 120_000)

  it('THE COMPOSED ORDER, GENUINELY CONTENDING: two producers on the SAME (org,user) serialize on the parent row and both commit', async () => {
    // ⚠️ REPLACED after gate finding P2-5. The earlier version of this leg used
    // two DIFFERENT parent rows and only SHARED advisory keys — i.e. NO shared
    // exclusive resource at all — so it could not have failed and proved
    // nothing about contention.
    //
    // The real production shape, given the corrected census (all four boundary
    // arms lock the parent BEFORE the seam): two concurrent punches for the
    // SAME (org, user) contend on the SAME parent row EXCLUSIVELY while taking
    // the SAME W7 keys SHARED.
    //
    // WHAT THIS CAN SHOW: that the composition serializes on the parent row and
    // that BOTH sides complete — no deadlock, no lost waiter. Blocking is
    // SERVER-OBSERVED via `pg_blocking_pids`, not inferred from timing.
    // WHAT IT CANNOT SHOW: safety against a counterparty that holds a W7 key
    // EXCLUSIVELY and then wants the parent row. That shape is covered by
    // census leg 2 (no such site exists) plus the 40P01 positive control above
    // (the cycle is detectable when it does exist).
    const timelineKey = buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)
    const scheduleKey = buildAttendanceW7ScheduleFactsLockKeyV1(orgId)
    const outcomes: string[] = []
    let observedBlocking = false

    const firstClient = await pool.connect()
    const secondClient = await pool.connect()
    try {
      // A: parent row EXCLUSIVE, then the W7 keys SHARED — and HOLD.
      await firstClient.query('BEGIN')
      await firstClient.query(`SELECT 1 FROM attendance_records WHERE id = $1::uuid FOR UPDATE`, [recordId])
      await firstClient.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [timelineKey])
      await firstClient.query(`SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))`, [scheduleKey, userId])
      const secondPid = Number((await secondClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

      // B: the SAME sequence on the SAME row — must block on the parent row.
      await secondClient.query('BEGIN')
      const bDone = (async () => {
        await secondClient.query(`SELECT 1 FROM attendance_records WHERE id = $1::uuid FOR UPDATE`, [recordId])
        await secondClient.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [timelineKey])
        await secondClient.query(`SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))`, [scheduleKey, userId])
        await secondClient.query('COMMIT')
        outcomes.push('B:ok')
      })()

      // Server-observed blocking, polled — never a sleep-and-assume.
      for (let i = 0; i < 40 && !observedBlocking; i += 1) {
        const blockers = (await pool.query('SELECT pg_blocking_pids($1)::int[] AS b', [secondPid])).rows[0].b
        if (Array.isArray(blockers) && blockers.length > 0) observedBlocking = true
        else await new Promise((r) => setTimeout(r, 50))
      }
      expect(observedBlocking, 'B must be SERVER-OBSERVED blocking on the parent row held by A').toBe(true)
      // B is still waiting, so the SHARED W7 keys did not let it past the row lock.
      expect(outcomes).not.toContain('B:ok')

      await firstClient.query('COMMIT')
      outcomes.push('A:ok')
      await bDone
    } finally {
      await firstClient.query('ROLLBACK').catch(() => undefined)
      await secondClient.query('ROLLBACK').catch(() => undefined)
      firstClient.release()
      secondClient.release()
    }
    // Both complete, in order, with no deadlock.
    expect(outcomes).toEqual(['A:ok', 'B:ok'])
  }, 120_000)

  it('T-M6: the W7 composite locks are TRANSACTION-scoped — held inside, released at COMMIT (pg_locks, observed)', async () => {
    // Written as "transaction-scoped and released at commit", NOT as "takes no
    // lock": W7-1a's facts resolver acquires these unconditionally as its step 1,
    // so a no-lock assertion would be asserting something the code cannot do.
    // This is what makes the mirror's own short transaction load-bearing — on
    // the pooled connection with no transaction, `pg_advisory_xact_lock_shared`
    // is released at STATEMENT end and buys no mutual exclusion at all.
    const timelineKey = buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)
    await withClient(async (c) => {
      const countAdvisory = async () =>
        Number(
          (await c.query(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE pid = pg_backend_pid() AND locktype = 'advisory'`,
          )).rows[0].n,
        )
      expect(await countAdvisory(), 'no advisory lock may be held before BEGIN').toBe(0)
      await c.query('BEGIN')
      await c.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [timelineKey])
      const insideTxn = await countAdvisory()
      expect(insideTxn, 'the advisory lock must be held INSIDE the transaction').toBeGreaterThanOrEqual(1)
      await c.query('COMMIT')
      // Released at COMMIT — the property the mirror's short transaction exists
      // to obtain, observed rather than argued.
      expect(await countAdvisory(), 'the advisory lock must be released at COMMIT').toBe(0)
    })
  }, 120_000)

  it('T-M6 negative control: on an AUTOCOMMIT connection the same acquisition buys NOTHING', async () => {
    // The reason the mirror may not simply call the helper on the pooled
    // connection. Without this control, T-M6 above would be equally consistent
    // with "the lock is always held".
    const timelineKey = buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)
    await withClient(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [timelineKey])
      const held = Number(
        (await c.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`,
        )).rows[0].n,
      )
      expect(held, 'an xact advisory lock outside a transaction is gone by the next statement').toBe(0)
    })
  }, 120_000)
})
