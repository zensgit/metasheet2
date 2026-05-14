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
  runAttendanceReportFieldsAcceptance,
  validateConfig,
} from './attendance-report-fields-live-acceptance.mjs'

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(json))
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...headers })
  res.end(text)
}

const categories = [
  { id: 'fixed', label: '固定字段' },
  { id: 'basic', label: '基础字段' },
  { id: 'attendance', label: '出勤统计字段' },
  { id: 'anomaly', label: '异常统计字段' },
  { id: 'leave', label: '请假统计字段' },
  { id: 'overtime', label: '加班统计字段' },
]

const reportFields = [
  { code: 'work_date', name: '日期', category: 'fixed', reportVisible: true, exportKey: 'work_date' },
  { code: 'employee_name', name: '姓名', category: 'fixed', reportVisible: true, exportKey: 'employee_name' },
  { code: 'late_minutes', name: '迟到时长', category: 'anomaly', reportVisible: true, exportKey: 'late_minutes' },
]

function reportFieldConfigPayload() {
  return {
    multitable: catalogPayload().multitable,
    fieldsFingerprint: {
      algorithm: 'sha1',
      value: 'unit-test-report-fields-fingerprint',
      fieldCount: reportFields.length,
      codes: reportFields.map(field => field.code),
    },
  }
}

function csvReportFieldHeaders() {
  const config = reportFieldConfigPayload()
  const fingerprint = config.fieldsFingerprint
  const multitable = config.multitable
  return {
    'X-Attendance-Report-Fields-Fingerprint-Algorithm': fingerprint.algorithm,
    'X-Attendance-Report-Fields-Fingerprint': fingerprint.value,
    'X-Attendance-Report-Fields-Count': String(fingerprint.fieldCount),
    'X-Attendance-Report-Fields-Codes': fingerprint.codes.join(','),
    'X-Attendance-Report-Fields-Project-Id': multitable.projectId,
    'X-Attendance-Report-Fields-Object-Id': multitable.objectId,
    'X-Attendance-Report-Fields-Sheet-Id': multitable.sheetId,
    'X-Attendance-Report-Fields-View-Id': multitable.viewId,
  }
}

function catalogPayload() {
  return {
    categories,
    items: reportFields,
    multitable: {
      available: true,
      degraded: false,
      projectId: 'default:attendance',
      objectId: 'attendance_report_field_catalog',
      sheetId: 'sheet_attendance_report_fields',
      viewId: 'fields_by_category',
      recordCount: reportFields.length,
    },
    reportFieldConfig: {
      multitable: {
        available: true,
        degraded: false,
        projectId: 'default:attendance',
        objectId: 'attendance_report_field_catalog',
        sheetId: 'sheet_attendance_report_fields',
        viewId: 'fields_by_category',
        recordCount: reportFields.length,
      },
      fieldsFingerprint: {
        algorithm: 'sha1',
        value: 'unit-test-report-fields-fingerprint',
        fieldCount: reportFields.length,
        codes: reportFields.map(field => field.code),
      },
    },
  }
}

async function startMockServer() {
  const calls = []
  const hostHeaders = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    calls.push(`${req.method} ${url.pathname}`)
    hostHeaders.push(req.headers.host || '')

    if (url.pathname === '/api/health') {
      send(res, 200, { ok: true, status: 'healthy' })
      return
    }
    if (url.pathname === '/api/auth/me') {
      send(res, 200, { ok: true, data: { user: { id: 'admin' } } })
      return
    }
    if (url.pathname === '/api/attendance/report-fields' && req.method === 'GET') {
      send(res, 200, { ok: true, data: catalogPayload() })
      return
    }
    if (url.pathname === '/api/attendance/report-fields/sync' && req.method === 'POST') {
      send(res, 200, { ok: true, data: catalogPayload() })
      return
    }
    if (url.pathname === '/api/attendance/records') {
      send(res, 200, {
        ok: true,
        success: true,
        data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 5,
          reportFields,
          reportFieldConfig: reportFieldConfigPayload(),
        },
      })
      return
    }
    if (url.pathname === '/api/attendance/export') {
      if (url.searchParams.get('format') === 'csv') {
        if (url.searchParams.get('header') === 'code') {
          sendText(res, 200, 'work_date,employee_name,late_minutes\n2026-05-13,Admin,0\n', 'text/csv; charset=utf-8', csvReportFieldHeaders())
          return
        }
        sendText(res, 200, '日期,姓名,迟到时长\n2026-05-13,Admin,0\n', 'text/csv; charset=utf-8', csvReportFieldHeaders())
        return
      }
      send(res, 200, {
        ok: true,
        success: true,
        data: {
          items: [{ work_date: '2026-05-13', employee_name: 'Admin', late_minutes: 0 }],
          total: 1,
          format: 'json',
          reportFields,
          reportFieldConfig: reportFieldConfigPayload(),
        },
      })
      return
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    hostHeaders,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function resolveUnusedBaseUrl() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${address.port}`
}

test('validateConfig requires explicit auth and sync confirmation', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.deepEqual(validateConfig(config), [
    'AUTH_TOKEN/AUTH_TOKEN_FILE or ALLOW_DEV_TOKEN=1',
    'CONFIRM_SYNC=1',
  ])
})

test('validateConfig accepts an auth token file for live mode', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    AUTH_SOURCE: 'token-file',
    AUTH_TOKEN_FILE: '/tmp/metasheet-admin.jwt',
    CONFIRM_SYNC: '1',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.equal(config.authSource, 'AUTH_TOKEN_FILE')
  assert.equal(config.authTokenFile, '/tmp/metasheet-admin.jwt')
  assert.deepEqual(validateConfig(config), [])
})

test('validateConfig rejects an unavailable requested auth source', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    AUTH_SOURCE: 'AUTH_TOKEN_FILE',
    AUTH_TOKEN: 'unit-test-env-token',
    CONFIRM_SYNC: '1',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.deepEqual(validateConfig(config), [
    'AUTH_SOURCE=AUTH_TOKEN_FILE requires AUTH_TOKEN_FILE/TOKEN_FILE',
  ])
})

test('validateConfig rejects an unknown requested auth source', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    AUTH_SOURCE: 'cookie',
    AUTH_TOKEN: 'unit-test-env-token',
    CONFIRM_SYNC: '1',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.deepEqual(validateConfig(config), [
    'AUTH_SOURCE one of AUTH_TOKEN, AUTH_TOKEN_FILE, ALLOW_DEV_TOKEN',
  ])
})

test('validateConfig rejects invalid API host headers', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    API_HOST_HEADER: 'http://localhost',
    AUTH_TOKEN: 'jwt-from-env',
    CONFIRM_SYNC: '1',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.deepEqual(validateConfig(config), ['API_HOST_HEADER host[:port]'])
})

test('validateConfig allows preflight without auth or sync confirmation', () => {
  const config = parseConfig({
    API_BASE: 'https://staging.example.test/',
    PREFLIGHT_ONLY: '1',
    FROM_DATE: '2026-05-01',
    TO_DATE: '2026-05-13',
  })
  assert.deepEqual(validateConfig(config), [])
})

test('live mode honors AUTH_SOURCE=AUTH_TOKEN_FILE over AUTH_TOKEN', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-auth-source-forced-file-'))
  const tokenFile = path.join(outputDir, 'admin.jwt')
  fs.writeFileSync(tokenFile, 'unit-test-file-token\n', { mode: 0o600 })
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_SOURCE: 'AUTH_TOKEN_FILE',
      AUTH_TOKEN: 'unit-test-env-token',
      AUTH_TOKEN_FILE: tokenFile,
      CONFIRM_SYNC: '1',
      ORG_ID: 'default',
      FROM_DATE: '2026-05-01',
      TO_DATE: '2026-05-13',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, true)
    assert.equal(report.metadata.authSource, 'AUTH_TOKEN_FILE')
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-source'
      && check.ok
      && check.details.requested === 'AUTH_TOKEN_FILE'
      && check.details.selected === 'AUTH_TOKEN_FILE'
      && check.details.present === 'AUTH_TOKEN,AUTH_TOKEN_FILE'
      && check.details.ignored === 'AUTH_TOKEN'
    )))
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-token-file'
      && check.ok
      && check.details.status === 'loaded'
    )))
    assert.ok(report.checks.some((check) => (
      check.name === 'api.auth-token'
      && check.ok
      && check.details.source === 'AUTH_TOKEN_FILE'
    )))
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.match(markdown, /Auth source: `AUTH_TOKEN_FILE`/)
    assert.match(markdown, /requested: `AUTH_TOKEN_FILE`/)
    assert.match(markdown, /ignored: `AUTH_TOKEN`/)
    assert.doesNotMatch(markdown, /unit-test-env-token/)
    assert.doesNotMatch(markdown, /unit-test-file-token/)
  } finally {
    await server.close()
  }
})

test('renderAcceptanceMarkdown summarizes checks without leaking auth material', () => {
  const markdown = renderAcceptanceMarkdown({
    ok: false,
    apiBase: 'https://staging.example.test',
    orgId: 'default',
    userId: 'token-user',
    from: '2026-05-01',
    to: '2026-05-13',
    expectedVisibleCode: 'work_date',
    expectedHiddenCode: 'secret-token-value',
    startedAt: '2026-05-13T00:00:00.000Z',
    finishedAt: '2026-05-13T00:00:01.000Z',
    reportPath: '/tmp/report.json',
    reportMdPath: '/tmp/report.md',
    metadata: {
      catalogFieldFingerprint: 'unit-test-fingerprint',
      recordsFieldFingerprint: 'unit-test-fingerprint',
      exportFieldFingerprint: 'unit-test-fingerprint',
      csvFieldFingerprint: 'unit-test-fingerprint',
      csvCodeFieldFingerprint: 'unit-test-fingerprint',
      csvFieldCount: 3,
      csvFieldCodes: 'work_date,employee_name,late_minutes',
      csvCodeFieldCodes: 'work_date,employee_name,late_minutes',
      csvBacking: 'default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category',
      csvCodeBacking: 'default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category',
    },
    checks: [
      { name: 'api.health', ok: true, details: { status: 200 } },
      { name: 'catalog.required-categories', ok: false, details: { missing: ['leave'] } },
      {
        name: 'export.csv.report-field-fingerprint-match',
        ok: true,
        details: {
          csv: 'unit-test-fingerprint',
          export: 'unit-test-fingerprint',
          algorithm: 'sha1',
          authorization: 'Bearer should-not-render',
        },
      },
    ],
    blocker: {
      code: 'BACKEND_UNREACHABLE',
      message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8900',
    },
    nextActions: [
      '确认 API_BASE 是否正确：https://staging.example.test',
    ],
  })

  assert.match(markdown, /# Attendance Report Fields Live Acceptance/)
  assert.match(markdown, /Overall: \*\*FAIL\*\*/)
  assert.match(markdown, /Failing checks: `catalog\.required-categories`/)
  assert.match(markdown, /Code: `BACKEND_UNREACHABLE`/)
  assert.match(markdown, /csv: `unit-test-fingerprint`/)
  assert.match(markdown, /export: `unit-test-fingerprint`/)
  assert.match(markdown, /algorithm: `sha1`/)
  assert.match(markdown, /## Evidence Summary/)
  assert.ok(markdown.includes('- CSV field codes: `work_date,employee_name,late_minutes`'))
  assert.ok(markdown.includes('- CSV backing: `default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category`'))
  assert.ok(markdown.includes('- CSV code backing: `default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category`'))
  assert.match(markdown, /## Next Actions/)
  assert.doesNotMatch(markdown, /Bearer/)
  assert.doesNotMatch(markdown, /should-not-render/)
})

test('renderHelp documents preflight and live-mode configuration', () => {
  const help = renderHelp()
  assert.match(help, /AUTH_TOKEN=<token>, AUTH_TOKEN_FILE=<path>, or ALLOW_DEV_TOKEN=1/)
  assert.match(help, /AUTH_SOURCE=AUTH_TOKEN\|AUTH_TOKEN_FILE\|ALLOW_DEV_TOKEN/)
  assert.match(help, /CONFIRM_SYNC=1/)
  assert.match(help, /API_HOST_HEADER=localhost/)
  assert.match(help, /PREFLIGHT_ONLY=1/)
})

test('preflight mode checks backend reachability without sync or auth', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-preflight-'))
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      PREFLIGHT_ONLY: '1',
      AUTH_TOKEN_FILE: path.join(outputDir, 'missing.jwt'),
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, true)
    assert.equal(report.runMode, 'preflight')
    assert.ok(report.checks.some((check) => check.name === 'api.health' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'preflight.completed' && check.ok))
    assert.equal(report.checks.some((check) => check.name === 'config.auth-token-file'), false)
    assert.equal(server.calls.includes('POST /api/attendance/report-fields/sync'), false)
    assert.equal(server.calls.includes('GET /api/auth/me'), false)
    assert.ok(fs.existsSync(path.join(outputDir, 'report.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'report.md')))
  } finally {
    await server.close()
  }
})

test('preflight mode applies the configured API host header', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-preflight-host-'))
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      API_HOST_HEADER: 'metasheet.local',
      PREFLIGHT_ONLY: '1',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, true)
    assert.equal(report.hostHeader, 'metasheet.local')
    assert.equal(server.hostHeaders[0], 'metasheet.local')
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.match(markdown, /Host header: `metasheet\.local`/)
  } finally {
    await server.close()
  }
})

test('preflight mode classifies an unreachable backend as an environment blocker', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-preflight-blocked-'))
  const report = await runAttendanceReportFieldsAcceptance(parseConfig({
    API_BASE: await resolveUnusedBaseUrl(),
    PREFLIGHT_ONLY: '1',
    TIMEOUT_MS: '500',
    OUTPUT_DIR: outputDir,
  }))

  assert.equal(report.ok, false)
  assert.equal(report.blocker.code, 'BACKEND_UNREACHABLE')
  assert.ok(report.checks.some((check) => check.name === 'api.health' && !check.ok))
  assert.ok(report.nextActions.some((action) => action.includes('API_BASE')))
})

test('live mode classifies an unreadable auth token file as a configuration blocker', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-token-file-blocked-'))
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN_FILE: path.join(outputDir, 'missing.jwt'),
      CONFIRM_SYNC: '1',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, false)
    assert.equal(report.blocker.code, 'AUTH_TOKEN_FILE_INVALID')
    assert.equal(report.checks.some((check) => check.name === 'api.health'), false)
    assert.ok(report.checks.some((check) => check.name === 'config.auth-token-file' && !check.ok))
    assert.equal(server.calls.includes('GET /api/health'), false)
    assert.equal(server.calls.includes('POST /api/attendance/report-fields/sync'), false)
    assert.ok(fs.existsSync(path.join(outputDir, 'report.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'report.md')))
  } finally {
    await server.close()
  }
})

test('live mode redacts home directory auth token file paths in artifacts', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-token-file-redacted-'))
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-home-'))
  const originalHome = process.env.HOME
  process.env.HOME = homeDir
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN_FILE: path.join(homeDir, '.tokens', 'admin.jwt'),
      CONFIRM_SYNC: '1',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, false)
    assert.equal(report.blocker.code, 'AUTH_TOKEN_FILE_INVALID')
    assert.match(report.blocker.message, /~\/\.tokens\/admin\.jwt/)
    const tokenFileCheck = report.checks.find((check) => check.name === 'config.auth-token-file')
    assert.equal(tokenFileCheck?.details?.tokenFile, '~/.tokens/admin.jwt')
    assert.equal(report.checks.some((check) => check.name === 'api.health'), false)
    assert.equal(server.calls.includes('GET /api/health'), false)
    assert.equal(server.calls.includes('POST /api/attendance/report-fields/sync'), false)

    const json = fs.readFileSync(path.join(outputDir, 'report.json'), 'utf8')
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.doesNotMatch(json, new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(markdown, new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(markdown, /~\/\.tokens\/admin\.jwt/)
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await server.close()
  }
})

test('live mode blocks auth token files with group or other permissions', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-token-file-mode-'))
  const tokenFile = path.join(outputDir, 'admin.jwt')
  fs.writeFileSync(tokenFile, 'unit-test-token\n', { mode: 0o644 })
  fs.chmodSync(tokenFile, 0o644)
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN_FILE: tokenFile,
      CONFIRM_SYNC: '1',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, false)
    assert.equal(report.blocker.code, 'AUTH_TOKEN_FILE_INVALID')
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-token-file-permissions'
      && !check.ok
      && check.details.mode === '0644'
    )))
    assert.equal(report.checks.some((check) => check.name === 'api.health'), false)
    assert.equal(server.calls.includes('GET /api/health'), false)
    assert.equal(server.calls.includes('POST /api/attendance/report-fields/sync'), false)
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.doesNotMatch(markdown, /unit-test-token/)
  } finally {
    await server.close()
  }
})

test('runAttendanceReportFieldsAcceptance verifies catalog, records, export, and writes artifacts', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-live-acceptance-'))
  const tokenFile = path.join(outputDir, 'admin.jwt')
  fs.writeFileSync(tokenFile, 'unit-test-token\n', { mode: 0o600 })
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN_FILE: tokenFile,
      CONFIRM_SYNC: '1',
      ORG_ID: 'default',
      FROM_DATE: '2026-05-01',
      TO_DATE: '2026-05-13',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, true)
    assert.equal(report.metadata.authSource, 'AUTH_TOKEN_FILE')
    assert.equal(report.metadata.projectId, 'default:attendance')
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-source'
      && check.ok
      && check.details.selected === 'AUTH_TOKEN_FILE'
      && check.details.present === 'AUTH_TOKEN_FILE'
      && check.details.ignored === 'none'
    )))
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-token-file'
      && check.ok
      && check.details.status === 'loaded'
    )))
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-token-file-permissions'
      && check.ok
      && check.details.mode === '0600'
    )))
    assert.ok(report.checks.some((check) => (
      check.name === 'api.auth-token'
      && check.ok
      && check.details.source === 'AUTH_TOKEN_FILE'
    )))
    assert.ok(report.checks.some((check) => check.name === 'catalog.required-categories' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'records-export.report-field-codes-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'records-export.report-field-config-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'catalog-records.report-field-fingerprint-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'records-export.report-field-fingerprint-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.header.expected-visible-label' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-fingerprint-present' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-fingerprint-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-count-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-codes-present' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-codes-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-backing-present' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.report-field-backing-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv.header-code.expected-visible-code' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv-code.report-field-fingerprint-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv-code.report-field-codes-match' && check.ok))
    assert.ok(report.checks.some((check) => check.name === 'export.csv-code.report-field-backing-match' && check.ok))
    assert.equal(report.metadata.recordsConfigProjectId, 'default:attendance')
    assert.equal(report.metadata.exportConfigProjectId, 'default:attendance')
    assert.equal(report.metadata.catalogFieldFingerprint, 'unit-test-report-fields-fingerprint')
    assert.equal(report.metadata.recordsFieldFingerprint, 'unit-test-report-fields-fingerprint')
    assert.equal(report.metadata.exportFieldFingerprint, 'unit-test-report-fields-fingerprint')
    assert.equal(report.metadata.csvHeader, '日期,姓名,迟到时长')
    assert.equal(report.metadata.csvFieldFingerprint, 'unit-test-report-fields-fingerprint')
    assert.equal(report.metadata.csvFieldFingerprintAlgorithm, 'sha1')
    assert.equal(report.metadata.csvFieldCount, reportFields.length)
    assert.equal(report.metadata.csvFieldCodes, 'work_date,employee_name,late_minutes')
    assert.equal(report.metadata.csvBacking, 'default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category')
    assert.equal(report.metadata.csvCodeHeader, 'work_date,employee_name,late_minutes')
    assert.equal(report.metadata.csvCodeFieldFingerprint, 'unit-test-report-fields-fingerprint')
    assert.equal(report.metadata.csvCodeFieldCodes, 'work_date,employee_name,late_minutes')
    assert.equal(report.metadata.csvCodeBacking, 'default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category')
    assert.ok(server.calls.includes('POST /api/attendance/report-fields/sync'))
    assert.ok(server.calls.includes('GET /api/attendance/records'))
    assert.ok(server.calls.includes('GET /api/attendance/export'))
    assert.ok(fs.existsSync(path.join(outputDir, 'report.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'report.md')))
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.match(markdown, /## Evidence Summary/)
    assert.ok(markdown.includes('- CSV field codes: `work_date,employee_name,late_minutes`'))
    assert.ok(markdown.includes('- CSV backing: `default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category`'))
    assert.ok(markdown.includes('- CSV code backing: `default:attendance|attendance_report_field_catalog|sheet_attendance_report_fields|fields_by_category`'))
    assert.match(markdown, /Auth source: `AUTH_TOKEN_FILE`/)
    assert.doesNotMatch(markdown, /unit-test-token/)
  } finally {
    await server.close()
  }
})

test('live mode records selected auth source when multiple auth sources are present', async () => {
  const server = await startMockServer()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-report-fields-auth-source-'))
  try {
    const report = await runAttendanceReportFieldsAcceptance(parseConfig({
      API_BASE: server.baseUrl,
      AUTH_TOKEN: 'unit-test-env-token',
      AUTH_TOKEN_FILE: path.join(outputDir, 'missing-and-ignored.jwt'),
      ALLOW_DEV_TOKEN: '1',
      CONFIRM_SYNC: '1',
      ORG_ID: 'default',
      FROM_DATE: '2026-05-01',
      TO_DATE: '2026-05-13',
      OUTPUT_DIR: outputDir,
    }))

    assert.equal(report.ok, true)
    assert.equal(report.metadata.authSource, 'AUTH_TOKEN')
    assert.ok(report.checks.some((check) => (
      check.name === 'config.auth-source'
      && check.ok
      && check.details.selected === 'AUTH_TOKEN'
      && check.details.present === 'AUTH_TOKEN,AUTH_TOKEN_FILE,ALLOW_DEV_TOKEN'
      && check.details.ignored === 'AUTH_TOKEN_FILE,ALLOW_DEV_TOKEN'
    )))
    assert.equal(report.checks.some((check) => check.name === 'config.auth-token-file'), false)
    assert.ok(report.checks.some((check) => (
      check.name === 'api.auth-token'
      && check.ok
      && check.details.source === 'AUTH_TOKEN'
    )))
    const markdown = fs.readFileSync(path.join(outputDir, 'report.md'), 'utf8')
    assert.match(markdown, /Auth source: `AUTH_TOKEN`/)
    assert.match(markdown, /selected: `AUTH_TOKEN`/)
    assert.match(markdown, /ignored: `AUTH_TOKEN_FILE,ALLOW_DEV_TOKEN`/)
    assert.doesNotMatch(markdown, /unit-test-env-token/)
  } finally {
    await server.close()
  }
})
