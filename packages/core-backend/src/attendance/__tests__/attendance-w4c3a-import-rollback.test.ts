import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAuthorizedAttendanceWriteContextV1 } from '../w4c0-authorization'
import {
  AttendanceImportRollbackError,
  computeAttendanceImportRollbackPreimageFingerprintV1,
  createFrozenAttendanceImportRollbackCommandV1,
  parseAttendanceImportRollbackPreimageV1,
} from '../w4c3a-import-rollback'

const orgId = crypto.randomUUID()
const actorId = crypto.randomUUID()

function auth(capability: 'rollback' | 'import' = 'rollback') {
  return createAuthorizedAttendanceWriteContextV1({
    actorId,
    actorPosture: 'delegated_import',
    tokenSubjectUserId: null,
    orgId,
    subjectScope: { kind: 'explicit_users', userIds: [actorId] },
    capability,
    sourceRef: 'test:w4c3a-rollback',
  })
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    orgId,
    rollbackOperationId: crypto.randomUUID(),
    sourceBatchEntrypoint: 'import_batch',
    sourceBatchId: crypto.randomUUID(),
    expectedSourceBatchFingerprint: 'a'.repeat(64),
    authorization: auth(),
    correlationId: 'test-correlation',
    targets: [
      {
        attendanceRecordId: crypto.randomUUID(),
        reversalOperationId: crypto.randomUUID(),
        reversalCalculationId: crypto.randomUUID(),
      },
    ],
    ...overrides,
  }
}

describe('W4C-3a import rollback command', () => {
  const presentPreimageInput = {
    projection: {
      status: 'normal',
      firstInAt: '2026-07-31T01:00:00.000Z',
      lastOutAt: '2026-07-31T09:00:00.000Z',
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    },
    projectionOwner: 'legacy_untracked' as const,
    currentCalculationId: null,
    visibilityState: 'active' as const,
    visibilityReason: 'active' as const,
  }

  it('uses one closed domain-separated rollback-preimage fingerprint', () => {
    const fingerprint = computeAttendanceImportRollbackPreimageFingerprintV1(presentPreimageInput)
    expect(fingerprint).toBe('e5849b5643245826606baaec06fc150c96648b76a4bdc6e339d0f6998c64a912')
    expect(
      parseAttendanceImportRollbackPreimageV1({
        posture: 'present',
        ...presentPreimageInput,
        compatibilityFingerprint: fingerprint,
      }),
    ).toEqual({
      posture: 'present',
      ...presentPreimageInput,
      compatibilityFingerprint: fingerprint,
    })
  })

  it('rejects fabricated fingerprints and one-field mutations', () => {
    const fingerprint = computeAttendanceImportRollbackPreimageFingerprintV1(presentPreimageInput)
    expect(() =>
      parseAttendanceImportRollbackPreimageV1({
        posture: 'present',
        ...presentPreimageInput,
        compatibilityFingerprint: 'f'.repeat(64),
      }),
    ).toThrow(AttendanceImportRollbackError)
    expect(() =>
      parseAttendanceImportRollbackPreimageV1({
        posture: 'present',
        ...presentPreimageInput,
        projection: { ...presentPreimageInput.projection, workMinutes: 481 },
        compatibilityFingerprint: fingerprint,
      }),
    ).toThrow(AttendanceImportRollbackError)
  })

  it('mints a deeply frozen, capability-bound command', () => {
    const command = createFrozenAttendanceImportRollbackCommandV1(input())
    expect(Object.isFrozen(command)).toBe(true)
    expect(Object.isFrozen(command.targets)).toBe(true)
    expect(Object.isFrozen(command.targets[0])).toBe(true)
    expect(command.authorization.capability).toBe('rollback')
  })

  it('rejects stale capability, unknown keys, and duplicate target identities', () => {
    expect(() => createFrozenAttendanceImportRollbackCommandV1(input({ authorization: auth('import') }))).toThrow()
    expect(() =>
      createFrozenAttendanceImportRollbackCommandV1({ ...input(), plan: { authorized: true } }),
    ).toThrow(AttendanceImportRollbackError)
    const shared = crypto.randomUUID()
    expect(() =>
      createFrozenAttendanceImportRollbackCommandV1(
        input({
          targets: [
            {
              attendanceRecordId: shared,
              reversalOperationId: crypto.randomUUID(),
              reversalCalculationId: crypto.randomUUID(),
            },
            {
              attendanceRecordId: shared,
              reversalOperationId: crypto.randomUUID(),
              reversalCalculationId: crypto.randomUUID(),
            },
          ],
        }),
      ),
    ).toThrow(AttendanceImportRollbackError)
  })
})
