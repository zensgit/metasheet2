/**
 * O2-S2 — mapActivateError (routes/admin-users.ts) recovery-conflict branch.
 *
 * The activate surface's HTTP mapping: a recovery conflict (the named retryable
 * RecoveryConflictError re-raised by activatePendingUser, or a raw marker 40001) maps
 * to the EXACT retryable 409 policy — and every pre-existing row of the closed
 * ACTIVATE_* policy table plus the ACTIVATE_FAILED fallback stays byte-identical.
 */

import { describe, expect, it } from 'vitest'
import {
  ACTIVATE_ERROR_FALLBACK,
  ACTIVATE_ERROR_POLICY,
  mapActivateError,
} from '../../src/routes/admin-users'
import {
  RECOVERY_CONFLICT_HTTP_CODE,
  RECOVERY_CONFLICT_HTTP_MESSAGE,
  RecoveryConflictError,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

describe('mapActivateError — O2-S2 recovery-conflict branch', () => {
  it('the named RecoveryConflictError maps to the exact retryable 409', () => {
    expect(mapActivateError(new RecoveryConflictError(markerError()))).toEqual({
      status: 409,
      code: RECOVERY_CONFLICT_HTTP_CODE,
      message: RECOVERY_CONFLICT_HTTP_MESSAGE,
    })
  })

  it('a raw marker 40001 leak maps to the same exact retryable 409', () => {
    expect(mapActivateError(markerError())).toEqual({
      status: 409,
      code: RECOVERY_CONFLICT_HTTP_CODE,
      message: RECOVERY_CONFLICT_HTTP_MESSAGE,
    })
  })

  it('a bare 40001 WITHOUT the marker still falls to the ACTIVATE_FAILED fallback (nothing loosened)', () => {
    expect(mapActivateError(
      Object.assign(new Error('could not serialize access'), { code: '40001' }),
    )).toEqual({ ...ACTIVATE_ERROR_FALLBACK })
  })

  it('authored ACTIVATE_* rows are byte-identical to the policy table', () => {
    for (const [code, row] of Object.entries(ACTIVATE_ERROR_POLICY)) {
      expect(mapActivateError(Object.assign(new Error('db text, never published'), { code }))).toEqual({
        code,
        status: row.status,
        message: row.message,
      })
    }
  })

  it('unauthored errors keep the exact ACTIVATE_FAILED fallback', () => {
    expect(mapActivateError(new Error('anything'))).toEqual({ ...ACTIVATE_ERROR_FALLBACK })
    expect(mapActivateError(Object.assign(new Error('x'), { code: 'ACTIVATE_DB_FAILURE' })))
      .toEqual({ ...ACTIVATE_ERROR_FALLBACK })
  })
})
