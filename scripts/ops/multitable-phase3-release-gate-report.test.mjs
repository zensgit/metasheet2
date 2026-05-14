import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  REPORT_SCHEMA_VERSION,
  buildReport,
  renderMarkdown,
  writeReport,
} from './multitable-phase3-release-gate-report.mjs'

test('REPORT_SCHEMA_VERSION is exported', () => {
  assert.equal(typeof REPORT_SCHEMA_VERSION, 'number')
})

test('buildReport stamps schema version and redacts secrets', () => {
  const report = buildReport({
    tool: 'multitable-phase3-release-gate',
    gate: 'perf:large-table',
    status: 'blocked',
    exitCode: 2,
    authToken: 'sk-leakytestonly1234567890abcdef',
    recipient: 'qa@example.com',
    reason: 'leaked Bearer abcdefghijklmnopqrstuvwx12345 surface',
  })
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(report.tool, 'multitable-phase3-release-gate')
  assert.equal(report.authToken, '<redacted>')
  assert.equal(report.recipient, '<redacted>')
  assert.match(report.reason, /Bearer <redacted>/)
  assert.doesNotMatch(report.reason, /abcdefghijklmnopqrstuvwx12345/)
})

test('renderMarkdown formats a blocked report with required-env and missing-env sections', () => {
  const md = renderMarkdown({
    tool: 'multitable-phase3-release-gate',
    gate: 'perf:large-table',
    status: 'blocked',
    exitCode: 2,
    reason: 'Lane D2 deferred',
    startedAt: '2026-05-14T00:00:00Z',
    completedAt: '2026-05-14T00:00:01Z',
    requiredEnv: ['MULTITABLE_PERF_LARGE_TABLE_CONFIRM', 'MULTITABLE_PERF_TARGET_DB'],
    missingEnv: ['MULTITABLE_PERF_LARGE_TABLE_CONFIRM'],
  })
  assert.match(md, /^# multitable-phase3-release-gate$/m)
  assert.match(md, /Status: \*\*blocked\*\*/)
  assert.match(md, /Exit code: `2`/)
  assert.match(md, /## Required env/)
  assert.match(md, /## Missing env/)
  assert.match(md, /MULTITABLE_PERF_LARGE_TABLE_CONFIRM/)
})

test('renderMarkdown formats aggregator with children table', () => {
  const md = renderMarkdown({
    tool: 'multitable-phase3-release-gate',
    gate: 'release:phase3',
    status: 'blocked',
    exitCode: 2,
    reason: 'children blocked',
    children: [
      { gate: 'perf:large-table', status: 'blocked', exitCode: 2 },
      { gate: 'permissions:matrix', status: 'blocked', exitCode: 2 },
      { gate: 'automation:soak', status: 'blocked', exitCode: 2 },
    ],
  })
  assert.match(md, /## Children/)
  assert.match(md, /\| `perf:large-table` \| blocked \| 2 \|/)
  assert.match(md, /\| `automation:soak` \| blocked \| 2 \|/)
})

test('writeReport produces redacted JSON and MD on disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-phase3-gate-report-'))
  try {
    const dirty = {
      tool: 'multitable-phase3-release-gate',
      gate: 'perf:large-table',
      status: 'blocked',
      exitCode: 2,
      authToken: 'Bearer abcdefghijklmnopqrstuvwx12345',
      smtpPassword: 'realSmtpPw99',
      recipient: 'qa@example.com',
      reason: 'Token Bearer abcdefghijklmnopqrstuvwx12345 leaked into reason',
    }
    const { outputJson, outputMd, report } = writeReport({
      outputJson: path.join(dir, 'report.json'),
      outputMd: path.join(dir, 'report.md'),
      report: dirty,
    })
    const json = readFileSync(outputJson, 'utf8')
    const md = readFileSync(outputMd, 'utf8')
    const all = `${json}\n${md}`
    assert.doesNotMatch(all, /abcdefghijklmnopqrstuvwx12345/, 'bearer token leaked')
    assert.doesNotMatch(all, /realSmtpPw99/, 'SMTP password leaked')
    assert.doesNotMatch(all, /qa@example\.com/, 'recipient leaked')
    assert.match(all, /Bearer <redacted>/, 'bearer marker missing')
    assert.match(all, /<redacted>/, 'generic redacted marker missing')
    assert.equal(report.authToken, '<redacted>')
    assert.equal(report.smtpPassword, '<redacted>')
    assert.equal(report.recipient, '<redacted>')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
