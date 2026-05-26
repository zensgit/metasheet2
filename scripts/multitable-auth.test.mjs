import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveMultitableAuthToken } from './multitable-auth.mjs'

test('resolveMultitableAuthToken prefers AUTH_TOKEN without requesting dev-token', async () => {
  const records = []
  let fetchCalls = 0
  const token = await resolveMultitableAuthToken({
    apiBase: 'http://example.test/api',
    envToken: '  jwt-from-env  ',
    perms: 'multitable:read,multitable:write',
    fetchJson: async () => {
      fetchCalls += 1
      return { res: { ok: true, status: 200 }, json: { token: 'unexpected' } }
    },
    record: (name, ok, details = {}) => records.push({ name, ok, ...details }),
  })

  assert.equal(token, 'jwt-from-env')
  assert.equal(fetchCalls, 0)
  assert.deepEqual(records, [{ name: 'api.auth-token', ok: true, source: 'AUTH_TOKEN' }])
})

test('resolveMultitableAuthToken falls back to dev-token when AUTH_TOKEN is missing', async () => {
  const records = []
  let requestedUrl = ''
  const token = await resolveMultitableAuthToken({
    apiBase: 'http://example.test/api',
    envToken: '',
    perms: 'multitable:read,multitable:write',
    fetchJson: async (url) => {
      requestedUrl = url
      return { res: { ok: true, status: 200 }, json: { token: 'dev-token' } }
    },
    record: (name, ok, details = {}) => records.push({ name, ok, ...details }),
  })

  assert.equal(token, 'dev-token')
  assert.match(requestedUrl, /\/api\/auth\/dev-token\?/)
  assert.match(requestedUrl, /perms=multitable%3Aread%2Cmultitable%3Awrite/)
  assert.deepEqual(records, [{ name: 'api.dev-token', ok: true, status: 200 }])
})

test('resolveMultitableAuthToken falls back to login when dev-token is unavailable', async () => {
  const records = []
  let requestedUrl = ''
  const called = []
  const token = await resolveMultitableAuthToken({
    apiBase: 'http://example.test/api',
    envToken: '',
    perms: 'multitable:read,multitable:write',
    fetchJson: async (url, options) => {
      called.push({ url, method: options?.method || 'GET' })
      if (url.includes('/api/auth/dev-token')) {
        requestedUrl = url
        return { res: { ok: false, status: 404 }, json: {} }
      }
      if (url.includes('/api/auth/login')) {
        return {
          res: { ok: true, status: 200 },
          json: {
            data: {
              token: 'login-token',
            },
          },
        }
      }
      return { res: { ok: true, status: 200 }, json: {} }
    },
    record: (name, ok, details = {}) => records.push({ name, ok, ...details }),
    loginEmail: 'admin@example.com',
    loginPassword: 'AdminPass12345',
  })

  assert.equal(token, 'login-token')
  assert.match(requestedUrl, /\/api\/auth\/dev-token\?/)
  assert.deepEqual(records, [
    { name: 'api.dev-token', ok: false, status: 404 },
    { name: 'api.login-token', ok: true, status: 200, email: 'admin@example.com' },
  ])
  assert.equal(called.length, 2)
  assert.equal(called[1].url.includes('/api/auth/login'), true)
})

test('resolveMultitableAuthToken throws when neither AUTH_TOKEN nor dev-token is available', async () => {
  await assert.rejects(
    () =>
      resolveMultitableAuthToken({
        apiBase: 'http://example.test/api',
        envToken: '',
        perms: 'multitable:read',
        fetchJson: async () => ({ res: { ok: false, status: 404 }, json: {} }),
      }),
    /Dev token unavailable/,
  )
})
