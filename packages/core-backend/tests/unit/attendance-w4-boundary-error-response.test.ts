import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AttendanceW4IdentityError } from '../../src/attendance/w4c0-identity'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'

const require = createRequire(import.meta.url)
const { respondIfW4BoundaryError, W4_ERROR_NAMES } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-w4-boundary-error-response.cjs',
) as {
  respondIfW4BoundaryError: (
    res: { status: (status: number) => { json: (body: unknown) => void } },
    error: unknown,
  ) => boolean
  W4_ERROR_NAMES: Set<string>
}

function captureResponse() {
  const captured: { statusCode?: number; body?: unknown } = {}
  const res = {
    status(statusCode: number) {
      captured.statusCode = statusCode
      return res
    },
    json(body: unknown) {
      captured.body = body
    },
  }
  return { res, captured }
}

describe('attendance W4 boundary error HTTP mapping (#5992)', () => {
  it('includes AttendanceW4IdentityError in the production name set', () => {
    expect(W4_ERROR_NAMES.has('AttendanceW4IdentityError')).toBe(true)
  })

  it('maps a real AttendanceW4IdentityError to 422 with the closed W4C0 code', () => {
    const error = new AttendanceW4IdentityError('W4C0_DEFAULT_ORG_POSTURE_REJECTED')
    expect(error.name).toBe('AttendanceW4IdentityError')
    expect('httpStatus' in error).toBe(false)

    const { res, captured } = captureResponse()
    expect(respondIfW4BoundaryError(res, error)).toBe(true)
    expect(captured.statusCode).toBe(422)
    expect(captured.body).toEqual({
      ok: false,
      error: {
        code: 'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
        message: 'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
      },
    })
  })

  it('maps W4C0_OPERATION_ID_REQUIRED the same way', () => {
    const error = new AttendanceW4IdentityError('W4C0_OPERATION_ID_REQUIRED')
    const { res, captured } = captureResponse()
    expect(respondIfW4BoundaryError(res, error)).toBe(true)
    expect(captured.statusCode).toBe(422)
    expect(captured.body).toEqual({
      ok: false,
      error: { code: 'W4C0_OPERATION_ID_REQUIRED', message: 'W4C0_OPERATION_ID_REQUIRED' },
    })
  })

  it('keeps an explicit integer httpStatus from a class that declares one', () => {
    const error = new AttendanceW4OperationError('SEGMENT_CALCULATION_SUSPENDED')
    const { res, captured } = captureResponse()
    expect(respondIfW4BoundaryError(res, error)).toBe(true)
    expect(captured.statusCode).toBe(error.httpStatus)
    expect(captured.body).toEqual({
      ok: false,
      error: { code: 'SEGMENT_CALCULATION_SUSPENDED', message: 'SEGMENT_CALCULATION_SUSPENDED' },
    })
  })

  it('returns false for a plain Error so the route catch can still answer 500', () => {
    const { res, captured } = captureResponse()
    expect(respondIfW4BoundaryError(res, new Error('W4C0_DEFAULT_ORG_POSTURE_REJECTED'))).toBe(false)
    expect(captured.statusCode).toBeUndefined()
    expect(captured.body).toBeUndefined()
  })

  it('returns false when the name is not in the set, even if the code looks like W4C0', () => {
    const impostor = new AttendanceW4IdentityError('W4C0_DEFAULT_ORG_POSTURE_REJECTED')
    impostor.name = 'Error'
    const { res, captured } = captureResponse()
    expect(respondIfW4BoundaryError(res, impostor)).toBe(false)
    expect(captured.body).toBeUndefined()
  })

  it('the plugin route file requires this module and does not keep a second name set', () => {
    const pluginIndex = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../plugins/plugin-attendance/index.cjs',
    )
    const source = readFileSync(pluginIndex, 'utf8')
    expect(source).toContain("require('./lib/attendance-w4-boundary-error-response.cjs')")
    expect(source.includes('const W4_ERROR_NAMES')).toBe(false)
  })
})
