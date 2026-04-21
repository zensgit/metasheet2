import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDefaultPatchUrl,
  normalizeBaseUrl,
  parseConfig,
  renderInvalidationSmokeMarkdown,
  validateConfig,
} from './yjs-invalidation-smoke.mjs'

test('normalizeBaseUrl trims trailing slashes', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8900///'), 'http://127.0.0.1:8900')
  assert.equal(normalizeBaseUrl('  https://example.test/base/  '), 'https://example.test/base')
})

test('buildDefaultPatchUrl targets canonical multitable record patch route', () => {
  assert.equal(
    buildDefaultPatchUrl('http://127.0.0.1:8900/', 'rec 1'),
    'http://127.0.0.1:8900/api/multitable/records/rec%201',
  )
})

test('parseConfig accepts API_BASE, token aliases, and explicit patch URL', () => {
  const config = parseConfig({
    API_BASE: 'http://127.0.0.1:8900/',
    TOKEN: 'jwt',
    RECORD_ID: 'rec_1',
    FIELD_ID: 'fld_title',
    SHEET_ID: 'sheet_1',
    PATCH_VALUE: 'next',
    PATCH_URL: 'http://override.test/patch',
    OUTPUT_DIR: 'tmp/out',
    CONFIRM_WRITE: '1',
    TIMEOUT_MS: '1234',
  })

  assert.equal(config.apiBase, 'http://127.0.0.1:8900')
  assert.equal(config.token, 'jwt')
  assert.equal(config.recordId, 'rec_1')
  assert.equal(config.fieldId, 'fld_title')
  assert.equal(config.sheetId, 'sheet_1')
  assert.equal(config.patchValue, 'next')
  assert.equal(config.patchUrl, 'http://override.test/patch')
  assert.equal(config.outputDir, 'tmp/out')
  assert.equal(config.confirmWrite, true)
  assert.equal(config.timeoutMs, 1234)
})

test('validateConfig requires write confirmation and auth by default', () => {
  assert.deepEqual(validateConfig(parseConfig({})), [
    'API_BASE or BASE_URL',
    'RECORD_ID',
    'FIELD_ID',
    'PATCH_URL',
    'AUTH_TOKEN or TOKEN',
    'CONFIRM_WRITE=1',
  ])

  assert.deepEqual(validateConfig(parseConfig({
    BASE_URL: 'http://127.0.0.1:8900',
    RECORD_ID: 'rec_1',
    FIELD_ID: 'fld_title',
    ALLOW_DEV_TOKEN: '1',
    CONFIRM_WRITE: 'true',
  })), [])
})

test('renderInvalidationSmokeMarkdown includes failed checks and payload', () => {
  const markdown = renderInvalidationSmokeMarkdown({
    ok: false,
    apiBase: 'http://127.0.0.1:8900',
    recordId: 'rec_1',
    fieldId: 'fld_title',
    patchUrl: 'http://127.0.0.1:8900/api/multitable/records/rec_1',
    startedAt: '2026-04-21T00:00:00.000Z',
    finishedAt: '2026-04-21T00:00:01.000Z',
    reportPath: '/tmp/report.json',
    reportMdPath: '/tmp/report.md',
    error: 'boom',
    invalidatedPayload: { recordId: 'rec_1', reason: 'rest-write' },
    checks: [
      { name: 'socket.connect', ok: true },
      { name: 'socket.invalidated', ok: false },
    ],
  })

  assert.match(markdown, /# Yjs Invalidation Smoke/)
  assert.match(markdown, /Overall: \*\*FAIL\*\*/)
  assert.match(markdown, /Failing checks: `socket\.invalidated`/)
  assert.match(markdown, /"reason": "rest-write"/)
  assert.match(markdown, /Error: `boom`/)
})
