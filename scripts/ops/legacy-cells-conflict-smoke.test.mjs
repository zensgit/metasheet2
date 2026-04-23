import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cellEndpoint,
  normalizeBaseUrl,
  parseConfig,
  parseEnvFile,
  renderLegacyCellsConflictSmokeMarkdown,
  resolveApiBase,
  validateConfig,
} from './legacy-cells-conflict-smoke.mjs'

test('normalizeBaseUrl trims spaces and trailing slashes', () => {
  assert.equal(normalizeBaseUrl(' http://127.0.0.1:8081/// '), 'http://127.0.0.1:8081')
})

test('resolveApiBase accepts web origins and explicit api origins', () => {
  assert.equal(resolveApiBase('http://127.0.0.1:8081'), 'http://127.0.0.1:8081/api')
  assert.equal(resolveApiBase('http://127.0.0.1:8081/api'), 'http://127.0.0.1:8081/api')
  assert.equal(resolveApiBase('http://127.0.0.1:8900/custom'), 'http://127.0.0.1:8900/custom')
})

test('cellEndpoint encodes spreadsheet and sheet ids', () => {
  assert.equal(
    cellEndpoint('http://127.0.0.1:8081', 'spread sheet', 'sheet/1'),
    'http://127.0.0.1:8081/api/spreadsheets/spread%20sheet/sheets/sheet%2F1/cells',
  )
})

test('parseEnvFile handles quotes, comments, and empty lines', () => {
  assert.deepEqual(parseEnvFile(`
    # comment
    BASE_URL="http://example.test"
    USERNAME='admin'
    PASSWORD=plain=value
  `), {
    BASE_URL: 'http://example.test',
    USERNAME: 'admin',
    PASSWORD: 'plain=value',
  })
})

test('parseConfig merges env-file values below process env overrides', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cells-smoke-'))
  const envFile = path.join(tmpDir, 'smoke.env')
  fs.writeFileSync(envFile, [
    'BASE_URL=http://file.example.test',
    'USERNAME=file-user',
    'PASSWORD=file-password',
    'CONFIRM_WRITE=1',
    '',
  ].join('\n'))

  const config = parseConfig({
    BASE_URL: 'http://override.example.test/api',
    OUTPUT_DIR: 'tmp/out',
  }, { envFile })

  assert.equal(config.apiBase, 'http://override.example.test/api')
  assert.equal(config.loginIdentifier, 'file-user')
  assert.equal(config.loginPassword, 'file-password')
  assert.equal(config.confirmWrite, true)
  assert.equal(config.outputDir, 'tmp/out')
})

test('parseConfig accepts bootstrap admin credential keys', () => {
  const config = parseConfig({
    BASE_URL: 'http://127.0.0.1:8081',
    CONFIRM_WRITE: '1',
    YUANTUS_BOOTSTRAP_ADMIN_USERNAME: 'bootstrap-admin',
    YUANTUS_BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-password',
  })

  assert.equal(config.loginIdentifier, 'bootstrap-admin')
  assert.equal(config.loginPassword, 'bootstrap-password')
})

test('validateConfig requires api base, write confirmation, and auth path', () => {
  assert.deepEqual(validateConfig(parseConfig({})), [
    'API_BASE or BASE_URL',
    'CONFIRM_WRITE=1',
    'AUTH_TOKEN/TOKEN or LOGIN_EMAIL/USERNAME + LOGIN_PASSWORD/PASSWORD or ALLOW_DEV_TOKEN=1',
  ])

  assert.deepEqual(validateConfig(parseConfig({
    BASE_URL: 'http://127.0.0.1:8081',
    CONFIRM_WRITE: 'true',
    ALLOW_DEV_TOKEN: '1',
  })), [])
})

test('renderLegacyCellsConflictSmokeMarkdown includes checks and conflict payload', () => {
  const markdown = renderLegacyCellsConflictSmokeMarkdown({
    ok: false,
    apiBase: 'http://127.0.0.1:8081/api',
    spreadsheetId: 'ss1',
    sheetId: 'sheet1',
    authSource: 'login',
    cleanupAttempted: true,
    cleanupOk: true,
    startedAt: '2026-04-23T00:00:00.000Z',
    finishedAt: '2026-04-23T00:00:01.000Z',
    reportPath: '/tmp/report.json',
    reportMdPath: '/tmp/report.md',
    conflict: { code: 'VERSION_CONFLICT', serverVersion: 2, expectedVersion: 1 },
    finalCell: { row_index: 0, column_index: 0, version: 2 },
    checks: [
      { name: 'config.valid', ok: true },
      { name: 'cell.session-b-conflict', ok: false },
    ],
  })

  assert.match(markdown, /# Legacy Cells Conflict Smoke/)
  assert.match(markdown, /Overall: \*\*FAIL\*\*/)
  assert.match(markdown, /Failing checks: `cell\.session-b-conflict`/)
  assert.match(markdown, /"code": "VERSION_CONFLICT"/)
  assert.match(markdown, /"version": 2/)
})
