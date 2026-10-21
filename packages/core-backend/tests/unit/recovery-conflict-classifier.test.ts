/**
 * O2-S2 — behaviour tests for the single 40001 recovery-conflict classifier
 * (src/db/recovery-conflict.ts).
 *
 * Positive assertions are EXACT equalities ("不是错误X"教训 — never notEqual): a conflict
 * classifies as 'recovery_conflict' and the express adapter writes precisely the uniform
 * 409 body; a non-conflict returns null / false and the adapter writes NOTHING (proven
 * with a positive control on the same spy, not by absence alone).
 */

import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import {
  classifyRecoveryConflict,
  RECOVERY_CONFLICT_HTTP_CODE,
  RECOVERY_CONFLICT_HTTP_MESSAGE,
  RECOVERY_CONFLICT_HTTP_STATUS,
  RecoveryConflictError,
  sendIfRecoveryConflict,
  translateRecoveryConflict,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { UserRoleAssignmentRecoveryBusyError } from '../../src/auth/AuthService'

function markerError(): Error & { code: string } {
  // Exactly the shape node-postgres surfaces for the lease trigger's RAISE:
  // SQLSTATE 40001 with the marker as the message.
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function mockResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as Response & { statusCode: number; body: unknown }
}

describe('classifyRecoveryConflict — the single discriminator', () => {
  it('classifies the raw marker 40001 (reusing isRecoveryAuthorityBusyError)', () => {
    expect(classifyRecoveryConflict(markerError())).toBe('recovery_conflict')
  })

  it('classifies the named service-layer RecoveryConflictError', () => {
    expect(classifyRecoveryConflict(new RecoveryConflictError(markerError()))).toBe(
      'recovery_conflict',
    )
  })

  it('classifies the REAL UserRoleAssignmentRecoveryBusyError (pins the cross-module code contract)', () => {
    // Constructed from the real class in auth/AuthService.ts — if its `code` or
    // `retryable` ever drifts, this goes red before the register handler regresses to 500.
    const real = new UserRoleAssignmentRecoveryBusyError('user-1', ['role-a'], markerError())
    expect(classifyRecoveryConflict(real)).toBe('recovery_conflict')
  })

  it('does NOT classify a bare 40001 without the marker (serialization_failure keeps its original path)', () => {
    expect(
      classifyRecoveryConflict(
        Object.assign(new Error('could not serialize access due to concurrent update'), {
          code: '40001',
        }),
      ),
    ).toBeNull()
  })

  it('does NOT classify the marker message under a different SQLSTATE', () => {
    expect(
      classifyRecoveryConflict(
        Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '55P03' }),
      ),
    ).toBeNull()
  })

  it('does NOT classify a spoofed code without retryable=true, generic errors, or non-objects', () => {
    expect(
      classifyRecoveryConflict(
        Object.assign(new Error('x'), { code: RECOVERY_CONFLICT_HTTP_CODE }),
      ),
    ).toBeNull()
    expect(classifyRecoveryConflict(new Error('plain failure'))).toBeNull()
    expect(classifyRecoveryConflict(null)).toBeNull()
    expect(classifyRecoveryConflict(undefined)).toBeNull()
    expect(classifyRecoveryConflict('40001')).toBeNull()
  })
})

describe('translateRecoveryConflict — service-layer adapter', () => {
  it('re-raises a marker 40001 as the named retryable RecoveryConflictError', async () => {
    const raw = markerError()
    const caught = await translateRecoveryConflict(async () => {
      throw raw
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(RecoveryConflictError)
    expect((caught as RecoveryConflictError).code).toBe(RECOVERY_CONFLICT_HTTP_CODE)
    expect((caught as RecoveryConflictError).retryable).toBe(true)
    expect((caught as { cause?: unknown }).cause).toBe(raw)
  })

  it('rethrows every other error as the SAME object (non-40001 byte-identical)', async () => {
    const original = Object.assign(new Error('column does not exist'), { code: '42703' })
    const caught = await translateRecoveryConflict(async () => {
      throw original
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(caught).toBe(original)
  })

  it('does not double-wrap an already-named RecoveryConflictError', async () => {
    const named = new RecoveryConflictError(markerError())
    const caught = await translateRecoveryConflict(async () => {
      throw named
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(caught).toBe(named)
  })

  it('passes successful results through untouched', async () => {
    await expect(translateRecoveryConflict(async () => 'ok')).resolves.toBe('ok')
  })
})

describe('sendIfRecoveryConflict — express-boundary adapter', () => {
  it('writes exactly the uniform retryable 409 for a conflict', () => {
    const res = mockResponse()
    expect(sendIfRecoveryConflict(res, markerError())).toBe(true)
    expect(res.statusCode).toBe(RECOVERY_CONFLICT_HTTP_STATUS)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: RECOVERY_CONFLICT_HTTP_CODE,
        message: RECOVERY_CONFLICT_HTTP_MESSAGE,
        details: { retryable: true },
      },
    })
  })

  it('writes NOTHING for a non-conflict (with positive control on the same spies)', () => {
    const res = mockResponse()
    const statusSpy = vi.spyOn(res, 'status')
    const jsonSpy = vi.spyOn(res, 'json')

    expect(sendIfRecoveryConflict(res, new Error('boom'))).toBe(false)
    expect(statusSpy).not.toHaveBeenCalled()
    expect(jsonSpy).not.toHaveBeenCalled()

    // Positive control: the same spies DO fire for a genuine conflict, so the
    // not-called assertions above cannot pass vacuously.
    expect(sendIfRecoveryConflict(res, markerError())).toBe(true)
    expect(statusSpy).toHaveBeenCalledWith(RECOVERY_CONFLICT_HTTP_STATUS)
    expect(jsonSpy).toHaveBeenCalledTimes(1)
  })
})
