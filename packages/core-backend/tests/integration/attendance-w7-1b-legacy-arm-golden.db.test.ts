/**
 * W7-1b (#4556) — W7-R3 STRUCTURAL PARITY: golden-equality of the legacy arm.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation). Design lock
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * (merge `0287b250b33fe4c7ea98b880360af74fc08a5ebf`, blob
 * `f7acf1da3be791bb2d77dbe58ca1078055828521`).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A SOURCE-TEXT GUARD
 * ---------------------------------------------------------------------------
 * W7-1b inserts a posture branch UPSTREAM of the legacy frozen-context builder.
 * The claim that the legacy arm is unchanged is therefore a claim about what the
 * tree PRODUCES, not about what its source says. A regex/diff pin over
 * `buildW4ShadowFrozenContextV1` is necessary and NOT sufficient: a text guard
 * can be deleted, and source-text identity does not establish output identity
 * once a branch has been inserted upstream of the call.
 *
 * So the load-bearing instrument is a golden-output equality harness over the
 * SERIALIZED artifacts — the frozen context in canonical form, plus both real
 * source-definition fingerprint domains computed over it.
 *
 * ---------------------------------------------------------------------------
 * THE BASE-CAPTURE MECHANIC (this is the part that is easy to get wrong)
 * ---------------------------------------------------------------------------
 * A golden generated from the post-change code proves only that the code equals
 * itself. The vectors in
 * `fixtures/w7-1b-legacy-arm-golden-vectors.json` were captured by running THIS
 * FILE at the pre-1b base commit recorded inside that file, before any
 * behavioural change existed in the branch (the "harness-first commit" mechanic:
 * this harness and its vectors are the FIRST commit of the 1b branch that
 * touches behaviour-adjacent code, and no producer had been rewired yet).
 *
 * Two properties make that capture honest, and both are asserted mechanically:
 *
 *  1. **The harness is byte-identical between the base run and the head run.**
 *     The vector file records this file's own SHA-256; `harness digest` below
 *     re-hashes the file at run time and compares. Two goldens produced by two
 *     different instruments say nothing about each other.
 *
 *  2. **The CAPTURE-ERA harness had ZERO import dependency on 1b's new
 *     modules** — it imported only `w4c0-fingerprints` and `w4c1-fingerprints`
 *     and reached production code exclusively through the plugin's existing
 *     `__attendanceW4c2LivePunchAdaptersForTests` export, which is what made
 *     running it at the pre-1b base possible at all. That property is a
 *     digest-pinned HISTORICAL fact of the capture (the recorded
 *     `harnessSha256`/`capturedAtBaseSha` pair is the audit trail). The W7-2
 *     extension below ADDS a seam import for the posture-parity legs (W7-R3's
 *     three named postures) — it never re-captures `entries`, and the
 *     committed `harnessSha256` was updated deliberately, as its own reviewed
 *     line, when the extension landed.
 *
 * THIS FILE DELIBERATELY CONTAINS NO SEAM LEG. A presence-guarded seam
 * assertion here would be a skip-when-unreachable gate: at the 1b head a seam
 * that failed to export would self-skip GREEN, which is the exact
 * green-test-against-nothing shape this codebase has been burned by. The
 * seam-vs-golden equality lives in
 * `attendance-w7-1b-issuance-seam.db.test.ts`, which boots the real host,
 * asserts the seam export is PRESENT unconditionally, and reads THESE vectors.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE GREEN RESULT MEANS — AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * Green here means: with the `attendance_calculation_context_source_state`
 * table EMPTY and `ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED` unset, the frozen
 * contexts and both source-definition fingerprints are byte-identical to the
 * pre-1b tree for every fixture in the corpus.
 *
 * It is a CONDITIONAL, HEAD-SCOPED statement under those two conditions. It is
 * NOT a claim that 1b is byte-neutral, and NOT a promise about any later head.
 * Inserting a posture row AND an exact allowlist entry deliberately changes the
 * bytes — that is the cutover, and the paired positive control below asserts
 * exactly that so "the golden did not move" cannot be confused with "the branch
 * is dead code" or "the branch was never wired".
 *
 * Shared-DB discipline: every fixture id is a file-namespaced random UUID; the
 * suite writes only its own rows and takes no globally-scoped fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { canonicalAttendanceJsonV1 } from '../../src/attendance/w4c0-fingerprints'
import {
  computeAttendanceSourceDefinitionFingerprintV1,
  computeAttendanceOuterComparableSourceDefinitionFingerprintV1,
} from '../../src/attendance/w4c1-fingerprints'
// W7-2 — the seam, for the posture-parity legs ONLY (see docblock property 2:
// the CAPTURE path above this import never touches it, and `entries` are
// never regenerated through it).
import { issueAttendanceFrozenContextV1 } from '../../src/attendance/w7-resolver/w7-frozen-context-issuance-seam'

/** The pre-1b base the committed vectors were captured at. PINNED so a
 *  re-capture from a later tree (which would record a different SHA, or none)
 *  reds here rather than being silently accepted — the harness-digest leg
 *  alone cannot catch a re-capture, because EMIT rewrites the digest too. */
const CAPTURED_AT_BASE_SHA = '348eccde90825591ed6af0b6e503d152fe3cc672'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTOR_PATH = path.join(HERE, 'fixtures', 'w7-1b-legacy-arm-golden-vectors.json')

/** Set to regenerate the vectors. NEVER set this on a tree that already carries
 *  a behavioural change — that is the self-proving capture this file exists to
 *  prevent. The recorded `capturedAtBaseSha` is the audit trail. */
const EMIT = String(process.env.W7_1B_EMIT_GOLDEN || '').trim() === '1'

const requireCjs = createRequire(import.meta.url)
type PluginExports = {
  __attendanceW4c2LivePunchAdaptersForTests: {
    buildW4ShadowFrozenContextV1: (
      trx: { query: (sql: string, params?: unknown[]) => Promise<any> },
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>
  }
}
function loadPlugin(): PluginExports {
  return requireCjs('../../../../plugins/plugin-attendance/index.cjs') as PluginExports
}

/**
 * The plugin's transaction client returns ROWS directly (`trx.query(...)[0]`),
 * unlike the core-backend client, which returns `{ rows }`. Adapting here rather
 * than passing a raw `Pool` is deliberate: passing the wrong client shape would
 * make every builder call return `undefined` and the harness would golden a
 * uniform `null`, which looks exactly like a passing run.
 */
function pluginTrx(pool: Pool) {
  return { query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows }
}

/** A frozen attribution value. Fixed, not `now()`-derived: a golden captured
 *  against a moving clock is not a golden. */
function frozenAttribution(orgId: string, userId: string, workDate: string, shiftId: string) {
  return {
    posture: 'resolved_v2' as const,
    value: {
      orgId,
      userId,
      workDate,
      shiftId,
      resolvedAt: '2026-01-05T00:00:00.000Z',
      reasonCode: 'W7_1B_GOLDEN_FIXTURE',
      resolverVersion: 'w7-1b-golden',
      attributionTailMinutes: 0,
    },
  }
}

/**
 * The fingerprints are computed over `{attribution, context}` with the org/user/
 * date/shift REDACTED out of both, because every fixture uses fresh random UUIDs
 * and a golden that embedded them would differ on every run for reasons that
 * have nothing to do with the legacy arm. What remains is exactly the POLICY
 * material the fingerprint domain exists to cover: timezone, grace, rounding,
 * thresholds, segments and flex.
 */
const IDENTITY_KEYS = new Set(['orgId', 'userId', 'workDate', 'shiftId'])
function redactIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactIdentity)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = IDENTITY_KEYS.has(key)
        ? `<redacted:${key}>`
        : redactIdentity((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

type GoldenEntry = {
  context: string
  storageFingerprint: string | null
  outerComparableFingerprint: string | null
}

function goldenFor(
  context: Record<string, unknown> | null,
  attribution: ReturnType<typeof frozenAttribution>,
): GoldenEntry {
  const redactedContext = redactIdentity(context)
  const redactedAttribution = redactIdentity(attribution)
  const input = { attribution: redactedAttribution, context: redactedContext }
  return {
    // Canonicalised with the tree's OWN canonicaliser, so key order is stable
    // by construction rather than by insertion accident.
    context: canonicalAttendanceJsonV1(redactedContext),
    storageFingerprint: computeAttendanceSourceDefinitionFingerprintV1(input),
    outerComparableFingerprint: computeAttendanceOuterComparableSourceDefinitionFingerprintV1(input),
  }
}

type Fixture = {
  id: string
  orgId: string
  userId: string
  shiftId: string
  workDate: string
  isWorkday: boolean
  holidayKind: string | null
}

describeDb('W7-1b — W7-R3 structural parity: legacy-arm golden equality (real DB)', () => {
  let pool: Pool
  const fixtures: Record<string, Fixture> = {}
  const captured: Record<string, GoldenEntry> = {}
  let harnessDigest = ''

  const mkFixture = (id: string, isWorkday = true, holidayKind: string | null = null): Fixture => {
    const f: Fixture = {
      id,
      orgId: randomUUID(),
      userId: randomUUID(),
      shiftId: randomUUID(),
      // Fixed work date: a golden must not move with the calendar.
      workDate: '2026-01-05',
      isWorkday,
      holidayKind,
    }
    fixtures[id] = f
    return f
  }

  async function insertShift(
    f: Fixture,
    opts: {
      timezone?: string
      start?: string
      end?: string
      overnight?: boolean
      lateGrace?: number
      earlyGrace?: number
      rounding?: number
      flex?: {
        requiredMinutes: number
        beforeMinutes: number
        afterMinutes: number
        coreStart: string | null
        coreEnd: string | null
      }
    } = {},
  ): Promise<void> {
    const flexMode = opts.flex ? 'flex_required_duration' : 'strict'
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes,
          flex_mode, flex_required_minutes, flex_arrival_window_before_minutes,
          flex_arrival_window_after_minutes, flex_core_start_time, flex_core_end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '[0,1,2,3,4,5,6]'::jsonb,
               $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        f.shiftId,
        f.orgId,
        `w7-1b-golden ${f.id}`,
        opts.timezone ?? 'Asia/Shanghai',
        opts.start ?? '09:00',
        opts.end ?? '18:00',
        opts.overnight ?? false,
        opts.lateGrace ?? 5,
        opts.earlyGrace ?? 7,
        opts.rounding ?? 15,
        flexMode,
        opts.flex?.requiredMinutes ?? null,
        opts.flex?.beforeMinutes ?? null,
        opts.flex?.afterMinutes ?? null,
        opts.flex?.coreStart ?? null,
        opts.flex?.coreEnd ?? null,
      ],
    )
  }

  async function insertSegments(
    f: Fixture,
    segments: readonly { start: string; end: string; endDayOffset?: 0 | 1 }[],
  ): Promise<void> {
    for (let i = 0; i < segments.length; i += 1) {
      const s = segments[i]
      await pool.query(
        `INSERT INTO attendance_shift_segments
           (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
        [randomUUID(), f.orgId, f.shiftId, i, s.start, s.end, s.endDayOffset ?? 0],
      )
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    harnessDigest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex')

    // --- The corpus. It must span the arms that EXIST, not one happy path. ---

    // 1. plain workday, single segment
    const workday = mkFixture('workday')
    await insertShift(workday)
    await insertSegments(workday, [{ start: '09:00', end: '18:00' }])

    // 2. non-workday (isWorkday false travels into the context verbatim)
    const nonWorkday = mkFixture('non_workday', false)
    await insertShift(nonWorkday)
    await insertSegments(nonWorkday, [{ start: '09:00', end: '18:00' }])

    // 3. holiday kind carried through
    const holiday = mkFixture('holiday', false, 'statutory')
    await insertShift(holiday)
    await insertSegments(holiday, [{ start: '09:00', end: '18:00' }])

    // 4. FLEX — the `flexPolicy` 15th key. This is the arm the W7-0 draft's
    //    guard order would have stripped (exact-14 before the discriminant).
    const flex = mkFixture('flex')
    await insertShift(flex, {
      start: '09:00',
      end: '18:00',
      flex: {
        requiredMinutes: 480,
        beforeMinutes: 60,
        afterMinutes: 60,
        coreStart: '11:00',
        coreEnd: '15:00',
      },
    })
    await insertSegments(flex, [{ start: '09:00', end: '18:00' }])

    // 5. OVERNIGHT — endDayOffset 1
    const overnight = mkFixture('overnight')
    await insertShift(overnight, { start: '22:00', end: '06:00', overnight: true })
    await insertSegments(overnight, [{ start: '22:00', end: '06:00', endDayOffset: 1 }])

    // 6. MULTI-SEGMENT — the split-shift arm
    const multi = mkFixture('multi_segment')
    await insertShift(multi)
    await insertSegments(multi, [
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
    ])

    // 7. NO SEGMENT ROWS — the builder's derived single-segment fallback
    const derived = mkFixture('derived_segment')
    await insertShift(derived, { start: '10:00', end: '19:00' })

    // 8. NON-DEFAULT TIMEZONE — the shift-row timezone override branch
    const tz = mkFixture('shift_timezone_override')
    await insertShift(tz, { timezone: 'America/New_York' })
    await insertSegments(tz, [{ start: '09:00', end: '17:30' }])

    // ---- Capture, through the REAL production builder. ----
    const plugin = loadPlugin()
    const build = plugin.__attendanceW4c2LivePunchAdaptersForTests.buildW4ShadowFrozenContextV1
    const trx = pluginTrx(pool)
    for (const f of Object.values(fixtures)) {
      const context = await build(trx, {
        orgId: f.orgId,
        userId: f.userId,
        workDate: f.workDate,
        shiftId: f.shiftId,
        timezone: 'Asia/Shanghai',
        isWorkday: f.isWorkday,
        holidayKind: f.holidayKind,
      })
      captured[f.id] = goldenFor(
        context,
        frozenAttribution(f.orgId, f.userId, f.workDate, f.shiftId),
      )
    }
  }, 120_000)

  afterAll(async () => {
    // Fixture cleanup is per-file-namespaced; rows are keyed by throwaway org ids.
    for (const f of Object.values(fixtures)) {
      await pool
        .query('DELETE FROM attendance_shift_segments WHERE org_id = $1', [f.orgId])
        .catch(() => undefined)
      await pool
        .query('DELETE FROM attendance_shifts WHERE org_id = $1', [f.orgId])
        .catch(() => undefined)
    }
    await pool?.end()
  })

  // -------------------------------------------------------------------------
  // Non-vacuity FIRST. A golden harness that captured nothing, or that captured
  // a uniform `null` because the client shape was wrong, looks exactly like a
  // passing run.
  // -------------------------------------------------------------------------

  it('non-vacuity: every fixture produced a real V1 context, and the corpus spans its named arms', () => {
    expect(Object.keys(captured).length).toBe(8)
    for (const [id, entry] of Object.entries(captured)) {
      expect(entry.context, `${id}: context must not be null`).not.toBe('null')
      expect(entry.storageFingerprint, `${id}: storage fingerprint`).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.outerComparableFingerprint, `${id}: outer fingerprint`).toMatch(/^[0-9a-f]{64}$/)
    }
    // The two fingerprint DOMAINS must actually differ — if a refactor ever
    // collapsed them, every equality below would still pass while covering half
    // the surface it claims to.
    for (const entry of Object.values(captured)) {
      expect(entry.storageFingerprint).not.toBe(entry.outerComparableFingerprint)
    }
    // The arms are really distinct: flex carries the 15th key, overnight carries
    // endDayOffset 1, multi carries two segments, derived carries one it built.
    expect(JSON.parse(captured.flex.context)).toHaveProperty('flexPolicy')
    expect(JSON.parse(captured.workday.context)).not.toHaveProperty('flexPolicy')
    expect(JSON.parse(captured.overnight.context).segments[0].endDayOffset).toBe(1)
    expect(JSON.parse(captured.multi_segment.context).segments).toHaveLength(2)
    expect(JSON.parse(captured.derived_segment.context).segments).toHaveLength(1)
    expect(JSON.parse(captured.shift_timezone_override.context).timezone).toBe('America/New_York')
    // Every fixture must be DISTINGUISHABLE — a corpus whose members all hash
    // the same is a single-fixture claim wearing eight names.
    const distinct = new Set(Object.values(captured).map((e) => e.storageFingerprint))
    expect(distinct.size).toBe(8)
  })

  it('harness digest: the committed vectors were produced by THIS EXACT FILE', () => {
    if (EMIT) return
    const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'))
    expect(
      vectors.harnessSha256,
      'Vectors were captured by a DIFFERENT version of this harness. Two goldens ' +
        'produced by two different instruments say nothing about each other. ' +
        'Re-capture at the recorded base SHA with W7_1B_EMIT_GOLDEN=1, or restore ' +
        'the harness — do NOT edit the recorded digest.',
    ).toBe(harnessDigest)
    expect(vectors.capturedAtBaseSha).toMatch(/^[0-9a-f]{40}$/)
    // W7-2 hardening: the recorded base is the EXACT pre-1b base, not merely
    // "some SHA" — a re-capture from a behaviour-carrying tree reds here.
    expect(vectors.capturedAtBaseSha).toBe(CAPTURED_AT_BASE_SHA)
  })

  it('T-B2/T-B4: the legacy arm is byte-identical to the pre-1b base for every fixture', () => {
    if (EMIT) {
      fs.mkdirSync(path.dirname(VECTOR_PATH), { recursive: true })
      fs.writeFileSync(
        VECTOR_PATH,
        `${JSON.stringify(
          {
            _README:
              'CAPTURED AT THE PRE-1b BASE. Do not regenerate from a tree that already ' +
              'carries a behavioural change — a golden generated from the post-change ' +
              'code proves only that the code equals itself.',
            capturedAtBaseSha: String(process.env.W7_1B_GOLDEN_BASE_SHA || '').trim(),
            harnessSha256: harnessDigest,
            entries: captured,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      return
    }
    const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'))
    // Compared per-fixture rather than as one blob, so a failure names the arm.
    for (const id of Object.keys(vectors.entries)) {
      expect(captured[id], `fixture ${id} vanished from the corpus`).toBeDefined()
      expect(captured[id].context, `${id}: canonical context bytes moved`).toBe(
        vectors.entries[id].context,
      )
      expect(captured[id].storageFingerprint, `${id}: STORAGE fingerprint moved`).toBe(
        vectors.entries[id].storageFingerprint,
      )
      expect(
        captured[id].outerComparableFingerprint,
        `${id}: OUTER-COMPARABLE fingerprint moved`,
      ).toBe(vectors.entries[id].outerComparableFingerprint)
    }
    // Both directions: a fixture silently dropped from the corpus must red too.
    expect(Object.keys(captured).sort()).toEqual(Object.keys(vectors.entries).sort())
  })

  // ---------------------------------------------------------------------------
  // W7-2 — T-A1: W7-R3 names THREE postures for byte parity: no W7 posture
  // (the legs above), `group_shadow` and `group_eligible`. The two new legs
  // drive the REAL seam (dual-run) and assert the SERVED half is byte-identical
  // to the SAME committed vectors — with the arm asserted first, so "unchanged
  // bytes" cannot be satisfied by the branch never engaging (an unhit probe and
  // a dead gate look identical).
  //
  // The group half fails closed here BY FIXTURE (no W1 membership rows exist
  // for these orgs => `membership-absent`), which is itself the positive
  // control that the dual-run really ran its group arm: a seam that silently
  // skipped it would carry `shadowReason: null`. The produced-group-context
  // twin lives in `attendance-w7-2-group-shadow-dualrun.db.test.ts`.
  // ---------------------------------------------------------------------------

  const W7_POSTURE_TABLE = 'attendance_calculation_context_source_state'
  const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'

  function coreTrx(p: Pool) {
    return {
      query: async (sqlText: string, params?: unknown[]) => ({
        rows: (await p.query(sqlText, params)).rows,
      }),
    }
  }

  function seamDeps() {
    const plugin = loadPlugin()
    const build = plugin.__attendanceW4c2LivePunchAdaptersForTests.buildW4ShadowFrozenContextV1
    const effectivenessLib = requireCjs(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
    ) as { deriveAttendanceGroupFixedScheduleEffectiveness: unknown }
    const producerKeyLib = requireCjs(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
    ) as { buildAttendanceGroupFixedScheduleProducerKey: unknown }
    expect(typeof effectivenessLib.deriveAttendanceGroupFixedScheduleEffectiveness).toBe('function')
    expect(typeof producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey).toBe('function')
    const trx = pluginTrx(pool)
    return {
      deriveFixedScheduleEffectiveness:
        effectivenessLib.deriveAttendanceGroupFixedScheduleEffectiveness,
      buildFixedScheduleProducerKey: producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey,
      // Reached only AFTER a membership resolves; these fixtures have none, so
      // a call here means the fixture premise broke — fail loudly, never stub.
      loadOrgRuleFacts: async () => {
        throw new Error('W7-2 golden harness: loadOrgRuleFacts must be unreachable (no memberships seeded)')
      },
      buildLegacyFrozenContext: (legacyArgs: Record<string, unknown>) => build(trx, legacyArgs),
    } as never
  }

  async function runPostureParityLeg(posture: 'group_shadow' | 'group_eligible'): Promise<void> {
    const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'))
    const priorEnv = process.env[W7_ENV]
    const orgKeys = Object.values(fixtures).map((f) => f.orgId.toLowerCase())
    process.env[W7_ENV] = orgKeys.join(',')
    try {
      for (const f of Object.values(fixtures)) {
        await pool.query(
          `INSERT INTO ${W7_POSTURE_TABLE} (org_id, state, scope) VALUES ($1, $2, 'synthetic_staging')`,
          [f.orgId.toLowerCase(), posture],
        )
      }
      for (const [id, f] of Object.entries(fixtures)) {
        const issued = (await issueAttendanceFrozenContextV1(coreTrx(pool) as never, seamDeps(), {
          orgId: f.orgId,
          userId: f.userId,
          workDate: f.workDate,
          timezone: 'Asia/Shanghai',
          isWorkday: f.isWorkday,
          holidayKind: f.holidayKind,
          shiftId: f.shiftId,
          purpose: 'persist',
        })) as {
          arm: string
          context: Record<string, unknown> | null
          shadowContext?: unknown
          shadowReason?: string | null
        }
        // ANCHOR FIRST: the branch really engaged for this posture.
        expect(issued.arm, `${id} (${posture}): arm`).toBe('legacy_with_group_shadow')
        // The group arm really RAN and failed closed on the fixture's missing
        // membership — a skipped group arm would carry null/null.
        expect(issued.shadowReason, `${id} (${posture}): group-arm fail-close reason`).toBe(
          'membership-absent',
        )
        expect(issued.shadowContext, `${id} (${posture}): no group context can exist here`).toBeNull()
        // THE PARITY CLAIM: the SERVED half is byte-identical to the committed
        // pre-1b vectors — canonical bytes and BOTH fingerprint domains.
        const golden = goldenFor(
          issued.context,
          frozenAttribution(f.orgId, f.userId, f.workDate, f.shiftId),
        )
        expect(golden.context, `${id} (${posture}): served context bytes`).toBe(
          vectors.entries[id].context,
        )
        expect(golden.storageFingerprint, `${id} (${posture}): storage fingerprint`).toBe(
          vectors.entries[id].storageFingerprint,
        )
        expect(golden.outerComparableFingerprint, `${id} (${posture}): outer fingerprint`).toBe(
          vectors.entries[id].outerComparableFingerprint,
        )
        // The MIRROR purpose stays on the plain legacy arm in this posture —
        // the observer of the SERVED path must observe the served (legacy)
        // result, and must not mint an unserved group context.
        const mirrored = (await issueAttendanceFrozenContextV1(coreTrx(pool) as never, seamDeps(), {
          orgId: f.orgId,
          userId: f.userId,
          workDate: f.workDate,
          timezone: 'Asia/Shanghai',
          isWorkday: f.isWorkday,
          holidayKind: f.holidayKind,
          shiftId: f.shiftId,
          purpose: 'mirror',
        })) as { arm: string; context: Record<string, unknown> | null }
        expect(mirrored.arm, `${id} (${posture}): mirror arm`).toBe('legacy')
        expect(
          canonicalAttendanceJsonV1(redactIdentity(mirrored.context)),
          `${id} (${posture}): mirror served bytes`,
        ).toBe(vectors.entries[id].context)
      }
    } finally {
      if (priorEnv === undefined) delete process.env[W7_ENV]
      else process.env[W7_ENV] = priorEnv
      await pool
        .query(`DELETE FROM ${W7_POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [orgKeys])
        .catch(() => undefined)
    }
  }

  it('W7-2 T-A1 (group_shadow): the SERVED half of the dual-run is byte-identical to the pre-1b golden for every fixture', async () => {
    if (EMIT) return
    await runPostureParityLeg('group_shadow')
  }, 60_000)

  it('W7-2 T-A1 (group_eligible): the SERVED half of the dual-run is byte-identical to the pre-1b golden for every fixture', async () => {
    if (EMIT) return
    await runPostureParityLeg('group_eligible')
  }, 60_000)

})
