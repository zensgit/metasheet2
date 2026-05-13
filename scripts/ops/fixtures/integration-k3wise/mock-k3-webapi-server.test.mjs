#!/usr/bin/env node

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockK3WebApiServer } from './mock-k3-webapi-server.mjs'

async function postJson(baseUrl, pathname, payload) {
  return fetchJson(baseUrl, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options)
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  }
}

test('mock K3 call log and logger redact login credential fields', async () => {
  const loggerEvents = []
  const mock = createMockK3WebApiServer({
    logger: (event) => loggerEvents.push(event),
  })
  const baseUrl = await mock.start()
  try {
    const result = await postJson(baseUrl, '/K3API/Login', {
      username: 'demo',
      password: 'secret-password',
      acctId: 'AIS_TEST',
      nested: {
        sessionToken: 'secret-session-token',
        apiKey: 'secret-api-key',
        keep: 'visible-value',
      },
      items: [
        { credential: 'secret-array-credential', keep: 'array-visible' },
      ],
    })

    assert.equal(result.status, 200)
    assert.equal(result.body.success, true)
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(loggerEvents, mock.calls)

    const recordedBody = mock.calls[0].body
    assert.equal(recordedBody.username, 'demo')
    assert.equal(recordedBody.password, '<redacted>')
    assert.equal(recordedBody.acctId, '<redacted>')
    assert.equal(recordedBody.nested.sessionToken, '<redacted>')
    assert.equal(recordedBody.nested.apiKey, '<redacted>')
    assert.equal(recordedBody.nested.keep, 'visible-value')
    assert.equal(recordedBody.items[0].credential, '<redacted>')
    assert.equal(recordedBody.items[0].keep, 'array-visible')

    const serializedCalls = JSON.stringify(mock.calls)
    const serializedLoggerEvents = JSON.stringify(loggerEvents)
    assert.equal(serializedCalls.includes('secret-password'), false)
    assert.equal(serializedCalls.includes('AIS_TEST'), false)
    assert.equal(serializedCalls.includes('secret-session-token'), false)
    assert.equal(serializedLoggerEvents.includes('secret-password'), false)
    assert.equal(serializedLoggerEvents.includes('AIS_TEST'), false)
  } finally {
    await mock.stop()
  }
})

test('mock K3 still evaluates material payloads with the raw request body', async () => {
  const mock = createMockK3WebApiServer({
    knownBadFNumbers: new Set(['BAD']),
  })
  const baseUrl = await mock.start()
  try {
    const result = await postJson(baseUrl, '/K3API/Material/Save', {
      Model: {
        FNumber: 'BAD',
        FName: 'Bad material',
      },
    })

    assert.equal(result.status, 200)
    assert.equal(result.body.success, false)
    assert.match(result.body.message, /BAD/)
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].body.Model.FNumber, 'BAD')
  } finally {
    await mock.stop()
  }
})

test('mock K3 WebAPI rejects methods that real K3 endpoints would not accept', async () => {
  const mock = createMockK3WebApiServer()
  const baseUrl = await mock.start()
  try {
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
      assert.equal(result.status, 405, `${item.method} ${item.pathname} should be rejected`)
      assert.equal(result.headers.get('allow'), item.expectedMethod)
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
  } finally {
    await mock.stop()
  }
})

test('mock K3 WebAPI can model successful login responses without usable auth transport', async () => {
  const mock = createMockK3WebApiServer({
    includeSessionCookie: false,
    includeSessionId: false,
  })
  const baseUrl = await mock.start()
  try {
    const login = await postJson(baseUrl, '/K3API/Login', {
      username: 'demo',
      password: 'demo',
      acctId: 'AIS_TEST',
    })

    assert.equal(login.status, 200)
    assert.equal(login.headers.get('set-cookie'), null)
    assert.deepEqual(login.body, { success: true })
  } finally {
    await mock.stop()
  }
})
