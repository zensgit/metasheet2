import { describe, expect, it } from 'vitest'
import {
  applyFrozenManualOverrideSnapshotToDailyProjectionV1,
  applyManualOverrideDailyOverlayV1,
  assertManualOverrideOperationsValidV1,
  assertNoPostWriteManualMetaPatchV1,
  buildManualAttendanceOverrideSnapshotV1,
  buildManualResultEditMarkerInWriteV1,
  mergeManualResultEditMetaForUpsertV1,
  ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES,
} from '../w4c3c-manual-override'
import {
  ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES,
  computeManualEditPayloadFingerprintV1,
} from '../w4c3c-manual-edit-apply'

describe('W4C-3c manual override', () => {
  it('validates set/unset operations fail closed on unknown fields and bad unset values', () => {
    expect(() =>
      assertManualOverrideOperationsValidV1([{ op: 'set', field: 'status', value: 'normal' }]),
    ).not.toThrow()
    expect(() =>
      assertManualOverrideOperationsValidV1([{ op: 'unset', field: 'lateMinutes', value: null }]),
    ).not.toThrow()
    expect(() =>
      assertManualOverrideOperationsValidV1([{ op: 'set', field: 'unknown', value: 1 }]),
    ).toThrowError(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.FIELD_UNKNOWN)
    expect(() =>
      assertManualOverrideOperationsValidV1([{ op: 'unset', field: 'status', value: 'normal' }]),
    ).toThrowError(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.UNSET_VALUE_NOT_NULL)
    expect(() =>
      assertManualOverrideOperationsValidV1([{ op: 'set', field: 'status', value: null }]),
    ).toThrowError(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.SET_VALUE_REQUIRED)
  })

  it('unset operation keeps null value (never invents zero at the contract layer)', () => {
    const ops = assertManualOverrideOperationsValidV1([
      { op: 'unset', field: 'workMinutes', value: null },
      { op: 'unset', field: 'lateMinutes', value: null },
    ])
    expect(ops[0].value).toBeNull()
    expect(ops[1].value).toBeNull()
    // Discriminating mutation: silent zero-coercion of unset would fail this.
    expect(ops.every((op) => op.value === null)).toBe(true)
    expect(ops.some((op) => op.value === 0)).toBe(false)
  })

  it('builds a frozen ManualAttendanceOverrideV1 snapshot with stable before fingerprint', () => {
    const left = buildManualAttendanceOverrideSnapshotV1({
      editId: '11111111-1111-1111-1111-111111111111',
      before: { status: 'late', workMinutes: 400 },
      reason: 'admin correction',
      operations: [{ op: 'set', field: 'status', value: 'normal' }],
    })
    const right = buildManualAttendanceOverrideSnapshotV1({
      editId: '11111111-1111-1111-1111-111111111111',
      before: { status: 'late', workMinutes: 400 },
      reason: 'admin correction',
      operations: [{ op: 'set', field: 'status', value: 'normal' }],
    })
    expect(left.beforeFingerprint).toBe(right.beforeFingerprint)
    expect(left.actorPosture).toBe('attendance_admin')
    expect(left.operations).toHaveLength(1)
  })

  it('freezes the meta marker for the same projection write', () => {
    const marker = buildManualResultEditMarkerInWriteV1({
      auditId: null,
      idempotencyKey: 'k1',
      targetStatus: 'normal',
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      workDate: '2026-08-01',
      firstInAt: '2026-08-01T01:00:00.000Z',
      lastOutAt: '2026-08-01T10:00:00.000Z',
      isWorkday: true,
      actorUserId: 'actor-1',
    })
    expect(marker.version).toBe(1)
    expect(marker.targetStatus).toBe('normal')
    expect((marker.correctedMetrics as { workMinutes: number }).workMinutes).toBe(480)
  })

  it('preserves an existing marker across unrelated updates until explicit supersession', () => {
    const existing = {
      manual_result_edit: {
        version: 1,
        targetStatus: 'normal',
        correctedAgainst: {
          workDate: '2026-08-01',
          firstInAt: '2026-08-01T01:00:00.000Z',
          lastOutAt: '2026-08-01T10:00:00.000Z',
        },
      },
      other: true,
    }
    const preserved = mergeManualResultEditMetaForUpsertV1({
      existingMeta: existing,
      incomingMeta: { punchSource: 'live' },
      statusOverride: null,
      derivedStatus: 'late',
      latestFacts: {
        workDate: '2026-08-01',
        firstInAt: '2026-08-01T01:05:00.000Z',
        lastOutAt: '2026-08-01T10:00:00.000Z',
        isWorkday: true,
      },
    })
    expect(preserved.manual_result_edit).toBeTruthy()
    expect((preserved.manual_result_edit as { reviewConflict: unknown }).reviewConflict).toBeTruthy()

    const superseded = mergeManualResultEditMetaForUpsertV1({
      existingMeta: existing,
      incomingMeta: { manual_result_edit: { version: 1, targetStatus: 'adjusted' } },
      statusOverride: 'adjusted',
    })
    expect((superseded.manual_result_edit as { targetStatus: string }).targetStatus).toBe('adjusted')

    const cleared = mergeManualResultEditMetaForUpsertV1({
      existingMeta: existing,
      incomingMeta: {},
      statusOverride: 'late',
    })
    expect(cleared.manual_result_edit).toBeUndefined()
  })

  it('kills reintroduction of a post-write meta patch helper', () => {
    expect(() =>
      assertNoPostWriteManualMetaPatchV1(
        'async function attachManualResultEditMarkerToRecord(trx, record, marker) { await trx.query(`UPDATE attendance_records SET meta = $1`) }',
      ),
    ).toThrowError(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.POST_WRITE_META_PATCH_FORBIDDEN)
  })

  it('payload fingerprint binds record + operations (replay identity component)', () => {
    const base = {
      recordId: '11111111-1111-4111-8111-111111111111',
      expectedCalculationId: '22222222-2222-4222-8222-222222222222',
      expectedCalculationVersion: 1,
      operations: assertManualOverrideOperationsValidV1([
        { op: 'set', field: 'status', value: 'normal' },
      ]),
      reason: 'admin correction',
    }
    const a = computeManualEditPayloadFingerprintV1(base)
    const b = computeManualEditPayloadFingerprintV1(base)
    expect(a).toBe(b)
    const mutated = computeManualEditPayloadFingerprintV1({
      ...base,
      reason: 'different reason',
    })
    expect(mutated).not.toBe(a)
  })

  it('exposes PRIOR_INCOMPLETE for fabricated first/last inference mutations to assert against', () => {
    expect(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.PRIOR_INCOMPLETE).toBe(
      'W4C3C_MANUAL_EDIT_PRIOR_INCOMPLETE',
    )
    expect(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.OPERATION_ID_REQUIRED).toBe(
      'W4C3C_MANUAL_EDIT_OPERATION_ID_REQUIRED',
    )
    expect(ATTENDANCE_MANUAL_EDIT_APPLY_ERROR_CODES.REPLAY_CONFLICT).toBe(
      'W4C3C_MANUAL_EDIT_REPLAY_CONFLICT',
    )
  })

  it('pure daily overlay applies set/unset without inventing first/last or coercing unset to zero', () => {
    const ops = assertManualOverrideOperationsValidV1([
      { op: 'set', field: 'status', value: 'normal' },
      { op: 'set', field: 'workMinutes', value: 480 },
      { op: 'unset', field: 'lateMinutes', value: null },
    ])
    const overlaid = applyManualOverrideDailyOverlayV1(
      {
        status: 'late',
        firstInAt: '2026-08-01T01:00:00.000Z',
        lastOutAt: '2026-08-01T10:00:00.000Z',
        workMinutes: 400,
        lateMinutes: 15,
        earlyLeaveMinutes: 0,
      },
      ops,
    )
    expect(overlaid.status).toBe('normal')
    expect(overlaid.workMinutes).toBe(480)
    expect(overlaid.lateMinutes).toBeNull()
    expect(overlaid.firstInAt).toBe('2026-08-01T01:00:00.000Z')
    expect(overlaid.lastOutAt).toBe('2026-08-01T10:00:00.000Z')
  })

  it('frozen snapshot overlay preserves surviving manual override for recompute', () => {
    const snapshot = buildManualAttendanceOverrideSnapshotV1({
      editId: '11111111-1111-4111-8111-111111111111',
      before: { status: 'late', workMinutes: 400 },
      reason: 'admin',
      operations: [
        { op: 'set', field: 'status', value: 'normal' },
        { op: 'set', field: 'workMinutes', value: 480 },
      ],
    })
    const base = {
      status: 'late',
      firstInAt: null,
      lastOutAt: null,
      workMinutes: 390,
      lateMinutes: 12,
      earlyLeaveMinutes: 0,
    }
    const overlaid = applyFrozenManualOverrideSnapshotToDailyProjectionV1(base, snapshot)
    expect(overlaid.status).toBe('normal')
    expect(overlaid.workMinutes).toBe(480)
    expect(overlaid.lateMinutes).toBe(12)
    // null snapshot → base unchanged
    expect(applyFrozenManualOverrideSnapshotToDailyProjectionV1(base, null).status).toBe('late')
    // A present malformed immutable snapshot must not silently fall back to the
    // physical projection and discard an administrator correction.
    expect(() => applyFrozenManualOverrideSnapshotToDailyProjectionV1(base, {})).toThrow(
      ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID,
    )
    expect(() =>
      applyFrozenManualOverrideSnapshotToDailyProjectionV1(base, {
        operations: [{ op: 'set', field: 'workMinutes', value: -1 }],
      }),
    ).toThrow(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  })
})
