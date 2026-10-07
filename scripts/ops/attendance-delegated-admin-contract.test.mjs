import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  AttendanceDelegatedAdminContractError,
  assertDelegatedAttendanceAdminIdentity,
} from './attendance-delegated-admin-contract.mjs'
import { verifyDelegatedAttendanceAdmin } from './attendance-verify-delegated-admin.mjs'

const expectedTenantId = 'synthetic-org-a'
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
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

function assertProvisioningRechecksDelegatedPosture(provisioner) {
  const refresh = provisioner.indexOf('\nrefresh_token_if_needed\n')
  const delegatedCheck = provisioner.indexOf('node "${ROOT_DIR}/scripts/ops/attendance-verify-delegated-admin.mjs"', refresh)
  const firstWrite = provisioner.indexOf('\ntry_assign_role || status=$?', refresh)

  assert.ok(refresh >= 0)
  assert.ok(delegatedCheck > refresh)
  assert.ok(firstWrite > delegatedCheck)
  assert.match(provisioner, /REQUIRE_DELEGATED_ATTENDANCE_ADMIN="\$\{REQUIRE_DELEGATED_ATTENDANCE_ADMIN:-false\}"/)
}

test('provisioning revalidates refreshed delegated posture before its first write', () => {
  const provisioner = readFileSync(path.join(repoRoot, 'scripts/ops/attendance-provision-user.sh'), 'utf8')
  assertProvisioningRechecksDelegatedPosture(provisioner)

  const withoutPostRefreshCheck = provisioner.replace(
    /if \[\[ "\$REQUIRE_DELEGATED_ATTENDANCE_ADMIN" == "true" \]\]; then[\s\S]*?\nfi\nverify_token_tenant/,
    'verify_token_tenant',
  )
  assert.notEqual(withoutPostRefreshCheck, provisioner)
  assert.throws(
    () => assertProvisioningRechecksDelegatedPosture(withoutPostRefreshCheck),
    /delegatedCheck > refresh/,
  )
})

test('strict runner propagates delegated posture to every provisioning invocation', () => {
  const runner = readFileSync(path.join(repoRoot, 'scripts/ops/attendance-run-gates.sh'), 'utf8')
  const start = runner.indexOf('function maybe_run_provision()')
  const end = runner.indexOf('\nfunction run_playwright_production_flow()', start)
  const provisionBlock = runner.slice(start, end)
  const invocationCount = (provisionBlock.match(/attendance-provision-user\.sh/g) || []).length
  const postureCount = (provisionBlock.match(/REQUIRE_DELEGATED_ATTENDANCE_ADMIN="\$REQUIRE_DELEGATED_ATTENDANCE_ADMIN"/g) || []).length
  const tenantCount = (provisionBlock.match(/AUTH_EXPECTED_TENANT_ID="\$\{AUTH_EXPECTED_TENANT_ID:-\}"/g) || []).length

  assert.equal(invocationCount, 3)
  assert.equal(postureCount, invocationCount)
  assert.equal(tenantCount, invocationCount)
})
