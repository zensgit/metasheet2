/**
 * W4C-2 (#4556) — V2 frozen-attribution freeze semantics + deterministic
 * scheduled run identity (lock 4.1/5.1/5.2; slice 12.3 "freeze W2/context").
 *
 * Freeze doctrine under test (pure layer): the minted V2 value's absolute and
 * attribution windows are LITERALS of the candidate the W2 resolver selected —
 * a later tail-policy, approved-overtime, or assignment change can never move
 * them. The builder therefore has exactly two behaviors: either the candidate
 * windows are strictly reconstructible and explained by the named tail/OT
 * evidence (=> resolved_v2 with those exact instants), or it refuses to mint
 * (`not_reconstructible` => the boundary's `unsupported`/review mapping). There
 * is NO third behavior that "re-derives" a window from current policy — the
 * negative legs here pin that refusal for every unexplained-end shape.
 *
 * Scheduled run identity: formerly a UUIDv5 derivation golden-pinned in this
 * file (`deriveAttendanceScheduledRunIdV1`); retired by the W4C-2 caller
 * cutover (owner ruling 2026-07-28, "(b-narrow)") — `runId` is now always the
 * server-minted `attendance_scheduled_runs.run_id` row
 * `createOrResumeAttendanceScheduledRunV1` (w4c2-scheduled-run.ts) produces,
 * never a pure function of (initiator, orgId, workDate). Its dedicated
 * describe block below is removed with it (section 1.1's "must not survive
 * implementation" rule); the durable row's own identity/lifecycle gates live
 * in `attendance-w4c2-p12-run-transactions.db.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1,
  AttendanceW4FrozenAttributionError,
  buildFrozenWorkDateAttributionV2,
  computeAttendanceWindowEvidenceFingerprintV1,
  type AttendanceFrozenAttributionBuildInputV1,
} from '../w4c2-frozen-attribution'

// Asia/Shanghai (no DST): 2026-07-20 09:00 => 01:00Z, 18:00 => 10:00Z.
const ABS_START = '2026-07-20T01:00:00.000Z'
const ABS_END = '2026-07-20T10:00:00.000Z'
const TAIL_30_END = '2026-07-20T10:30:00.000Z'

function baseInput(
  overrides: Partial<AttendanceFrozenAttributionBuildInputV1> = {},
): AttendanceFrozenAttributionBuildInputV1 {
  return {
    orgId: 'org-w4c2-frozen',
    userId: 'user-w4c2-frozen',
    workDate: '2026-07-20',
    shiftId: 'shift-w4c2-frozen',
    reasonCode: 'SINGLE_MATCHING_CANDIDATE',
    resolvedAt: '2026-07-20T02:00:00.000Z',
    timezone: 'Asia/Shanghai',
    workStartTime: '09:00',
    workEndTime: '18:00',
    isOvernight: false,
    candidateAbsoluteWindow: { startAt: ABS_START, endAt: ABS_END },
    candidateAttributionWindow: { startAt: ABS_START, endAt: TAIL_30_END },
    attributionTailMinutes: 30,
    approvedOvertimeWindows: [],
    source: 'live_resolution',
    ...overrides,
  }
}

describe('buildFrozenWorkDateAttributionV2 — freeze semantics', () => {
  it('positive control: reconstructible candidate mints resolved_v2 whose windows are the candidate LITERALS', () => {
    const result = buildFrozenWorkDateAttributionV2(baseInput())
    expect(result.kind).toBe('resolved_v2')
    if (result.kind !== 'resolved_v2') throw new Error('unreachable')
    const value = result.attribution.value
    // Exact frozen shape — every window instant is the candidate's own byte.
    expect(value).toEqual({
      schemaVersion: 2,
      resolverVersion: ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1,
      orgId: 'org-w4c2-frozen',
      userId: 'user-w4c2-frozen',
      workDate: '2026-07-20',
      shiftId: 'shift-w4c2-frozen',
      reasonCode: 'SINGLE_MATCHING_CANDIDATE',
      resolvedAt: '2026-07-20T02:00:00.000Z',
      absoluteWindow: { startAt: ABS_START, endAt: ABS_END },
      attributionWindow: { startAt: ABS_START, endAt: TAIL_30_END },
      attributionTailMinutes: 30,
      extendedByApprovedOvertime: false,
      windowEvidenceFingerprint: computeAttendanceWindowEvidenceFingerprintV1({
        attributionTailMinutes: 30,
        approvedOvertimeWindows: [],
      }),
      source: 'live_resolution',
    })
  })

  it('approved-overtime-explained extension mints resolved_v2 with the extension flag and the same literal windows', () => {
    // OT approved end 20:00 local => 12:00Z; attribution end = 12:00Z + 30min tail.
    const otExplainedEnd = '2026-07-20T12:30:00.000Z'
    const result = buildFrozenWorkDateAttributionV2(
      baseInput({
        candidateAttributionWindow: { startAt: ABS_START, endAt: otExplainedEnd },
        approvedOvertimeWindows: [
          { requestId: 'ot-req-1', approvedEndAt: '2026-07-20T12:00:00.000Z', anchor: { kind: 'shift_end' } },
        ],
      }),
    )
    expect(result.kind).toBe('resolved_v2')
    if (result.kind !== 'resolved_v2') throw new Error('unreachable')
    expect(result.attribution.value.extendedByApprovedOvertime).toBe(true)
    expect(result.attribution.value.absoluteWindow).toEqual({ startAt: ABS_START, endAt: ABS_END })
    expect(result.attribution.value.attributionWindow).toEqual({ startAt: ABS_START, endAt: otExplainedEnd })
  })

  it('a changed tail policy can never MOVE a frozen window: the stale candidate end becomes unexplained, not shifted', () => {
    // Candidate froze end = shift end + 30; a tail-policy change to 60 arrives
    // through the input. The builder must refuse — never emit a window moved to
    // the new policy's end.
    const result = buildFrozenWorkDateAttributionV2(baseInput({ attributionTailMinutes: 60 }))
    expect(result).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_END_UNEXPLAINED' })
  })

  it('a removed overtime approval can never silently keep its extension: extended end with no named OT evidence is refused', () => {
    const result = buildFrozenWorkDateAttributionV2(
      baseInput({
        candidateAttributionWindow: { startAt: ABS_START, endAt: '2026-07-20T12:30:00.000Z' },
        approvedOvertimeWindows: [],
      }),
    )
    expect(result).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_END_UNEXPLAINED' })
  })

  it('an attribution end SHORTER than shift end + tail is refused (windows cannot shrink either)', () => {
    const result = buildFrozenWorkDateAttributionV2(
      baseInput({ candidateAttributionWindow: { startAt: ABS_START, endAt: ABS_END } }),
    )
    expect(result).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_END_UNEXPLAINED' })
  })

  it('an attribution start diverging from the absolute start is refused', () => {
    const result = buildFrozenWorkDateAttributionV2(
      baseInput({
        candidateAttributionWindow: { startAt: '2026-07-20T00:30:00.000Z', endAt: TAIL_30_END },
      }),
    )
    expect(result).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_START_MISMATCH' })
  })

  it('legacy-helper drift: a candidate absolute window the strict rebuild cannot reproduce is refused instant-for-instant', () => {
    // Start drifted by one hour (the buildZonedDate-fallback shape).
    const startDrift = buildFrozenWorkDateAttributionV2(
      baseInput({
        candidateAbsoluteWindow: { startAt: '2026-07-20T02:00:00.000Z', endAt: ABS_END },
        candidateAttributionWindow: { startAt: '2026-07-20T02:00:00.000Z', endAt: TAIL_30_END },
      }),
    )
    expect(startDrift).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_START_MISMATCH' })
    const endDrift = buildFrozenWorkDateAttributionV2(
      baseInput({
        candidateAbsoluteWindow: { startAt: ABS_START, endAt: '2026-07-20T11:00:00.000Z' },
        candidateAttributionWindow: { startAt: ABS_START, endAt: '2026-07-20T11:30:00.000Z' },
      }),
    )
    expect(endDrift).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_END_MISMATCH' })
  })

  it('a DST gap on a boundary refuses to mint (start leg and end leg independently)', () => {
    // America/New_York 2026-03-08: 02:00-03:00 does not exist.
    const gapStart = buildFrozenWorkDateAttributionV2(
      baseInput({
        workDate: '2026-03-08',
        timezone: 'America/New_York',
        workStartTime: '02:30',
        workEndTime: '11:00',
        candidateAbsoluteWindow: { startAt: '2026-03-08T07:30:00.000Z', endAt: '2026-03-08T15:00:00.000Z' },
        candidateAttributionWindow: { startAt: '2026-03-08T07:30:00.000Z', endAt: '2026-03-08T15:30:00.000Z' },
      }),
    )
    expect(gapStart).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_START_NOT_UNIQUE' })
    const gapEnd = buildFrozenWorkDateAttributionV2(
      baseInput({
        workDate: '2026-03-08',
        timezone: 'America/New_York',
        workStartTime: '00:30',
        workEndTime: '02:30',
        candidateAbsoluteWindow: { startAt: '2026-03-08T05:30:00.000Z', endAt: '2026-03-08T07:30:00.000Z' },
        candidateAttributionWindow: { startAt: '2026-03-08T05:30:00.000Z', endAt: '2026-03-08T08:00:00.000Z' },
      }),
    )
    expect(gapEnd).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_END_NOT_UNIQUE' })
  })

  it('a DST fold on a boundary refuses to mint (ambiguous local time never freezes silently)', () => {
    // America/New_York 2026-11-01: 01:00-02:00 occurs twice.
    const fold = buildFrozenWorkDateAttributionV2(
      baseInput({
        workDate: '2026-11-01',
        timezone: 'America/New_York',
        workStartTime: '01:30',
        workEndTime: '09:00',
        candidateAbsoluteWindow: { startAt: '2026-11-01T05:30:00.000Z', endAt: '2026-11-01T14:00:00.000Z' },
        candidateAttributionWindow: { startAt: '2026-11-01T05:30:00.000Z', endAt: '2026-11-01T14:30:00.000Z' },
      }),
    )
    expect(fold).toEqual({ kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_START_NOT_UNIQUE' })
  })

  it('input-shape violations THROW the closed values-free error (never a business refusal)', () => {
    const shapes: Array<Partial<AttendanceFrozenAttributionBuildInputV1>> = [
      { workDate: '2026/07/20' },
      { workStartTime: '9:00' },
      { workEndTime: '24:00' },
      { attributionTailMinutes: -1 },
      { attributionTailMinutes: 30.5 },
      { source: 'import_resolution' as unknown as 'live_resolution' },
      { timezone: '' },
      { shiftId: '' },
    ]
    for (const override of shapes) {
      let thrown: unknown
      try {
        buildFrozenWorkDateAttributionV2(baseInput(override))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AttendanceW4FrozenAttributionError)
      expect((thrown as AttendanceW4FrozenAttributionError).code).toBe('W4C2_FROZEN_ATTRIBUTION_INPUT_INVALID')
    }
  })
})

describe('computeAttendanceWindowEvidenceFingerprintV1 — window-policy evidence freeze', () => {
  const otA = { requestId: 'ot-a', approvedEndAt: '2026-07-20T12:00:00.000Z', anchor: { kind: 'shift_end' } }
  const otB = { requestId: 'ot-b', approvedEndAt: '2026-07-20T13:00:00.000Z', anchor: null }

  it('is caller-order-insensitive over OT entries and sensitive to tail, OT identity, and anchor bytes', () => {
    const base = computeAttendanceWindowEvidenceFingerprintV1({
      attributionTailMinutes: 30,
      approvedOvertimeWindows: [otA, otB],
    })
    const reordered = computeAttendanceWindowEvidenceFingerprintV1({
      attributionTailMinutes: 30,
      approvedOvertimeWindows: [otB, otA],
    })
    expect(reordered).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    const tailChanged = computeAttendanceWindowEvidenceFingerprintV1({
      attributionTailMinutes: 31,
      approvedOvertimeWindows: [otA, otB],
    })
    expect(tailChanged).not.toBe(base)
    const otDropped = computeAttendanceWindowEvidenceFingerprintV1({
      attributionTailMinutes: 30,
      approvedOvertimeWindows: [otA],
    })
    expect(otDropped).not.toBe(base)
    const anchorChanged = computeAttendanceWindowEvidenceFingerprintV1({
      attributionTailMinutes: 30,
      approvedOvertimeWindows: [{ ...otA, anchor: { kind: 'fixed_end' } }, otB],
    })
    expect(anchorChanged).not.toBe(base)
  })

  it('rejects malformed evidence shapes with the closed per-layer error', () => {
    // Shape violations owned by this module refuse with its own closed error;
    // an offset-less approvedEndAt is refused one layer down by the ONE strict
    // instant parser (AttendanceW4TimeError) — never silently coerced.
    const ownShapeCases = [
      { attributionTailMinutes: -1, approvedOvertimeWindows: [] },
      { attributionTailMinutes: 0.5, approvedOvertimeWindows: [] },
      { attributionTailMinutes: 30, approvedOvertimeWindows: [{ requestId: '', approvedEndAt: otA.approvedEndAt, anchor: null }] },
    ]
    for (const bad of ownShapeCases) {
      let thrown: unknown
      try {
        computeAttendanceWindowEvidenceFingerprintV1(bad as never)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AttendanceW4FrozenAttributionError)
    }
    let strictTimeThrown: unknown
    try {
      computeAttendanceWindowEvidenceFingerprintV1({
        attributionTailMinutes: 30,
        approvedOvertimeWindows: [{ requestId: 'x', approvedEndAt: '2026-07-20 12:00', anchor: null }],
      })
    } catch (error) {
      strictTimeThrown = error
    }
    expect((strictTimeThrown as { name?: string; code?: string })?.name).toBe('AttendanceW4TimeError')
    expect((strictTimeThrown as { code?: string })?.code).toBe('W4C1_INSTANT_INVALID')
  })
})

