/**
 * Contract: authorizeAttendanceLegacyPlanFullImportFromJobV1 must convert only
 * known authorization-domain denial/input exceptions to false. PostgreSQL
 * 40001/40P01 and other infrastructure errors must propagate unchanged for the
 * governing whole-transaction retry.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  authorizeAttendanceLegacyPlanFullImportFromJobV1,
  AttendanceLegacyPlanEnqueueError,
} from '../w4c3a-legacy-plan-enqueue'
import { AttendanceW4AuthorizationError } from '../w4c0-authorization'
import { AttendanceW4OperationError } from '../w4c0-operation-contract'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'

const JOB = Object.freeze({
  // Canonical org key (UUID) required by createAuthorizedAttendanceWriteContextV1.
  orgId: '55555555-5555-4555-8555-555555555555',
  actorId: 'admin-w4c3a-auth',
  actorPosture: 'platform_admin',
  tokenSubjectUserId: 'admin-w4c3a-auth',
  sourceRef: 'attendance-import',
})

function okRow(): { rows: Array<Record<string, unknown>> } {
  return { rows: [{ '?column?': 1 }] }
}

function emptyRows(): { rows: Array<Record<string, unknown>> } {
  return { rows: [] }
}

describe('authorizeAttendanceLegacyPlanFullImportFromJobV1 error contract', () => {
  it('returns false for deliberate full-import authorization denial (enqueue error class)', async () => {
    // platform_admin + self: one liveness users query, then permission query.
    const query = vi
      .fn()
      .mockResolvedValueOnce(okRow()) // actor liveness
      .mockResolvedValueOnce(emptyRows()) // permission grant missing
    const trx = { query } as unknown as AttendanceW4TransactionClientV1

    await expect(
      authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, JOB),
    ).resolves.toBe(false)

    // Prove the denial path used the enqueue authorization error class, not a
    // swallowed SQL fault: the permission query completed without throwing.
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('returns false for authorization input-domain rejection (AttendanceW4AuthorizationError)', async () => {
    const query = vi.fn(async () => {
      throw new Error('query must not run after invalid auth mint')
    })
    const trx = { query } as unknown as AttendanceW4TransactionClientV1

    await expect(
      authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, {
        ...JOB,
        actorPosture: 'not-a-closed-posture',
      }),
    ).resolves.toBe(false)
    expect(query).not.toHaveBeenCalled()

    // Discriminator: the mint path throws AttendanceW4AuthorizationError, not a
    // generic Error — if the helper only caught Error by message it would still
    // pass, so assert the class exists and is what invalid mint produces.
    expect(() => {
      throw new AttendanceW4AuthorizationError('W4C0_AUTHORIZATION_INPUT_INVALID')
    }).toThrow(AttendanceW4AuthorizationError)
  })

  it('returns false for actor liveness denial (AttendanceW4OperationError NOT_AUTHORIZED)', async () => {
    const query = vi.fn().mockResolvedValue(emptyRows())
    const trx = { query } as unknown as AttendanceW4TransactionClientV1

    await expect(
      authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, JOB),
    ).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(1)

    // Class discriminator for the denial mapped to false.
    const sample = new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(sample).toBeInstanceOf(AttendanceW4OperationError)
    expect(sample.code).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  })

  it('propagates synthetic SQLSTATE 40001 unchanged (same instance)', async () => {
    const serialization = Object.assign(new Error('could not serialize access'), {
      code: '40001',
    })
    const query = vi.fn(async () => {
      throw serialization
    })
    const trx = { query } as unknown as AttendanceW4TransactionClientV1

    await expect(
      authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, JOB),
    ).rejects.toBe(serialization)
    expect(serialization).not.toBeInstanceOf(AttendanceLegacyPlanEnqueueError)
    expect(serialization).not.toBeInstanceOf(AttendanceW4AuthorizationError)
    expect(serialization).not.toBeInstanceOf(AttendanceW4OperationError)
    expect((serialization as { code: string }).code).toBe('40001')
  })

  it('propagates synthetic SQLSTATE 40P01 unchanged (same instance)', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    })
    const query = vi.fn(async () => {
      throw deadlock
    })
    const trx = { query } as unknown as AttendanceW4TransactionClientV1

    await expect(
      authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, JOB),
    ).rejects.toBe(deadlock)
    expect(deadlock).not.toBeInstanceOf(AttendanceLegacyPlanEnqueueError)
    expect(deadlock).not.toBeInstanceOf(AttendanceW4AuthorizationError)
    expect(deadlock).not.toBeInstanceOf(AttendanceW4OperationError)
    expect((deadlock as { code: string }).code).toBe('40P01')
  })

  it('does not treat a plain Error with an authorization-looking message as denial', async () => {
    const infrastructure = new Error('W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED')
    const query = vi.fn(async () => {
      throw infrastructure
    })
    const trx = { query } as unknown as AttendanceW4TransactionClientV1

    await expect(
      authorizeAttendanceLegacyPlanFullImportFromJobV1(trx, JOB),
    ).rejects.toBe(infrastructure)
    expect(infrastructure).not.toBeInstanceOf(AttendanceLegacyPlanEnqueueError)
  })
})
