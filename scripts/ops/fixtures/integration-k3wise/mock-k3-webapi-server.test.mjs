import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockK3WebApiServer } from './mock-k3-webapi-server.mjs'

async function withMockServer(fn) {
  const mock = createMockK3WebApiServer()
  const baseUrl = await mock.start()
  try {
    await fn({ mock, baseUrl })
  } finally {
    await mock.stop()
  }
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options)
  return {
    response,
    body: await response.json(),
  }
}

test('mock K3 WebAPI keeps the adapter happy-path methods available', async () => {
  await withMockServer(async ({ baseUrl }) => {
    const login = await fetchJson(baseUrl, '/K3API/Login', {
      method: 'POST',
      body: JSON.stringify({ username: 'demo', password: 'demo', acctId: 'AIS_TEST' }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.body.success, true)
    assert.equal(login.body.sessionId, 'mock-session-1')

    const health = await fetchJson(baseUrl, '/K3API/Health')
    assert.equal(health.response.status, 200)
    assert.equal(health.body.ok, true)

    const save = await fetchJson(baseUrl, '/K3API/Material/Save', {
      method: 'POST',
      body: JSON.stringify({ Model: { FNumber: 'MAT-METHOD-001' } }),
    })
    assert.equal(save.response.status, 200)
    assert.equal(save.body.success, true)
    assert.equal(save.body.billNo, 'MAT-METHOD-001')
  })
})

test('mock K3 WebAPI rejects methods that real K3 endpoints would not accept', async () => {
  await withMockServer(async ({ baseUrl, mock }) => {
    const cases = [
      { pathname: '/K3API/Login', method: 'GET', expectedMethod: 'POST' },
      { pathname: '/K3API/Health', method: 'POST', expectedMethod: 'GET' },
      { pathname: '/K3API/Material/Save', method: 'GET', expectedMethod: 'POST' },
      { pathname: '/K3API/Material/Submit', method: 'GET', expectedMethod: 'POST' },
      { pathname: '/K3API/Material/Audit', method: 'GET', expectedMethod: 'POST' },
      { pathname: '/K3API/BOM/Save', method: 'GET', expectedMethod: 'POST' },
      { pathname: '/K3API/BOM/Submit', method: 'GET', expectedMethod: 'POST' },
      { pathname: '/K3API/BOM/Audit', method: 'GET', expectedMethod: 'POST' },
    ]

    for (const item of cases) {
      const result = await fetchJson(baseUrl, item.pathname, { method: item.method })
      assert.equal(result.response.status, 405, `${item.method} ${item.pathname} should be rejected`)
      assert.equal(result.response.headers.get('allow'), item.expectedMethod)
      assert.deepEqual(result.body, {
        success: false,
        message: `mock K3 method not allowed: ${item.method} ${item.pathname}`,
        expectedMethod: item.expectedMethod,
      })
    }

    assert.deepEqual(
      mock.calls.map((call) => `${call.method} ${call.pathname}`),
      cases.map((item) => `${item.method} ${item.pathname}`),
      'rejected calls remain visible for debugging',
    )
  })
})

test('mock K3 WebAPI can model successful login responses without usable auth transport', async () => {
  const mock = createMockK3WebApiServer({
    includeSessionCookie: false,
    includeSessionId: false,
  })
  const baseUrl = await mock.start()
  try {
    const login = await fetchJson(baseUrl, '/K3API/Login', {
      method: 'POST',
      body: JSON.stringify({ username: 'demo', password: 'demo', acctId: 'AIS_TEST' }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.response.headers.get('set-cookie'), null)
    assert.deepEqual(login.body, { success: true })
  } finally {
    await mock.stop()
  }
})
