#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const shaPattern = /^[0-9a-f]{40}$/

export class AcceptanceTenantError extends Error {
  constructor() {
    super('ACCEPTANCE_TENANT_UNVERIFIED')
  }
}

export async function verifyAcceptanceTokenTenant(apiBase, token, { env = process.env, fetchImpl = fetch } = {}) {
  const expected = env.AUTH_EXPECTED_TENANT_ID
  // Unbound local verification retains its existing behavior; strict jobs always bind this value.
  if (expected === undefined) return
  if (typeof expected !== 'string' || !expected || expected !== expected.trim()) throw new AcceptanceTenantError()
  try {
    const response = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    const body = await response.json()
    if (response.status !== 200 || body?.success !== true || body?.data?.user?.tenantId !== expected) {
      throw new AcceptanceTenantError()
    }
  } catch {
    throw new AcceptanceTenantError()
  }
}

export function acceptanceConfiguration(env) {
  const org = env.ATTENDANCE_SYNTHETIC_ORG_ID
  if (typeof org !== 'string' || !org || org !== org.trim() || /[\r\n\0]/.test(org)) {
    throw new Error('ACCEPTANCE_SYNTHETIC_ORG_REQUIRED')
  }
  if (env.ORG_ID !== org || env.AUTH_EXPECTED_TENANT_ID !== org) {
    throw new Error('ACCEPTANCE_ORG_MISMATCH')
  }
  if (!shaPattern.test(env.ATTENDANCE_EXPECTED_DEPLOY_SHA ?? '')) {
    throw new Error('ACCEPTANCE_EXPECTED_SHA_REQUIRED')
  }
  let api
  try {
    api = new URL(env.API_BASE)
  } catch {
    throw new Error('ACCEPTANCE_API_BASE_INVALID')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)
  if (api.username || api.password || api.search || api.hash
    || api.pathname.replace(/\/$/, '') !== '/api'
    || (api.protocol !== 'https:' && !(api.protocol === 'http:' && (loopback || env.AUTH_RESOLVE_ALLOW_INSECURE_HTTP === 'true')))) {
    throw new Error('ACCEPTANCE_API_BASE_INVALID')
  }
  return { healthUrl: `${api.origin}/api/health`, expectedDeploymentSha: env.ATTENDANCE_EXPECTED_DEPLOY_SHA }
}

export async function collectAcceptanceProvenance(env, checkoutSha, fetchImpl = fetch) {
  const config = acceptanceConfiguration(env)
  if (!shaPattern.test(checkoutSha)) throw new Error('ACCEPTANCE_CHECKOUT_SHA_INVALID')
  let payload
  try {
    const response = await fetchImpl(config.healthUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('health unavailable')
    payload = await response.json()
  } catch {
    throw new Error('ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE')
  }
  const observedDeploymentSha = payload?.build?.commit
  if (payload?.ok !== true || !shaPattern.test(observedDeploymentSha ?? '')) {
    throw new Error('ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE')
  }
  if (observedDeploymentSha !== config.expectedDeploymentSha) {
    throw new Error('ACCEPTANCE_DEPLOYMENT_MISMATCH')
  }
  return { checkoutSha, expectedDeploymentSha: config.expectedDeploymentSha, observedDeploymentSha, source: 'backend_health_build_commit' }
}

export function validAcceptanceProvenance(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'checkoutSha,expectedDeploymentSha,observedDeploymentSha,source'
    && shaPattern.test(value.checkoutSha ?? '')
    && shaPattern.test(value.expectedDeploymentSha ?? '')
    && value.observedDeploymentSha === value.expectedDeploymentSha
    && value.source === 'backend_health_build_commit'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Validate the target before invoking git or performing any network request.
    acceptanceConfiguration(process.env)
    const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    console.log(JSON.stringify(await collectAcceptanceProvenance(process.env, checkoutSha)))
  } catch (error) {
    const reason = /^ACCEPTANCE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'ACCEPTANCE_PREFLIGHT_FAILED'
    console.error(`[attendance-acceptance-preflight] ${reason}`)
    process.exitCode = 1
  }
}
