import { pathToFileURL } from 'node:url'

import {
  AttendanceDelegatedAdminContractError,
  assertDelegatedAttendanceAdminIdentity,
} from './attendance-delegated-admin-contract.mjs'

export async function verifyDelegatedAttendanceAdmin({
  apiBase = process.env.API_BASE,
  token = process.env.AUTH_TOKEN,
  expectedTenantId = process.env.AUTH_EXPECTED_TENANT_ID,
  fetchImpl = fetch,
} = {}) {
  if (!apiBase || !token || !expectedTenantId) {
    throw new AttendanceDelegatedAdminContractError('DELEGATED_ADMIN_INPUT_MISSING')
  }

  let response
  try {
    response = await fetchImpl(`${String(apiBase).replace(/\/+$/, '')}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new AttendanceDelegatedAdminContractError('DELEGATED_ADMIN_AUTH_ME_FAILED')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success !== true) {
    throw new AttendanceDelegatedAdminContractError('DELEGATED_ADMIN_AUTH_ME_FAILED')
  }

  assertDelegatedAttendanceAdminIdentity({
    user: body?.data?.user,
    features: body?.data?.features,
    expectedTenantId,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDelegatedAttendanceAdmin()
    .then(() => console.log('[attendance-delegated-admin] PASS'))
    .catch((error) => {
      console.error(`[attendance-delegated-admin] FAIL code=${error?.code || error?.message || 'UNKNOWN'}`)
      process.exitCode = 1
    })
}
