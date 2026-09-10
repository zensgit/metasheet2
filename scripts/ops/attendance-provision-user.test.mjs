import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const userId = '11111111-1111-4111-8111-111111111111'
const permissions = ['attendance:read', 'attendance:write']
const script = new URL('./attendance-provision-user.sh', import.meta.url)

async function runCase({ assignCode = 200, assignBody = { ok: true }, missingRoute = false, accessBody, legacyReadback, expectedTenant = '', authMeBody, refreshBody } = {}) {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization })
    res.setHeader('Connection', 'close')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/refresh-token') {
      res.statusCode = refreshBody ? 200 : 401
      res.end(JSON.stringify(refreshBody ?? {}))
    } else if (req.url === '/api/auth/me') {
      res.end(JSON.stringify(authMeBody ?? { success: true, data: { user: { tenantId: 'synthetic-org' } } }))
    } else if (req.url === `/api/admin/users/${userId}/roles/assign`) {
      res.statusCode = missingRoute ? 404 : assignCode
      res.end(missingRoute ? `<!DOCTYPE html>\n<html><body><pre>Cannot POST /api/admin/users/${userId}/roles/assign</pre></body></html>` : JSON.stringify(assignBody))
    } else if (req.url === `/api/attendance-admin/users/${userId}/access?scope=global`) {
      res.end(JSON.stringify(accessBody ?? { ok: true, data: { user: { id: userId }, roles: ['attendance_employee'], permissions } }))
    } else if (req.url === '/api/permissions/grant') {
      res.end(JSON.stringify({ success: true }))
    } else if (req.url === `/api/permissions/user/${userId}`) {
      res.end(JSON.stringify(legacyReadback ?? { userId, permissions, isAdmin: false }))
    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error: { code: 'UNEXPECTED_TEST_REQUEST' } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('bash', [script.pathname], {
        env: { ...process.env, API_BASE: `http://127.0.0.1:${server.address().port}/api`, AUTH_TOKEN: 'synthetic.token.only', AUTH_EXPECTED_TENANT_ID: expectedTenant, USER_ID: userId, ROLE: 'employee', CURL_RETRY_ATTEMPTS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      child.on('error', reject)
      child.on('close', code => resolve({ code, output, calls }))
    })
    assert.doesNotMatch(result.output, /synthetic\.token\.only|sensitive-response|11111111-1111/)
    return result
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('modern assignment requires a matching role and effective-permission readback', async () => {
  const result = await runCase()
  assert.equal(result.code, 0, result.output)
  assert.equal(result.calls.filter(call => call.url.endsWith('/access?scope=global')).length, 1)
  assert.equal(result.calls.filter(call => call.url.endsWith('/grant')).length, 0)
})

for (const code of ['ROLE_NOT_FOUND', 'NOT_FOUND', 'USER_TARGET_NOT_FOUND', 'FEATURE_DISABLED']) {
  test(`semantic 404 ${code} never grants legacy permissions`, async () => {
    const result = await runCase({ assignCode: 404, assignBody: { ok: false, error: { code, message: 'sensitive-response' } } })
    assert.notEqual(result.code, 0)
    assert.equal(result.calls.length, 2)
    assert.doesNotMatch(result.output, /\] OK\b/)
  })
}

test('unknown JSON 404 cannot authorize legacy fallback', async () => {
  const result = await runCase({ assignCode: 404, assignBody: {} })
  assert.notEqual(result.code, 0)
  assert.equal(result.calls.length, 2)
})

test('legacy missing-role 400 fails without permission grants', async () => {
  const result = await runCase({ assignCode: 400, assignBody: { error: { code: 'ROLE_NOT_FOUND', message: 'sensitive-response' } } })
  assert.notEqual(result.code, 0)
  assert.equal(result.calls.length, 2)
})

test('proven missing route uses legacy grants then independent permission readback', async () => {
  const result = await runCase({ missingRoute: true })
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(result.calls.filter(call => call.url.endsWith('/grant')).map(call => JSON.parse(call.body)), permissions.map(permission => ({ userId, permission })))
  assert.equal(result.calls.at(-1).url, `/api/permissions/user/${userId}`)
})

for (const data of [
  { user: { id: userId }, roles: [], permissions },
  { user: { id: userId }, roles: ['attendance_employee'], permissions: ['attendance:read'] },
  { user: { id: 'other-user' }, roles: ['attendance_employee'], permissions },
]) {
  test(`modern readback rejects incomplete identity/role/permission ${JSON.stringify(data)}`, async () => {
    const result = await runCase({ accessBody: { ok: true, data } })
    assert.notEqual(result.code, 0)
    assert.match(result.output, /PROVISION_READBACK_FAILED/)
  })
}

test('legacy readback rejects a false successful grant', async () => {
  const result = await runCase({ missingRoute: true, legacyReadback: { userId, permissions: [] } })
  assert.notEqual(result.code, 0)
  assert.match(result.output, /PROVISION_READBACK_FAILED/)
})

test('provisioning validates the refreshed token tenant before assigning a role', async () => {
  const token = 'synthetic.refreshed.token.only'
  const result = await runCase({ expectedTenant: 'synthetic-org', refreshBody: { success: true, data: { token } } })
  assert.equal(result.code, 0, result.output)
  assert.equal(result.calls[1].url, '/api/auth/me')
  assert.equal(result.calls[1].authorization, `Bearer ${token}`)
  assert.ok(result.calls[2].url.endsWith('/roles/assign'))
  assert.doesNotMatch(result.output, /synthetic\.refreshed\.token\.only/)
})

for (const authMeBody of [
  { success: true, data: { user: { tenantId: 'other-org' } } },
  { success: true, data: { user: {} } },
  { success: false, data: { user: { tenantId: 'synthetic-org' } } },
]) {
  test(`provisioning rejects invalid post-refresh tenant evidence ${JSON.stringify(authMeBody)}`, async () => {
    const result = await runCase({ expectedTenant: 'synthetic-org', authMeBody, refreshBody: { success: true, data: { token: 'synthetic.refreshed.token.only' } } })
    assert.notEqual(result.code, 0)
    assert.match(result.output, /PROVISION_TENANT_MISMATCH/)
    assert.equal(result.calls.filter(call => call.url.endsWith('/roles/assign') || call.url.endsWith('/grant')).length, 0)
    assert.doesNotMatch(result.output, /other-org|synthetic\.refreshed\.token\.only/)
  })
}
