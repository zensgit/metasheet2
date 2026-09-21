import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AttendanceDelegatedAdminContractError,
  assertDelegatedAttendanceAdminIdentity,
} from './attendance-delegated-admin-contract.mjs'
import { verifyDelegatedAttendanceAdmin } from './attendance-verify-delegated-admin.mjs'

const expectedTenantId = 'synthetic-org-a'
const delegated = {
  user: {
    id: 'synthetic-user-a',
    role: 'member',
    tenantId: expectedTenantId,
    permissions: ['attendance:read', 'attendance:admin'],
  },
  features: { attendanceAdmin: true },
}

test('accepts a tenant-bound delegated attendance administrator', () => {
  assert.doesNotThrow(() => assertDelegatedAttendanceAdminIdentity({ ...delegated, expectedTenantId }))
})

for (const [name, fixture, code] of [
  ['platform administrator', { ...delegated, user: { ...delegated.user, role: 'admin' } }, 'PLATFORM_ADMIN_NOT_ALLOWED'],
  ['wrong tenant', { ...delegated, user: { ...delegated.user, tenantId: 'synthetic-org-b' } }, 'DELEGATED_ADMIN_TENANT_MISMATCH'],
  ['missing delegated permission', { ...delegated, user: { ...delegated.user, permissions: ['attendance:read'] } }, 'DELEGATED_ATTENDANCE_ADMIN_REQUIRED'],
  ['missing feature posture', { ...delegated, features: { attendanceAdmin: false } }, 'ATTENDANCE_ADMIN_FEATURE_REQUIRED'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => assertDelegatedAttendanceAdminIdentity({ ...fixture, expectedTenantId }),
      (error) => error instanceof AttendanceDelegatedAdminContractError && error.code === code,
    )
  })
}

test('remote verifier performs only auth/me before accepting delegated posture', async () => {
  const calls = []
  await verifyDelegatedAttendanceAdmin({
    apiBase: 'https://synthetic.invalid/api',
    token: 'synthetic-token',
    expectedTenantId,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method })
      return {
        ok: true,
        json: async () => ({ success: true, data: delegated }),
      }
    },
  })
  assert.deepEqual(calls, [{ url: 'https://synthetic.invalid/api/auth/me', method: 'GET' }])
})

test('remote verifier rejects platform posture without issuing a business request', async () => {
  const calls = []
  await assert.rejects(
    verifyDelegatedAttendanceAdmin({
      apiBase: 'https://synthetic.invalid/api',
      token: 'synthetic-token',
      expectedTenantId,
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method })
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              ...delegated,
              user: { ...delegated.user, role: 'admin' },
            },
          }),
        }
      },
    }),
    /PLATFORM_ADMIN_NOT_ALLOWED/,
  )
  assert.deepEqual(calls, [{ url: 'https://synthetic.invalid/api/auth/me', method: 'GET' }])
})
