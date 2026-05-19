import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  parseConfig,
  renderAcceptanceMarkdown,
  renderHelp,
  runAttendanceReportPeriodSummariesAcceptance,
  validateConfig,
} from './attendance-report-period-summaries-live-acceptance.mjs'

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(json))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.setEncoding('utf8')
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const text = chunks.join('')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function syncPayload(body, count) {
  const isCycle = Boolean(body.cycleId)
  const skipped = count > 1 ? 1 : 0
  const created = count > 1 ? 0 : 1
  return {
    ok: true,
    data: {
      periodType: isCycle ? 'payroll_cycle' : 'date_range',
      periodKey: isCycle ? `cycle:${body.cycleId}` : `range:${body.from}:${body.to}`,
      cycleId: body.cycleId || null,
      from: isCycle ? '2026-05-01' : body.from,
      to: isCycle ? '2026-05-31' : body.to,
      userSelection: body.allUsers ? 'allUsers' : Array.isArray(body.userIds) ? 'explicit' : undefined,
      totalUsers: body.allUsers ? 1 : undefined,
      page: body.page,
      pageSize: body.pageSize,
      hasNextPage: false,
      usersScanned: body.allUsers ? 1 : 1,
      usersSynced: 1,
      usersFailed: 0,
      synced: 1,
      rowsSynced: 1,
      created,
      patched: 0,
      skipped,
      failed: 0,
      duplicateRowKeys: 0,
      fieldFingerprint: 'unit-test-period-field-fingerprint',
      syncedAt: '2026-05-19T06:00:00.000Z',
      multitable: {
        available: true,
        degraded: false,
        projectId: 'default:attendance',
        objectId: 'attendance_report_period_summaries',
        sheetId: 'sheet_period',
        viewId: 'view_period',
      },
    },
  }
}

async function startMockServer() {
  const calls = []
  const bodies = []
  const jobBodies = []
  const jobRunCounts = new Map()
  let dateJobCreateCount = 0
  let cycleJobCreateCount = 0
  let dateSyncCount = 0
  let cycleSyncCount = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    calls.push(`${req.method} ${url.pathname}`)

    if (url.pathname === '/api/health') {
      send(res, 200, { ok: true, status: 'healthy' })
      return
    }
    if (url.pathname === '/api/auth/me') {
      send(res, 200, { ok: true, data: { user: { id: 'admin' } } })
      return
    }
    if (url.pathname === '/api/attendance/report-period-summaries/sync' && req.method === 'POST') {
      const body = await readBody(req)
      bodies.push(body)
      if (body.cycleId) {
        cycleSyncCount += 1
        send(res, 200, syncPayload(body, cycleSyncCount))
        return
      }
      dateSyncCount += 1
      send(res, 200, syncPayload(body, dateSyncCount))
      return
    }
    if (url.pathname === '/api/attendance/report-sync-jobs' && req.method === 'POST') {
      const body = await readBody(req)
      jobBodies.push(body)
      const isCycle = Boolean(body.periodSource?.cycleId)
      const id = isCycle
        ? `period-cycle-job-${++cycleJobCreateCount}`
        : `period-date-job-${++dateJobCreateCount}`
      send(res, 201, {
        ok: true,
        data: {
          id,
          kind: body.kind,
          status: 'queued',
          mode: body.mode,
          periodSource: body.periodSource,
          userSelection: body.userSelection,
          cursor: { nextPage: 1, pageSize: body.pageSize, hasNextPage: true },
          totals: { usersScanned: 0, usersSynced: 0, usersFailed: 0, synced: 0, rowsSynced: 0, created: 0, patched: 0, skipped: 0, failed: 0, duplicateRowKeys: 0 },
        },
      })
      return
    }
    const jobCancelMatch = url.pathname.match(/^\/api\/attendance\/report-sync-jobs\/([^/]+)\/cancel$/)
    if (jobCancelMatch && req.method === 'POST') {
      const jobId = decodeURIComponent(jobCancelMatch[1])
      send(res, 200, {
        ok: true,
        data: {
          id: jobId,
          kind: 'period_summaries',
          status: 'canceled',
          totals: { usersScanned: 0, usersSynced: 0, usersFailed: 0, synced: 0, rowsSynced: 0, created: 0, patched: 0, skipped: 0, failed: 0, duplicateRowKeys: 0 },
        },
      })
      return
    }
    const jobRunMatch = url.pathname.match(/^\/api\/attendance\/report-sync-jobs\/([^/]+)\/run-next-page$/)
    if (jobRunMatch && req.method === 'POST') {
      const jobId = decodeURIComponent(jobRunMatch[1])
      const runCount = (jobRunCounts.get(jobId) || 0) + 1
      jobRunCounts.set(jobId, runCount)
      if (runCount > 1) {
        send(res, 409, { ok: false, error: { code: 'JOB_TERMINAL', message: 'Completed or canceled attendance report sync jobs cannot run again' } })
        return
      }
      send(res, 200, {
        ok: true,
        data: {
          job: {
            id: jobId,
            kind: 'period_summaries',
            status: 'completed',
            cursor: { nextPage: 1, pageSize: 5, hasNextPage: false },
            totals: { usersScanned: 1, usersSynced: 1, usersFailed: 0, synced: 1, rowsSynced: 1, created: 1, patched: 0, skipped: 0, failed: 0, duplicateRowKeys: 0 },
            lastResult: { usersScanned: 1, synced: 1, hasNextPage: false },
          },
          pageResult: { usersScanned: 1, synced: 1, hasNextPage: false },
        },
      })
      return
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    bodies,
    jobBodies,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function writeTokenFile(tmpDir, value = 'unit-test-token') {
  const tokenFile = path.join(tmpDir, 'token.jwt')
  fs.writeFileSync(tokenFile, value)
  fs.chmodSync(tokenFile, 0o600)
  return tokenFile
}

test('validateConfig requires auth, confirmation, and user selection', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.deepEqual(validateConfig(config), [
    'AUTH_TOKEN/AUTH_TOKEN_FILE or ALLOW_DEV_TOKEN=1',
    'CONFIRM_SYNC=1',
    'USER_ID/USER_IDS or ALL_USERS=1',
  ])
})

test('validateConfig accepts token file and explicit user', () => {
  const config = parseConfig({
    AUTH_SOURCE: 'token-file',
    AUTH_TOKEN_FILE: '/tmp/metasheet-admin.jwt',
    CONFIRM_SYNC: '1',
    USER_ID: 'user-1',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.equal(config.authSource, 'AUTH_TOKEN_FILE')
  assert.equal(config.authTokenFile, '/tmp/metasheet-admin.jwt')
  assert.deepEqual(validateConfig(config), [])
})

test('run acceptance syncs date range and optional cycle twice', async () => {
  const server = await startMockServer()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-summaries-live-'))
  try {
    const tokenFile = writeTokenFile(tmpDir)
    const outputDir = path.join(tmpDir, 'out')
    const config = parseConfig({
      API_BASE: server.baseUrl,
      AUTH_SOURCE: 'AUTH_TOKEN_FILE',
      AUTH_TOKEN_FILE: tokenFile,
      CONFIRM_SYNC: '1',
      USER_ID: 'user-1',
      FROM_DATE: '2026-05-01',
      TO_DATE: '2026-05-13',
      CYCLE_ID: 'cycle-1',
      OUTPUT_DIR: outputDir,
    })

    const report = await runAttendanceReportPeriodSummariesAcceptance(config)
    assert.equal(report.ok, true)
    assert.equal(report.metadata.dateRangeFieldFingerprint, 'unit-test-period-field-fingerprint')
    assert.equal(report.metadata.cycleFieldFingerprint, 'unit-test-period-field-fingerprint')
    assert.equal(fs.existsSync(config.reportPath), true)
    assert.equal(fs.existsSync(config.reportMdPath), true)
    assert.deepEqual(server.bodies.map(body => body.cycleId || `${body.from}:${body.to}`), [
      '2026-05-01:2026-05-13',
      '2026-05-01:2026-05-13',
      'cycle-1',
      'cycle-1',
    ])
    assert.equal(report.checks.some(check => check.name === 'date-range.rerun-skipped' && check.ok), true)
    assert.equal(report.checks.some(check => check.name === 'payroll-cycle.rerun-skipped' && check.ok), true)
  } finally {
    await server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('JOB_MODE runs period summary sync jobs and rejects terminal reruns', async () => {
  const server = await startMockServer()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-summaries-job-mode-'))
  try {
    const tokenFile = writeTokenFile(tmpDir)
    const outputDir = path.join(tmpDir, 'out')
    const config = parseConfig({
      API_BASE: server.baseUrl,
      AUTH_SOURCE: 'AUTH_TOKEN_FILE',
      AUTH_TOKEN_FILE: tokenFile,
      CONFIRM_SYNC: '1',
      USER_IDS: 'user-1,user-2',
      FROM_DATE: '2026-05-01',
      TO_DATE: '2026-05-13',
      CYCLE_ID: 'cycle-1',
      JOB_MODE: '1',
      PAGE_SIZE: '4',
      OUTPUT_DIR: outputDir,
    })

    const report = await runAttendanceReportPeriodSummariesAcceptance(config)
    assert.equal(report.ok, true)
    assert.equal(report.metadata.dateRangeJobId, 'period-date-job-1')
    assert.equal(report.metadata.dateRangeJobStatus, 'completed')
    assert.equal(report.metadata.dateRangeJobPages, 1)
    assert.equal(report.metadata.cycleJobId, 'period-cycle-job-1')
    assert.equal(report.metadata.cycleJobStatus, 'completed')
    const dateJobBody = {
      kind: 'period_summaries',
      mode: 'manual_step',
      pageSize: 4,
      periodSource: { from: '2026-05-01', to: '2026-05-13' },
      userSelection: { userIds: ['user-1', 'user-2'] },
    }
    const cycleJobBody = {
      kind: 'period_summaries',
      mode: 'manual_step',
      pageSize: 4,
      periodSource: { cycleId: 'cycle-1' },
      userSelection: { userIds: ['user-1', 'user-2'] },
    }
    assert.deepEqual(server.jobBodies, [
      dateJobBody,
      dateJobBody,
      cycleJobBody,
      cycleJobBody,
    ])
    assert.ok(report.checks.some(check => check.name === 'date-range.job.completed' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'date-range.job.terminal-rerun-rejected' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'date-range.job.new-job-created' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'date-range.job.new-job-canceled' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'payroll-cycle.job.completed' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'payroll-cycle.job.terminal-rerun-rejected' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'payroll-cycle.job.new-job-created' && check.ok))
    assert.ok(report.checks.some(check => check.name === 'payroll-cycle.job.new-job-canceled' && check.ok))
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.match(markdown, /dateRangeJobStatus: `completed`/)
    assert.doesNotMatch(markdown, /unit-test-token/)
  } finally {
    await server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('run acceptance sends allUsers pagination body', async () => {
  const server = await startMockServer()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-summaries-live-'))
  try {
    const tokenFile = writeTokenFile(tmpDir)
    const config = parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN_FILE: tokenFile,
      CONFIRM_SYNC: '1',
      ALL_USERS: '1',
      PAGE: '2',
      PAGE_SIZE: '7',
      FROM_DATE: '2026-05-01',
      TO_DATE: '2026-05-13',
      OUTPUT_DIR: path.join(tmpDir, 'out'),
    })

    const report = await runAttendanceReportPeriodSummariesAcceptance(config)
    assert.equal(report.ok, true)
    assert.equal(server.bodies[0].allUsers, true)
    assert.equal(server.bodies[0].page, 2)
    assert.equal(server.bodies[0].pageSize, 7)
    assert.equal(report.checks.some(check => check.name === 'payroll-cycle.skipped' && check.ok), true)
  } finally {
    await server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('preflight only checks health and skips auth requirement', async () => {
  const server = await startMockServer()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-summaries-live-'))
  try {
    const config = parseConfig({
      API_BASE: server.baseUrl,
      PREFLIGHT_ONLY: '1',
      OUTPUT_DIR: path.join(tmpDir, 'out'),
    })
    const report = await runAttendanceReportPeriodSummariesAcceptance(config)
    assert.equal(report.ok, true)
    assert.deepEqual(server.calls, ['GET /api/health'])
  } finally {
    await server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('render helpers include period summaries wording', () => {
  assert.match(renderHelp(), /report-period-summaries/)
  assert.match(renderAcceptanceMarkdown({ ok: true, checks: [] }), /Attendance Report Period Summaries Live Acceptance/)
})
