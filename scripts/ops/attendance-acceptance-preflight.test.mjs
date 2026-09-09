import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceConfiguration, collectAcceptanceProvenance, validAcceptanceProvenance } from './attendance-acceptance-preflight.mjs'
import * as preflight from './attendance-acceptance-preflight.mjs'

const deployed = 'a'.repeat(40)
const checkout = 'b'.repeat(40)
const env = { ATTENDANCE_SYNTHETIC_ORG_ID: 'fixture-org', ORG_ID: 'fixture-org', AUTH_EXPECTED_TENANT_ID: 'fixture-org', ATTENDANCE_EXPECTED_DEPLOY_SHA: deployed, API_BASE: 'http://127.0.0.1:8899/api' }

test('records checkout and observed backend identity separately', async () => {
  let calls = 0
  const proof = await collectAcceptanceProvenance(env, checkout, async (url, options) => {
    calls++
    assert.equal(url, 'http://127.0.0.1:8899/api/health')
    assert.equal(options.redirect, 'error')
    return { ok: true, json: async () => ({ ok: true, build: { commit: deployed } }) }
  })
  assert.equal(calls, 1)
  assert.deepEqual(proof, { checkoutSha: checkout, expectedDeploymentSha: deployed, observedDeploymentSha: deployed, source: 'backend_health_build_commit' })
  assert.equal(validAcceptanceProvenance(proof), true)
})

for (const [field, value, reason] of [
  ['ATTENDANCE_SYNTHETIC_ORG_ID', '', 'SYNTHETIC_ORG_REQUIRED'],
  ['ATTENDANCE_SYNTHETIC_ORG_ID', ' fixture-org ', 'SYNTHETIC_ORG_REQUIRED'],
  ['ORG_ID', 'different-org', 'ORG_MISMATCH'],
  ['AUTH_EXPECTED_TENANT_ID', '', 'ORG_MISMATCH'],
  ['ATTENDANCE_EXPECTED_DEPLOY_SHA', '', 'EXPECTED_SHA_REQUIRED'],
  ['ATTENDANCE_EXPECTED_DEPLOY_SHA', 'main', 'EXPECTED_SHA_REQUIRED'],
  ['API_BASE', 'http://private.example/api', 'API_BASE_INVALID'],
  ['API_BASE', 'https://name:password@example.invalid/api', 'API_BASE_INVALID'],
]) {
  test(`rejects invalid ${field} before any request`, async () => {
    let calls = 0
    await assert.rejects(collectAcceptanceProvenance({ ...env, [field]: value }, checkout, async () => { calls++ }), new RegExp(reason))
    assert.equal(calls, 0)
  })
}

for (const payload of [{}, { ok: false, build: { commit: deployed } }, { ok: true, build: { commit: 'main' } }, { ok: true, build: { commit: null } }]) {
  test(`unverified runtime shape cannot become evidence ${JSON.stringify(payload)}`, async () => {
    await assert.rejects(collectAcceptanceProvenance(env, checkout, async () => ({ ok: true, json: async () => payload })), /IDENTITY_UNAVAILABLE/)
  })
}

test('valid but mismatched deployment is refused', async () => {
  await assert.rejects(collectAcceptanceProvenance(env, checkout, async () => ({ ok: true, json: async () => ({ ok: true, build: { commit: checkout } }) })), /DEPLOYMENT_MISMATCH/)
})

test('network and malformed response failures are values-free', async () => {
  await assert.rejects(collectAcceptanceProvenance(env, checkout, async () => { throw new Error('sensitive-target') }), error => error.message === 'ACCEPTANCE_RUNTIME_IDENTITY_UNAVAILABLE')
  await assert.rejects(collectAcceptanceProvenance(env, checkout, async () => ({ ok: false })), /IDENTITY_UNAVAILABLE/)
})

test('evidence validation rejects missing and contradictory identity', () => {
  const valid = { checkoutSha: checkout, expectedDeploymentSha: deployed, observedDeploymentSha: deployed, source: 'backend_health_build_commit' }
  for (const key of Object.keys(valid)) {
    const copy = { ...valid }
    delete copy[key]
    assert.equal(validAcceptanceProvenance(copy), false)
  }
  assert.equal(validAcceptanceProvenance({ ...valid, observedDeploymentSha: checkout }), false)
  assert.equal(validAcceptanceProvenance({ ...valid, source: 'checkout' }), false)
  assert.equal(validAcceptanceProvenance({ ...valid, extra: true }), false)
})

test('explicit insecure-http opt-in retains the exact target contract', () => {
  assert.equal(acceptanceConfiguration({ ...env, API_BASE: 'http://example.invalid/api', AUTH_RESOLVE_ALLOW_INSECURE_HTTP: 'true' }).healthUrl, 'http://example.invalid/api/health')
})

test('verifies the effective token with exact server tenant before accepting it', async () => {
  const calls = []
  await preflight.verifyAcceptanceTokenTenant(env.API_BASE, 'synthetic-token', {
    env,
    fetchImpl: async (url, options) => {
      calls.push(url)
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token')
      assert.equal(options.redirect, 'error')
      return { status: 200, json: async () => ({ success: true, data: { user: { tenantId: 'fixture-org' } } }) }
    },
  })
  assert.deepEqual(calls, [`${env.API_BASE}/auth/me`])
})

for (const [label, status, body] of [
  ['missing tenant', 200, { success: true, data: { user: {} } }],
  ['wrong tenant', 200, { success: true, data: { user: { tenantId: 'wrong-org' } } }],
  ['unsuccessful envelope', 200, { success: false, data: { user: { tenantId: 'fixture-org' } } }],
  ['malformed envelope', 200, null],
  ['non-200 status', 201, { success: true, data: { user: { tenantId: 'fixture-org' } } }],
]) {
  test(`token proof refuses ${label} without leaking values`, async () => {
    await assert.rejects(preflight.verifyAcceptanceTokenTenant(env.API_BASE, 'synthetic-token', {
      env, fetchImpl: async () => ({ status, json: async () => body }),
    }), error => error.message === 'ACCEPTANCE_TENANT_UNVERIFIED')
  })
}

test('token proof fails closed on network/JSON errors and preserves unconfigured local compatibility', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('sensitive-target') },
    async () => ({ status: 200, json: async () => { throw new Error('sensitive-body') } }),
  ]) {
    await assert.rejects(preflight.verifyAcceptanceTokenTenant(env.API_BASE, 'synthetic-token', { env, fetchImpl }),
      error => error.message === 'ACCEPTANCE_TENANT_UNVERIFIED')
  }
  await preflight.verifyAcceptanceTokenTenant(env.API_BASE, 'synthetic-token', {
    env: {}, fetchImpl: async () => { assert.fail('unconfigured compatibility must not request') },
  })
})
