import { describe, expect, it, vi } from 'vitest'
import {
  computeLegacyImportRecordPreconditionFingerprintV1,
  LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
  type LegacyImportRecordWritePlanV1,
} from '../w4c3a-legacy-execution-plan'
import { lockAndRecheckAttendanceLegacyRecordPreconditionsV1 } from '../w4c3a-legacy-plan-preconditions'
import type { VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const ORG_ID = 'org-a'
const USER_ID = 'user-a'
const RECORD_ID = '10000000-0000-4000-8000-000000000001'
const BATCH_ID = '10000000-0000-4000-8000-000000000002'
const WRITE_ID = '10000000-0000-4000-8000-000000000003'

const EXISTING_ROW = {
  id: RECORD_ID,
  org_id: ORG_ID,
  user_id: USER_ID,
  work_date: '2026-07-30',
  first_in_at: new Date('2026-07-30T01:00:00.000Z'),
  last_out_at: new Date('2026-07-30T09:00:00.000Z'),
  work_minutes: 480,
  late_minutes: 0,
  early_leave_minutes: 0,
  status: 'normal',
  is_workday: true,
  meta: { source: 'import' },
  source_batch_id: BATCH_ID,
  visibility_state: 'active',
  visibility_reason: 'active',
}

function existingWrite(
  overrides: Partial<LegacyImportRecordWritePlanV1> = {},
): LegacyImportRecordWritePlanV1 {
  const fingerprint = computeLegacyImportRecordPreconditionFingerprintV1({
    exists: true,
    id: RECORD_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    workDate: '2026-07-30',
    firstInAt: '2026-07-30T01:00:00.000Z',
    lastOutAt: '2026-07-30T09:00:00.000Z',
    workMinutes: 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    status: 'normal',
    isWorkday: true,
    meta: { source: 'import' },
    sourceBatchId: BATCH_ID,
  })
  return {
    recordWriteId: WRITE_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    workDate: '2026-07-30',
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: null,
    lastOutAt: null,
    workMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    status: null,
    isWorkday: null,
    timezone: 'Asia/Taipei',
    targetRevision: 4,
    existingRecordPreconditionFingerprint: fingerprint,
    expectedSourceOwnership: BATCH_ID,
    recordId: RECORD_ID,
    compatibilityMetadata: {},
    policySnapshot: {},
    profileSnapshot: {},
    multiPunchSnapshot: {},
    attributionSnapshot: {},
    sourceBatchId: BATCH_ID,
    resultSlots: {},
    ...overrides,
  }
}

function missingWrite(
  overrides: Partial<LegacyImportRecordWritePlanV1> = {},
): LegacyImportRecordWritePlanV1 {
  return existingWrite({
    targetRevision: 0,
    existingRecordPreconditionFingerprint:
      LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
    expectedSourceOwnership: null,
    recordId: '10000000-0000-4000-8000-000000000004',
    ...overrides,
  })
}

function plan(
  recordWrites: readonly LegacyImportRecordWritePlanV1[],
): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {},
    chunks: [],
    items: [],
    recordWrites,
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

function queryStub(rowsByCall: Array<Array<Record<string, unknown>>>) {
  const query = vi.fn(async () => ({ rows: rowsByCall.shift() ?? [] }))
  return { query }
}

describe('lockAndRecheckAttendanceLegacyRecordPreconditionsV1', () => {
  it('locks an existing record before its revision and checks the full fingerprint', async () => {
    const db = queryStub([[EXISTING_ROW], [{ revision: '4' }]])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        db,
        plan([existingWrite()]),
      ),
    ).resolves.toBe(true)

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      'FROM attendance_records',
    )
    expect(String(db.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(String(db.query.mock.calls[1]?.[0])).toContain(
      'FROM attendance_record_target_revisions',
    )
  })

  it('locks a missing target revision before rechecking absence', async () => {
    const db = queryStub([[{ revision: '0' }], []])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        db,
        plan([missingWrite()]),
      ),
    ).resolves.toBe(true)

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      'FROM attendance_record_target_revisions',
    )
    expect(String(db.query.mock.calls[1]?.[0])).toContain(
      'FROM attendance_records',
    )
    expect(String(db.query.mock.calls[1]?.[0])).not.toContain('FOR UPDATE')
  })

  it('fails closed when a frozen-existing row disappears before revision access', async () => {
    const db = queryStub([[]])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        db,
        plan([existingWrite()]),
      ),
    ).resolves.toBe(false)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('operator-retired import target fails before revision/effect SQL', async () => {
    const db = queryStub([[
      {
        ...EXISTING_ROW,
        visibility_state: 'retired',
        visibility_reason: 'operator_retirement',
      },
    ]])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        db,
        plan([existingWrite()]),
      ),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_RECORD_OPERATOR_RETIRED' })
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
  })

  it('fails closed when a frozen-missing row appears after its revision lock', async () => {
    const db = queryStub([[{ revision: '0' }], [{ present: 1 }]])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        db,
        plan([missingWrite()]),
      ),
    ).resolves.toBe(false)
  })

  it('rejects revision, fingerprint, and source-ownership drift', async () => {
    const revisionDrift = queryStub([[EXISTING_ROW], [{ revision: '5' }]])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        revisionDrift,
        plan([existingWrite()]),
      ),
    ).resolves.toBe(false)

    const fingerprintDrift = queryStub([
      [{ ...EXISTING_ROW, work_minutes: 481 }],
      [{ revision: '4' }],
    ])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        fingerprintDrift,
        plan([existingWrite()]),
      ),
    ).resolves.toBe(false)

    const ownershipDrift = queryStub([
      [{ ...EXISTING_ROW, source_batch_id: null }],
      [{ revision: '4' }],
    ])
    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        ownershipDrift,
        plan([existingWrite()]),
      ),
    ).resolves.toBe(false)
  })

  it('propagates SQL errors for the governing transaction retry', async () => {
    const serialization = Object.assign(new Error('serialization failure'), {
      code: '40001',
    })
    const db = {
      query: vi.fn(async () => {
        throw serialization
      }),
    }

    await expect(
      lockAndRecheckAttendanceLegacyRecordPreconditionsV1(
        db,
        plan([missingWrite()]),
      ),
    ).rejects.toBe(serialization)
  })
})
