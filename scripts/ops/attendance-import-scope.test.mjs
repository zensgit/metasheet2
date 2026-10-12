import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scopeAttendanceImportUrl } from './attendance-import-scope.mjs'

test('import scope preserves other query fields, and refuses a conflicting selector', () => {
  const input = 'http://localhost/api/attendance/import/batches/b/export.csv?type=all'
  const scoped = new URL(scopeAttendanceImportUrl(input, 'synthetic-org'))
  assert.equal(scoped.searchParams.get('type'), 'all')
  assert.equal(scoped.searchParams.get('orgId'), 'synthetic-org')
  assert.equal(scopeAttendanceImportUrl(scoped.href, 'synthetic-org'), scoped.href)
  assert.throws(() => scopeAttendanceImportUrl(scoped.href, 'other-org'), /ATTENDANCE_IMPORT_ORG_MISMATCH/)
  for (const path of ['/api/auth/me', '/api/attendance/rules/me', '/api/attendance/leave-balances/me']) {
    const url = `http://localhost${path}`
    assert.equal(scopeAttendanceImportUrl(url, 'synthetic-org'), url)
  }
})

test('non-default import can preview, commit, read metadata, export and roll back in the same scope', async () => {
  const calls = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let raw = ''
    for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/auth/refresh-token') return reply(401, { success: false })
    if (url.pathname === '/api/auth/me') return reply(200, { ok: true, data: { user: { id: 'synthetic-user' } } })
    const effectiveOrg = body.orgId ?? url.searchParams.get('orgId') ?? 'default'
    calls.push({ path: url.pathname, orgId: effectiveOrg })
    if (effectiveOrg !== 'synthetic-org') return reply(404, { ok: false, error: { code: 'NOT_FOUND' } })
    if (url.pathname.endsWith('/template')) return reply(200, { ok: true, data: { payloadExample: {} } })
    if (url.pathname.endsWith('/prepare')) return reply(200, { ok: true, data: { commitToken: 'synthetic' } })
    if (url.pathname.endsWith('/preview')) return reply(200, { ok: true, data: { items: [{}] } })
    if (url.pathname.endsWith('/commit')) return reply(200, { ok: true, data: { batchId: 'synthetic-batch', imported: 1 } })
    if (url.pathname.endsWith('/batches/synthetic-batch')) return reply(200, { ok: true, data: {} })
    if (url.pathname.endsWith('/export.csv')) {
      res.writeHead(200, { 'Content-Type': 'text/csv' })
      return res.end('batchId,workDate,userId\n')
    }
    if (url.pathname.endsWith('/rollback/synthetic-batch')) return reply(200, { ok: true, data: {} })
    return reply(404, { ok: false })
  })
  const output = await mkdtemp(join(tmpdir(), 'attendance-import-scope-'))
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const child = spawn(process.execPath, ['scripts/ops/attendance-import-perf.mjs'], {
      env: { ...process.env, API_BASE: `http://127.0.0.1:${server.address().port}/api`,
        AUTH_TOKEN: 'synthetic', ORG_ID: 'synthetic-org', ROWS: '1', MODE: 'commit',
        PREVIEW_MODE: 'sync', COMMIT_ASYNC: 'false', ASYNC: 'false', PAYLOAD_SOURCE: 'rows',
        REQUIRE_IMPORT_TELEMETRY: 'false', REQUIRE_IMPORT_UPSERT_STRATEGY: 'false',
        EXPORT_CSV: 'true', ROLLBACK: 'true', API_RETRY_ATTEMPTS: '1', OUTPUT_DIR: output },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    assert.equal(exitCode, 0, log)
    for (const endpoint of ['template', 'prepare', 'preview', 'commit', 'batches/synthetic-batch', 'export.csv', 'rollback/synthetic-batch']) {
      assert.ok(calls.some(call => call.path.endsWith(`/${endpoint}`)), endpoint)
    }
    assert.ok(calls.every(call => call.orgId === 'synthetic-org'))
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(output, { recursive: true, force: true })
  }
})

test('non-default API smoke polls both job kinds, exports and reads batch items in its import scope', async () => {
  const calls = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    let raw = ''
    for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: status === 200, success: status === 200, data }))
    }
    if (path === '/api/auth/refresh-token' || path === '/api/attendance-admin/role-templates') return reply({}, 404)
    if (path === '/api/auth/me') return reply({ user: { id: 'synthetic-user', tenantId: 'synthetic-org' }, features: { attendance: true } })
    if (path === '/api/plugins') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify([{ name: 'plugin-attendance', status: 'active' }]))
    }
    if (path.startsWith('/api/attendance/import/')) {
      const effectiveOrg = body.orgId ?? url.searchParams.get('orgId') ?? 'default'
      calls.push({ path, orgId: effectiveOrg })
      if (effectiveOrg !== 'synthetic-org') return reply({ code: 'NOT_FOUND' }, 404)
      if (path.endsWith('/template')) return reply({ payloadExample: {} })
      if (path.endsWith('/prepare')) return reply({ commitToken: 'synthetic' })
      if (path.endsWith('/preview')) return reply({ items: [{}] })
      if (path.endsWith('/preview-async')) return reply({ job: { id: 'preview-job' }, idempotent: true })
      if (path.endsWith('/commit-async')) return reply({ job: { id: 'commit-job', batchId: 'async-batch' }, idempotent: true })
      if (path.endsWith('/jobs/preview-job')) return reply({ id: 'preview-job', status: 'completed', kind: 'preview', preview: { items: [{}] } })
      if (path.endsWith('/jobs/commit-job')) return reply({ id: 'commit-job', status: 'completed', batchId: 'async-batch' })
      if (path.endsWith('/commit')) return reply({ batchId: 'synthetic-batch', idempotent: true })
      if (path.endsWith('/items')) return reply({ items: [{}] })
      if (path.endsWith('/export.csv')) {
        res.writeHead(200, { 'Content-Type': 'text/csv' })
        return res.end('batchId,workDate,userId\n')
      }
      if (path.endsWith('/rollback/async-batch')) return reply({})
    }
    if (path.endsWith('/groups')) return reply({ items: [{ id: 'synthetic-group', name: 'Smoke Gate Group' }] })
    if (path.endsWith('/members')) return reply({ items: [{ userId: 'synthetic-user' }] })
    if (path.endsWith('/requests') && req.method === 'POST') return reply({ request: { id: 'synthetic-request' } })
    if (path.endsWith('/requests')) return reply({ items: url.searchParams.get('status') === 'approved' ? [{ id: 'synthetic-request' }] : [] })
    if (path.endsWith('/approve')) return reply({})
    if (path.endsWith('/records')) return reply({ items: [{ userId: 'synthetic-user', workDate: '2049-06-11', status: 'adjusted' }] })
    return reply({}, 404)
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const child = spawn(process.execPath, ['scripts/ops/attendance-smoke-api.mjs'], {
      env: { ...process.env, API_BASE: `http://127.0.0.1:${server.address().port}/api`,
        AUTH_TOKEN: 'synthetic', ORG_ID: 'synthetic-org', AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        SMOKE_WORK_DATE: '2049-06-11', REQUIRE_ATTENDANCE_ADMIN_API: 'false',
        REQUIRE_PREVIEW_ASYNC: 'true', REQUIRE_IMPORT_ASYNC: 'true', REQUIRE_IMPORT_EXPORT: 'true',
        REQUIRE_IMPORT_UPLOAD: 'false', REQUIRE_IMPORT_UPLOAD_ASYNC: 'false',
        REQUIRE_IMPORT_TELEMETRY: 'false', EXPECT_PRODUCT_MODE: '', API_RETRY_ATTEMPTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    assert.equal(exitCode, 0, log)
    for (const endpoint of ['jobs/preview-job', 'jobs/commit-job', 'export.csv', 'batches/async-batch/items', 'rollback/async-batch']) {
      assert.ok(calls.some(call => call.path.endsWith(`/${endpoint}`)), endpoint)
    }
    assert.ok(calls.every(call => call.orgId === 'synthetic-org'))
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
