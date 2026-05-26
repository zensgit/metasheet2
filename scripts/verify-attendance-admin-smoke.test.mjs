import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  ADMIN_ENDPOINTS,
  normalizeApiBase,
  parseConfig,
  runAttendanceAdminSmoke,
} from './verify-attendance-admin-smoke.mjs'

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(json))
}

function createSilentLogger() {
  return {
    log() {},
    error() {},
    warn() {},
  }
}

async function startMockServer({ admin }) {
  const calls = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    calls.push(`${req.method} ${url.pathname}${url.search}`)

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      send(res, 200, {
        success: true,
        data: {
          user: { id: admin ? 'admin-user' : 'employee-user', email: admin ? 'admin@example.com' : 'employee@example.com', role: 'user' },
          features: {
            attendance: true,
            attendanceAdmin: admin,
            attendanceImport: admin,
            mode: 'attendance',
          },
        },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/attendance/rules/default') {
      send(res, 200, { ok: true, data: { id: 'default-rule' } })
      return
    }

    const expectedAdminPaths = new Set([
      ...ADMIN_ENDPOINTS.map(endpoint => `/api${endpoint.path.split('?')[0]}`),
      '/api/attendance/advanced-scheduling/workbench',
    ])
    if (req.method === 'GET' && expectedAdminPaths.has(url.pathname)) {
      if (admin) {
        send(res, 200, { ok: true, data: { items: [], templates: [] } })
      } else {
        send(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } })
      }
      return
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND' } })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('normalizeApiBase accepts deployment origin or /api base', () => {
  assert.equal(normalizeApiBase('http://example.test:8081'), 'http://example.test:8081/api')
  assert.equal(normalizeApiBase('http://example.test:8081/api/'), 'http://example.test:8081/api')
})

test('passes an attendance admin token when admin endpoints return 2xx', async () => {
  const server = await startMockServer({ admin: true })
  try {
    const report = await runAttendanceAdminSmoke(
      parseConfig({
        API_BASE: server.apiBase,
        AUTH_TOKEN: 'admin-token',
        REQUIRE_ADMIN: 'true',
        WRITE_OUTPUT: '0',
      }, new Date('2026-05-26T12:00:00.000Z')),
      { logger: createSilentLogger() },
    )

    assert.equal(report.auth.features.attendanceAdmin, true)
    assert.equal(report.expectation.expectedAdmin, true)
    assert.equal(report.summary.failed, 0)
    assert.equal(report.summary.passed, report.summary.total)
  } finally {
    await server.close()
  }
})

test('passes an employee token when admin endpoints are forbidden as expected', async () => {
  const server = await startMockServer({ admin: false })
  try {
    const report = await runAttendanceAdminSmoke(
      parseConfig({
        API_BASE: server.apiBase,
        AUTH_TOKEN: 'employee-token',
        EXPECTED_ADMIN: 'false',
        WRITE_OUTPUT: '0',
      }, new Date('2026-05-26T12:00:00.000Z')),
      { logger: createSilentLogger() },
    )

    assert.equal(report.auth.features.attendanceAdmin, false)
    assert.equal(report.expectation.expectedAdmin, false)
    assert.equal(report.summary.failed, 0)
    assert.equal(report.summary.forbiddenAsExpected, ADMIN_ENDPOINTS.length + 1)
    assert.ok(server.calls.includes('GET /api/attendance/rules/default'))
  } finally {
    await server.close()
  }
})

test('REQUIRE_ADMIN fails before endpoint probing for an employee token', async () => {
  const server = await startMockServer({ admin: false })
  try {
    await assert.rejects(
      () => runAttendanceAdminSmoke(
        parseConfig({
          API_BASE: server.apiBase,
          AUTH_TOKEN: 'employee-token',
          REQUIRE_ADMIN: 'true',
          WRITE_OUTPUT: '0',
        }, new Date('2026-05-26T12:00:00.000Z')),
        { logger: createSilentLogger() },
      ),
      /AUTH_NOT_ATTENDANCE_ADMIN/,
    )
    assert.deepEqual(server.calls, ['GET /api/auth/me'])
  } finally {
    await server.close()
  }
})
